import { NodeIO, type Document } from "@gltf-transform/core";

import {
  HOLOIM_CREDIT_EXTRAS_KEY,
  formatCredit,
  objectCreditSchema,
  type ObjectCredit,
  type ObjectLicence
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

/**
 * Poly Pizza (PRD-060 slice 2): thousands of light low-poly GLBs, CC0 or
 * CC-BY. Unlike Poly Haven a result states no file size, so each candidate's
 * GLB is downloaded and vetted before it is offered, and the vetted, credited
 * GLB is kept for the pick that follows. Its API terms require crediting the
 * author and naming Poly Pizza with a link, which the credit does.
 */

const SEARCH_TTL_MS = 10 * 60 * 1000;
const MODEL_TTL_MS = 60 * 60 * 1000;
/** Results asked of the API; the first ones that pass vetting are offered. */
const API_RESULTS = 16;
const VET_CONCURRENCY = 4;
/** A search answers with what has passed vetting by then; the rest keeps vetting for the next search. */
const SEARCH_DEADLINE_MS = 2000;
/** GLB downloads in flight across all searches and picks, so concurrent searches cannot multiply them. */
const DOWNLOADS_IN_FLIGHT = 4;
const SEARCH_CACHE_ENTRIES = 100;
const PACKED_CACHE_ENTRIES = 20;
const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;

/** The model itself is unusable (not a GLB, compressed, rigged, external files); remembered so it is not downloaded again. */
class RefusedModelError extends UpstreamError {}

export const POLYPIZZA_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

export type PolypizzaConfig = {
  /** API base including the version, e.g. https://api.poly.pizza/v1.1. */
  apiOrigin: string;
  apiKey: string;
  /** Hosts the API may point downloads and thumbnails at, besides its own. */
  allowedHosts: string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  searchDeadlineMs?: number;
};

export type PolypizzaModel = {
  id: string;
  title: string;
  author: string;
  licence: ObjectLicence;
  thumbnailUrl: string;
  downloadUrl: string;
};

export type PolypizzaCandidate = PolypizzaModel & { bytes: number };

/** The licences a take may redistribute; Poly Pizza also has CC-BY 3.0 models, which are left out. */
function licenceOf(value: unknown): ObjectLicence | null {
  if (typeof value !== "string") return null;
  const label = value.trim().toUpperCase().replace(/\s+/g, " ");
  if (label === "CC0 1.0" || label === "CC0") return "CC0-1.0";
  if (label === "CC-BY 4.0" || label === "CC BY 4.0") return "CC-BY-4.0";
  return null;
}

function trimmed(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().slice(0, max);
  return text.length > 0 ? text : null;
}

/** The glTF JSON of a GLB, or null when the bytes are not a GLB. */
function glbJson(bytes: Uint8Array): Record<string, unknown> | null {
  if (bytes.byteLength < 20) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) return null;
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== JSON_CHUNK || 20 + length > bytes.byteLength) return null;
  try {
    return asRecord(JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length))));
  } catch {
    return null;
  }
}

/** A GLB must carry everything itself: an external buffer or image would be fetched from wherever it points. */
function hasExternalUri(json: Record<string, unknown>): boolean {
  const entries = [json.buffers, json.images].flatMap((list) => (Array.isArray(list) ? list : []));
  return entries.some((entry) => {
    const uri = asRecord(entry).uri;
    return typeof uri === "string" && !uri.startsWith("data:");
  });
}

