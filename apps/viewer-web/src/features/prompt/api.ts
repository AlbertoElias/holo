import {
  hologramDtoSchema,
  promptCapabilitiesSchema,
  promptJobDtoSchema,
  type CreatePromptRequest,
  type HologramDTO,
  type PromptCapabilitiesDTO,
  type PromptJobDTO,
  type PromptLlmProvider,
  type PublishPromptRequest,
  type RevisePromptRequest
} from "@holoim/contracts";

import { authHeaders } from "../auth/auth";

const apiOrigin = import.meta.env.VITE_API_ORIGIN ?? "";
const apiBase = `${apiOrigin}/api`;

const BYOK_STORAGE_KEY = "holoim.prompt.byok";

export type ByokConfig = {
  provider: Extract<PromptLlmProvider, "anthropic" | "openai" | "openrouter">;
  apiKey: string;
  model: string;
};

export function loadByokConfig(): ByokConfig {
  if (typeof window === "undefined") {
    return { provider: "anthropic", apiKey: "", model: "" };
  }
  try {
    const raw = window.localStorage.getItem(BYOK_STORAGE_KEY);
    if (!raw) return { provider: "anthropic", apiKey: "", model: "" };
    const parsed = JSON.parse(raw) as Partial<ByokConfig>;
    const provider =
      parsed.provider === "openai" || parsed.provider === "openrouter" ? parsed.provider : "anthropic";
    return {
      provider,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      model: typeof parsed.model === "string" ? parsed.model : ""
    };
  } catch {
    return { provider: "anthropic", apiKey: "", model: "" };
  }
}

export function saveByokConfig(config: ByokConfig): void {
  if (typeof window === "undefined") return;
  if (!config.apiKey.trim()) {
    window.localStorage.removeItem(BYOK_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(BYOK_STORAGE_KEY, JSON.stringify(config));
}

export function clearByokConfig(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(BYOK_STORAGE_KEY);
}

function byokHeaders(byok?: ByokConfig): Record<string, string> {
  if (!byok || !byok.apiKey.trim()) return {};
  return {
    "x-llm-provider": byok.provider,
    "x-llm-api-key": byok.apiKey.trim(),
    ...(byok.model.trim() ? { "x-llm-model": byok.model.trim() } : {})
  };
}

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? fallback;
}

export async function fetchPromptCapabilities(): Promise<PromptCapabilitiesDTO> {
  const response = await fetch(`${apiBase}/prompts/capabilities`);
  if (!response.ok) {
    throw new Error(await readError(response, "Could not load prompt capabilities."));
  }
  return promptCapabilitiesSchema.parse(await response.json());
}

export async function createPromptJob(input: CreatePromptRequest, byok?: ByokConfig): Promise<PromptJobDTO> {
  const response = await fetch(`${apiBase}/prompts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders(),
      ...byokHeaders(byok)
    },
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    throw new Error(await readError(response, "Could not start hologram generation."));
  }
  return promptJobDtoSchema.parse(await response.json());
}

export async function getPromptJob(id: string): Promise<PromptJobDTO> {
  const response = await fetch(`${apiBase}/prompts/${encodeURIComponent(id)}`, {
    headers: authHeaders()
  });
  if (!response.ok) {
    throw new Error(await readError(response, "Could not check generation status."));
  }
  return promptJobDtoSchema.parse(await response.json());
}

export async function fetchPromptPreviewBlobUrl(id: string): Promise<string> {
  const response = await fetch(`${apiBase}/prompts/${encodeURIComponent(id)}/preview.glb`, {
    headers: authHeaders()
  });
  if (!response.ok) {
    throw new Error(await readError(response, "Could not load hologram preview."));
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

export async function revisePromptJob(
  id: string,
  input: RevisePromptRequest,
  byok?: ByokConfig
): Promise<PromptJobDTO> {
  const response = await fetch(`${apiBase}/prompts/${encodeURIComponent(id)}/revise`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders(),
      ...byokHeaders(byok)
    },
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    throw new Error(await readError(response, "Could not revise hologram."));
  }
  return promptJobDtoSchema.parse(await response.json());
}

export async function publishPromptJob(id: string, input: PublishPromptRequest = { quickLookEnabled: true }): Promise<HologramDTO> {
  const response = await fetch(`${apiBase}/prompts/${encodeURIComponent(id)}/publish`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders()
    },
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    throw new Error(await readError(response, "Could not publish hologram."));
  }
  return hologramDtoSchema.parse(await response.json());
}
