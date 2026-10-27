import { NodeIO, type Document } from "@gltf-transform/core";

import {
  HOLOIM_CREDIT_EXTRAS_KEY,
  formatCredit,
  objectCreditSchema,
  type ObjectCredit
} from "@holoim/objects";

/** Same ceiling as capture's MAX_SUPPLIED_OBJECT_BYTES: a result the tray would refuse is never offered. */
export const MAX_PACKED_OBJECT_BYTES = 8 * 1024 * 1024;
/** Source files may be a little larger than the packed GLB (jpg stays jpg, but JSON/padding differ). */
const MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const LIST_TTL_MS = 60 * 60 * 1000;
const CANDIDATES_CHECKED = 12;
const FILES_CONCURRENCY = 4;
const PACKED_CACHE_ENTRIES = 20;
const MAX_REDIRECTS = 3;
const USER_AGENT = "HoloIM object search (+https://github.com/holoim; contact via repository issues)";
const COMPRESSION_EXTENSIONS = new Set([
  "KHR_draco_mesh_compression",
  "EXT_meshopt_compression",
  "KHR_texture_basisu"
]);

export const POLYHAVEN_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

export type PolyhavenConfig = {
  apiOrigin: string;
  allowedHosts: string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export type PolyhavenModel = {
  id: string;
  title: string;
  author: string;
  tags: string[];
  categories: string[];
  dimensionsM: [number, number, number] | null;
  downloads: number;
};

export type PolyhavenCandidate = PolyhavenModel & { bytes: number };

/** The registry or the network misbehaved; routes answer 502. */
export class UpstreamError extends Error {}
/** The id is not a model in the registry; routes answer 404. */
export class UnknownObjectError extends Error {}
/** The packed GLB is larger than the tray accepts; routes answer 422. */
export class ObjectTooLargeError extends Error {}

type FileEntry = { url: string; size: number };
type GltfFiles = { gltf: FileEntry; include: Record<string, FileEntry> };

function isLocalHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function singleFlight<T>(inflight: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = run().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asFileEntry(value: unknown): FileEntry | null {
  const record = asRecord(value);
  return typeof record.url === "string" && typeof record.size === "number" && record.size >= 0
    ? { url: record.url, size: record.size }
    : null;
}

export function createPolyhaven(config: PolyhavenConfig) {
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;
  const apiOrigin = config.apiOrigin.replace(/\/+$/, "");
  const apiHost = new URL(apiOrigin).hostname.toLowerCase();
  const allowedHosts = new Set([apiHost, ...config.allowedHosts.map((host) => host.toLowerCase())]);

  let list: { at: number; models: Map<string, PolyhavenModel> } | null = null;
  const listFlight = new Map<string, Promise<Map<string, PolyhavenModel>>>();
  const filesCache = new Map<string, { at: number; files: GltfFiles | null }>();
  const filesFlight = new Map<string, Promise<GltfFiles | null>>();
  const packed = new Map<string, Uint8Array>();
  const packFlight = new Map<string, Promise<Uint8Array>>();

  /** SSRF guard: only the API host and the configured download hosts, over https (http only for loopback). */
  function checkUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new UpstreamError("Poly Haven returned an invalid file URL.");
    }
    const hostname = url.hostname.toLowerCase();
    const secure = url.protocol === "https:" || (url.protocol === "http:" && isLocalHost(hostname));
    if (!secure || !allowedHosts.has(hostname)) {
      throw new UpstreamError("Poly Haven pointed at a file host that is not allowed.");
    }
    return url;
  }

  async function request(raw: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
    let url = checkUrl(raw);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers: { "user-agent": USER_AGENT },
          redirect: "manual",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });
      } catch {
        throw new UpstreamError("Poly Haven could not be reached.");
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new UpstreamError("Poly Haven sent a bad redirect.");
        url = checkUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) throw new UpstreamError(`Poly Haven answered ${response.status}.`);
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > maxBytes) throw new UpstreamError("A Poly Haven file is larger than allowed.");
      try {
        const body = new Uint8Array(await response.arrayBuffer());
        if (body.byteLength > maxBytes) throw new UpstreamError("A Poly Haven file is larger than allowed.");
        return body;
      } catch (error) {
        if (error instanceof UpstreamError) throw error;
        throw new UpstreamError("Poly Haven could not be reached.");
      }
    }
    throw new UpstreamError("Poly Haven redirected too many times.");
  }

  async function requestJson(raw: string): Promise<unknown> {
    const body = await request(raw, MAX_DOWNLOAD_BYTES);
    try {
      return JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new UpstreamError("Poly Haven returned unreadable data.");
    }
  }

  function loadList(): Promise<Map<string, PolyhavenModel>> {
    if (list && now() - list.at < LIST_TTL_MS) return Promise.resolve(list.models);
    return singleFlight(listFlight, "list", async () => {
      const raw = asRecord(await requestJson(`${apiOrigin}/assets?t=models`));
      const models = new Map<string, PolyhavenModel>();
      for (const [id, value] of Object.entries(raw)) {
        if (!POLYHAVEN_ID_PATTERN.test(id)) continue;
        const asset = asRecord(value);
        const authors = Object.keys(asRecord(asset.authors));
        const dims = asset.dimensions;
        const dimensionsM =
          Array.isArray(dims) && dims.length === 3 && dims.every((n) => typeof n === "number" && n > 0)
            // Poly Haven states Blender axes (z up, millimetres); the GLB is y-up in metres.
            ? ([dims[0] / 1000, dims[2] / 1000, dims[1] / 1000] as [number, number, number])
            : null;
        models.set(id, {
          id,
          title: typeof asset.name === "string" && asset.name.trim() ? asset.name.trim() : id,
          author: authors.length > 0 ? authors.join(", ") : "Unknown",
          tags: Array.isArray(asset.tags) ? asset.tags.filter((t): t is string => typeof t === "string") : [],
          categories: Array.isArray(asset.categories)
            ? asset.categories.filter((c): c is string => typeof c === "string")
            : [],
          dimensionsM,
          downloads: typeof asset.download_count === "number" ? asset.download_count : 0
        });
      }
      list = { at: now(), models };
      return models;
    });
  }

  /** The 1k glTF and the files it references; null when the model has no 1k glTF. */
  function loadFiles(id: string): Promise<GltfFiles | null> {
    const cached = filesCache.get(id);
    if (cached && now() - cached.at < LIST_TTL_MS) return Promise.resolve(cached.files);
    return singleFlight(filesFlight, id, async () => {
      const raw = asRecord(await requestJson(`${apiOrigin}/files/${encodeURIComponent(id)}`));
      const source = asRecord(asRecord(asRecord(raw.gltf)["1k"]).gltf);
      const gltf = asFileEntry(source);
      let files: GltfFiles | null = null;
      if (gltf) {
        const include: Record<string, FileEntry> = {};
        let valid = true;
        for (const [relPath, value] of Object.entries(asRecord(source.include))) {
          const entry = asFileEntry(value);
          if (!entry) valid = false;
          else include[relPath] = entry;
        }
        files = valid ? { gltf, include } : null;
      }
      filesCache.set(id, { at: now(), files });
      return files;
    });
  }

  function score(model: PolyhavenModel, tokens: string[]): number {
    const nameWords = tokenize(model.title);
    const name = nameWords.join(" ");
    let total = 0;
    for (const token of tokens) {
      if (nameWords.includes(token)) total += 15;
      else if (name.includes(token)) total += 10;
      if (model.tags.some((tag) => tag.toLowerCase() === token)) total += 4;
      else if (model.tags.some((tag) => tag.toLowerCase().includes(token))) total += 1;
      if (model.categories.some((category) => category.toLowerCase() === token)) total += 3;
    }
    return total;
  }

  async function search(query: string, limit: number): Promise<PolyhavenCandidate[]> {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const models = await loadList();
    const ranked = [...models.values()]
      .map((model) => ({ model, score: score(model, tokens) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.model.downloads - a.model.downloads || a.model.id.localeCompare(b.model.id))
      .slice(0, CANDIDATES_CHECKED)
      .map((entry) => entry.model);

    const sized: Array<PolyhavenCandidate | null> = new Array(ranked.length).fill(null);
    let failures = 0;
    let next = 0;
    const worker = async () => {
      while (next < ranked.length) {
        const index = next++;
        const model = ranked[index]!;
        try {
          const files = await loadFiles(model.id);
          if (!files) continue;
          const bytes = files.gltf.size + Object.values(files.include).reduce((sum, file) => sum + file.size, 0);
          if (bytes <= MAX_PACKED_OBJECT_BYTES) sized[index] = { ...model, bytes };
        } catch {
          failures += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(FILES_CONCURRENCY, ranked.length) }, worker));
    if (failures > 0 && failures === ranked.length) throw new UpstreamError("Poly Haven could not be reached.");
    return sized.filter((entry): entry is PolyhavenCandidate => entry !== null).slice(0, limit);
  }

  function creditFor(model: PolyhavenModel): ObjectCredit {
    return objectCreditSchema.parse({
      source: "Poly Haven",
      sourceUrl: sourceUrl(model.id),
      title: model.title,
      author: model.author,
      licence: "CC0-1.0"
    });
  }

  async function buildGlb(id: string): Promise<Uint8Array> {
    const models = await loadList();
    const model = models.get(id);
    if (!model) throw new UnknownObjectError("No such Poly Haven model.");
    const files = await loadFiles(id);
    if (!files) throw new UpstreamError("Poly Haven has no 1k glTF for this model.");

    const total = files.gltf.size + Object.values(files.include).reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_PACKED_OBJECT_BYTES) throw new ObjectTooLargeError("This model is too large to use.");

    let json: Record<string, unknown>;
    try {
      json = JSON.parse(new TextDecoder().decode(await request(files.gltf.url, MAX_DOWNLOAD_BYTES))) as Record<
        string,
        unknown
      >;
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError("Poly Haven returned an unreadable glTF.");
    }
    const used = Array.isArray(json.extensionsUsed) ? (json.extensionsUsed as string[]) : [];
    const required = Array.isArray(json.extensionsRequired) ? (json.extensionsRequired as string[]) : [];
    if (required.length > 0 || used.some((name) => COMPRESSION_EXTENSIONS.has(name))) {
      throw new UpstreamError("This model uses compression the tray cannot read.");
    }

    const resources: Record<string, Uint8Array<ArrayBuffer>> = {};
    let downloaded = 0;
    for (const [relPath, file] of Object.entries(files.include)) {
      const body = await request(file.url, MAX_DOWNLOAD_BYTES);
      downloaded += body.byteLength;
      if (downloaded > MAX_DOWNLOAD_BYTES) throw new UpstreamError("A Poly Haven model is larger than allowed.");
      resources[relPath] = body;
    }

    let document: Document;
    try {
      document = await new NodeIO().readJSON({ json: json as never, resources });
    } catch {
      throw new UpstreamError("Poly Haven returned a model that could not be read.");
    }

    const credit = creditFor(model);
    const asset = document.getRoot().getAsset();
    asset.copyright = formatCredit(credit);
    asset.extras = { ...(asset.extras ?? {}), [HOLOIM_CREDIT_EXTRAS_KEY]: credit };

    const glb = await new NodeIO().writeBinary(document);
    if (glb.byteLength > MAX_PACKED_OBJECT_BYTES) throw new ObjectTooLargeError("This model is too large to use.");
    return glb;
  }

  function packGlb(id: string): Promise<Uint8Array> {
    const hit = packed.get(id);
    if (hit) {
      packed.delete(id);
      packed.set(id, hit);
      return Promise.resolve(hit);
    }
    return singleFlight(packFlight, id, async () => {
      const glb = await buildGlb(id);
      packed.set(id, glb);
      while (packed.size > PACKED_CACHE_ENTRIES) packed.delete(packed.keys().next().value as string);
      return glb;
    });
  }

  return { search, packGlb };
}

export function sourceUrl(id: string): string {
  return `https://polyhaven.com/a/${id}`;
}

export function thumbnailUrl(id: string): string {
  return `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256&height=256`;
}

export type Polyhaven = ReturnType<typeof createPolyhaven>;
