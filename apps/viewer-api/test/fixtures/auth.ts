import type { FastifyInstance } from "fastify";
import { expect } from "vitest";

export type SessionBody = { token: string; user: { id: string; email: string; displayName: string } };

/**
 * The API reads env once at import time, so a test that signs in through the
 * real magic-link route sets this before importing the app. Returns the restore
 * function for afterAll.
 */
export function exposeMagicLinksForTests(): () => void {
  const previous = process.env.AUTH_DEV_EXPOSE_MAGIC_LINK;
  process.env.AUTH_DEV_EXPOSE_MAGIC_LINK = "true";
  return () => {
    if (previous === undefined) delete process.env.AUTH_DEV_EXPOSE_MAGIC_LINK;
    else process.env.AUTH_DEV_EXPOSE_MAGIC_LINK = previous;
  };
}

/** Requests a magic link and returns the dev-exposed token (needs exposeMagicLinksForTests). */
export async function requestMagicToken(app: FastifyInstance, email: string, displayName?: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/magic-link",
    payload: { email, ...(displayName ? { displayName } : {}) }
  });
  expect(response.statusCode).toBe(202);
  const body = response.json<{ sent: boolean; devMagicLinkToken?: string }>();
  expect(body.sent).toBe(true);
  expect(body.devMagicLinkToken).toBeTruthy();
  return body.devMagicLinkToken!;
}

/** Signs in through the real magic-link and verify routes. */
export async function signIn(app: FastifyInstance, email: string, displayName?: string): Promise<SessionBody> {
  const token = await requestMagicToken(app, email, displayName);
  const response = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { token } });
  expect(response.statusCode).toBe(200);
  return response.json<SessionBody>();
}

export function bearer(session: SessionBody): { authorization: string } {
  return { authorization: `Bearer ${session.token}` };
}
