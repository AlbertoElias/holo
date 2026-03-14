import type { HologramDTO, PaginatedHolograms } from "@holoim/contracts";
import { hologramDtoSchema, paginatedHologramsSchema } from "@holoim/contracts";

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

export async function uploadHologram(input: UploadHologramInput): Promise<HologramDTO> {
  const formData = new FormData();
  formData.set("file", input.file);
  formData.set("hologramName", input.hologramName);
  formData.set("submittedBy", input.submittedBy);

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

export function resolveMediaUrl(urlPath: string): string {
  return `${apiOrigin}${urlPath}`;
}
