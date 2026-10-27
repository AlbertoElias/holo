import type { PrismaClient } from "@prisma/client";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const MIN = 60_000;
const HOUR = 60 * MIN;

type CleanupResult = { expiredRemoved: number; completedPruned: number; storageFailures: number };
type CleanupFn = (options: {
  storage: never;
  now?: Date;
  graceMs?: number;
  completedRetentionMs?: number;
  batchSize?: number;
}) => Promise<CleanupResult>;

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false
  );
}

describe("upload-intent cleanup", () => {
  let prisma: PrismaClient;
  let testRoot: string;
  let uploadsRoot: string;
  let previousDatabaseUrl: string | undefined;
  let cleanupExpiredUploadIntents: CleanupFn;
  let LocalMediaStorage: new (root: string) => { putBuffer: (k: string, b: Buffer, t: string) => Promise<void> };
  let storage: InstanceType<typeof LocalMediaStorage>;

  const seedIntent = async (input: {
    key: string;
    expiresAt: Date;
    createdAt?: Date;
    completedHologramId?: string | null;
    withObject?: boolean;
  }) => {
    const intent = await prisma.uploadIntent.create({
      data: {
        storageKey: input.key,
        filenameOriginal: "avatar.glb",
        hologramName: "Cleanup test",
        submittedBy: "Cleanup Tester",
        mimeType: "model/gltf-binary",
        sizeBytes: 4,
        expiresAt: input.expiresAt,
        completedHologramId: input.completedHologramId ?? null,
        ...(input.createdAt ? { createdAt: input.createdAt } : {})
      }
    });
    if (input.withObject !== false) {
      await storage.putBuffer(input.key, Buffer.from("glTF"), "model/gltf-binary");
    }
    return intent;
  };

  beforeAll(async () => {
    testRoot = await mkdtemp(path.join(tmpdir(), "holoim-cleanup-"));
    uploadsRoot = path.join(testRoot, "uploads");
    await mkdir(uploadsRoot, { recursive: true });
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `file:${path.join(testRoot, "cleanup.db")}`;

    vi.resetModules();
    const prismaModule = await import("../src/lib/prisma.js");
    prisma = prismaModule.prisma;
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
      )
    `);
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX "UploadIntent_storageKey_key" ON "UploadIntent"("storageKey")`
    );
    ({ cleanupExpiredUploadIntents } = (await import("../src/services/upload-intent-cleanup.js")) as never);
    ({ LocalMediaStorage } = (await import("../src/services/media-storage.js")) as never);
    storage = new LocalMediaStorage(uploadsRoot);
  });

  beforeEach(async () => {
    await prisma.uploadIntent.deleteMany();
    await rm(uploadsRoot, { recursive: true, force: true });
    await mkdir(uploadsRoot, { recursive: true });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await rm(testRoot, { recursive: true, force: true });
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it("removes an expired intent past the grace period and its object; a second sweep is a no-op", async () => {
    const now = new Date();
    const intent = await seedIntent({ key: "incoming/expired.glb", expiresAt: new Date(now.getTime() - HOUR) });

    const result = await cleanupExpiredUploadIntents({ storage: storage as never, now });
    expect(result).toEqual({ expiredRemoved: 1, completedPruned: 0, storageFailures: 0 });
    expect(await prisma.uploadIntent.findUnique({ where: { id: intent.id } })).toBeNull();
    expect(await exists(path.join(uploadsRoot, "incoming/expired.glb"))).toBe(false);

    const again = await cleanupExpiredUploadIntents({ storage: storage as never, now });
    expect(again.expiredRemoved).toBe(0);
  });

  it("keeps a live intent and its object", async () => {
    const now = new Date();
    const intent = await seedIntent({ key: "incoming/live.glb", expiresAt: new Date(now.getTime() + 10 * MIN) });

    const result = await cleanupExpiredUploadIntents({ storage: storage as never, now });
    expect(result.expiredRemoved).toBe(0);
    expect(await prisma.uploadIntent.findUnique({ where: { id: intent.id } })).not.toBeNull();
    expect(await exists(path.join(uploadsRoot, "incoming/live.glb"))).toBe(true);
  });

  it("keeps an expired intent still inside the grace period", async () => {
    const now = new Date();
    const intent = await seedIntent({ key: "incoming/grace.glb", expiresAt: new Date(now.getTime() - 5 * MIN) });

    const result = await cleanupExpiredUploadIntents({ storage: storage as never, now, graceMs: 15 * MIN });
    expect(result.expiredRemoved).toBe(0);
    expect(await prisma.uploadIntent.findUnique({ where: { id: intent.id } })).not.toBeNull();
  });

  it("keeps the row when the storage delete fails, and still cleans other intents", async () => {
    const now = new Date();
    const failing = await seedIntent({ key: "incoming/fails.glb", expiresAt: new Date(now.getTime() - HOUR) });
    const ok = await seedIntent({ key: "incoming/ok.glb", expiresAt: new Date(now.getTime() - HOUR) });
    const flakyStorage = {
      kind: "local",
      delete: async (key: string) => {
        if (key === "incoming/fails.glb") throw new Error("storage down");
        return storage.delete(key);
      }
    };

    const result = await cleanupExpiredUploadIntents({ storage: flakyStorage as never, now });
    expect(result).toEqual({ expiredRemoved: 1, completedPruned: 0, storageFailures: 1 });
    expect(await prisma.uploadIntent.findUnique({ where: { id: failing.id } })).not.toBeNull();
    expect(await prisma.uploadIntent.findUnique({ where: { id: ok.id } })).toBeNull();
  });

  it("removes the row when the object was never uploaded", async () => {
    const now = new Date();
    const intent = await seedIntent({
      key: "incoming/never.glb",
      expiresAt: new Date(now.getTime() - HOUR),
      withObject: false
    });

    const result = await cleanupExpiredUploadIntents({ storage: storage as never, now });
    expect(result.expiredRemoved).toBe(1);
    expect(await prisma.uploadIntent.findUnique({ where: { id: intent.id } })).toBeNull();
  });

  it("prunes old completed intent rows only, keeping recent ones and the published file", async () => {
    const now = new Date();
    const old = await seedIntent({
      key: "incoming/done-old.glb",
      expiresAt: new Date(now.getTime() - 2 * HOUR),
      createdAt: new Date(now.getTime() - 48 * HOUR),
      completedHologramId: "holo-1",
      withObject: false
    });
    const recent = await seedIntent({
      key: "incoming/done-recent.glb",
      expiresAt: new Date(now.getTime() - 2 * HOUR),
      createdAt: now,
      completedHologramId: "holo-2",
      withObject: false
    });
    await storage.putBuffer("published.glb", Buffer.from("glTF"), "model/gltf-binary");

    const result = await cleanupExpiredUploadIntents({ storage: storage as never, now });
    expect(result.completedPruned).toBe(1);
    expect(await prisma.uploadIntent.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.uploadIntent.findUnique({ where: { id: recent.id } })).not.toBeNull();
    expect(await exists(path.join(uploadsRoot, "published.glb"))).toBe(true);
  });
});
