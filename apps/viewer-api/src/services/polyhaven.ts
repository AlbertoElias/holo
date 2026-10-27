import { NodeIO, type Document } from "@gltf-transform/core";

import {
  HOLOIM_CREDIT_EXTRAS_KEY,
  formatCredit,
  objectCreditSchema,
  type ObjectCredit
} from "@holoim/objects";

import {
  MAX_DOWNLOAD_BYTES,
  MAX_PACKED_OBJECT_BYTES,
  ObjectTooLargeError,
  UnknownObjectError,
  UpstreamError,
  asRecord,
  createRegistryFetch,
  singleFlight,
  unsupportedReason
} from "./registry-fetch.js";

export { MAX_PACKED_OBJECT_BYTES, ObjectTooLargeError, UnknownObjectError, UpstreamError };

const LIST_TTL_MS = 60 * 60 * 1000;
const CANDIDATES_CHECKED = 12;
const FILES_CONCURRENCY = 4;
const PACKED_CACHE_ENTRIES = 20;

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

type FileEntry = { url: string; size: number };
type GltfFiles = { gltf: FileEntry; include: Record<string, FileEntry> };

// Category shortcuts and spoken queries are plural ("chairs") while titles and
// tags are mostly singular, so both sides compare by a naive singular form.
function singular(word: string): string {
  if (word.length <= 3 || word.endsWith("ss")) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(ch|sh|x|z)es$/.test(word)) return word.slice(0, -2);
  return word.endsWith("s") ? word.slice(0, -1) : word;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
    .map(singular);
}

function asFileEntry(value: unknown): FileEntry | null {
  const record = asRecord(value);
  return typeof record.url === "string" && typeof record.size === "number" && record.size >= 0
    ? { url: record.url, size: record.size }
    : null;
}

export function createPolyhaven(config: PolyhavenConfig) {
  const now = config.now ?? Date.now;
  const apiOrigin = config.apiOrigin.replace(/\/+$/, "");
  const apiHost = new URL(apiOrigin).hostname.toLowerCase();
  const { request, requestJson } = createRegistryFetch({
    name: "Poly Haven",
    allowedHosts: [apiHost, ...config.allowedHosts],
    fetchImpl: config.fetchImpl
  });

  let list: { at: number; models: Map<string, PolyhavenModel> } | null = null;
  const listFlight = new Map<string, Promise<Map<string, PolyhavenModel>>>();
  const filesCache = new Map<string, { at: number; files: GltfFiles | null }>();
  const jsonCache = new Map<string, { at: number; json: Record<string, unknown> }>();
  const filesFlight = new Map<string, Promise<GltfFiles | null>>();
  const packed = new Map<string, Uint8Array>();
  const packFlight = new Map<string, Promise<Uint8Array>>();

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

  /** The 1k glTF JSON, fetched once per TTL alongside the files entry. */
  async function loadGltfJson(id: string, files: GltfFiles): Promise<Record<string, unknown>> {
    const cached = jsonCache.get(id);
    if (cached && now() - cached.at < LIST_TTL_MS) return cached.json;
    let json: Record<string, unknown>;
    try {
      json = asRecord(JSON.parse(new TextDecoder().decode(await request(files.gltf.url, MAX_DOWNLOAD_BYTES))));
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError("Poly Haven returned an unreadable glTF.");
    }
    jsonCache.set(id, { at: now(), json });
    return json;
  }

  function score(model: PolyhavenModel, tokens: string[]): number {
    const nameWords = tokenize(model.title);
    let total = 0;
    for (const token of tokens) {
      if (nameWords.includes(token)) total += 15;
      else if (nameWords.some((word) => word.startsWith(token))) total += 10;
      if (model.tags.some((tag) => singular(tag.toLowerCase()) === token)) total += 4;
      else if (model.tags.some((tag) => tag.toLowerCase().startsWith(token))) total += 1;
      if (model.categories.some((category) => singular(category.toLowerCase()) === token)) total += 3;
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
          if (bytes > MAX_PACKED_OBJECT_BYTES) continue;
          // Drop what capture or the packer would refuse after the user picked it.
          if (unsupportedReason(await loadGltfJson(model.id, files)) !== null) continue;
          sized[index] = { ...model, bytes };
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

    const json = await loadGltfJson(id, files);
    const reason = unsupportedReason(json);
    if (reason) throw new UpstreamError(reason);

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
