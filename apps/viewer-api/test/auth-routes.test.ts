import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bearer,
  exposeMagicLinksForTests,
  requestMagicToken as requestToken,
  signIn as signInAs,
  type SessionBody
} from "./fixtures/auth.js";
import { applyMigrations } from "./fixtures/db.js";

type HologramDto = {
  id: string;
  hologramName: string;
  submittedBy: string;
  submittedByVerified: boolean;
  ownedByViewer: boolean;
  ownerId: string | null;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("auth and ownership routes", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let testRoot: string;
  let previousDatabaseUrl: string | undefined;
  let restoreExpose: () => void;

  const requestMagicToken = (email: string, displayName?: string) => requestToken(app, email, displayName);
  const signIn = (email: string, displayName?: string) => signInAs(app, email, displayName);

  async function upload(session: SessionBody, submittedBy = "Spoofed Name", name = "Owned take"): Promise<HologramDto> {
    const boundary = `auth-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="hologramName"\r\n\r\n${name}\r\n` +
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
        ...bearer(session)
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
    process.env.DATABASE_URL = `file:${path.join(testRoot, "auth.db")}`;
    restoreExpose = exposeMagicLinksForTests();

    vi.resetModules();
    const prismaModule = await import("../src/lib/prisma.js");
    prisma = prismaModule.prisma;

    await applyMigrations(prisma);

    const { buildApp } = await import("../src/app.js");
    app = buildApp({ logger: false, uploadsRoot, searchLimit: 10_000, magicLinkLimit: 10_000 });
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
    restoreExpose();
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
      headers: bearer(session)
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: "ada@example.com", displayName: "Ada" });

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: bearer(session)
    });
    expect(logout.statusCode).toBe(204);

    const afterLogout = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: bearer(session)
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

    const created = await upload(owner);
    expect(created.submittedBy).toBe("Owner Name");
    expect(created.submittedByVerified).toBe(true);
    expect(created.ownedByViewer).toBe(true);
    await expect(prisma.hologram.findUniqueOrThrow({ where: { id: created.id } })).resolves.toMatchObject({
      ownerId: owner.user.id,
      submittedBy: "Owner Name"
    });

    const asOther = await app.inject({
      method: "GET",
      url: `/api/holograms/${created.id}`,
      headers: bearer(other)
    });
    expect(asOther.json<HologramDto>().ownedByViewer).toBe(false);
    expect(asOther.json<HologramDto>().submittedByVerified).toBe(true);

    const anonymousDelete = await app.inject({ method: "DELETE", url: `/api/holograms/${created.id}` });
    expect(anonymousDelete.statusCode).toBe(401);

    const nonOwnerDelete = await app.inject({
      method: "DELETE",
      url: `/api/holograms/${created.id}`,
      headers: bearer(other)
    });
    expect(nonOwnerDelete.statusCode).toBe(403);
    expect(await prisma.hologram.count()).toBe(1);

    const ownerDelete = await app.inject({
      method: "DELETE",
      url: `/api/holograms/${created.id}`,
      headers: bearer(owner)
    });
    expect(ownerDelete.statusCode).toBe(200);
    expect(await prisma.hologram.count()).toBe(0);
  });

  it("lists one creator's holograms, searches by title or creator, and pages a filtered list", async () => {
    const ada = await signIn("ada@example.com", "Ada Lovelace");
    const bo = await signIn("bo@example.com", "Bo");
    await upload(ada, "x", "Engine tour");
    await upload(ada, "x", "100% sure_thing");
    await upload(bo, "x", "Engine room");
    // A legacy upload: named by hand, no account.
    await prisma.hologram.create({
      data: {
        filenameOriginal: "a.glb", hologramName: "Legacy engine", submittedBy: "alberto", filenameStored: "legacy.glb",
        mimeType: "model/gltf-binary", sizeBytes: 1, storagePath: "uploads/legacy.glb"
      }
    });
    const list = async (query: string) =>
      (await app.inject({ method: "GET", url: `/api/holograms?${query}` })).json<{ items: HologramDto[]; nextCursor: string | null }>();

    const owned = await list(`ownerId=${ada.user.id}`);
    expect(owned.items.map((item) => item.hologramName).sort()).toEqual(["100% sure_thing", "Engine tour"]);
    expect(owned.items.every((item) => item.ownerId === ada.user.id)).toBe(true);

    expect((await list("q=ENGINE")).items.map((item) => item.hologramName).sort()).toEqual(["Engine room", "Engine tour", "Legacy engine"]);
    expect((await list("q=lovelace")).items.map((item) => item.hologramName).sort()).toEqual(["100% sure_thing", "Engine tour"]);
    expect((await list(`q=${encodeURIComponent("%")}`)).items.map((item) => item.hologramName)).toEqual(["100% sure_thing"]);
    expect((await list(`q=${encodeURIComponent("_")}`)).items.map((item) => item.hologramName)).toEqual(["100% sure_thing"]);
    expect((await list("q=zzz")).items).toEqual([]);
    expect((await list(`q=${encodeURIComponent("éngine")}`)).items).toHaveLength(3);
    expect((await list("limit=5&cursor=deleted-since")).items).toEqual([]);
    expect((await list("q=%20%20")).items).toHaveLength(4);
    expect((await list(`ownerId=${ada.user.id}&q=room`)).items).toEqual([]);

    const first = await list(`ownerId=${ada.user.id}&limit=1`);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await list(`ownerId=${ada.user.id}&limit=1&cursor=${first.nextCursor}`);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    expect(second.nextCursor).toBeNull();
  });

  it("pages a search through a table larger than one read batch, in order, and ends cleanly", async () => {
    // 450 rows, newest first by index. Matches sit in the first, second and last read batches (batches are 200).
    const base = Date.now() - 1_000_000;
    const matching = new Set([3, 250, 449]);
    await prisma.hologram.createMany({
      data: Array.from({ length: 450 }, (_, index) => ({
        filenameOriginal: "a.glb", hologramName: matching.has(index) ? `needle ${index}` : `filler ${index}`,
        submittedBy: "bulk", filenameStored: `bulk-${index}.glb`, mimeType: "model/gltf-binary", sizeBytes: 1,
        storagePath: `uploads/bulk-${index}.glb`, createdAt: new Date(base - index * 1000)
      }))
    });
    const list = async (query: string) =>
      (await app.inject({ method: "GET", url: `/api/holograms?${query}` })).json<{ items: HologramDto[]; nextCursor: string | null }>();

    const names: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 10; pages += 1) {
      const page: { items: HologramDto[]; nextCursor: string | null } = await list(`q=needle&limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      names.push(...page.items.map((item) => item.hologramName));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(names).toEqual(["needle 3", "needle 250", "needle 449"]);
    expect(cursor).toBeNull();

    expect((await list("q=needle&limit=2")).items.map((item) => item.hologramName)).toEqual(["needle 3", "needle 250"]);
    expect(await list("q=nothing-like-it")).toEqual({ items: [], nextCursor: null });
  });

  it("stops one search request after its scan budget and carries on from a cursor", async () => {
    // 2300 rows, newest first by index; the only match is past the 2000-row budget of one request.
    const base = Date.now() - 1_000_000;
    await prisma.hologram.createMany({
      data: Array.from({ length: 2300 }, (_, index) => ({
        filenameOriginal: "a.glb", hologramName: index === 2250 ? "needle far" : `filler ${index}`,
        submittedBy: "bulk", filenameStored: `far-${index}.glb`, mimeType: "model/gltf-binary", sizeBytes: 1,
        storagePath: `uploads/far-${index}.glb`, createdAt: new Date(base - index * 1000)
      }))
    });
    const list = async (query: string) =>
      (await app.inject({ method: "GET", url: `/api/holograms?${query}` })).json<{ items: HologramDto[]; nextCursor: string | null }>();

    const first = await list("q=needle&limit=5");
    expect(first.items).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    const second = await list(`q=needle&limit=5&cursor=${first.nextCursor}`);
    expect(second.items.map((item) => item.hologramName)).toEqual(["needle far"]);
    expect(second.nextCursor).toBeNull();
  });

  it("limits searches and sign-in emails per client, but not browsing the feed", async () => {
    const { buildApp } = await import("../src/app.js");
    const limited = buildApp({ logger: false, uploadsRoot: path.join(testRoot, "uploads"), searchLimit: 2, magicLinkLimit: 2 });
    await limited.ready();
    try {
      const search = () => limited.inject({ method: "GET", url: "/api/holograms?q=anything" });
      expect((await search()).statusCode).toBe(200);
      expect((await search()).statusCode).toBe(200);
      const refused = await search();
      expect(refused.statusCode).toBe(429);
      expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
      for (let browse = 0; browse < 5; browse += 1) {
        expect((await limited.inject({ method: "GET", url: "/api/holograms" })).statusCode).toBe(200);
      }

      const ask = () =>
        limited.inject({ method: "POST", url: "/api/auth/magic-link", payload: { email: "ada@example.com" } });
      expect((await ask()).statusCode).toBe(202);
      expect((await ask()).statusCode).toBe(202);
      expect((await ask()).statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });

  it("serves a creator's public page without their email, and 404s an unknown creator", async () => {
    const ada = await signIn("ada@example.com", "Ada Lovelace");
    await upload(ada);
    const page = await app.inject({ method: "GET", url: `/api/users/${ada.user.id}` });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toEqual({ id: ada.user.id, displayName: "Ada Lovelace", hologramCount: 1 });
    expect(page.body).not.toContain("example.com");
    expect((await app.inject({ method: "GET", url: "/api/users/nobody" })).statusCode).toBe(404);
  });
});
