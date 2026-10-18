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
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return { boundary, payload: Buffer.concat(chunks) };
}

async function uploadHologram(
  app: FastifyInstance,
  input: { hologramName: string; submittedBy?: string; file?: Buffer }
): Promise<HologramDto> {
  const multipart = multipartUpload({
    hologramName: input.hologramName,
    submittedBy: input.submittedBy ?? "Route Tester",
    file: input.file ?? Buffer.from("route-test-glb")
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
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await prisma.$executeRawUnsafe(
      `CREATE INDEX "Hologram_createdAt_idx" ON "Hologram"("createdAt" DESC)`
    );

    const { buildApp } = await import("../src/app.js");
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
      usdzUrl: null
    });
    expect(await readFile(path.join(uploadsRoot, path.basename(created.url)))).toEqual(file);

    const served = await app.inject({ method: "GET", url: created.url });
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload).toEqual(file);
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
    const created = await uploadHologram(app, { hologramName: "Delete route" });
    const glbPath = path.join(uploadsRoot, path.basename(created.url));
    const usdzFilename = path.basename(created.url).replace(/\.glb$/i, ".usdz");
    const usdzPath = path.join(uploadsRoot, usdzFilename);
    await writeFile(usdzPath, "route-test-usdz");
    await prisma.hologram.update({
      where: { id: created.id },
      data: { usdzPath: `uploads/${usdzFilename}` }
    });

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

    const getResponse = await app.inject({ method: "GET", url: `/api/holograms/${created.id}` });
    expect(getResponse.statusCode).toBe(404);
  });

  it("replaces an obsolete preview, reuses the current cache, and repairs a missing cache", async () => {
    const source = Buffer.from("original-capture-for-cache-repair");
    const created = await uploadHologram(app, { hologramName: "Cache lifecycle", file: source });
    const glbFilename = path.basename(created.url);
    const obsoleteFilename = glbFilename.replace(/\.glb$/i, ".usdz");
    const obsoletePath = path.join(uploadsRoot, obsoleteFilename);
    const currentFilename = usdzFilenameFor(glbFilename);
    const currentPath = path.join(uploadsRoot, currentFilename);
    await writeFile(obsoletePath, "obsolete-preview");
    await prisma.hologram.update({
      where: { id: created.id },
      data: { usdzPath: `uploads/${obsoleteFilename}` }
    });
    const requestPreview = () => app.inject({ method: "GET", url: `/api/holograms/${created.id}/usdz` });

    const converted = await requestPreview();
    expect(converted.statusCode).toBe(302);
    expect(converted.headers.location).toBe(`/uploads/${currentFilename}`);
    expect(converted.headers["cache-control"]).toBe("no-store");
    const served = await app.inject({ method: "GET", url: converted.headers.location! });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toContain("model/vnd.usdz+zip");
    expect(served.rawPayload).toEqual(Buffer.concat([Buffer.from("fixture-usdz:"), source]));
    await expect(access(obsoletePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(prisma.hologram.findUnique({ where: { id: created.id } })).resolves.toMatchObject({
      usdzPath: `uploads/${currentFilename}`
    });

    expect((await requestPreview()).statusCode).toBe(302);
    expect(await readFile(path.join(converterControl, "calls"), "utf8")).toBe("convert\n");
    await rm(currentPath);
    expect((await requestPreview()).statusCode).toBe(302);
    expect(await readFile(currentPath)).toEqual(served.rawPayload);
    expect(await readFile(path.join(converterControl, "calls"), "utf8")).toBe("convert\nconvert\n");
    expect(await readFile(path.join(uploadsRoot, glbFilename))).toEqual(source);
  });

  it("discards failed partial output, preserves the GLB, and succeeds on retry", async () => {
    const source = Buffer.from("retryable-original-capture");
    const created = await uploadHologram(app, { hologramName: "Conversion failure", file: source });
    const glbFilename = path.basename(created.url);
    await writeFile(path.join(converterControl, "fail"), "fail after writing partial output");

    const response = await app.inject({
      method: "GET",
      url: `/api/holograms/${created.id}/usdz`
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "USDZ conversion temporarily unavailable." });
    await expect(prisma.hologram.findUnique({ where: { id: created.id } })).resolves.toMatchObject({
      id: created.id,
      usdzPath: null
    });
    expect(await readFile(path.join(uploadsRoot, glbFilename))).toEqual(source);
    expect(await readdir(uploadsRoot)).toEqual([glbFilename]);

    await rm(path.join(converterControl, "fail"));
    const retried = await app.inject({ method: "GET", url: `/api/holograms/${created.id}/usdz` });
    expect(retried.statusCode).toBe(302);
    const served = await app.inject({ method: "GET", url: retried.headers.location! });
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload).toEqual(Buffer.concat([Buffer.from("fixture-usdz:"), source]));
    expect((await readdir(uploadsRoot)).sort()).toEqual([glbFilename, usdzFilenameFor(glbFilename)].sort());
  });

  it("waits for in-flight conversion before deleting both representations", async () => {
    const created = await uploadHologram(app, { hologramName: "Delete during conversion" });
    await writeFile(path.join(converterControl, "hold"), "hold conversion before publication");
    const conversion = app.inject({ method: "GET", url: `/api/holograms/${created.id}/usdz` }).then((response) => response);
    let deletion: ReturnType<typeof app.inject> | undefined;
    try {
      await expect.poll(async () => access(path.join(converterControl, "started")).then(() => true, () => false)).toBe(true);
      deletion = app.inject({ method: "DELETE", url: `/api/holograms/${created.id}` });
      const first = await Promise.race([
        deletion.then(() => "deleted"),
        delay(100).then(() => "conversion still running")
      ]);
      expect(first).toBe("conversion still running");
    } finally {
      await rm(path.join(converterControl, "hold"), { force: true });
      await conversion;
      if (deletion) await deletion;
    }
    expect((await conversion).statusCode).toBe(302);
    expect((await deletion!).statusCode).toBe(200);
    expect(await readdir(uploadsRoot)).toEqual([]);
    await expect(prisma.hologram.findUnique({ where: { id: created.id } })).resolves.toBeNull();
    expect((await app.inject({ method: "GET", url: `/api/holograms/${created.id}/usdz` })).statusCode).toBe(404);
  });
});
