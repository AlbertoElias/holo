import type { FastifyInstance } from "fastify";

import {
  requestMagicLinkResponseSchema,
  requestMagicLinkSchema,
  sessionResponseSchema,
  updateProfileSchema,
  userDtoSchema,
  verifyMagicLinkSchema
} from "@holoim/contracts";

import { env } from "../lib/env.js";
import {
  bearerToken,
  getSessionUser,
  requestMagicLink,
  revokeSession,
  toUserDto,
  updateDisplayName,
  verifyMagicLink,
  type AuthUser
} from "../services/auth.js";

async function requireUser(
  request: { headers: { authorization?: string | string[] | undefined } },
  reply: { status: (code: number) => { send: (body: unknown) => unknown } }
): Promise<AuthUser | null> {
  const token = bearerToken(request.headers);
  const user = token ? await getSessionUser(token) : null;
  if (!user) {
    reply.status(401).send({ error: "Sign in required." });
    return null;
  }
  return user;
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/magic-link", async (request, reply) => {
    const parsed = requestMagicLinkSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "A valid email is required." });
    }

    const { token } = await requestMagicLink({
      email: parsed.data.email,
      ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {})
    });

    // Same response whether or not the email already has an account.
    return reply.status(202).send(
      requestMagicLinkResponseSchema.parse({
        sent: true as const,
        ...(env.AUTH_DEV_EXPOSE_MAGIC_LINK ? { devMagicLinkToken: token } : {})
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
    const user = await requireUser(request, reply);
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
