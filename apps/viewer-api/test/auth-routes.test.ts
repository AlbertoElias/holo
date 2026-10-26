import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type SessionBody = { token: string; user: { id: string; email: string; displayName: string } };
type HologramDto = {
  id: string;
  hologramName: string;
  submittedBy: string;
  submittedByVerified: boolean;
  ownedByViewer: boolean;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("auth and ownership routes", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let testRoot: string;
  let previousDatabaseUrl: string | undefined;
  let previousExpose: string | undefined;

  async function requestMagicToken(email: string, displayName?: string): Promise<string> {
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

  async function signIn(email: string, displayName?: string): Promise<SessionBody> {
    const token = await requestMagicToken(email, displayName);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: { token }
    });
    expect(response.statusCode).toBe(200);
    return response.json<SessionBody>();
  }

  async function upload(sessionToken: string | null, submittedBy = "Spoofed Name"): Promise<HologramDto> {
    const boundary = `auth-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="hologramName"\r\n\r\nOwned take\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="submittedBy"\r\n\r\n${submittedBy}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="avatar.glb"\r\n` +
          "Content-Type: model/gltf-binary\r\n\r\n"
      ),
      Buffer.from("auth-test-glb"),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const response = await app.inject({
      method: "POST",
      url: "/api/holograms",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {})
      },
      payload
    });
    expect(response.statusCode).toBe(201);
    return response.json<HologramDto>();
  }

  beforeAll(async () => {
    testRoot = await mkdtemp(path.join(tmpdir(), "holoim-auth-routes-"));
    const uploadsRoot = path.join(testRoot, "uploads");
    await mkdir(uploadsRoot, { recursive: true });
    previousDatabaseUrl = process.env.DATABASE_URL;
    previousExpose = process.env.AUTH_DEV_EXPOSE_MAGIC_LINK;
    process.env.DATABASE_URL = `file:${path.join(testRoot, "auth.db")}`;
    process.env.AUTH_DEV_EXPOSE_MAGIC_LINK = "true";

    vi.resetModules();
    const prismaModule = await import("../src/lib/prisma.js");
    prisma = prismaModule.prisma;

    await prisma.$executeRawUnsafe(`
      CREATE TABLE "User" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "email" TEXT NOT NULL,
        "displayName" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX "User_email_key" ON "User"("email")`);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "MagicLinkToken" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "email" TEXT NOT NULL,
        "displayName" TEXT,
        "tokenHash" TEXT NOT NULL,
        "expiresAt" DATETIME NOT NULL,
        "usedAt" DATETIME,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX "MagicLinkToken_tokenHash_key" ON "MagicLinkToken"("tokenHash")`
    );
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "Session" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "tokenHash" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "expiresAt" DATETIME NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash")`);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "Hologram" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "filenameOriginal" TEXT NOT NULL,
        "hologramName" TEXT NOT NULL,
        "submittedBy" TEXT NOT NULL,
        "filenameStored" TEXT NOT NULL,
        "mimeType" TEXT NOT NULL,
        "sizeBytes" INTEGER NOT NULL,
        "storagePath" TEXT NOT NULL,
        "durationSec" REAL,
        "usdzPath" TEXT,
        "usdzStatus" TEXT NOT NULL DEFAULT 'none',
        "usdzClaimedAt" DATETIME,
        "usdzClaimToken" TEXT,
        "usdzAttempts" INTEGER NOT NULL DEFAULT 0,
        "usdzError" TEXT,
        "quickLookEnabled" BOOLEAN NOT NULL DEFAULT false,
        "ownerId" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "UploadIntent" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "storageKey" TEXT NOT NULL,
        "quickLookEnabled" BOOLEAN NOT NULL DEFAULT false,
        "filenameOriginal" TEXT NOT NULL,
        "hologramName" TEXT NOT NULL,
        "submittedBy" TEXT NOT NULL,
        "mimeType" TEXT NOT NULL,
        "sizeBytes" INTEGER NOT NULL,
        "expiresAt" DATETIME NOT NULL,
        "completedHologramId" TEXT,
        "ownerId" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);

    const { buildApp } = await import("../src/app.js");
    app = buildApp({ logger: false, uploadsRoot });
    await app.ready();
  });

  beforeEach(async () => {
    await prisma.hologram.deleteMany();
    await prisma.session.deleteMany();
    await prisma.magicLinkToken.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await rm(testRoot, { recursive: true, force: true });
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousExpose === undefined) delete process.env.AUTH_DEV_EXPOSE_MAGIC_LINK;
    else process.env.AUTH_DEV_EXPOSE_MAGIC_LINK = previousExpose;
  });

  it("creates the account on verify, stores only token hashes, and revokes on logout", async () => {
    const token = await requestMagicToken("ada@example.com", "Ada");
    const stored = await prisma.magicLinkToken.findFirstOrThrow();
    expect(stored.tokenHash).toBe(sha256(token));
    expect(stored.tokenHash).not.toBe(token);

    const verify = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { token } });
    expect(verify.statusCode).toBe(200);
    const session = verify.json<SessionBody>();
    expect(session.user).toMatchObject({ email: "ada@example.com", displayName: "Ada" });

    const sessionRow = await prisma.session.findFirstOrThrow();
    expect(sessionRow.tokenHash).toBe(sha256(session.token));

    // A magic link is single-use.
    const reuse = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { token } });
    expect(reuse.statusCode).toBe(401);

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${session.token}` }
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: "ada@example.com", displayName: "Ada" });

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { authorization: `Bearer ${session.token}` }
    });
    expect(logout.statusCode).toBe(204);

    const afterLogout = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${session.token}` }
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it("rejects an expired magic link", async () => {
    const token = await requestMagicToken("grace@example.com", "Grace");
    await prisma.magicLinkToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const response = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { token } });
    expect(response.statusCode).toBe(401);
    expect(await prisma.user.count()).toBe(0);
  });

  it("owns authenticated uploads, overrides the client-sent name, and enforces the delete matrix", async () => {
    const owner = await signIn("owner@example.com", "Owner Name");
    const other = await signIn("other@example.com", "Other Name");

    const created = await upload(owner.token);
    expect(created.submittedBy).toBe("Owner Name");
    expect(created.submittedByVerified).toBe(true);
    expect(created.ownedByViewer).toBe(true);

    const asOther = await app.inject({
      method: "GET",
      url: `/api/holograms/${created.id}`,
      headers: { authorization: `Bearer ${other.token}` }
    });
    expect(asOther.json<HologramDto>().ownedByViewer).toBe(false);
    expect(asOther.json<HologramDto>().submittedByVerified).toBe(true);

    const anonymousDelete = await app.inject({ method: "DELETE", url: `/api/holograms/${created.id}` });
    expect(anonymousDelete.statusCode).toBe(401);

    const nonOwnerDelete = await app.inject({
      method: "DELETE",
      url: `/api/holograms/${created.id}`,
      headers: { authorization: `Bearer ${other.token}` }
    });
    expect(nonOwnerDelete.statusCode).toBe(403);
    expect(await prisma.hologram.count()).toBe(1);

    const ownerDelete = await app.inject({
      method: "DELETE",
      url: `/api/holograms/${created.id}`,
      headers: { authorization: `Bearer ${owner.token}` }
    });
    expect(ownerDelete.statusCode).toBe(200);
    expect(await prisma.hologram.count()).toBe(0);
  });

  it("keeps anonymous legacy uploads and deletes working with no verified name", async () => {
    const created = await upload(null, "Free Text Name");
    expect(created.submittedBy).toBe("Free Text Name");
    expect(created.submittedByVerified).toBe(false);
    expect(created.ownedByViewer).toBe(false);

    const deleted = await app.inject({ method: "DELETE", url: `/api/holograms/${created.id}` });
    expect(deleted.statusCode).toBe(200);
    expect(await prisma.hologram.count()).toBe(0);
  });
});
