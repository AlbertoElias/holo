import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_HOLOGRAM_BYTES, readGlbChunks, readStoredPlace } from "@holoim/contracts";
import { validateHoloimObjects } from "@holoim/objects";

import { bearer, createAuthTables, exposeMagicLinksForTests, signIn, type SessionBody } from "./fixtures/auth.js";
import { hologramGlb, MEANING, spz, spzBomb, type HologramGlbSpec } from "./fixtures/hologramGlb.js";

// hologram-budgets (docs/features/hologram-budgets.md), API side, through the
// real routes, SQLite, local storage, the processing worker and the real
// KTX2 encoder (toktx, installed by the CI setup with `ktx: "true"`); only
// the Quick Look converter process is a fixture that echoes its input.

type HologramDto = {
  id: string;
  url: string;
  sizeBytes: number;
  placeDetailUrl?: string | null;
  textureDetailUrl?: string | null;
  usdzStatus: string;
};

type Json = Record<string, unknown> & {
  nodes: Array<{ name?: string; extensions?: Record<string, unknown> }>;
  extensions?: Record<string, unknown>;
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  bufferViews: Array<{ byteOffset?: number; byteLength: number }>;
  accessors: Array<{ bufferView?: number; componentType: number; normalized?: boolean; count: number }>;
  animations: Array<{ channels: Array<{ sampler: number; target: { node: number; path: string } }>; samplers: Array<{ input: number; output: number; interpolation?: string }> }>;
  images?: Array<{ bufferView?: number; mimeType?: string }>;
  textures?: Array<{ source?: number; extensions?: Record<string, { source: number }> }>;
};

function parse(glb: Buffer): { json: Json; bin: Uint8Array; view: (index: number) => Buffer } {
  const chunks = readGlbChunks(new Uint8Array(glb));
  const json = chunks.json as unknown as Json;
  const bin = chunks.bin ?? new Uint8Array(0);
  return {
    json,
    bin,
    view: (index) => {
      const view = json.bufferViews[index]!;
      return Buffer.from(bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
    }
  };
}

function multipart(file: Buffer, fields: Record<string, string> = {}): { boundary: string; payload: Buffer } {
  const boundary = `holoim-budgets-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries({ hologramName: "Budget take", submittedBy: "Budget Tester", ...fields })) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="take.glb"\r\nContent-Type: model/gltf-binary\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  );
  return { boundary, payload: Buffer.concat(parts) };
}

// An S3-style store kept in memory, for the direct-upload (complete) route.
function fakeObjectStorage() {
  const objects = new Map<string, Buffer>();
  const storage = {
    kind: "s3" as const,
    publicUrl: (key: string) => `https://media.test/${key}`,
    putFile: async (key: string, absolutePath: string) => void objects.set(key, await readFile(absolutePath)),
    putBuffer: async (key: string, body: Buffer) => void objects.set(key, Buffer.from(body)),
    head: async (key: string) => {
      const body = objects.get(key);
      return body ? { sizeBytes: body.length, contentType: "model/gltf-binary" } : null;
    },
    readPrefix: async (key: string, length: number) => objects.get(key)?.subarray(0, length) ?? null,
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
    createPresignedPost: async (key: string) => ({ url: "https://storage.test/upload", fields: { key } })
  };
  return { objects, storage };
}

const CAP_MESSAGE = `File exceeds ${MAX_HOLOGRAM_BYTES / (1024 * 1024)}MB limit.`;

