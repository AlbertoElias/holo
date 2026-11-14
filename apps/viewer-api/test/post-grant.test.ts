import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bearer, exposeMagicLinksForTests, signIn, type SessionBody } from "./fixtures/auth.js";

// Post grants (docs/features/phone-capture.md), through the real migrations
// and routes. Cases come from the brief's failure list: a grant only posts
// one hologram, even in open-uploads mode; it never reads or changes the
// account; a replay returns the same hologram; a failed post gives the
// grant back; expired and forged grants fail; only a site session mints one;
// the production capture origin passes CORS on the two routes it uses.

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = (name: string) => path.join(apiRoot, "node_modules", ".bin", name);
const CAPTURE = "https://holoim-capture.pages.dev";
const SITE = "https://localhost:3174";

describe("post grants", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let testRoot: string;
  let previousDatabaseUrl: string | undefined;
  let previousOpen: string | undefined;
  let restoreExpose: () => void;
  let session: SessionBody;

  function post(authorization: string | null, { withFile = true, origin = CAPTURE } = {}) {
    const boundary = `pg-${Math.random().toString(16).slice(2)}`;
    const parts =
      `--${boundary}\r\nContent-Disposition: form-data; name="hologramName"\r\n\r\nTake\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="submittedBy"\r\n\r\nSpoofed\r\n`;
    const file = withFile
      ? Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="take.glb"\r\nContent-Type: model/gltf-binary\r\n\r\n`),
          Buffer.from("post-grant-glb"),
          Buffer.from("\r\n")
        ])
      : Buffer.alloc(0);
    return app.inject({
      method: "POST",
      url: "/api/holograms",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}`, origin, ...(authorization ? { authorization } : {}) },
      payload: Buffer.concat([Buffer.from(parts), file, Buffer.from(`--${boundary}--\r\n`)])
    });
  }

  async function mint(origin = SITE): Promise<string> {
    const response = await app.inject({ method: "POST", url: "/api/auth/post-grant", headers: { ...bearer(session), origin } });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ grant: string }>().grant;
  }

  beforeAll(async () => {
    testRoot = await mkdtemp(path.join(tmpdir(), "holoim-post-grant-"));
    const uploadsRoot = path.join(testRoot, "uploads");
    await mkdir(uploadsRoot, { recursive: true });
    const databaseUrl = `file:${path.join(testRoot, "grant.db")}`;
    execFileSync(bin("prisma"), ["migrate", "deploy"], { cwd: apiRoot, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "ignore" });
    previousDatabaseUrl = process.env.DATABASE_URL;
    previousOpen = process.env.TEST_OPEN_UPLOADS;
    process.env.DATABASE_URL = databaseUrl;
    // Open mode on: a grant must still be checked strictly.
    process.env.TEST_OPEN_UPLOADS = "true";
    restoreExpose = exposeMagicLinksForTests();
    vi.resetModules();
    prisma = (await import("../src/lib/prisma.js")).prisma;
    const { buildApp } = await import("../src/app.js");
    app = buildApp({ logger: false, uploadsRoot, searchLimit: 10_000, magicLinkLimit: 10_000 });
    await app.ready();
  }, 60_000);

  beforeEach(async () => {
    await prisma.postGrant.deleteMany();
    await prisma.hologram.deleteMany();
    await prisma.session.deleteMany();
    await prisma.magicLinkToken.deleteMany();
    await prisma.user.deleteMany();
    session = await signIn(app, "author@example.com", "Author");
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await rm(testRoot, { recursive: true, force: true });
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousOpen === undefined) delete process.env.TEST_OPEN_UPLOADS;
    else process.env.TEST_OPEN_UPLOADS = previousOpen;
    restoreExpose();
  });

  it("posts once as the author, and a replay returns the same hologram", async () => {
    const grant = await mint();
    const info = await app.inject({ method: "GET", url: "/api/auth/post-grant", headers: { authorization: `Bearer ${grant}`, origin: CAPTURE } });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({ displayName: "Author", returnOrigin: SITE, hologramId: null });

    const first = await post(`Bearer ${grant}`);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ ownerId: session.user.id, submittedBy: "Author" });
    const again = await post(`Bearer ${grant}`);
    expect(again.statusCode).toBe(200);
    expect(again.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
    expect(await prisma.hologram.count()).toBe(1);
  }, 30_000);

  it("gives the grant back when a post fails, so the same take can retry", async () => {
    const grant = await mint();
    const failed = await post(`Bearer ${grant}`, { withFile: false });
    expect(failed.statusCode).toBe(400);
    const retried = await post(`Bearer ${grant}`);
    expect(retried.statusCode, retried.body).toBe(201);
  }, 30_000);

  it("lets a retry take over a claim whose upload died with the process", async () => {
    const grant = await mint();
    // A live upload's claim holds; one left by a crash or deploy (no release) goes stale.
    await prisma.postGrant.updateMany({ data: { usedAt: new Date() } });
    expect((await post(`Bearer ${grant}`)).statusCode).toBe(409);
    await prisma.postGrant.updateMany({ data: { usedAt: new Date(Date.now() - 6 * 60_000) } });
    const retried = await post(`Bearer ${grant}`);
    expect(retried.statusCode, retried.body).toBe(201);
  }, 30_000);

  it("is never an identity: no /auth/me, no rename, no delete, no minting", async () => {
    const grant = await mint();
    const auth = { authorization: `Bearer ${grant}` };
    const piece = (await post(auth.authorization)).json<{ id: string }>();
    const grant2 = await mint();
    const auth2 = { authorization: `Bearer ${grant2}` };
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: auth2 })).statusCode).toBe(401);
    expect((await app.inject({ method: "PATCH", url: "/api/auth/me", headers: auth2, payload: { displayName: "Hijack" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: `/api/holograms/${piece.id}`, headers: auth2 })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/post-grant", headers: { ...auth2, origin: SITE } })).statusCode).toBe(401);
    expect(await prisma.hologram.count()).toBe(1);
  }, 30_000);

  it("refuses expired and forged grants even with open uploads", async () => {
    const grant = await mint();
    await prisma.postGrant.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await post(`Bearer ${grant}`)).statusCode).toBe(401);
    expect((await post("Bearer holoim_pg_forged")).statusCode).toBe(401);
    const info = await app.inject({ method: "GET", url: "/api/auth/post-grant", headers: { authorization: `Bearer ${grant}` } });
    expect(info.statusCode).toBe(401);
    expect(await prisma.hologram.count()).toBe(0);
  }, 30_000);

  it("mints only from a site session and a site origin", async () => {
    expect((await app.inject({ method: "POST", url: "/api/auth/post-grant", headers: { origin: SITE } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/post-grant", headers: { ...bearer(session), origin: "https://evil.example" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/auth/post-grant", headers: { ...bearer(session), origin: CAPTURE } })).statusCode).toBe(403);
    // A capture preview deploy passes the site's CORS list, but capture is never where a post returns.
    expect((await app.inject({ method: "POST", url: "/api/auth/post-grant", headers: { ...bearer(session), origin: "https://abc123.holoim-capture.pages.dev" } })).statusCode).toBe(403);
  });

  it("lets the production capture origin through CORS on the post routes only", async () => {
    for (const url of ["/api/holograms", "/api/auth/post-grant"]) {
      const preflight = await app.inject({
        method: "OPTIONS",
        url,
        headers: { origin: CAPTURE, "access-control-request-method": url === "/api/holograms" ? "POST" : "GET", "access-control-request-headers": "authorization" }
      });
      expect(preflight.headers["access-control-allow-origin"], url).toBe(CAPTURE);
      expect(String(preflight.headers["access-control-allow-headers"]).toLowerCase()).toContain("authorization");
    }
    const other = await app.inject({ method: "OPTIONS", url: "/api/auth/me", headers: { origin: CAPTURE, "access-control-request-method": "GET" } });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    const mintFromCapture = await app.inject({ method: "OPTIONS", url: "/api/auth/post-grant", headers: { origin: CAPTURE, "access-control-request-method": "POST" } });
    expect(mintFromCapture.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("sends a sign-in link that returns to recording when asked", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const response = await app.inject({ method: "POST", url: "/api/auth/magic-link", payload: { email: "new@example.com", next: "record" } });
      expect(response.statusCode).toBe(202);
      const line = info.mock.calls.map((call) => String(call[0])).find((text) => text.includes("new@example.com"));
      expect(line).toMatch(/\/auth\/verify\?token=[^&\s]+&next=record$/);
      const bad = await app.inject({ method: "POST", url: "/api/auth/magic-link", payload: { email: "new@example.com", next: "https://evil.example" } });
      expect(bad.statusCode).toBe(400);
    } finally {
      info.mockRestore();
    }
  });
});
