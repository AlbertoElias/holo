import { Document, NodeIO } from "@gltf-transform/core";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A tiny local stand-in for Poly Haven's API and download host, for the API
 * tests and the e2e pipeline (PRD-060). Point POLYHAVEN_API_ORIGIN at `origin`;
 * downloads come from the same host, which the API always allows.
 */

type FixtureModel = {
  id: string;
  name: string;
  author: string;
  tags: string[];
  categories: string[];
  /** Poly Haven order: Blender x, y (depth), z (up), millimetres. */
  dimensions: [number, number, number];
  downloads: number;
  /** Declared source size in bytes, to model a model too big for the tray. */
  declaredBytes?: number;
  /** Serve the file entries from another origin (the SSRF case). */
  downloadOrigin?: string;
  /** Add a required extension so the packer must refuse it. */
  draco?: boolean;
};

export type PolyhavenFixture = {
  origin: string;
  /** Request paths the fixture served, in order. */
  requests: string[];
  close: () => Promise<void>;
};

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/** A one-triangle model sized so its bounds are [w, h, d] metres, with a texture, in Poly Haven's file layout. */
async function buildModel(size: [number, number, number], draco: boolean) {
  const doc = new Document();
  const buffer = doc.createBuffer().setURI("model.bin");
  const position = doc
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, size[0], 0, 0, 0, size[1], size[2]]))
    .setBuffer(buffer);
  const texture = doc.createTexture("tex").setImage(PNG_1X1).setMimeType("image/png").setURI("textures/tex.png");
  const material = doc.createMaterial("m").setBaseColorTexture(texture);
  const primitive = doc.createPrimitive().setAttribute("POSITION", position).setMaterial(material);
  const mesh = doc.createMesh("tri").addPrimitive(primitive);
  const node = doc.createNode("tri").setMesh(mesh);
  const scene = doc.createScene("s").addChild(node);
  doc.getRoot().setDefaultScene(scene);
  const { json, resources } = await new NodeIO().writeJSON(doc);
  if (draco) {
    json.extensionsUsed = ["KHR_draco_mesh_compression"];
    json.extensionsRequired = ["KHR_draco_mesh_compression"];
  }
  return { json, resources: resources as Record<string, Uint8Array> };
}

const CHAIRS: FixtureModel[] = Array.from({ length: 8 }, (_, index) => ({
  id: `Chair_0${index + 1}`,
  name: `Chair 0${index + 1}`,
  author: "Chair Maker",
  tags: ["furniture", "seat"],
  categories: ["furniture", "seating"],
  dimensions: [500 + index, 600, 900],
  downloads: 100 - index
}));

export const FIXTURE_MODELS: FixtureModel[] = [
  ...CHAIRS,
  { id: "Chair_Huge", name: "Huge Chair", author: "Big Texture", tags: ["chair"], categories: ["furniture"], dimensions: [1000, 1000, 1000], downloads: 999, declaredBytes: 9 * 1024 * 1024 },
  { id: "Sofa_01", name: "Sofa", author: "Cushion, Sew", tags: ["chair", "couch"], categories: ["furniture"], dimensions: [2000, 900, 800], downloads: 5 },
  { id: "Lamp_01", name: "Desk Lamp", author: "Lumen", tags: ["light"], categories: ["lighting"], dimensions: [300, 300, 500], downloads: 10 },
  { id: "Light_01", name: "Ceiling Light", author: "Lumen", tags: ["lamp"], categories: ["lighting"], dimensions: [400, 400, 200], downloads: 20 },
  { id: "Draco_01", name: "Compressed Barrel", author: "Squash", tags: ["barrel"], categories: ["props"], dimensions: [500, 500, 700], downloads: 1, draco: true },
  { id: "NoFiles_01", name: "Missing Barrel", author: "Nobody", tags: ["barrel"], categories: ["props"], dimensions: [500, 500, 700], downloads: 1 }
];

export async function startPolyhavenFixture(extra: FixtureModel[] = [], options: { port?: number } = {}): Promise<PolyhavenFixture> {
  const models = [...FIXTURE_MODELS, ...extra];
  const requests: string[] = [];
  let origin = "";

  const built = new Map<string, Awaited<ReturnType<typeof buildModel>>>();
  for (const model of models) {
    // glTF is y-up: width x, height from Blender z, depth from Blender y.
    built.set(model.id, await buildModel([model.dimensions[0] / 1000, model.dimensions[2] / 1000, model.dimensions[1] / 1000], model.draco === true));
  }

  function files(model: FixtureModel) {
    const source = built.get(model.id)!;
    const base = model.downloadOrigin ?? origin;
    const include = Object.fromEntries(
      Object.entries(source.resources).map(([relPath, bytes]) => [
        relPath,
        { url: `${base}/dl/${model.id}/${relPath}`, size: model.declaredBytes ?? bytes.byteLength }
      ])
    );
    return {
      gltf: {
        "1k": {
          gltf: {
            url: `${base}/dl/${model.id}/model.gltf`,
            size: JSON.stringify(source.json).length,
            include
          }
        }
      }
    };
  }

  function send(response: ServerResponse, status: number, body: Buffer | string, type: string) {
    response.writeHead(status, { "content-type": type });
    response.end(body);
  }

  function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", origin);
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/assets") {
      const list = Object.fromEntries(
        models.map((model) => [
          model.id,
          { name: model.name, authors: Object.fromEntries(model.author.split(", ").map((name) => [name, "All"])), tags: model.tags, categories: model.categories, dimensions: model.dimensions, download_count: model.downloads, files_hash: model.id }
        ])
      );
      return send(response, 200, JSON.stringify(list), "application/json");
    }
    const filesMatch = /^\/files\/([^/]+)$/.exec(url.pathname);
    if (filesMatch) {
      const model = models.find((candidate) => candidate.id === filesMatch[1]);
      if (!model || model.id === "NoFiles_01") return send(response, model ? 200 : 404, model ? "{}" : "{}", "application/json");
      return send(response, 200, JSON.stringify(files(model)), "application/json");
    }
    const downloadMatch = /^\/dl\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (downloadMatch) {
      const source = built.get(downloadMatch[1]!);
      if (!source) return send(response, 404, "", "text/plain");
      if (downloadMatch[2] === "model.gltf") return send(response, 200, JSON.stringify(source.json), "application/json");
      const bytes = source.resources[downloadMatch[2]!];
      return bytes ? send(response, 200, Buffer.from(bytes), "application/octet-stream") : send(response, 404, "", "text/plain");
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
