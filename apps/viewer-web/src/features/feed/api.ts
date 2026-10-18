import type { HologramDTO, InitiateUploadResponse, PaginatedHolograms } from "@holoim/contracts";
import {
  hologramDtoSchema,
  initiateUploadResponseSchema,
  paginatedHologramsSchema
} from "@holoim/contracts";

const apiOrigin = import.meta.env.VITE_API_ORIGIN ?? "";
const apiBase = `${apiOrigin}/api`;

function resolveApiBaseForMessage(): string {
  if (apiBase.startsWith("http://") || apiBase.startsWith("https://")) {
    return apiBase;
  }

  if (typeof window !== "undefined") {
    return `${window.location.origin}${apiBase}`;
  }

  return apiBase;
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? fallback;
}

export async function fetchHolograms(cursor?: string, limit = 10): Promise<PaginatedHolograms> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) {
    params.set("cursor", cursor);
  }

  let response: Response;
  try {
    response = await fetch(`${apiBase}/holograms?${params.toString()}`);
  } catch {
    throw new Error(`Unable to reach API at ${resolveApiBaseForMessage()}. Start the API server and try again.`);
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `Failed to fetch holograms (${response.status}).`));
  }

  return paginatedHologramsSchema.parse(await response.json());
}

export async function fetchHologram(id: string): Promise<HologramDTO> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}/holograms/${id}`);
  } catch {
    throw new Error(`Unable to reach API at ${resolveApiBaseForMessage()}. Start the API server and try again.`);
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `Failed to fetch hologram (${response.status}).`));
  }

  return hologramDtoSchema.parse(await response.json());
}

export type UploadHologramInput = {
  file: File;
  hologramName: string;
  submittedBy: string;
};

async function uploadMultipart(input: UploadHologramInput): Promise<HologramDTO> {
  const formData = new FormData();
  // Fastify consumes multipart serially. Send metadata before the large file
  // so it is available throughout streaming upload processing.
  formData.set("hologramName", input.hologramName);
  formData.set("submittedBy", input.submittedBy);
  formData.set("file", input.file);

  let response: Response;
  try {
    response = await fetch(`${apiBase}/holograms`, {
      method: "POST",
      body: formData
    });
  } catch {
    throw new Error(`Unable to reach API at ${apiBase}. Check that the API is running and CORS is configured.`);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: "Upload failed." }))) as { error?: string };
    throw new Error(body.error ?? "Upload failed.");
  }

  return hologramDtoSchema.parse(await response.json());
}

async function tryInitiateDirectUpload(input: UploadHologramInput): Promise<InitiateUploadResponse | null> {
  try {
    const response = await fetch(`${apiBase}/holograms/uploads/initiate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filenameOriginal: input.file.name,
        hologramName: input.hologramName,
        submittedBy: input.submittedBy,
        sizeBytes: input.file.size,
        mimeType: input.file.type || "model/gltf-binary"
      })
    });
    if (!response.ok) {
      return null;
    }
    return initiateUploadResponseSchema.parse(await response.json());
  } catch {
    return null;
  }
}

export async function uploadHologram(input: UploadHologramInput): Promise<HologramDTO> {
  const initiated = await tryInitiateDirectUpload(input);
  if (!initiated || initiated.mode === "multipart") {
    return uploadMultipart(input);
  }

  // Direct path: bytes go straight to object storage; the API only
  // validates and registers the result on complete.
  const formData = new FormData();
  for (const [key, value] of Object.entries(initiated.formFields)) {
    formData.set(key, value);
  }
  formData.set("file", input.file);

  const storageResponse = await fetch(initiated.uploadUrl, { method: "POST", body: formData });
  if (!storageResponse.ok) {
    throw new Error(`Direct upload to storage failed (${storageResponse.status}).`);
  }

  let completeResponse: Response;
  try {
    completeResponse = await fetch(`${apiBase}/holograms/uploads/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intentId: initiated.intentId })
    });
  } catch {
    throw new Error(`Unable to reach API at ${apiBase}. Check that the API is running and CORS is configured.`);
  }

  if (!completeResponse.ok) {
    throw new Error(await readErrorMessage(completeResponse, "Upload completion failed."));
  }

  return hologramDtoSchema.parse(await completeResponse.json());
}

export function resolveMediaUrl(urlPath: string): string {
  if (/^(https?:)?\/\//i.test(urlPath) || urlPath.startsWith("data:") || urlPath.startsWith("blob:")) {
    return urlPath;
  }
  return `${apiOrigin}${urlPath}`;
}
