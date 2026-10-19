import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
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
        "quickLookEnabled" BOOLEAN NOT NULL DEFAULT false,
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
    expect(await readdir(uploadsRoot)).toEqual([path.basename(created.url)]);
    await expect(prisma.hologram.findUnique({ where: { id: created.id } })).resolves.toMatchObject({
      quickLookEnabled: false,
      usdzPath: null
    });
  });

  it("converts at upload, stores the USDZ, and reuses it without reconverting", async () => {
    const source = Buffer.from("quicklook-enabled-capture");
    const created = await uploadHologram(app, {
      hologramName: "Quick Look demo",
      file: source,
      quickLookEnabled: true
    });
    const glbFilename = path.basename(created.url);
    const currentFilename = usdzFilenameFor(glbFilename);
    const expectedUsdz = Buffer.concat([Buffer.from("fixture-usdz:"), source]);

    // Conversion already happened during the upload request.
    expect(created.quickLookEnabled).toBe(true);
    expect(created.usdzUrl).toBe(`/uploads/${currentFilename}`);
    expect(await readFile(path.join(uploadsRoot, currentFilename))).toEqual(expectedUsdz);
    expect(await readFile(path.join(converterControl, "calls"), "utf8")).toBe("convert\n");
    await expect(prisma.hologram.findUnique({ where: { id: created.id } })).resolves.toMatchObject({
      quickLookEnabled: true,
      usdzPath: `uploads/${currentFilename}`
    });

    const response = await app.inject({ method: "GET", url: `/api/holograms/${created.id}/usdz` });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(created.usdzUrl);
    expect(response.headers["cache-control"]).toBe("no-store");
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
      usdzUrl: created.usdzUrl
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
    const glbPath = path.join(uploadsRoot, path.basename(created.url));
    const usdzPath = path.join(uploadsRoot, path.basename(created.usdzUrl!));

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

  it("does not regenerate a missing stored USDZ package", async () => {
    const source = Buffer.from("original-capture-for-stored-preview");
    const created = await uploadHologram(app, { hologramName: "Stored preview", file: source, quickLookEnabled: true });
    const glbFilename = path.basename(created.url);
    const currentPath = path.join(uploadsRoot, usdzFilenameFor(glbFilename));
    expect(await readFile(path.join(converterControl, "calls"), "utf8")).toBe("convert\n");

    await rm(currentPath);
    const response = await app.inject({ method: "GET", url: `/api/holograms/${created.id}/usdz` });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Quick Look preview is not available for this hologram." });
    // Still missing and still only the one upload-time conversion.
    await expect(access(currentPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(converterControl, "calls"), "utf8")).toBe("convert\n");
    expect(await readFile(path.join(uploadsRoot, glbFilename))).toEqual(source);
  });

  it("fails the upload when conversion fails, leaves nothing behind, and succeeds on retry", async () => {
    const source = Buffer.from("retryable-original-capture");
    await writeFile(path.join(converterControl, "fail"), "fail after writing partial output");
    const failing = multipartUpload({
      hologramName: "Conversion failure",
      submittedBy: "Route Tester",
      file: source,
      quickLookEnabled: true
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/holograms",
      headers: { "content-type": `multipart/form-data; boundary=${failing.boundary}` },
      payload: failing.payload
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "USDZ conversion temporarily unavailable." });
    // No hologram record, no GLB, and no partial USDZ are left behind.
    await expect(prisma.hologram.findMany()).resolves.toEqual([]);
    expect(await readdir(uploadsRoot)).toEqual([]);

    await rm(path.join(converterControl, "fail"));
    const created = await uploadHologram(app, {
      hologramName: "Conversion failure",
      file: source,
      quickLookEnabled: true
    });
    expect(created.usdzUrl).toBe(`/uploads/${usdzFilenameFor(path.basename(created.url))}`);
    const served = await app.inject({ method: "GET", url: created.usdzUrl! });
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload).toEqual(Buffer.concat([Buffer.from("fixture-usdz:"), source]));
    expect((await readdir(uploadsRoot)).sort()).toEqual(
      [path.basename(created.url), usdzFilenameFor(path.basename(created.url))].sort()
    );
  });
});
