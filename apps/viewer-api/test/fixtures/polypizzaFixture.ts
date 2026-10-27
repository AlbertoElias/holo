import { Document, NodeIO } from "@gltf-transform/core";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A tiny local stand-in for Poly Pizza's v1.1 API and its static file host,
 * for the API tests and the e2e pipeline (PRD-060 slice 2). Point
 * POLYPIZZA_API_ORIGIN at `origin` and set POLYPIZZA_API_KEY to
 * POLYPIZZA_FIXTURE_KEY; files come from the same host, which the API always
 * allows. Response shapes follow poly.pizza/apispec/v1.1.yaml.
 */

export const POLYPIZZA_FIXTURE_KEY = "fixture-polypizza-key";

type FixtureModel = {
  id: string;
  title: string;
  creator: string;
  /** Poly Pizza's own label, e.g. "CC0 1.0", "CC-BY 4.0", "CC-BY 3.0". */
  licence: string;
  tags: string[];
  /** Serve the GLB from another origin (the SSRF case). */
  downloadOrigin?: string;
  /** Patch the GLB the way a model the tray refuses would look. */
  kind?: "draco" | "skinned" | "huge" | "external";
};

export type PolypizzaFixture = {
  origin: string;
  /** Request paths the fixture served, in order. */
  requests: string[];
  close: () => Promise<void>;
};

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

export const POLYPIZZA_FIXTURE_MODELS: FixtureModel[] = [
  { id: "PzChair01", title: "Wooden Chair", creator: "Pizza Carpenter", licence: "CC-BY 4.0", tags: ["chair", "furniture"] },
  { id: "PzChair02", title: "Camp Chair", creator: "Quaternius", licence: "CC0 1.0", tags: ["chair", "camping"] },
  { id: "PzChair03", title: "Old Chair", creator: "Legacy Poly", licence: "CC-BY 3.0", tags: ["chair"] },
  { id: "PzChairRig", title: "Rigged Chair", creator: "Animator", licence: "CC0 1.0", tags: ["chair"], kind: "skinned" },
  { id: "PzChairDraco", title: "Squashed Chair", creator: "Squash", licence: "CC0 1.0", tags: ["chair"], kind: "draco" },
  { id: "PzChairExt", title: "Linked Chair", creator: "Linker", licence: "CC0 1.0", tags: ["chair"], kind: "external" },
  { id: "PzChairBig", title: "Huge Chair", creator: "Big Texture", licence: "CC0 1.0", tags: ["chair"], kind: "huge" },
  { id: "PzStool01", title: "Bar Stool", creator: "Pizza Carpenter", licence: "CC-BY 4.0", tags: ["stool", "furniture"] }
];

/** A one-triangle GLB (0.4 × 0.8 × 0.4) with an embedded texture; `kind` makes it one the tray refuses. */
async function buildGlb(kind: FixtureModel["kind"]): Promise<Buffer> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 0.4, 0, 0, 0, 0.8, 0.4]))
    .setBuffer(buffer);
  // A 9 MB "texture" makes a GLB past the tray's 8 MB but under the 12 MB download cap.
  const image = kind === "huge" ? Buffer.concat([PNG_1X1, Buffer.alloc(9 * 1024 * 1024, 7)]) : PNG_1X1;
  const texture = doc.createTexture("tex").setImage(image).setMimeType("image/png");
  const material = doc.createMaterial("m").setBaseColorTexture(texture);
  const primitive = doc.createPrimitive().setAttribute("POSITION", position).setMaterial(material);
  const node = doc.createNode("tri").setMesh(doc.createMesh("tri").addPrimitive(primitive));
  doc.getRoot().setDefaultScene(doc.createScene("s").addChild(node));
  const glb = Buffer.from(await new NodeIO().writeBinary(doc));
  if (!kind || kind === "huge") return glb;
  return patchJson(glb, (json) => {
    if (kind === "draco") {
      json.extensionsUsed = ["KHR_draco_mesh_compression"];
      json.extensionsRequired = ["KHR_draco_mesh_compression"];
    } else if (kind === "skinned") {
      json.skins = [{ joints: [0] }];
    } else if (kind === "external") {
      (json.images as Array<Record<string, unknown>>)[0] = { uri: "file:///etc/passwd", mimeType: "image/png" };
    }
  });
}

