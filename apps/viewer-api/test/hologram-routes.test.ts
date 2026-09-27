import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

  addField("hologramName", input.hologramName);
  addField("submittedBy", input.submittedBy);
  chunks.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${input.filename ?? "avatar.glb"}"\r\n` +
        "Content-Type: model/gltf-binary\r\n\r\n"
    ),
    input.file,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  );

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

  beforeAll(async () => {
    testRoot = await mkdtemp(path.join(tmpdir(), "holoim-api-routes-"));
    uploadsRoot = path.join(testRoot, "uploads");
    const databaseUrl = `file:${path.join(testRoot, "routes.db")}`;
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrl;

    vi.resetModules();
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

  it("returns a retryable response and preserves the record when USDZ conversion fails", async () => {
    const created = await uploadHologram(app, { hologramName: "Conversion failure" });
    await rm(path.join(uploadsRoot, path.basename(created.url)));

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
  });
});
