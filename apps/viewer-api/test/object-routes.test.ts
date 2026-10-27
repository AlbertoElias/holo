import { NodeIO, getBounds } from "@gltf-transform/core";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { objectSearchResponseSchema } from "@holoim/contracts";
import { HOLOIM_CREDIT_EXTRAS_KEY, objectCreditSchema } from "@holoim/objects";

import { startPolyhavenFixture, type PolyhavenFixture } from "./fixtures/polyhavenFixture.js";

type SearchBody = ReturnType<typeof objectSearchResponseSchema.parse>;

describe("object search routes", () => {
  let app: FastifyInstance;
  let fixture: PolyhavenFixture;
  let evil: Server;
  let evilHits: string[];
  let testRoot: string;
  const previous: Record<string, string | undefined> = {};

  beforeAll(async () => {
    evilHits = [];
    evil = createServer((request, response) => {
      evilHits.push(request.url ?? "");
      response.end("x");
    });
    await new Promise<void>((resolve) => evil.listen(0, "127.0.0.1", resolve));
    // "localhost" is plain-http-friendly but is not the fixture's host, so it must be refused.
    const evilOrigin = `http://localhost:${(evil.address() as AddressInfo).port}`;

    fixture = await startPolyhavenFixture([
      {
        id: "Evil_01",
        name: "Evil Crate",
        author: "Mallory",
        tags: ["crate"],
        categories: ["props"],
        dimensions: [500, 500, 500],
        downloads: 1,
        downloadOrigin: evilOrigin
      }
    ]);

    testRoot = await mkdtemp(path.join(tmpdir(), "holoim-object-routes-"));
    for (const key of ["POLYHAVEN_API_ORIGIN", "POLYHAVEN_ALLOWED_HOSTS"]) previous[key] = process.env[key];
    process.env.POLYHAVEN_API_ORIGIN = fixture.origin;
    process.env.POLYHAVEN_ALLOWED_HOSTS = "dl.polyhaven.org";

    vi.resetModules();
    const { buildApp } = await import("../src/app.js");
    app = buildApp({ logger: false, uploadsRoot: path.join(testRoot, "uploads") });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await fixture.close();
    await new Promise((resolve) => evil.close(resolve));
    await rm(testRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function search(q: string): Promise<SearchBody> {
    const response = await app.inject({ method: "GET", url: `/api/objects/search?q=${encodeURIComponent(q)}` });
    expect(response.statusCode).toBe(200);
    return objectSearchResponseSchema.parse(response.json());
  }

  it("returns at most six results, drops oversize models and ranks name over tags", async () => {
    const body = await search("chair");
    expect(body.results).toHaveLength(6);
    const ids = body.results.map((result) => result.id);
    expect(ids).not.toContain("Chair_Huge");
    expect(ids).not.toContain("Sofa_01");
    expect(ids.every((id) => id.startsWith("Chair_0"))).toBe(true);
    const first = body.results[0]!;
    expect(first).toMatchObject({
      id: "Chair_01",
      source: "Poly Haven",
      title: "Chair 01",
      author: "Chair Maker",
      licence: "CC0-1.0",
      sourceUrl: "https://polyhaven.com/a/Chair_01",
      glbPath: "/api/objects/polyhaven/Chair_01.glb"
    });
    expect(first.thumbnailUrl).toBe("https://cdn.polyhaven.com/asset_img/thumbs/Chair_01.png?width=256&height=256");
    // Blender [x, y, z] mm -> glTF [x, up, depth] m
    expect(first.dimensionsM).toEqual([0.5, 0.9, 0.6]);
    expect(first.bytes).toBeGreaterThan(0);
  });

  it("ranks the name match first, keeps the tag match, and drops zero scores", async () => {
    expect((await search("lamp")).results.map((r) => r.id)).toEqual(["Lamp_01", "Light_01"]);
    expect((await search("nothing-like-this")).results).toEqual([]);
  });

  it("ranks a name match above a tag-only match", async () => {
    const ids = (await search("sofa")).results.map((result) => result.id);
    expect(ids[0]).toBe("Sofa_01");
  });

  it("rejects empty, blank, missing and over-long queries with 400", async () => {
    for (const url of [
      "/api/objects/search",
      "/api/objects/search?q=",
      "/api/objects/search?q=%20%20",
      `/api/objects/search?q=${"a".repeat(101)}`
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(400);
      expect(response.json()).toHaveProperty("error");
    }
  });

  it("packs a valid credited GLB without compression extensions", async () => {
    const response = await app.inject({ method: "GET", url: "/api/objects/polyhaven/Chair_01.glb" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("model/gltf-binary");
    expect(response.headers["cache-control"]).toContain("max-age");
    const glb = response.rawPayload;
    expect(glb.subarray(0, 4).toString("latin1")).toBe("glTF");
    expect(glb.readUInt32LE(4)).toBe(2);
    expect(glb.readUInt32LE(8)).toBe(glb.byteLength);
    expect(glb.subarray(16, 20).toString("latin1")).toBe("JSON");
    const jsonLength = glb.readUInt32LE(12);
    const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8")) as {
      asset: { copyright?: string; extras?: Record<string, unknown> };
      extensionsRequired?: string[];
      extensionsUsed?: string[];
      images?: Array<{ bufferView?: number; uri?: string }>;
      buffers: Array<{ uri?: string }>;
    };
    expect(json.asset.copyright).toBe("“Chair 01” by Chair Maker, Poly Haven, CC0");
    expect(objectCreditSchema.parse(json.asset.extras?.[HOLOIM_CREDIT_EXTRAS_KEY])).toMatchObject({
      sourceUrl: "https://polyhaven.com/a/Chair_01",
      licence: "CC0-1.0"
    });
    expect(json.extensionsRequired ?? []).toEqual([]);
    expect(json.extensionsUsed ?? []).toEqual([]);
    // One self-contained file: embedded buffer and texture, no external URIs.
    expect(json.buffers.every((buffer) => buffer.uri === undefined)).toBe(true);
    expect(json.images?.every((image) => image.uri === undefined && image.bufferView !== undefined)).toBe(true);

    const doc = await new NodeIO().readBinary(new Uint8Array(glb));
    expect(doc.getRoot().listTextures()).toHaveLength(1);
    // The GLB's bounds are the search result's stated dimensions (metres, y up).
    const bounds = getBounds(doc.getRoot().getDefaultScene()!);
    const size = bounds.max.map((max, axis) => max - bounds.min[axis]!);
    expect(size[0]).toBeCloseTo(0.5);
    expect(size[1]).toBeCloseTo(0.9);
    expect(size[2]).toBeCloseTo(0.6);
  });

  it("answers 404 for unknown ids and ids that are not plain names", async () => {
    for (const file of ["Nope_99.glb", "Chair_01", "Chair_01.gltf", "..%2Fetc%2Fpasswd.glb", "a%2Fb.glb", ".glb"]) {
      const response = await app.inject({ method: "GET", url: `/api/objects/polyhaven/${file}` });
      expect(response.statusCode, file).toBe(404);
    }
  });

  it("answers 502 when the model has no 1k glTF or uses compression", async () => {
    for (const id of ["NoFiles_01", "Draco_01"]) {
      const response = await app.inject({ method: "GET", url: `/api/objects/polyhaven/${id}.glb` });
      expect(response.statusCode, id).toBe(502);
      expect(response.json<{ error: string }>().error).toMatch(/unavailable/i);
    }
  });

  it("refuses a file host that is not allowed and never fetches it", async () => {
    const response = await app.inject({ method: "GET", url: "/api/objects/polyhaven/Evil_01.glb" });
    expect(response.statusCode).toBe(502);
    expect(evilHits).toEqual([]);
  });

  it("refuses models whose declared size is over 8 MB", async () => {
    const response = await app.inject({ method: "GET", url: "/api/objects/polyhaven/Chair_Huge.glb" });
    expect(response.statusCode).toBe(422);
  });

  it("serves the same packed bytes again without refetching the files", async () => {
    await app.inject({ method: "GET", url: "/api/objects/polyhaven/Chair_02.glb" });
    const before = fixture.requests.filter((path) => path.startsWith("/dl/Chair_02/")).length;
    await app.inject({ method: "GET", url: "/api/objects/polyhaven/Chair_02.glb" });
    expect(fixture.requests.filter((path) => path.startsWith("/dl/Chair_02/")).length).toBe(before);
  });
});

describe("object search when Poly Haven is down", () => {
  it("answers 502 for search and download", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));

    const { default: Fastify } = await import("fastify");
    const { registerObjectRoutes } = await import("../src/routes/objects.js");
    const { createPolyhaven } = await import("../src/services/polyhaven.js");
    const app = Fastify({ logger: false });
    await app.register(
      async (instance) => {
        await registerObjectRoutes(instance, {
          polyhaven: createPolyhaven({ apiOrigin: `http://127.0.0.1:${port}`, allowedHosts: [] })
        });
      },
      { prefix: "/api" }
    );
    const searchResponse = await app.inject({ method: "GET", url: "/api/objects/search?q=chair" });
    expect(searchResponse.statusCode).toBe(502);
    const glbResponse = await app.inject({ method: "GET", url: "/api/objects/polyhaven/Chair_01.glb" });
    expect(glbResponse.statusCode).toBe(502);
    await app.close();
  });
});
