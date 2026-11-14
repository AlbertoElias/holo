import type { FastifyInstance } from "fastify";

import {
  postGrantInfoSchema,
  postGrantResponseSchema,
  requestMagicLinkResponseSchema,
  requestMagicLinkSchema,
  sessionResponseSchema,
  updateProfileSchema,
  userDtoSchema,
  verifyMagicLinkSchema
} from "@holoim/contracts";

import { isAllowedWebOrigin, isCaptureOrigin } from "../lib/cors.js";
import { env } from "../lib/env.js";
import { clientKey, createRateLimit } from "../lib/rate-limit.js";
import {
  bearerToken,
  MagicLinkDeliveryError,
  requestMagicLink,
  resolveAuth,
  revokeSession,
  toUserDto,
  updateDisplayName,
  verifyMagicLink,
  type AuthUser
} from "../services/auth.js";
import { findPostGrant, mintPostGrant, postGrantBearer } from "../services/post-grant.js";

/**
 * The signed-in account, or null after answering 401. An agent token passes
 * only where `allowApiToken` is set; elsewhere it gets 403, so a standing
 * credential cannot rename the account (and with it every later byline).
 */
async function requireUser(
  request: { headers: { authorization?: string | string[] | undefined } },
  reply: { status: (code: number) => { send: (body: unknown) => unknown } },
  { allowApiToken = false }: { allowApiToken?: boolean } = {}
): Promise<AuthUser | null> {
  const auth = await resolveAuth(request.headers);
  if (!auth) {
    reply.status(401).send({ error: "Sign in required." });
    return null;
  }
  if (auth.via === "apiToken" && !allowApiToken) {
    reply.status(403).send({ error: "An agent token cannot do this; sign in on the site instead." });
    return null;
  }
  return auth.user;
}

const MAGIC_LINK_WINDOW_MS = 10 * 60_000;
/** Each request sends an email through a paid service, so one client may ask only so often. */
const MAGIC_LINK_PER_WINDOW = 20;

export async function registerAuthRoutes(app: FastifyInstance, options: { magicLinkLimit?: number } = {}): Promise<void> {
  const behindFly = Boolean(process.env.FLY_APP_NAME);
  // Tests sign in dozens of times from one address; the mode that hands the token back (never on in production) sends no email, so it has nothing to protect.
  const perWindow = options.magicLinkLimit ?? (env.AUTH_DEV_EXPOSE_MAGIC_LINK ? Number.MAX_SAFE_INTEGER : MAGIC_LINK_PER_WINDOW);
  const magicLinkLimit = createRateLimit(perWindow, MAGIC_LINK_WINDOW_MS);

  app.post("/auth/magic-link", async (request, reply) => {
    const parsed = requestMagicLinkSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "A valid email is required." });
    }
    const retryAfter = magicLinkLimit(clientKey(request, behindFly));
    if (retryAfter !== null) {
      return reply.status(429).header("retry-after", String(retryAfter)).send({ error: "Too many sign-in emails; try again in a few minutes." });
    }

    let token: string;
    try {
      ({ token } = await requestMagicLink({
        email: parsed.data.email,
        ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
        ...(parsed.data.next ? { next: parsed.data.next } : {})
      }));
    } catch (error) {
      if (error instanceof MagicLinkDeliveryError) {
        request.log.error({ err: error }, "sign-in email not delivered");
        return reply.status(503).send({ error: "We couldn't send the sign-in email. Try again in a minute." });
      }
      throw error;
    }

    // Same response whether or not the email already has an account.
    return reply.status(202).send(
      requestMagicLinkResponseSchema.parse({
        sent: true as const,
        ...(env.AUTH_DEV_EXPOSE_MAGIC_LINK ? { devMagicLinkToken: token } : {})
      })
    );
  });

  // A post grant for capture (docs/features/phone-capture.md). Only a site
  // session mints one; the page that asked is where capture returns.
  app.post("/auth/post-grant", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return reply;
    const origin = request.headers.origin;
    // The minting page is where capture returns, so it must be the viewer, never capture itself.
    if (origin && (!isAllowedWebOrigin(origin, env.WEB_ORIGIN, env.WEB_ORIGIN_LIST) || isCaptureOrigin(origin, env.CAPTURE_ORIGIN_LIST))) {
      return reply.status(403).send({ error: "Post grants are minted only from the site." });
    }
    const { grant, expiresAt } = await mintPostGrant(user.id, origin ?? env.WEB_ORIGIN);
    return reply.status(201).send(postGrantResponseSchema.parse({ grant, expiresAt: expiresAt.toISOString() }));
  });

  // Capture reads its grant early: it learns where to return, finds an
  // expired grant before the take, and wakes a stopped API machine.
  app.get("/auth/post-grant", async (request, reply) => {
    const bearer = postGrantBearer(request.headers);
    const row = bearer ? await findPostGrant(bearer) : null;
    if (!row) {
      return reply.status(401).send({ error: "This recording link has expired. Start again from HoloIM." });
    }
    return reply.send(
      postGrantInfoSchema.parse({
        displayName: row.user.displayName,
        returnOrigin: row.returnOrigin,
        expiresAt: row.expiresAt.toISOString(),
        hologramId: row.hologramId
      })
    );
  });

  app.post("/auth/verify", async (request, reply) => {
    const parsed = verifyMagicLinkSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "A magic-link token is required." });
    }

    const result = await verifyMagicLink(parsed.data.token);
    if (!result) {
      return reply.status(401).send({ error: "This sign-in link is invalid, expired, or already used." });
    }

    return reply.send(
      sessionResponseSchema.parse({ token: result.sessionToken, user: toUserDto(result.user) })
    );
  });

  app.get("/auth/me", async (request, reply) => {
    const user = await requireUser(request, reply, { allowApiToken: true });
    if (!user) {
      return;
    }
    return reply.send(userDtoSchema.parse(toUserDto(user)));
  });

  app.patch("/auth/me", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }
    const parsed = updateProfileSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "A display name is required." });
    }
    const updated = await updateDisplayName(user.id, parsed.data.displayName);
    return reply.send(userDtoSchema.parse(toUserDto(updated)));
  });

  app.post("/auth/logout", async (request, reply) => {
    const token = bearerToken(request.headers);
    if (token) {
      await revokeSession(token);
    }
    return reply.status(204).send();
  });
}
