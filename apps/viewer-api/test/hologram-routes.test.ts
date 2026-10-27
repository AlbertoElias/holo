import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type HologramDto = {
  id: string;
  url: string;
  usdzUrl: string | null;
  quickLookEnabled: boolean;
  filenameOriginal: string;
  hologramName: string;
  submittedBy: string;
  sizeBytes: number;
};

type PaginatedHolograms = {
  items: HologramDto[];
  nextCursor: string | null;
};

function multipartUpload(input: {
  filename?: string;
  hologramName: string;
  submittedBy: string;
  file: Buffer;
  fileFirst?: boolean;
  quickLookEnabled?: boolean;
}): { boundary: string; payload: Buffer } {
  const boundary = `holoim-route-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  const addField = (name: string, value: string) => {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      )
    );
  };

  if (!input.fileFirst) {
    addField("hologramName", input.hologramName);
    addField("submittedBy", input.submittedBy);
    if (input.quickLookEnabled !== undefined) {
      addField("quickLookEnabled", String(input.quickLookEnabled));
    }
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${input.filename ?? "avatar.glb"}"\r\n` +
        "Content-Type: model/gltf-binary\r\n\r\n"
    ),
    input.file,
    Buffer.from("\r\n")
  );
  if (input.fileFirst) {
    addField("hologramName", input.hologramName);
    addField("submittedBy", input.submittedBy);
    if (input.quickLookEnabled !== undefined) {
      addField("quickLookEnabled", String(input.quickLookEnabled));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return { boundary, payload: Buffer.concat(chunks) };
}

// The feed snapshot (feed/latest.json) lives beside the media; these checks count media only.
async function mediaObjects(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => name !== "feed");
}

async function feedSnapshotIds(root: string): Promise<string[]> {
  const snapshot = JSON.parse(await readFile(path.join(root, "feed", "latest.json"), "utf8")) as { items: { id: string; ownedByViewer: boolean }[] };
  expect(snapshot.items.every((item) => !item.ownedByViewer), "the snapshot is the anonymous page").toBe(true);
  return snapshot.items.map((item) => item.id);
}

async function uploadHologram(
  app: FastifyInstance,
  input: { hologramName: string; submittedBy?: string; file?: Buffer; quickLookEnabled?: boolean }
): Promise<HologramDto> {
  const multipart = multipartUpload({
    hologramName: input.hologramName,
    submittedBy: input.submittedBy ?? "Route Tester",
    file: input.file ?? Buffer.from("route-test-glb"),
    ...(input.quickLookEnabled !== undefined ? { quickLookEnabled: input.quickLookEnabled } : {})
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/holograms",
    headers: {
      "content-type": `multipart/form-data; boundary=${multipart.boundary}`
    },
    payload: multipart.payload
  });

  expect(response.statusCode).toBe(201);
  return response.json<HologramDto>();
}

