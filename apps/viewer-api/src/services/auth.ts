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

/**
 * Email delivery seam. No provider is configured in this repo, so a local
 * operator reads the link from the log only when dev exposure is enabled;
 * a real provider replaces this function without touching routes or
 * contracts. The token is never logged otherwise.
 */
export function deliverMagicLink(email: string, url: string): void {
  if (env.AUTH_DEV_EXPOSE_MAGIC_LINK) {
    console.info(`[auth] Magic link for ${email}: ${url}`);
    return;
  }
  console.info(`[auth] Magic link sent to ${email}`);
}

export async function requestMagicLink(input: {
  email: string;
  displayName?: string;
}): Promise<{ token: string; url: string }> {
  const token = newToken();
  const email = input.email.toLowerCase();
  await prisma.magicLinkToken.create({
    data: {
      email,
      displayName: input.displayName ?? null,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + env.AUTH_MAGIC_LINK_TTL_MS)
    }
  });
  const url = `${env.WEB_ORIGIN}/auth/verify?token=${encodeURIComponent(token)}`;
  deliverMagicLink(email, url);
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