export function createPolypizza(config: PolypizzaConfig) {
  const now = config.now ?? Date.now;
  const searchDeadlineMs = config.searchDeadlineMs ?? SEARCH_DEADLINE_MS;
  const apiOrigin = config.apiOrigin.replace(/\/+$/, "");
  const apiHost = new URL(apiOrigin).hostname.toLowerCase();
  // Poly Pizza asks for the key on its file host too.
  const { isAllowedUrl, request, requestJson } = createRegistryFetch({
    name: "Poly Pizza",
    allowedHosts: [apiHost, ...config.allowedHosts],
    fetchImpl: config.fetchImpl,
    headers: { "x-auth-token": config.apiKey }
  });

  const searches = new Map<string, { at: number; models: PolypizzaModel[] }>();
  const searchFlight = new Map<string, Promise<PolypizzaModel[]>>();
  const models = new Map<string, { at: number; model: PolypizzaModel }>();
  const modelFlight = new Map<string, Promise<PolypizzaModel>>();
  /** Outcome of vetting by id: the packed size, or the reason it was refused. */
  const vetted = new Map<string, { at: number; bytes: number } | { at: number; refused: true }>();
  const packed = new Map<string, Uint8Array>();
  const packFlight = new Map<string, Promise<Uint8Array>>();
  let downloading = 0;
  const waiting: Array<() => void> = [];

  async function download(url: string): Promise<Uint8Array<ArrayBuffer>> {
    if (downloading >= DOWNLOADS_IN_FLIGHT) await new Promise<void>((resolve) => waiting.push(resolve));
    downloading += 1;
    try {
      return await request(url, MAX_DOWNLOAD_BYTES);
    } finally {
      downloading -= 1;
      waiting.shift()?.();
    }
  }

  function parseModel(value: unknown): PolypizzaModel | null {
    const record = asRecord(value);
    const id = typeof record.ID === "string" ? record.ID : "";
    if (!POLYPIZZA_ID_PATTERN.test(id)) return null;
    const licence = licenceOf(record.Licence);
    const title = trimmed(record.Title, 200);
    const author = trimmed(asRecord(record.Creator).Username, 200);
    const downloadUrl = typeof record.Download === "string" ? record.Download : "";
    const thumbnailUrl = typeof record.Thumbnail === "string" ? record.Thumbnail : "";
    if (!licence || !title || !author || !isAllowedUrl(downloadUrl) || !isAllowedUrl(thumbnailUrl)) return null;
    return { id, title, author, licence, thumbnailUrl, downloadUrl };
  }

  function remember(model: PolypizzaModel) {
    models.set(model.id, { at: now(), model });
  }

  function searchApi(query: string): Promise<PolypizzaModel[]> {
    const key = query.toLowerCase();
    const cached = searches.get(key);
    if (cached && now() - cached.at < SEARCH_TTL_MS) return Promise.resolve(cached.models);
    return singleFlight(searchFlight, key, async () => {
      const raw = asRecord(await requestJson(`${apiOrigin}/search/${encodeURIComponent(query)}?Limit=${API_RESULTS}`));
      const found = (Array.isArray(raw.results) ? raw.results : [])
        .map(parseModel)
        .filter((model): model is PolypizzaModel => model !== null);
      for (const model of found) remember(model);
      searches.set(key, { at: now(), models: found });
      while (searches.size > SEARCH_CACHE_ENTRIES) searches.delete(searches.keys().next().value as string);
      return found;
    });
  }

  function loadModel(id: string): Promise<PolypizzaModel> {
    const cached = models.get(id);
    if (cached && now() - cached.at < MODEL_TTL_MS) return Promise.resolve(cached.model);
    return singleFlight(modelFlight, id, async () => {
      let raw: unknown;
      try {
        raw = await requestJson(`${apiOrigin}/model/${encodeURIComponent(id)}`);
      } catch (error) {
        if (error instanceof UpstreamError && error.status === 404) throw new UnknownObjectError("No such Poly Pizza model.");
        throw error;
      }
      const model = parseModel(raw);
      // A model with a licence a take may not redistribute is, for this API, not a model.
      if (!model || model.id !== id) throw new UnknownObjectError("No such Poly Pizza model.");
      remember(model);
      return model;
    });
  }

  function creditFor(model: PolypizzaModel): ObjectCredit {
    return objectCreditSchema.parse({
      source: "Poly Pizza",
      sourceUrl: sourceUrl(model.id),
      title: model.title,
      author: model.author,
      licence: model.licence
    });
  }

  async function buildGlb(model: PolypizzaModel): Promise<Uint8Array> {
    const source = await download(model.downloadUrl);
    const json = glbJson(source);
    if (!json) throw new RefusedModelError("Poly Pizza returned a file that is not a GLB.");
    const reason = unsupportedReason(json);
    if (reason) throw new RefusedModelError(reason);
    if (hasExternalUri(json)) throw new RefusedModelError("This model refers to files outside itself.");

    let document: Document;
    try {
      document = await new NodeIO().readBinary(source);
    } catch {
      throw new RefusedModelError("Poly Pizza returned a model that could not be read.");
    }

    const credit = creditFor(model);
    const asset = document.getRoot().getAsset();
    asset.copyright = formatCredit(credit);
    asset.extras = { ...(asset.extras ?? {}), [HOLOIM_CREDIT_EXTRAS_KEY]: credit };

    const glb = await new NodeIO().writeBinary(document);
    if (glb.byteLength > MAX_PACKED_OBJECT_BYTES) throw new ObjectTooLargeError("This model is too large to use.");
    return glb;
  }

  function pack(model: PolypizzaModel): Promise<Uint8Array> {
    const hit = packed.get(model.id);
    if (hit) {
      packed.delete(model.id);
      packed.set(model.id, hit);
      return Promise.resolve(hit);
    }
    return singleFlight(packFlight, model.id, async () => {
      let glb: Uint8Array;
      try {
        glb = await buildGlb(model);
      } catch (error) {
        // Only the model's own faults are remembered; a network failure is retried next time.
        if (error instanceof RefusedModelError || error instanceof ObjectTooLargeError) vetted.set(model.id, { at: now(), refused: true });
        throw error;
      }
      vetted.set(model.id, { at: now(), bytes: glb.byteLength });
      packed.set(model.id, glb);
      while (packed.size > PACKED_CACHE_ENTRIES) packed.delete(packed.keys().next().value as string);
      return glb;
    });
  }

  /** Up to `limit` models the tray accepts, in the API's order, each already vetted and packed. */
  async function search(query: string, limit: number): Promise<PolypizzaCandidate[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return [];
    const ranked = await searchApi(trimmedQuery);

    const found: Array<PolypizzaCandidate | null> = new Array(ranked.length).fill(null);
    let markAccepted = () => {};
    const firstAccepted = new Promise<void>((resolve) => (markAccepted = resolve));
    let accepted = 0;
    let failures = 0;
    let next = 0;
    const worker = async () => {
      while (next < ranked.length && accepted < limit) {
        const index = next++;
        const model = ranked[index]!;
        const known = vetted.get(model.id);
        if (known && now() - known.at < MODEL_TTL_MS) {
          if ("bytes" in known) {
            found[index] = { ...model, bytes: known.bytes };
            accepted += 1;
            markAccepted();
          }
          continue;
        }
        try {
          const glb = await pack(model);
          found[index] = { ...model, bytes: glb.byteLength };
          accepted += 1;
          markAccepted();
        } catch (error) {
          if (!(error instanceof RefusedModelError || error instanceof ObjectTooLargeError)) failures += 1;
        }
      }
    };
    const vetting = Promise.all(Array.from({ length: Math.min(VET_CONCURRENCY, ranked.length) }, worker));
    // Vetting may outlive this search, so a late rejection must not go unhandled.
    vetting.catch(() => undefined);
    // One stalled download must not hold the search for the whole fetch timeout:
    // answer at the deadline with what has passed, unless nothing has yet.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, searchDeadlineMs);
      timer.unref();
    });
    await Promise.race([vetting, deadline]);
    if (accepted === 0) await Promise.race([vetting, firstAccepted]);
    clearTimeout(timer);
    const results = found.filter((entry): entry is PolypizzaCandidate => entry !== null).slice(0, limit);
    if (results.length === 0 && failures > 0) throw new UpstreamError("Poly Pizza could not be reached.");
    return results;
  }

  async function packGlb(id: string): Promise<Uint8Array> {
    return pack(await loadModel(id));
  }

  return { search, packGlb };
}

export function sourceUrl(id: string): string {
  return `https://poly.pizza/m/${id}`;
}

export type Polypizza = ReturnType<typeof createPolypizza>;
