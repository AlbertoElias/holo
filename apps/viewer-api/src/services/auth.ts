import { createHash, randomBytes } from "node:crypto";

import { env } from "../lib/env.js";
import { prisma } from "../lib/prisma.js";

export type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  createdAt: Date;
};

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function toUserDto(user: AuthUser) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt.toISOString()
  };
}

/** Why a sign-in email could not go out; the route turns it into a 503. */
export class MagicLinkDeliveryError extends Error {}

/**
 * Sends the sign-in email through Cloudflare Email Service. Without a
 * configured mailer the link is only logged, and only when dev exposure is
 * on (local development and tests); otherwise delivery fails loudly rather
 * than telling the person to check an inbox nothing was sent to.
 */
export async function deliverMagicLink(email: string, url: string): Promise<void> {
  const { CLOUDFLARE_EMAIL_ACCOUNT_ID: accountId, CLOUDFLARE_EMAIL_API_TOKEN: apiToken, AUTH_EMAIL_FROM: from } = env;
  if (accountId && apiToken && from) {
    const minutes = Math.round(env.AUTH_MAGIC_LINK_TTL_MS / 60_000);
    let response: Response;
    try {
      response = await fetch(
        `${env.CLOUDFLARE_EMAIL_API_ORIGIN}/accounts/${encodeURIComponent(accountId)}/email/sending/send`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
          body: JSON.stringify({
            to: email,
            from: { address: from, name: "HoloIM" },
            subject: "Your HoloIM sign-in link",
            text: `Open this link to sign in to HoloIM. It works once and expires in ${minutes} minutes.\n\n${url}\n\nIf you did not ask for it, ignore this email.`,
            html: `<p>Open this link to sign in to HoloIM. It works once and expires in ${minutes} minutes.</p><p><a href="${url}">Sign in to HoloIM</a></p><p>If you did not ask for it, ignore this email.</p>`
          }),
          signal: AbortSignal.timeout(10_000)
        }
      );
    } catch (error) {
      throw new MagicLinkDeliveryError(`Email service unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      // The body names the cause (unverified domain, bad token); it never holds the link.
      throw new MagicLinkDeliveryError(`Email service answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    return;
  }
  if (env.AUTH_DEV_EXPOSE_MAGIC_LINK) {
    console.info(`[auth] Magic link for ${email}: ${url}`);
    return;
  }
  throw new MagicLinkDeliveryError("No email provider is configured (CLOUDFLARE_EMAIL_ACCOUNT_ID, CLOUDFLARE_EMAIL_API_TOKEN, AUTH_EMAIL_FROM).");
}

export async function requestMagicLink(input: {
  email: string;
  displayName?: string;
}): Promise<{ token: string; url: string }> {
  const token = newToken();
  const email = input.email.toLowerCase();
  const record = await prisma.magicLinkToken.create({
    data: {
      email,
      displayName: input.displayName ?? null,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + env.AUTH_MAGIC_LINK_TTL_MS)
    }
  });
  const url = `${env.WEB_ORIGIN}/auth/verify?token=${encodeURIComponent(token)}`;
  try {
    await deliverMagicLink(email, url);
  } catch (error) {
    // An undelivered link must not stay redeemable.
    await prisma.magicLinkToken.delete({ where: { id: record.id } });
    throw error;
  }
  return { token, url };
}

export async function verifyMagicLink(
  token: string
): Promise<{ sessionToken: string; user: AuthUser } | null> {
  const record = await prisma.magicLinkToken.findUnique({
    where: { tokenHash: hashToken(token) }
  });
  if (!record || record.usedAt || record.expiresAt.getTime() < Date.now()) {
    return null;
  }

  const claimed = await prisma.magicLinkToken.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: new Date() }
  });
  if (claimed.count !== 1) {
    return null;
  }

  const existing = await prisma.user.findUnique({ where: { email: record.email } });
  const user =
    existing ??
    (await prisma.user.create({
      data: {
        email: record.email,
        displayName: record.displayName ?? record.email.split("@")[0] ?? record.email
      }
    }));

  const sessionToken = newToken();
  await prisma.session.create({
    data: {
      tokenHash: hashToken(sessionToken),
      userId: user.id,
      expiresAt: new Date(Date.now() + env.AUTH_SESSION_TTL_MS)
    }
  });

  return { sessionToken, user };
}

export async function getSessionUser(token: string): Promise<AuthUser | null> {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true }
  });
  if (!session || session.expiresAt.getTime() < Date.now()) {
    return null;
  }
  return session.user;
}

export async function revokeSession(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export async function updateDisplayName(userId: string, displayName: string): Promise<AuthUser> {
  return prisma.user.update({ where: { id: userId }, data: { displayName } });
}

/** Bearer token from the Authorization header, or null when absent/malformed. */
export function bearerToken(headers: { authorization?: string | string[] | undefined }): string | null {
  const value = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization;
  if (!value?.startsWith("Bearer ")) {
    return null;
  }
  const token = value.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/** Signed-in user for a request, or null for anonymous/invalid sessions. */
export async function optionalAuthUser(headers: {
  authorization?: string | string[] | undefined;
}): Promise<AuthUser | null> {
  const token = bearerToken(headers);
  return token ? getSessionUser(token) : null;
}