describe("hologram routes", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let testRoot: string;
  let uploadsRoot: string;
  let previousDatabaseUrl: string | undefined;
  let previousUsdzPython: string | undefined;
  let converterControl: string;
  let usdzFilenameFor: (filename: string) => string;
  let processNextUsdzConversion: (options: { storage: never }) => Promise<boolean>;
  let buildAppFn: (options?: Record<string, unknown>) => FastifyInstance;
  let LocalMediaStorage: new (root: string) => unknown;
  const runWorkerOnce = async () => {
    const storage = new LocalMediaStorage(uploadsRoot);
    await processNextUsdzConversion({ storage: storage as never });
  };

  beforeAll(async () => {
    testRoot = await mkdtemp(path.join(tmpdir(), "holoim-api-routes-"));
    uploadsRoot = path.join(testRoot, "uploads");
    const databaseUrl = `file:${path.join(testRoot, "routes.db")}`;
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrl;
    previousUsdzPython = process.env.USDZ_PYTHON;
    converterControl = path.join(testRoot, "converter-control");
    const converterExecutable = path.join(testRoot, "converter-fixture.cjs");
    // Substitute only the external converter process. Routes, subprocess execution,
    // cache publication, upload storage, and SQLite are real in these lifecycle
    // checks; capture-to-viewer E2E separately verifies actual USD fidelity.
    await writeFile(converterExecutable, `#!${process.execPath}
const fs = require("node:fs/promises");
const path = require("node:path");
const control = ${JSON.stringify(converterControl)};
const exists = (name) => fs.access(path.join(control, name)).then(() => true, () => false);
(async () => {
  const source = await fs.readFile(process.argv[3]);
  await fs.appendFile(path.join(control, "calls"), "convert\\n");
  await fs.writeFile(path.join(control, "started"), "started");
  while (await exists("hold")) await new Promise((resolve) => setTimeout(resolve, 10));
  await fs.writeFile(process.argv[4], Buffer.concat([Buffer.from("fixture-usdz:"), source]));
  if (await exists("fail")) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
`, { mode: 0o755 });
    process.env.USDZ_PYTHON = converterExecutable;

    vi.resetModules();
    ({ usdzFilenameFor } = await import("../src/services/usdz-converter.js"));
    ({ processNextUsdzConversion } = await import("../src/services/usdz-worker.js"));
    ({ LocalMediaStorage } = await import("../src/services/media-storage.js"));
    const prismaModule = await import("../src/lib/prisma.js");
    prisma = prismaModule.prisma;
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
      )
    `);
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
    await prisma.$executeRawUnsafe(
      `CREATE INDEX "Hologram_createdAt_idx" ON "Hologram"("createdAt" DESC)`
    );

    const { buildApp } = await import("../src/app.js");
    buildAppFn = buildApp as never;
    app = buildApp({ logger: false, uploadsRoot });
    await app.ready();
  });

  beforeEach(async () => {
    await prisma.hologram.deleteMany();
    await rm(uploadsRoot, { recursive: true, force: true });
    await mkdir(uploadsRoot, { recursive: true });
    await rm(converterControl, { recursive: true, force: true });
    await mkdir(converterControl);
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await rm(testRoot, { recursive: true, force: true });

    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    if (previousUsdzPython === undefined) {
      delete process.env.USDZ_PYTHON;
    } else {
      process.env.USDZ_PYTHON = previousUsdzPython;
    }
  });

  it("uploads a GLB and serves the stored bytes", async () => {
    const file = Buffer.from("inspectable-glb-route-artifact");
    const created = await uploadHologram(app, {
      hologramName: "Route upload",
      submittedBy: "API route test",
      file
    });

    expect(created).toMatchObject({
      filenameOriginal: "avatar.glb",
      hologramName: "Route upload",
      submittedBy: "API route test",
      sizeBytes: file.length,
      usdzUrl: null,
      quickLookEnabled: false
    });
    expect(await readFile(path.join(uploadsRoot, path.basename(created.url)))).toEqual(file);

    const served = await app.inject({ method: "GET", url: created.url });
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload).toEqual(file);
  });

  it("does not generate USDZ when Quick Look was not enabled at upload", async () => {
    const created = await uploadHologram(app, { hologramName: "No Quick Look" });
    expect(created.quickLookEnabled).toBe(false);
    expect(created.usdzUrl).toBeNull();

    const response = await app.inject({ method: "GET", url: `/api/holograms/${created.id}/usdz` });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Quick Look is not enabled for this hologram." });
    // No conversion ran and no USDZ file was published.
    await expect(access(path.join(converterControl, "calls"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await mediaObjects(uploadsRoot)).toEqual([path.basename(created.url)]);
    await expect(prisma.hologram.findUnique({ where: { id: created.id } })).resolves.toMatchObject({
      quickLookEnabled: false,
      usdzPath: null
    });
  });

  it("converts after an opted-in upload, stores the USDZ, and reuses it without reconverting", async () => {
    const source = Buffer.from("quicklook-enabled-capture");
    const created = await uploadHologram(app, {
      hologramName: "Quick Look demo",
      file: source,
      quickLookEnabled: true
    });
    const glbFilename = path.basename(created.url);
    const currentFilename = usdzFilenameFor(glbFilename);
    const expectedUsdz = Buffer.concat([Buffer.from("fixture-usdz:"), source]);

    // Opted in: conversion is queued at upload, not performed inline.
    expect(created.quickLookEnabled).toBe(true);
    expect(created.usdzStatus).toBe("pending");
    expect(created.usdzUrl).toBeNull();

    await runWorkerOnce();
    expect(await readFile(path.join(uploadsRoot, currentFilename))).toEqual(expectedUsdz);
    expect(await readFile(path.join(converterControl, "calls"), "utf8")).toBe("convert\n");
    await expect(prisma.hologram.findUnique({ where: { id: created.id } })).resolves.toMatchObject({
      quickLookEnabled: true,
      usdzStatus: "ready",
      usdzPath: `uploads/${currentFilename}`
    });

    const response = await app.inject({ method: "GET", url: `/api/holograms/${created.id}/usdz` });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`/uploads/${currentFilename}`);
    const served = await app.inject({ method: "GET", url: response.headers.location! });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toContain("model/vnd.usdz+zip");
    expect(served.rawPayload).toEqual(expectedUsdz);

    // Reuse: a second request serves the same stored bytes, no new conversion.
    expect((await app.inject({ method: "GET", url: `/api/holograms/${created.id}/usdz` })).statusCode).toBe(302);
    expect(await readFile(path.join(converterControl, "calls"), "utf8")).toBe("convert\n");

    const fetched = await app.inject({ method: "GET", url: `/api/holograms/${created.id}` });
    expect(fetched.json<HologramDto>()).toMatchObject({
      quickLookEnabled: true,
      usdzUrl: `/uploads/${currentFilename}`
    });
  });

  it("uploads a streamed 2MB file before its trailing form fields", async () => {
    const file = Buffer.alloc(2 * 1024 * 1024, 0x6b);
    const { boundary, payload } = multipartUpload({
      hologramName: "File-first streaming upload",
      submittedBy: "Pipeline upload transport",
      file,
      fileFirst: true
    });
    const chunks = function* () {
      for (let offset = 0; offset < payload.length; offset += 16 * 1024) {
        yield payload.subarray(offset, offset + 16 * 1024);
      }
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/holograms",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Readable.from(chunks())
    });
    expect(response.statusCode, response.body).toBe(201);
    const created = response.json<HologramDto>();
    expect(created).toMatchObject({
      hologramName: "File-first streaming upload",
      submittedBy: "Pipeline upload transport",
      sizeBytes: file.length
    });
    expect((await readFile(path.join(uploadsRoot, path.basename(created.url)))).equals(file)).toBe(true);
  });

  it("paginates without duplicates and returns a stable end cursor", async () => {
    const created = [];
    for (const name of ["Pagination one", "Pagination two", "Pagination three"]) {
      created.push(await uploadHologram(app, { hologramName: name }));
    }

    const firstResponse = await app.inject({
      method: "GET",
      url: "/api/holograms?limit=2"
    });
    expect(firstResponse.statusCode).toBe(200);
    const firstPage = firstResponse.json<PaginatedHolograms>();
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).toBe(firstPage.items[1]?.id);

    const secondResponse = await app.inject({
      method: "GET",
      url: `/api/holograms?limit=2&cursor=${firstPage.nextCursor}`
    });
    expect(secondResponse.statusCode).toBe(200);
    const secondPage = secondResponse.json<PaginatedHolograms>();
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();

    const pagedIds = [...firstPage.items, ...secondPage.items].map((item) => item.id);
    expect(new Set(pagedIds)).toEqual(new Set(created.map((item) => item.id)));
  });

  it("deletes the database record and both stored representations", async () => {
    const created = await uploadHologram(app, { hologramName: "Delete route", quickLookEnabled: true });
    expect(await feedSnapshotIds(uploadsRoot), "an upload is in the feed snapshot at once").toEqual([created.id]);
    await runWorkerOnce();
    const glbPath = path.join(uploadsRoot, path.basename(created.url));
    const usdzPath = path.join(uploadsRoot, usdzFilenameFor(path.basename(created.url)));

    const response = await app.inject({
      method: "DELETE",
      url: `/api/holograms/${created.id}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: created.id,
      deletedFile: true,
      deletedUsdz: true
    });
    await expect(access(glbPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(usdzPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(prisma.hologram.findUnique({ where: { id: created.id } })).resolves.toBeNull();
    expect(await feedSnapshotIds(uploadsRoot), "a delete leaves the feed snapshot at once").toEqual([]);

    const getResponse = await app.inject({ method: "GET", url: `/api/holograms/${created.id}` });
    expect(getResponse.statusCode).toBe(404);
  });

  it("converts asynchronously: upload is pending, worker publishes, endpoint redirects", async () => {
    const source = Buffer.from("async-capture-for-conversion");
    const created = await uploadHologram(app, { hologramName: "Async lifecycle", file: source, quickLookEnabled: true });
    expect(created.usdzStatus).toBe("pending");
    expect(created.usdzUrl).toBeNull();
    const glbFilename = path.basename(created.url);
    const currentFilename = usdzFilenameFor(glbFilename);
    const currentPath = path.join(uploadsRoot, currentFilename);
    const requestPreview = () => app.inject({ method: "GET", url: `/api/holograms/${created.id}/usdz` });

    const waiting = await requestPreview();
    expect(waiting.statusCode).toBe(202);
    expect(waiting.headers["retry-after"]).toBe("5");
    expect(waiting.json()).toEqual({ id: created.id, usdzStatus: "pending", usdzUrl: null });

    await runWorkerOnce();

    await expect(prisma.hologram.findUnique({ where: { id: created.id } })).resolves.toMatchObject({
      usdzStatus: "ready",
      usdzPath: `uploads/${currentFilename}`
    });
    const converted = await requestPreview();
    expect(converted.statusCode).toBe(302);
    expect(converted.headers.location).toBe(`/uploads/${currentFilename}`);
    const served = await app.inject({ method: "GET", url: converted.headers.location! });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toContain("model/vnd.usdz+zip");
    expect(served.rawPayload).toEqual(Buffer.concat([Buffer.from("fixture-usdz:"), source]));

    // Ready path reuses the published object; a missing object re-enqueues.
    expect((await requestPreview()).statusCode).toBe(302);
    expect(await readFile(path.join(converterControl, "calls"), "utf8")).toBe("convert\n");

    await rm(currentPath);
    const repair = await requestPreview();
    expect(repair.statusCode).toBe(202);
    await runWorkerOnce();
    expect((await requestPreview()).statusCode).toBe(302);
    expect(await readFile(path.join(converterControl, "calls"), "utf8")).toBe("convert\nconvert\n");
    expect(await readFile(path.join(uploadsRoot, glbFilename))).toEqual(source);
  });

  it("marks failed conversions, preserves the GLB, and re-enqueues on request", async () => {
    const source = Buffer.from("retryable-original-capture");
    const created = await uploadHologram(app, { hologramName: "Conversion failure", file: source, quickLookEnabled: true });
    const glbFilename = path.basename(created.url);
    await writeFile(path.join(converterControl, "fail"), "fail after writing partial output");

    await runWorkerOnce();
    await expect(prisma.hologram.findUnique({ where: { id: created.id } })).resolves.toMatchObject({
      usdzStatus: "failed",
      usdzPath: null
    });
    expect(await readFile(path.join(uploadsRoot, glbFilename))).toEqual(source);
    expect(await mediaObjects(uploadsRoot)).toEqual([glbFilename]);

    await rm(path.join(converterControl, "fail"));
    const retried = await app.inject({ method: "GET", url: `/api/holograms/${created.id}/usdz` });
    expect(retried.statusCode).toBe(202);
    await runWorkerOnce();
    const ready = await app.inject({ method: "GET", url: `/api/holograms/${created.id}/usdz` });
    expect(ready.statusCode).toBe(302);
    const served = await app.inject({ method: "GET", url: ready.headers.location! });
    expect(served.rawPayload).toEqual(Buffer.concat([Buffer.from("fixture-usdz:"), source]));
  });

  it("deleting during conversion does not resurrect the record or leave objects", async () => {
    const created = await uploadHologram(app, { hologramName: "Delete during conversion", quickLookEnabled: true });
    const workerRun = runWorkerOnce();
    const deletion = await app.inject({ method: "DELETE", url: `/api/holograms/${created.id}` });
    expect(deletion.statusCode).toBe(200);
    await workerRun;
    await delay(50);
    expect(await mediaObjects(uploadsRoot)).toEqual([]);
    await expect(prisma.hologram.findUnique({ where: { id: created.id } })).resolves.toBeNull();
    expect((await app.inject({ method: "GET", url: `/api/holograms/${created.id}/usdz` })).statusCode).toBe(404);
  });

  it("Quick Look is opt-in: disabled holograms never convert and the endpoint 404s", async () => {
    const created = await uploadHologram(app, { hologramName: "No Quick Look" });
    expect(created.quickLookEnabled).toBe(false);
    expect(created.usdzStatus).toBe("none");
    expect(created.usdzUrl).toBeNull();
    const response = await app.inject({ method: "GET", url: `/api/holograms/${created.id}/usdz` });
    expect(response.statusCode).toBe(404);
    // The worker has nothing to claim for this record.
    await runWorkerOnce();
    await expect(prisma.hologram.findUnique({ where: { id: created.id } })).resolves.toMatchObject({
      usdzStatus: "none",
      usdzPath: null
    });
  });

  it("direct upload completes only for a valid GLB object and is idempotent", async () => {
    const { LocalMediaStorage: StorageClass } = await import("../src/services/media-storage.js");
    void StorageClass;
    // Local driver advertises the multipart fallback.
    const initiateLocal = await app.inject({
      method: "POST",
      url: "/api/holograms/uploads/initiate",
      payload: {
        filenameOriginal: "avatar.glb",
        hologramName: "Direct local",
        submittedBy: "Route Tester",
        sizeBytes: 12,
        mimeType: "model/gltf-binary"
      }
    });
    expect(initiateLocal.statusCode).toBe(200);
    expect(initiateLocal.json()).toEqual({ mode: "multipart" });
  });

  it("direct upload via object storage validates, completes, and replays idempotently", async () => {
    const objects = new Map<string, Buffer>();
    const fakeStorage = {
      kind: "s3" as const,
      publicUrl: (key: string) => `https://media.test/${key}`,
      putFile: async (key: string, absolutePath: string) => {
        objects.set(key, await readFile(absolutePath));
      },
      putBuffer: async (key: string, body: Buffer) => {
        objects.set(key, Buffer.from(body));
      },
      head: async (key: string) => {
        const body = objects.get(key);
        return body ? { sizeBytes: body.length, contentType: "model/gltf-binary" } : null;
      },
      readPrefix: async (key: string, length: number) => {
        const body = objects.get(key);
        return body ? body.subarray(0, length) : null;
      },
      copy: async (sourceKey: string, destKey: string) => {
        const body = objects.get(sourceKey);
        if (!body) throw new Error("missing source");
        objects.set(destKey, body);
      },
      delete: async (key: string) => objects.delete(key),
      downloadToFile: async (key: string, absolutePath: string) => {
        const body = objects.get(key);
        if (!body) throw new Error("missing object");
        await writeFile(absolutePath, body);
      },
      createPresignedPost: async (key: string) => ({
        url: "https://storage.test/upload",
        fields: { key }
      })
    };
    const fakeApp = buildAppFn({ logger: false, uploadsRoot, storage: fakeStorage });
    await fakeApp.ready();
    try {
      const glb = Buffer.concat([Buffer.from("glTF"), Buffer.from("direct-bytes")]);
      const initiate = await fakeApp.inject({
        method: "POST",
        url: "/api/holograms/uploads/initiate",
        payload: {
          filenameOriginal: "avatar.glb",
          hologramName: "Direct upload",
          submittedBy: "Route Tester",
          sizeBytes: glb.length,
          mimeType: "model/gltf-binary",
          quickLookEnabled: true
        }
      });
      expect(initiate.statusCode).toBe(200);
      const intent = initiate.json<{ mode: string; intentId: string; storageKey: string }>();
      expect(intent.mode).toBe("direct");

      // Complete before the object exists is retryable, not destructive.
      const early = await fakeApp.inject({
        method: "POST",
        url: "/api/holograms/uploads/complete",
        payload: { intentId: intent.intentId }
      });
      expect(early.statusCode).toBe(409);

      await fakeStorage.putBuffer(intent.storageKey, glb, "model/gltf-binary");
      const complete = await fakeApp.inject({
        method: "POST",
        url: "/api/holograms/uploads/complete",
        payload: { intentId: intent.intentId }
      });
      expect(complete.statusCode, complete.body).toBe(201);
      const created = complete.json<HologramDto>();
      expect(created.url).toMatch(/^https:\/\/media\.test\/.+\.glb$/);
      expect(created.usdzStatus).toBe("pending");
      expect(objects.has(intent.storageKey)).toBe(false);

      const replay = await fakeApp.inject({
        method: "POST",
        url: "/api/holograms/uploads/complete",
        payload: { intentId: intent.intentId }
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json<HologramDto>().id).toBe(created.id);

      // A non-GLB object is rejected and removed.
      const badInitiate = await fakeApp.inject({
        method: "POST",
        url: "/api/holograms/uploads/initiate",
        payload: {
          filenameOriginal: "evil.glb",
          hologramName: "Bad bytes",
          submittedBy: "Route Tester",
          sizeBytes: 8,
          mimeType: "model/gltf-binary"
        }
      });
      const badIntent = badInitiate.json<{ intentId: string; storageKey: string }>();
      await fakeStorage.putBuffer(badIntent.storageKey, Buffer.from("not-a-glb"), "model/gltf-binary");
      const badComplete = await fakeApp.inject({
        method: "POST",
        url: "/api/holograms/uploads/complete",
        payload: { intentId: badIntent.intentId }
      });
      expect(badComplete.statusCode).toBe(422);
      expect(objects.has(badIntent.storageKey)).toBe(false);
    } finally {
      await fakeApp.close();
    }
  });
});

