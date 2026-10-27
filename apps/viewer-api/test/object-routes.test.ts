import { NodeIO, getBounds } from "@gltf-transform/core";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { objectSearchResponseSchema, objectTranscribeResponseSchema } from "@holoim/contracts";
import { HOLOIM_CREDIT_EXTRAS_KEY, objectCreditSchema } from "@holoim/objects";

import type { ObjectRouteOptions } from "../src/routes/objects.js";
import { startPolyhavenFixture, type PolyhavenFixture } from "./fixtures/polyhavenFixture.js";
import { POLYPIZZA_FIXTURE_KEY, startPolypizzaFixture, type PolypizzaFixture } from "./fixtures/polypizzaFixture.js";

type SearchBody = ReturnType<typeof objectSearchResponseSchema.parse>;

describe("object search routes", () => {
  let app: FastifyInstance;
  let fixture: PolyhavenFixture;
  let pizza: PolypizzaFixture;
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

    pizza = await startPolypizzaFixture([
      { id: "PzChairEvil", title: "Evil Chair", creator: "Mallory", licence: "CC0 1.0", tags: ["chair"], downloadOrigin: evilOrigin }
    ]);

    testRoot = await mkdtemp(path.join(tmpdir(), "holoim-object-routes-"));
    const settings: Record<string, string> = {
      POLYHAVEN_API_ORIGIN: fixture.origin,
      POLYHAVEN_ALLOWED_HOSTS: "dl.polyhaven.org",
      POLYPIZZA_API_ORIGIN: pizza.origin,
      POLYPIZZA_API_KEY: POLYPIZZA_FIXTURE_KEY,
      POLYPIZZA_ALLOWED_HOSTS: "static.poly.pizza",
      WEB_ORIGIN: "https://localhost:3174",
      WEB_ORIGINS: ""
    };
    for (const [key, value] of Object.entries(settings)) {
      previous[key] = process.env[key];
      process.env[key] = value;
    }
    // The capture origins are the defaults, which the deploy relies on.
    previous.CAPTURE_ORIGINS = process.env.CAPTURE_ORIGINS;
    delete process.env.CAPTURE_ORIGINS;

    vi.resetModules();
    const { buildApp } = await import("../src/app.js");
    app = buildApp({ logger: false, uploadsRoot: path.join(testRoot, "uploads") });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await fixture.close();
    await pizza.close();
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

  it("answers the capture app and the web origins on object routes, and no other site", async () => {
    for (const origin of ["https://holoim-capture.pages.dev", "https://feature-x.holoim-capture.pages.dev", "https://localhost:3174", "http://localhost:5173"]) {
      const found = await app.inject({ method: "GET", url: "/api/objects/search?q=lamp", headers: { origin } });
      expect(found.headers["access-control-allow-origin"], origin).toBe(origin);
      const glb = await app.inject({ method: "GET", url: "/api/objects/polyhaven/Lamp_01.glb", headers: { origin } });
      expect(glb.headers["access-control-allow-origin"], origin).toBe(origin);
    }
    // Poly Pizza's terms forbid offering its models to third parties.
    for (const origin of ["https://example.com", "https://holoim-capture.pages.dev.example.com", "https://a.b.holoim-capture.pages.dev"]) {
      const found = await app.inject({ method: "GET", url: "/api/objects/search?q=lamp", headers: { origin } });
      expect(found.headers["access-control-allow-origin"], origin).toBeUndefined();
    }
    // The voice upload is not a simple request, so its preflight must pass too.
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/objects/transcribe",
      headers: { origin: "https://holoim-capture.pages.dev", "access-control-request-method": "POST", "access-control-request-headers": "content-type" }
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("https://holoim-capture.pages.dev");
    // Capture joins only the object routes, not the authenticated ones.
    const feed = await app.inject({ method: "GET", url: "/api/holograms", headers: { origin: "https://holoim-capture.pages.dev" } });
    expect(feed.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("returns at most six results, drops oversize models and ranks name over tags", async () => {
    const body = await search("chair");
    expect(body.results).toHaveLength(6);
    const haven = body.results.filter((result) => result.source === "Poly Haven").map((result) => result.id);
    expect(haven).not.toContain("Chair_Huge");
    expect(haven).not.toContain("Sofa_01");
    expect(haven.every((id) => id.startsWith("Chair_0"))).toBe(true);
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

  it("merges Poly Pizza by rank, keeping only CC0 and CC BY 4.0 models the tray accepts", async () => {
    const body = await search("chair");
    expect(body.results.map((result) => `${result.source}:${result.id}`)).toEqual([
      "Poly Haven:Chair_01",
      "Poly Pizza:PzChair01",
      "Poly Haven:Chair_02",
      "Poly Pizza:PzChair02",
      "Poly Haven:Chair_03",
      "Poly Haven:Chair_04"
    ]);
    expect(body.results[1]).toMatchObject({
      source: "Poly Pizza",
      title: "Wooden Chair",
      author: "Pizza Carpenter",
      licence: "CC-BY-4.0",
      sourceUrl: "https://poly.pizza/m/PzChair01",
      thumbnailUrl: `${pizza.origin}/static/PzChair01.webp`,
      glbPath: "/api/objects/polypizza/PzChair01.glb",
      // Poly Pizza states no real-world size.
      dimensionsM: null
    });
    expect(body.results[1]!.bytes).toBeGreaterThan(0);
    expect(body.results[3]).toMatchObject({ author: "Quaternius", licence: "CC0-1.0" });
    // CC BY 3.0, rigged, compressed, externally linked, oversize and off-host models are never offered.
    expect(evilHits).toEqual([]);
  });

  it("serves a vetted Poly Pizza GLB credited to its author and to Poly Pizza, without downloading it again", async () => {
    await search("chair");
    const before = pizza.requests.filter((entry) => entry === "/static/PzChair01.glb").length;
    expect(before).toBe(1);
    const response = await app.inject({ method: "GET", url: "/api/objects/polypizza/PzChair01.glb" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("model/gltf-binary");
    expect(pizza.requests.filter((entry) => entry === "/static/PzChair01.glb").length).toBe(before);
    const glb = response.rawPayload;
    const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8")) as {
      asset: { copyright?: string; extras?: Record<string, unknown> };
    };
    expect(json.asset.copyright).toBe("“Wooden Chair” by Pizza Carpenter, Poly Pizza, CC BY 4.0");
    expect(objectCreditSchema.parse(json.asset.extras?.[HOLOIM_CREDIT_EXTRAS_KEY])).toEqual({
      source: "Poly Pizza",
      sourceUrl: "https://poly.pizza/m/PzChair01",
      title: "Wooden Chair",
      author: "Pizza Carpenter",
      licence: "CC-BY-4.0"
    });
    const doc = await new NodeIO().readBinary(new Uint8Array(glb));
    expect(doc.getRoot().listTextures()).toHaveLength(1);
  });

  it("looks up a Poly Pizza model it has not searched for, and refuses what it may not offer", async () => {
    const stool = await app.inject({ method: "GET", url: "/api/objects/polypizza/PzStool01.glb" });
    expect(stool.statusCode).toBe(200);
    expect(pizza.requests).toContain("/model/PzStool01");
    const cases: Array<[string, number]> = [
      ["PzNope99.glb", 404],
      // CC BY 3.0 is not a licence a take may carry.
      ["PzChair03.glb", 404],
      ["PzChair01", 404],
      ["..%2Fsecret.glb", 404],
      ["PzChairRig.glb", 502],
      ["PzChairDraco.glb", 502],
      ["PzChairExt.glb", 502],
      // A model whose file sits on a host that is not allowed is not offered at all.
      ["PzChairEvil.glb", 404],
      ["PzChairBig.glb", 422]
    ];
    for (const [file, status] of cases) {
      const response = await app.inject({ method: "GET", url: `/api/objects/polypizza/${file}` });
      expect(response.statusCode, file).toBe(status);
    }
    expect(evilHits).toEqual([]);
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

describe("object search vetting", () => {
  it("never offers a Draco or skinned model, since capture or the packer would refuse it", async () => {
    const gltfs: Record<string, object> = {
      Plain_01: { asset: { version: "2.0" } },
      Draco_02: { asset: { version: "2.0" }, extensionsUsed: ["KHR_draco_mesh_compression"], extensionsRequired: ["KHR_draco_mesh_compression"] },
      Meshopt_01: { asset: { version: "2.0" }, extensionsUsed: ["EXT_meshopt_compression"] },
      Skinned_01: { asset: { version: "2.0" }, skins: [{ joints: [0] }] }
    };
    let origin = "";
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", origin);
      const send = (body: unknown) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (url.pathname === "/assets") {
        return send(
          Object.fromEntries(
            Object.keys(gltfs).map((id) => [id, { name: `Barrel ${id}`, authors: { A: "All" }, tags: ["barrel"], categories: [], dimensions: [500, 500, 500], download_count: 1 }])
          )
        );
      }
      const files = /^\/files\/([^/]+)$/.exec(url.pathname);
      if (files) return send({ gltf: { "1k": { gltf: { url: `${origin}/dl/${files[1]}/model.gltf`, size: 100, include: {} } } } });
      const dl = /^\/dl\/([^/]+)\/model\.gltf$/.exec(url.pathname);
      if (dl && gltfs[dl[1]!]) return send(gltfs[dl[1]!]);
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const { createPolyhaven } = await import("../src/services/polyhaven.js");
      const results = await createPolyhaven({ apiOrigin: origin, allowedHosts: [] }).search("barrel", 6);
      expect(results.map((result) => result.id)).toEqual(["Plain_01"]);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

async function closedOrigin(): Promise<string> {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = (closed.address() as AddressInfo).port;
  await new Promise((resolve) => closed.close(resolve));
  return `http://127.0.0.1:${port}`;
}

async function objectApp(options: ObjectRouteOptions): Promise<FastifyInstance> {
  const { default: Fastify } = await import("fastify");
  const { registerObjectRoutes } = await import("../src/routes/objects.js");
  const app = Fastify({ logger: false });
  await app.register(async (instance) => registerObjectRoutes(instance, options), { prefix: "/api" });
  await app.ready();
  return app;
}

describe("object search with Poly Pizza unavailable", () => {
  let haven: PolyhavenFixture;
  let pizza: PolypizzaFixture;

  beforeAll(async () => {
    haven = await startPolyhavenFixture();
    pizza = await startPolypizzaFixture();
  });

  afterAll(async () => {
    await haven.close();
    await pizza.close();
  });

  it("shows Poly Haven alone when there is no key, Poly Pizza is down or refuses the key", async () => {
    const { createPolyhaven } = await import("../src/services/polyhaven.js");
    const { createPolypizza } = await import("../src/services/polypizza.js");
    const polyhaven = createPolyhaven({ apiOrigin: haven.origin, allowedHosts: [] });
    const variants = {
      "no key": null,
      down: createPolypizza({ apiOrigin: await closedOrigin(), apiKey: "k", allowedHosts: [] }),
      "wrong key": createPolypizza({ apiOrigin: pizza.origin, apiKey: "wrong", allowedHosts: [] })
    };
    for (const [label, polypizza] of Object.entries(variants)) {
      const app = await objectApp({ polyhaven, polypizza, transcriber: null });
      const response = await app.inject({ method: "GET", url: "/api/objects/search?q=chair" });
      expect(response.statusCode, label).toBe(200);
      const sources = objectSearchResponseSchema.parse(response.json()).results.map((result) => result.source);
      expect(sources, label).toEqual(Array(6).fill("Poly Haven"));
      const glb = await app.inject({ method: "GET", url: "/api/objects/polypizza/PzChair01.glb" });
      expect(glb.statusCode, label).toBe(label === "no key" ? 404 : 502);
      await app.close();
    }
  });

  it("shows Poly Pizza alone when Poly Haven is down, and 502 only when both are", async () => {
    const { createPolyhaven } = await import("../src/services/polyhaven.js");
    const { createPolypizza } = await import("../src/services/polypizza.js");
    const downHaven = createPolyhaven({ apiOrigin: await closedOrigin(), allowedHosts: [] });
    const app = await objectApp({
      polyhaven: downHaven,
      polypizza: createPolypizza({ apiOrigin: pizza.origin, apiKey: POLYPIZZA_FIXTURE_KEY, allowedHosts: [] }),
      transcriber: null
    });
    const response = await app.inject({ method: "GET", url: "/api/objects/search?q=chair" });
    expect(response.statusCode).toBe(200);
    expect(objectSearchResponseSchema.parse(response.json()).results.map((result) => result.id)).toEqual(["PzChair01", "PzChair02"]);
    await app.close();

    const both = await objectApp({
      polyhaven: downHaven,
      polypizza: createPolypizza({ apiOrigin: await closedOrigin(), apiKey: "k", allowedHosts: [] }),
      transcriber: null
    });
    expect((await both.inject({ method: "GET", url: "/api/objects/search?q=chair" })).statusCode).toBe(502);
    await both.close();
  });
});

describe("voice search transcription", () => {
  type Call = { path: string; authorization: string | undefined; body: { audio?: string; task?: string } };
  let workersAi: Server;
  let origin: string;
  let calls: Call[];
  /** What the stand-in Workers AI answers next. */
  let answer: { status: number; body: unknown };

  beforeAll(async () => {
    calls = [];
    workersAi = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        calls.push({ path: request.url ?? "", authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") });
        response.writeHead(answer.status, { "content-type": "application/json" });
        response.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => workersAi.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(workersAi.address() as AddressInfo).port}/client/v4`;
  });

  afterAll(async () => {
    workersAi.closeAllConnections();
    await new Promise((resolve) => workersAi.close(resolve));
  });

  const ok = (text: string) => ({ status: 200, body: { result: { text, word_count: 2 }, success: true, errors: [], messages: [] } });
  const audio = Buffer.from("OggS fake opus bytes");

  async function transcribeApp(limit = 100) {
    const { createTranscriber } = await import("../src/services/transcribe.js");
    return objectApp({
      polypizza: null,
      transcriber: createTranscriber({ apiOrigin: origin, accountId: "acct-1", apiToken: "token-1" }),
      transcribeLimit: limit
    });
  }

  function post(app: FastifyInstance, body: Buffer | string, type = "audio/webm;codecs=opus", ip = "203.0.113.5") {
    return app.inject({ method: "POST", url: "/api/objects/transcribe", payload: body, headers: { "content-type": type, "fly-client-ip": ip } });
  }

  it("sends the recording to Whisper and returns the spoken query, trimmed and without closing punctuation", async () => {
    const app = await transcribeApp();
    answer = ok("  A red   armchair.  ");
    const response = await post(app, audio);
    expect(response.statusCode).toBe(200);
    expect(objectTranscribeResponseSchema.parse(response.json())).toEqual({ text: "A red armchair" });
    const call = calls.at(-1)!;
    expect(call.path).toBe("/client/v4/accounts/acct-1/ai/run/@cf/openai/whisper-large-v3-turbo");
    expect(call.authorization).toBe("Bearer token-1");
    expect(Buffer.from(call.body.audio!, "base64").equals(audio)).toBe(true);
    expect(call.body.task).toBe("transcribe");

    for (const type of ["audio/ogg", "audio/wav", "audio/mp4"]) {
      answer = ok("Lamp?!");
      const other = await post(app, audio, type);
      expect(other.json(), type).toEqual({ text: "Lamp" });
    }
    answer = ok(`${"word ".repeat(40)}end.`);
    const long = objectTranscribeResponseSchema.parse((await post(app, audio)).json());
    expect(long.text.length).toBeLessThanOrEqual(100);
    expect(long.text).toBe(long.text.trim());
    answer = ok("");
    expect((await post(app, audio)).json()).toEqual({ text: "" });
    await app.close();
  });

  it("refuses recordings that are too large, empty or not audio before calling Whisper", async () => {
    const app = await transcribeApp();
    const before = calls.length;
    const tooLarge = await post(app, Buffer.alloc(1024 * 1024 + 1, 1));
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json()).toHaveProperty("error");
    for (const type of ["text/plain", "application/json", "audio/mpeg", "video/webm"]) {
      const response = await post(app, type === "application/json" ? "{}" : audio, type);
      expect(response.statusCode, type).toBe(415);
      expect(response.json(), type).toHaveProperty("error");
    }
    expect((await post(app, Buffer.alloc(0))).statusCode).toBe(400);
    expect(calls.length).toBe(before);
    await app.close();
  });

  it("answers 503 when voice search is not set up or today's allowance is used up, and 502 when Whisper fails", async () => {
    const off = await objectApp({ polypizza: null, transcriber: null });
    const notSetUp = await post(off, audio);
    expect(notSetUp.statusCode).toBe(503);
    expect(notSetUp.json<{ error: string }>().error).toMatch(/type/i);
    await off.close();

    const app = await transcribeApp();
    answer = { status: 429, body: { success: false, errors: [{ code: 3036, message: "You have used up your daily free allocation of 10,000 neurons." }] } };
    expect((await post(app, audio)).statusCode).toBe(503);
    answer = { status: 400, body: { success: false, errors: [{ code: 3036, message: "daily free allocation" }] } };
    expect((await post(app, audio)).statusCode).toBe(503);
    answer = { status: 500, body: { success: false, errors: [{ code: 3043, message: "Internal" }] } };
    expect((await post(app, audio)).statusCode).toBe(502);
    answer = { status: 200, body: { success: true, result: {} } };
    expect((await post(app, audio)).statusCode).toBe(502);
    await app.close();

    const { createTranscriber } = await import("../src/services/transcribe.js");
    const unreachable = await objectApp({
      polypizza: null,
      transcriber: createTranscriber({ apiOrigin: await closedOrigin(), accountId: "a", apiToken: "t" })
    });
    expect((await post(unreachable, audio)).statusCode).toBe(502);
    await unreachable.close();
  });

  it("limits each client to a few searches a minute", async () => {
    const app = await objectApp({ polyhaven: (await import("../src/services/polyhaven.js")).createPolyhaven({ apiOrigin: await closedOrigin(), allowedHosts: [] }), polypizza: null, transcriber: null, searchLimit: 1 });
    expect((await app.inject({ method: "GET", url: "/api/objects/search?q=chair" })).statusCode).toBe(502);
    const limited = await app.inject({ method: "GET", url: "/api/objects/search?q=chair" });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    await app.close();
  });

  it("limits each client to a few transcriptions a minute", async () => {
    // Fly-Client-IP is trusted only on Fly.
    process.env.FLY_APP_NAME = "holoim-api-test";
    const app = await transcribeApp(2);
    delete process.env.FLY_APP_NAME;
    answer = ok("chair");
    expect((await post(app, audio)).statusCode).toBe(200);
    expect((await post(app, audio)).statusCode).toBe(200);
    const limited = await post(app, audio);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    // Another client still gets through.
    expect((await post(app, audio, "audio/webm", "198.51.100.7")).statusCode).toBe(200);
    await app.close();

    // Off Fly a client cannot pick its own key with the header.
    const local = await transcribeApp(1);
    expect((await post(local, audio, "audio/webm", "192.0.2.1")).statusCode).toBe(200);
    expect((await post(local, audio, "audio/webm", "192.0.2.2")).statusCode).toBe(429);
    await local.close();
  });
});