describe("hologram budgets: split, caps, processing, delete", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let testRoot: string;
  let uploadsRoot: string;
  let session: SessionBody;
  let previousDatabaseUrl: string | undefined;
  let previousUsdzPython: string | undefined;
  let restoreExpose: () => void;
  let buildAppFn: (options?: Record<string, unknown>) => FastifyInstance;
  let localStorage: unknown;
  let processNextHologram: (options: { storage: never }) => Promise<false | { id: string; report: unknown }>;
  let processNextUsdzConversion: (options: { storage: never }) => Promise<boolean>;

  const media = async () => (await readdir(uploadsRoot)).filter((name) => name !== "feed").sort();
  const stored = (url: string) => readFile(path.join(uploadsRoot, path.basename(url)));

  const upload = async (file: Buffer, fields: Record<string, string> = {}) => {
    const body = multipart(file, fields);
    return app.inject({
      method: "POST",
      url: "/api/holograms",
      headers: { "content-type": `multipart/form-data; boundary=${body.boundary}`, ...bearer(session) },
      payload: body.payload
    });
  };

  /** The direct-upload route: initiate (declaring `declared` bytes), put `file` as the incoming object, complete. */
  const direct = async (file: Buffer, declared = file.length) => {
    const { objects, storage } = fakeObjectStorage();
    const directApp = buildAppFn({ logger: false, uploadsRoot, storage });
    await directApp.ready();
    try {
      const initiate = await directApp.inject({
        method: "POST",
        url: "/api/holograms/uploads/initiate",
        headers: bearer(session),
        payload: { filenameOriginal: "take.glb", hologramName: "Direct take", submittedBy: "Budget Tester", sizeBytes: declared, mimeType: "model/gltf-binary" }
      });
      expect(initiate.statusCode, initiate.body).toBe(200);
      const intent = initiate.json<{ intentId: string; storageKey: string }>();
      await storage.putBuffer(intent.storageKey, file);
      const complete = await directApp.inject({
        method: "POST",
        url: "/api/holograms/uploads/complete",
        headers: bearer(session),
        payload: { intentId: intent.intentId }
      });
      return { complete, objects, storageKey: intent.storageKey };
    } finally {
      await directApp.close();
    }
  };

  beforeAll(async () => {
    testRoot = await mkdtemp(path.join(tmpdir(), "holoim-api-budgets-"));
    uploadsRoot = path.join(testRoot, "uploads");
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `file:${path.join(testRoot, "budgets.db")}`;
    previousUsdzPython = process.env.USDZ_PYTHON;
    // The Quick Look converter fixture writes "fixture-usdz:" and the GLB it was given.
    const converter = path.join(testRoot, "converter-fixture.cjs");
    await writeFile(
      converter,
      `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(process.argv[4], Buffer.concat([Buffer.from("fixture-usdz:"), fs.readFileSync(process.argv[3])]));
`,
      { mode: 0o755 }
    );
    process.env.USDZ_PYTHON = converter;
    restoreExpose = exposeMagicLinksForTests();

    vi.resetModules();
    const prismaModule = await import("../src/lib/prisma.js");
    prisma = prismaModule.prisma;
    await createAuthTables(prisma);
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
        "placeDetailKey" TEXT,
        "textureDetailKey" TEXT,
        "servedKey" TEXT,
        "processStatus" TEXT NOT NULL DEFAULT 'none',
        "processClaimedAt" DATETIME,
        "processClaimToken" TEXT,
        "processAttempts" INTEGER NOT NULL DEFAULT 0,
        "processError" TEXT,
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
    ({ processNextHologram } = (await import("../src/services/process-worker.js")) as never);
    ({ processNextUsdzConversion } = (await import("../src/services/usdz-worker.js")) as never);
    const { LocalMediaStorage } = await import("../src/services/media-storage.js");
    localStorage = new LocalMediaStorage(uploadsRoot);
    const { buildApp } = await import("../src/app.js");
    buildAppFn = buildApp as never;
    app = buildApp({ logger: false, uploadsRoot });
    await app.ready();
    session = await signIn(app, "budget-tester@example.com", "Budget Tester");
  }, 60_000);

  beforeEach(async () => {
    await prisma.hologram.deleteMany();
    await prisma.uploadIntent.deleteMany();
    await rm(uploadsRoot, { recursive: true, force: true });
    await mkdir(uploadsRoot, { recursive: true });
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await rm(testRoot, { recursive: true, force: true });
    restoreExpose?.();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousUsdzPython === undefined) delete process.env.USDZ_PYTHON;
    else process.env.USDZ_PYTHON = previousUsdzPython;
  });

  const light = spz(40, 0);
  const detail = spz(900, 1, 3);
  const withDetail: HologramGlbSpec = { place: { light, splatCount: 40, detail: { spz: detail, splatCount: 900, maxSh: 1 } } };

  it("splits the place's detail level into its own object on the multipart route", async () => {
    const response = await upload(hologramGlb(withDetail));
    expect(response.statusCode, response.body).toBe(201);
    const created = response.json<HologramDto>();
    expect(created.placeDetailUrl).toMatch(/-place\.spz$/);
    expect(created.textureDetailUrl).toBeNull();

    expect(await stored(created.placeDetailUrl!), "the detail SPZ is stored byte for byte").toEqual(detail);
    const lightGlb = await stored(created.url);
    expect(created.sizeBytes).toBe(lightGlb.length);
    const place = await readStoredPlace(new Uint8Array(lightGlb));
    expect(place?.detail, "the light GLB carries no detail").toBeNull();
    expect(place?.extension.detail).toBeUndefined();
    expect(Buffer.from(place!.spz)).toEqual(light);
    expect(lightGlb.length).toBeLessThan(hologramGlb(withDetail).length - detail.length + 8);
    expect(await media()).toHaveLength(2);
  });

  it("splits on the direct-upload complete route and removes the incoming object", async () => {
    const { complete, objects, storageKey } = await direct(hologramGlb(withDetail));
    expect(complete.statusCode, complete.body).toBe(201);
    const created = complete.json<HologramDto>();
    expect(created.placeDetailUrl).toMatch(/^https:\/\/media\.test\/.+-place\.spz$/);
    expect(objects.get(path.basename(created.placeDetailUrl!))).toEqual(detail);
    const place = await readStoredPlace(new Uint8Array(objects.get(path.basename(created.url))!));
    expect(place?.detail).toBeNull();
    expect(objects.has(storageKey)).toBe(false);
  });

  it("stores an upload without a detail level as uploaded", async () => {
    const file = hologramGlb({ place: { light, splatCount: 40 } });
    const created = (await upload(file)).json<HologramDto>();
    expect(created.placeDetailUrl).toBeNull();
    expect(await stored(created.url)).toEqual(file);

    const { complete, objects } = await direct(file);
    const directCreated = complete.json<HologramDto>();
    expect(directCreated.placeDetailUrl).toBeNull();
    expect(objects.get(path.basename(directCreated.url))).toEqual(file);
  });

  it("refuses a malformed detail level with the reason and stores nothing", async () => {
    const cases: Array<[string, HologramGlbSpec, RegExp]> = [
      ["gzip bomb", { place: { light, splatCount: 40, detail: { spz: spzBomb(), splatCount: 1 } } }, /decompresses past what its header allows/],
      ["count mismatch", { place: { light, splatCount: 40, detail: { spz: spz(900), splatCount: 901 } } }, /detail SPZ header says 900 splats, the extension 901/],
      ["over the detail cap", { place: { light, splatCount: 40, detail: { spz: spz(10), splatCount: 3_000_001 } } }, /detail\.splatCount is not between 1 and 3000000/]
    ];
    for (const [label, spec, reason] of cases) {
      const response = await upload(hologramGlb(spec));
      expect(response.statusCode, label).toBe(422);
      expect(response.json<{ error: string }>().error, label).toMatch(/^The hologram's stored place is malformed: /);
      expect(response.json<{ error: string }>().error, label).toMatch(reason);

      const { complete, objects } = await direct(hologramGlb(spec));
      expect(complete.statusCode, `${label} (complete)`).toBe(422);
      expect(complete.json<{ error: string }>().error, `${label} (complete)`).toMatch(reason);
      expect([...objects.keys()].filter((key) => !key.startsWith("feed/")), `${label}: nothing kept`).toEqual([]);
    }
    expect(await media()).toEqual([]);
    expect(await prisma.hologram.count()).toBe(0);
  });

  it("accepts a take of exactly the cap and refuses one byte over it, naming the cap, on both routes", async () => {
    const atCap = hologramGlb({ ...withDetail, padTo: MAX_HOLOGRAM_BYTES });
    expect(atCap.length).toBe(MAX_HOLOGRAM_BYTES);
    const overCap = Buffer.concat([atCap, Buffer.from([0])]);

    const accepted = await upload(atCap);
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(accepted.json<HologramDto>().placeDetailUrl).toMatch(/-place\.spz$/);
    const refused = await upload(overCap);
    expect(refused.statusCode).toBe(413);
    expect(refused.json()).toEqual({ error: CAP_MESSAGE });

    const directAccepted = await direct(atCap);
    expect(directAccepted.complete.statusCode, directAccepted.complete.body).toBe(201);
    // Declared at the cap, the object put one byte over it: complete names the cap.
    const directRefused = await direct(overCap, MAX_HOLOGRAM_BYTES);
    expect(directRefused.complete.statusCode).toBe(413);
    expect(directRefused.complete.json()).toEqual({ error: CAP_MESSAGE });
    expect(directRefused.objects.has(directRefused.storageKey)).toBe(false);
  }, 120_000);

  it("processing serves KTX2 textures and a reduced animation, and keeps every HOLOIM extension", async () => {
    const spec: HologramGlbSpec = { ...withDetail, texture: { width: 2048, height: 64 } };
    const original = parse(hologramGlb(spec));
    const created = (await upload(hologramGlb(spec))).json<HologramDto>();
    const storedGlb = await stored(created.url);

    const result = await processNextHologram({ storage: localStorage as never });
    expect(result && result.id).toBe(created.id);
    expect(result && result.report, "processing succeeded").not.toBeNull();
    const after = (await app.inject({ method: "GET", url: `/api/holograms/${created.id}` })).json<HologramDto>();
    expect(after.url).toMatch(/-light\.glb$/);
    expect(after.textureDetailUrl).toMatch(/-textures\.glb$/);
    expect(after.placeDetailUrl).toBe(created.placeDetailUrl);
    expect(await stored(created.url), "the stored GLB is kept, unchanged, as the Quick Look source").toEqual(storedGlb);

    const served = await stored(after.url);
    expect(after.sizeBytes).toBe(served.length);
    const processed = parse(served);
    const { json } = processed;

    // Place: the light level, unchanged.
    const place = await readStoredPlace(new Uint8Array(served));
    expect(Buffer.from(place!.spz)).toEqual(light);
    expect(place!.detail).toBeNull();
    // Meaning, objects and audio: same JSON, same bytes, same node indices.
    expect(json.extensions?.HOLOIM_meaning).toEqual(MEANING);
    const objects = validateHoloimObjects(json.extensions?.HOLOIM_objects);
    expect(objects.ok).toBe(true);
    expect(json.extensions?.HOLOIM_objects).toEqual(original.json.extensions?.HOLOIM_objects);
    expect(json.nodes.map((node) => node.name)).toEqual(original.json.nodes.map((node) => node.name));
    expect(json.nodes[4]!.name).toBe("RecordedObject");
    const audio = (json.extensions?.KHR_audio as { audio: Array<{ bufferView: number }> }).audio[0]!.bufferView;
    const originalAudio = (original.json.extensions?.KHR_audio as { audio: Array<{ bufferView: number }> }).audio[0]!.bufferView;
    expect(processed.view(audio)).toEqual(original.view(originalAudio));
    expect(json.extensionsUsed).toEqual(expect.arrayContaining(["HOLOIM_meaning", "HOLOIM_objects", "HOLOIM_place", "KHR_audio", "KHR_texture_basisu"]));

    // Textures: KTX2, downscaled to 1024.
    expect(json.images).toEqual([expect.objectContaining({ mimeType: "image/ktx2" })]);
    expect(json.textures).toEqual([{ sampler: 0, extensions: { KHR_texture_basisu: { source: 0 } } }]);
    const ktx = processed.view(json.images![0]!.bufferView!);
    expect(ktx.subarray(1, 7).toString("ascii")).toBe("KTX 20");
    expect([ktx.readUInt32LE(20), ktx.readUInt32LE(24)]).toEqual([1024, 32]);

    // Animation: rotations quantized, keys reduced, the STEP presence track as recorded.
    const clip = json.animations[0]!;
    const rotations = clip.channels.filter((channel) => channel.target.path === "rotation").map((channel) => json.accessors[clip.samplers[channel.sampler]!.output]!);
    expect(rotations.every((accessor) => accessor.componentType === 5122 && accessor.normalized === true)).toBe(true);
    const keys = clip.samplers.map((sampler) => json.accessors[sampler.input]!.count);
    expect(Math.max(...keys.slice(0, 4))).toBeLessThan(240);
    const step = clip.channels.find((channel) => channel.target.path === "scale")!;
    const stepSampler = clip.samplers[step.sampler]!;
    expect(stepSampler.interpolation).toBe("STEP");
    const originalStep = original.json.animations[0]!.samplers[original.json.animations[0]!.channels.find((channel) => channel.target.path === "scale")!.sampler]!;
    expect(processed.view(json.accessors[stepSampler.output]!.bufferView!)).toEqual(original.view(original.json.accessors[originalStep.output]!.bufferView!));
    const report = (result as { report: { animation: { world: { maxPositionErrorMm: number; maxRotationErrorDeg: number } } } }).report;
    expect(report.animation.world.maxPositionErrorMm).toBeLessThanOrEqual(1);
    expect(report.animation.world.maxRotationErrorDeg).toBeLessThanOrEqual(0.5);

    // The textures GLB: as many textures as the served GLB, in order, full size.
    const textures = parse(await stored(after.textureDetailUrl!));
    expect(textures.json.textures).toHaveLength(json.textures!.length);
    const full = textures.view(textures.json.images![textures.json.textures![0]!.extensions!.KHR_texture_basisu!.source]!.bufferView!);
    expect([full.readUInt32LE(20), full.readUInt32LE(24)]).toEqual([2048, 64]);
  }, 120_000);

  it("gives Quick Look its own input: the stored GLB without the place", async () => {
    const created = (await upload(hologramGlb({ ...withDetail, texture: { width: 64, height: 64 } }), { quickLookEnabled: "true" })).json<HologramDto>();
    expect(await processNextUsdzConversion({ storage: localStorage as never })).toBe(true);
    const usdzName = (await media()).find((name) => name.endsWith(".usdz"))!;
    const usdz = await readFile(path.join(uploadsRoot, usdzName));
    expect(usdz.subarray(0, 13).toString()).toBe("fixture-usdz:");
    const input = parse(usdz.subarray(13));
    expect(input.json.nodes.some((node) => node.extensions?.HOLOIM_place)).toBe(false);
    expect(input.json.extensionsUsed).not.toContain("HOLOIM_place");
    expect(input.json.images).toEqual([expect.objectContaining({ mimeType: "image/png" })]);
    expect(input.json.accessors.every((accessor) => accessor.componentType !== 5122), "unquantized").toBe(true);
    expect(input.json.extensions?.HOLOIM_meaning).toEqual(MEANING);
    expect((await readStoredPlace(new Uint8Array(await stored(created.url))))?.extension.splatCount, "the stored GLB keeps its place").toBe(40);
  });

  type CapReport = {
    skippedTextures: Array<{ image: number; reason: string; width?: number; height?: number }>;
    textures: unknown[];
    animation: { skipped?: string; tracks: number; reducedTracks: number };
  };
  const processOne = async (file: Buffer) => {
    const created = (await upload(file)).json<HologramDto>();
    const result = await processNextHologram({ storage: localStorage as never });
    const after = (await app.inject({ method: "GET", url: `/api/holograms/${created.id}` })).json<HologramDto>();
    return { after, report: (result as { report: CapReport }).report, served: parse(await stored(after.url)).json };
  };

  it("keeps a texture over the pixel cap as uploaded instead of encoding it", async () => {
    // 8192 x 2049 is just over 4096 x 4096 pixels.
    const { after, report, served } = await processOne(hologramGlb({ texture: { width: 8192, height: 2049 } }));
    expect(report.skippedTextures).toEqual([{ image: 0, reason: "too-large", width: 8192, height: 2049 }]);
    expect(report.textures).toEqual([]);
    expect(served.images).toEqual([expect.objectContaining({ mimeType: "image/png" })]);
    expect(served.textures).toEqual([{ source: 0, sampler: 0 }]);
    expect(served.extensionsUsed).not.toContain("KHR_texture_basisu");
    expect(after.textureDetailUrl).toBeNull();
    expect(report.animation.reducedTracks, "the animation is still reduced").toBe(4);
  }, 120_000);

  it("keeps a texture the encoder refuses as uploaded and still processes the rest", async () => {
    // A PNG whose header reads but whose pixel data is corrupt: toktx exits non-zero.
    const glb = hologramGlb({ texture: { width: 2048, height: 2048 } });
    const idat = glb.indexOf("IDAT");
    expect(idat, "the fixture's PNG has pixel data").toBeGreaterThan(0);
    glb.fill(0xa5, idat + 8, idat + 72);
    const { after, report, served } = await processOne(glb);
    expect(report, "one bad image does not fail the job").not.toBeNull();
    expect(after.url).toMatch(/-light\.glb$/);
    expect(report.skippedTextures).toEqual([{ image: 0, reason: "encode-failed", width: 2048, height: 2048 }]);
    expect(served.images).toEqual([expect.objectContaining({ mimeType: "image/png" })]);
    expect(served.extensionsUsed).not.toContain("KHR_texture_basisu");
    expect(after.textureDetailUrl).toBeNull();
    expect(report.animation.reducedTracks, "the animation is still reduced").toBe(4);
  }, 120_000);

  it("reduces a long LINEAR scale track without overflowing the stack", async () => {
    // 60 000 keys x 3 values: spreading them into Math.max overflows the call stack.
    const { after, report } = await processOne(
      hologramGlb({
        frames: 60_000,
        mutate: (json) => {
          for (const sampler of json.animations[0]!.samplers as Array<{ interpolation?: string }>) sampler.interpolation = "LINEAR";
        }
      })
    );
    expect(report, "the job finished").not.toBeNull();
    expect(after.url).toMatch(/-light\.glb$/);
    expect(report.animation.skipped).toBeUndefined();
    expect(report.animation.reducedTracks).toBe(5);
  }, 240_000);

  it("serves the animation as recorded when its key count is over the cap", async () => {
    const { report, served } = await processOne(
      hologramGlb({ mutate: (json) => void (json.accessors[json.animations[0]!.samplers[0]!.input]!.count = 4_000_001) })
    );
    expect(report.animation.skipped).toBe("too-many-keys");
    expect(report.animation.reducedTracks).toBe(0);
    expect(served.accessors.every((accessor) => accessor.componentType === 5126), "nothing quantized").toBe(true);
    expect(served.accessors[served.animations[0]!.samplers[0]!.input]!.count).toBe(4_000_001);
  });

  it("leaves a track whose accessor runs past its buffer view as recorded, and reduces the rest", async () => {
    const { report, served } = await processOne(
      hologramGlb({ mutate: (json) => void (json.accessors[json.animations[0]!.samplers[0]!.output]!.count = 241) })
    );
    expect(report.animation.skipped).toBeUndefined();
    expect(report.animation.reducedTracks).toBe(3);
    const translation = served.accessors[served.animations[0]!.samplers[0]!.output]!;
    expect([translation.componentType, translation.count]).toEqual([5126, 241]);
  });

  it("delete removes the place detail, the textures and the processed GLB", async () => {
    const created = (await upload(hologramGlb({ ...withDetail, texture: { width: 2048, height: 16 } }))).json<HologramDto>();
    await processNextHologram({ storage: localStorage as never });
    expect(await media()).toHaveLength(4);
    const response = await app.inject({ method: "DELETE", url: `/api/holograms/${created.id}`, headers: bearer(session) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: created.id, deletedFile: true, deletedUsdz: false, deletedDetail: true });
    expect(await media()).toEqual([]);
  }, 120_000);
});