/** Rewrites a GLB's JSON chunk, keeping the BIN chunk. */
function patchJson(glb: Buffer, mutate: (json: Record<string, unknown>) => void): Buffer {
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8")) as Record<string, unknown>;
  mutate(json);
  let text = Buffer.from(JSON.stringify(json), "utf8");
  if (text.byteLength % 4) text = Buffer.concat([text, Buffer.alloc(4 - (text.byteLength % 4), 0x20)]);
  const rest = glb.subarray(20 + jsonLength);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + text.byteLength + rest.byteLength, 8);
  header.writeUInt32LE(text.byteLength, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, text, rest]);
}

export async function startPolypizzaFixture(extra: FixtureModel[] = [], options: { port?: number } = {}): Promise<PolypizzaFixture> {
  const models = [...POLYPIZZA_FIXTURE_MODELS, ...extra];
  const requests: string[] = [];
  let origin = "";

  const built = new Map<string, Buffer>();
  for (const model of models) built.set(model.id, await buildGlb(model.kind));

  function record(model: FixtureModel) {
    const files = model.downloadOrigin ?? origin;
    return {
      ID: model.id,
      Title: model.title,
      Attribution: `"${model.title}" by ${model.creator}, https://poly.pizza/m/${model.id}`,
      Thumbnail: `${files}/static/${model.id}.webp`,
      Download: `${files}/static/${model.id}.glb`,
      "Tri Count": 1,
      Creator: { Username: model.creator, DPURL: `${files}/static/dp.jpg` },
      Category: "Furniture & Decor",
      Tags: model.tags,
      Licence: model.licence,
      Animated: false
    };
  }

  function send(response: ServerResponse, status: number, body: Buffer | string, type: string) {
    response.writeHead(status, { "content-type": type });
    response.end(body);
  }

  function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", origin);
    requests.push(`${url.pathname}${url.search}`);
    // Poly Pizza asks for the key on the API and on its file host.
    if (request.headers["x-auth-token"] !== POLYPIZZA_FIXTURE_KEY) {
      return send(response, 401, JSON.stringify({ error: "Unauthorized" }), "application/json");
    }
    const search = /^\/search\/([^/]+)$/.exec(url.pathname);
    if (search) {
      const keyword = decodeURIComponent(search[1]!).toLowerCase();
      const words = keyword.split(/\s+/).filter(Boolean);
      const found = models.filter((model) =>
        words.every((word) => model.title.toLowerCase().includes(word) || model.tags.some((tag) => tag.includes(word)))
      );
      const limit = Number(url.searchParams.get("Limit") ?? 32);
      return send(response, 200, JSON.stringify({ total: found.length, results: found.slice(0, limit).map(record) }), "application/json; charset=utf-8");
    }
    const one = /^\/model\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const model = models.find((candidate) => candidate.id === one[1]);
      return model
        ? send(response, 200, JSON.stringify(record(model)), "application/json; charset=utf-8")
        : send(response, 404, JSON.stringify({ error: "Not found" }), "application/json");
    }
    const file = /^\/static\/([^/]+)\.(glb|webp)$/.exec(url.pathname);
    if (file) {
      if (file[2] === "webp") return send(response, 200, PNG_1X1, "image/png");
      const glb = built.get(file[1]!);
      return glb ? send(response, 200, glb, "model/gltf-binary") : send(response, 404, "", "text/plain");
    }
    return send(response, 404, "", "text/plain");
  }

  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    origin,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}
