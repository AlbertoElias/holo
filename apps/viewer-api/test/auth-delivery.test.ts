import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthTables } from "./fixtures/auth.js";

const ENV_KEYS = [
  "DATABASE_URL",
  "AUTH_DEV_EXPOSE_MAGIC_LINK",
  "AUTH_EMAIL_FROM",
  "CLOUDFLARE_EMAIL_ACCOUNT_ID",
  "CLOUDFLARE_EMAIL_API_TOKEN",
  "CLOUDFLARE_EMAIL_API_ORIGIN"
] as const;

type SentEmail = { url: string; authorization: string | undefined; body: Record<string, unknown> };

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

describe("sign-in email delivery", () => {
  const cleanups: Array<() => Promise<void>> = [];
  const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    for (const key of ENV_KEYS) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  /** Env is parsed at import time, so each case sets its env and boots its own app and database. */
  async function boot(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
    const testRoot = await mkdtemp(path.join(tmpdir(), "holoim-auth-delivery-"));
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, { DATABASE_URL: `file:${path.join(testRoot, "auth.db")}`, ...env });

    vi.resetModules();
    const { prisma } = (await import("../src/lib/prisma.js")) as { prisma: PrismaClient };
    await createAuthTables(prisma);
    const { buildApp } = await import("../src/app.js");
    const app: FastifyInstance = buildApp({ logger: false, uploadsRoot: path.join(testRoot, "uploads") });
    await app.ready();
    cleanups.push(async () => {
      await app.close();
      await prisma.$disconnect();
      await rm(testRoot, { recursive: true, force: true });
    });
    return { app, prisma };
  }

  /** A stand-in for api.cloudflare.com that records what it is sent and answers with `status`. */
  async function startMailServer(status: number) {
    const received: SentEmail[] = [];
    const server: Server = createServer((request, response) => {
      void readBody(request).then((raw) => {
        received.push({
          url: request.url ?? "",
          authorization: request.headers.authorization,
          body: JSON.parse(raw) as Record<string, unknown>
        });
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(status === 200 ? { success: true } : { success: false, errors: [{ message: "boom" }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return { received, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  const mailerEnv = (origin: string) => ({
    CLOUDFLARE_EMAIL_ACCOUNT_ID: "acct123",
    CLOUDFLARE_EMAIL_API_TOKEN: "mail-api-token",
    AUTH_EMAIL_FROM: "login@holoim.example",
    CLOUDFLARE_EMAIL_API_ORIGIN: origin
  });

  const requestLink = (app: FastifyInstance) =>
    app.inject({ method: "POST", url: "/api/auth/magic-link", payload: { email: "Ada@Example.com", displayName: "Ada" } });

  it("answers 503 and stores no token when no mailer is configured and dev exposure is off", async () => {
    const { app, prisma } = await boot({});
    const response = await requestLink(app);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "We couldn't send the sign-in email. Try again in a minute." });
    expect(await prisma.magicLinkToken.count()).toBe(0);
  });

  it("sends the link by email and never returns the token to the client", async () => {
    const mail = await startMailServer(200);
    const { app, prisma } = await boot(mailerEnv(mail.origin));
    const response = await requestLink(app);
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ sent: true });

    expect(mail.received).toHaveLength(1);
    const sent = mail.received[0]!;
    expect(sent.url).toBe("/accounts/acct123/email/sending/send");
    expect(sent.authorization).toBe("Bearer mail-api-token");
    expect(sent.body.to).toBe("ada@example.com");
    expect(sent.body.from).toMatchObject({ address: "login@holoim.example" });
    expect(typeof sent.body.subject).toBe("string");
    expect(sent.body.subject).not.toBe("");
    const link = /(https?:\/\/\S*\/auth\/verify\?token=([^\s"<]+))/.exec(String(sent.body.text));
    expect(link, "the text body carries the verify link").not.toBeNull();
    const token = decodeURIComponent(link![2]!);

    expect(response.body).not.toContain(token);
    expect(await prisma.magicLinkToken.count()).toBe(1);

    // The emailed link is the real thing: it signs the person in.
    const verify = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { token } });
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toMatchObject({ user: { email: "ada@example.com", displayName: "Ada" } });
  });

  it("answers 503 and deletes the token when the email service fails", async () => {
    const mail = await startMailServer(500);
    const { app, prisma } = await boot(mailerEnv(mail.origin));
    const response = await requestLink(app);
    expect(mail.received).toHaveLength(1);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "We couldn't send the sign-in email. Try again in a minute." });
    expect(await prisma.magicLinkToken.count()).toBe(0);
  });
});
