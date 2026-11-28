import type { PromptCapabilitiesDTO, PromptFinish, PromptLlmProvider } from "@holoim/contracts";
import { promptLlmProviderSchema } from "@holoim/contracts";

import { env } from "../lib/env.js";

export type LlmConfig = {
  provider: PromptLlmProvider;
  apiKey?: string;
  accountId?: string;
  model: string;
  isByok: boolean;
};

export type GenerateBeatSheetInput = {
  prompt: string;
  finish: PromptFinish;
  includeVoice: boolean;
  previousSheetJson?: string | null;
  revisionNote?: string | null;
  repairErrors?: string | null;
  llm: LlmConfig;
  fetchImpl?: typeof fetch | undefined;
};

const DEFAULT_MODELS: Record<PromptLlmProvider, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  openrouter: "anthropic/claude-3.5-haiku",
  "workers-ai": "@cf/meta/llama-3.1-8b-instruct",
  mock: "mock-director-v1"
};

export const SUPPORTED_BYOK_PROVIDERS: PromptLlmProvider[] = ["anthropic", "openai", "openrouter"];

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveServerLlmConfig(): LlmConfig | null {
  const explicit = env.PROMPT_LLM_PROVIDER;
  if (explicit === "mock") {
    return { provider: "mock", model: DEFAULT_MODELS.mock, isByok: false };
  }
  if (explicit === "anthropic" && env.ANTHROPIC_API_KEY) {
    return { provider: "anthropic", apiKey: env.ANTHROPIC_API_KEY, model: env.PROMPT_LLM_MODEL ?? DEFAULT_MODELS.anthropic, isByok: false };
  }
  if (explicit === "openai" && env.OPENAI_API_KEY) {
    return { provider: "openai", apiKey: env.OPENAI_API_KEY, model: env.PROMPT_LLM_MODEL ?? DEFAULT_MODELS.openai, isByok: false };
  }
  if (explicit === "openrouter" && env.OPENROUTER_API_KEY) {
    return { provider: "openrouter", apiKey: env.OPENROUTER_API_KEY, model: env.PROMPT_LLM_MODEL ?? DEFAULT_MODELS.openrouter, isByok: false };
  }
  if (explicit === "workers-ai" && env.WORKERS_AI_ACCOUNT_ID && env.WORKERS_AI_API_TOKEN) {
    return {
      provider: "workers-ai",
      accountId: env.WORKERS_AI_ACCOUNT_ID,
      apiKey: env.WORKERS_AI_API_TOKEN,
      model: env.PROMPT_LLM_MODEL ?? DEFAULT_MODELS["workers-ai"],
      isByok: false
    };
  }
  // Auto-detect cheapest configured server key when PROMPT_LLM_PROVIDER is unset.
  if (!explicit) {
    if (env.ANTHROPIC_API_KEY) {
      return { provider: "anthropic", apiKey: env.ANTHROPIC_API_KEY, model: env.PROMPT_LLM_MODEL ?? DEFAULT_MODELS.anthropic, isByok: false };
    }
    if (env.OPENAI_API_KEY) {
      return { provider: "openai", apiKey: env.OPENAI_API_KEY, model: env.PROMPT_LLM_MODEL ?? DEFAULT_MODELS.openai, isByok: false };
    }
    if (env.OPENROUTER_API_KEY) {
      return { provider: "openrouter", apiKey: env.OPENROUTER_API_KEY, model: env.PROMPT_LLM_MODEL ?? DEFAULT_MODELS.openrouter, isByok: false };
    }
    if (env.WORKERS_AI_ACCOUNT_ID && env.WORKERS_AI_API_TOKEN) {
      return {
        provider: "workers-ai",
        accountId: env.WORKERS_AI_ACCOUNT_ID,
        apiKey: env.WORKERS_AI_API_TOKEN,
        model: env.PROMPT_LLM_MODEL ?? DEFAULT_MODELS["workers-ai"],
        isByok: false
      };
    }
  }
  return null;
}

export function resolveLlmConfig(headers: Record<string, string | string[] | undefined>): LlmConfig | null {
  const byokKey = headerValue(headers, "x-llm-api-key");
  const byokProviderRaw = headerValue(headers, "x-llm-provider");
  const byokModel = headerValue(headers, "x-llm-model");

  if (byokKey) {
    const parsedProvider = promptLlmProviderSchema.safeParse(byokProviderRaw ?? "anthropic");
    if (!parsedProvider.success || parsedProvider.data === "mock" || parsedProvider.data === "workers-ai") {
      throw new Error("Unsupported x-llm-provider. Use anthropic, openai, or openrouter.");
    }
    return {
      provider: parsedProvider.data,
      apiKey: byokKey,
      model: byokModel ?? DEFAULT_MODELS[parsedProvider.data],
      isByok: true
    };
  }

  return resolveServerLlmConfig();
}

export function getPromptCapabilities(): PromptCapabilitiesDTO {
  const server = resolveServerLlmConfig();
  return {
    serverLlmAvailable: server !== null,
    serverProvider: server?.provider ?? null,
    voiceAvailable: env.PROMPT_ENABLE_VOICE,
    supportedByokProviders: SUPPORTED_BYOK_PROVIDERS
  };
}

export function redactSecret(text: string, secret?: string): string {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join("[REDACTED]");
}

const SYSTEM_PROMPT = `You direct short 3D holograms (5 to 9 seconds) as valid JSON beat sheets for HoloIM's house avatar.
Output ONLY raw JSON (no markdown, no explanation).

Schema:
{
  "title": "Short title (2-6 words)",
  "intent": "One sentence describing what the viewer sees and feels.",
  "story": {
    "setup": { "says": "...", "see": ["..."] },
    "event": { "says": "...", "see": ["..."] },
    "reaction": { "says": "...", "see": ["..."] }
  },
  "duration": 6,
  "performers": [
    {
      "id": "me",
      "avatar": "house:clay",
      "at": [0, 0],
      "facing": 0,
      "seed": 7,
      "look": {
        "build": "slight|medium|broad",
        "skin": "porcelain|linen|goldenSand|honey|caramel|copper|umber|espresso",
        "eyes": "darkBrown|amber|mossGreen|blue|coolGrey|hazel",
        "hair": {
          "style": "sweptCrop|wavyBob|tightCoils|highBun|centrePart|shortTwists",
          "colour": "black|espresso|chestnut|copper|wheat|plum|silver|ashBrown"
        },
        "glasses": "none|round|square",
        "clothing": "oatmealSlate|rustWalnut|stormGraphite"
      }
    }
  ],
  "marks": { "viewer": [0, 1.55, 2.5] },
  "beats": [
    {
      "id": "beat1",
      "performer": "me",
      "at": 0.4,
      "hold": 1.4,
      "intent": "What happens in this beat.",
      "directions": [
        { "kind": "state", "name": "noticing", "at": "viewer" },
        { "kind": "look", "at": "viewer", "head": 0.8 },
        { "kind": "expression", "shape": "smile", "strength": 0.85 },
        { "kind": "gesture", "name": "wave", "side": "right", "count": 2 }
      ],
      "say": { "text": "Short spoken line (3-12 words).", "voice": "local:af_heart" }
    }
  ]
}

Rules:
- Use ONLY these expressions: smile, small-smile, sad, hope, held, resolve, breath, eyes-down, noticing, concerned.
- Use ONLY these gestures: wave (optional side "left"|"right", count 1-3), nod, head-shake, shrug, rub, hand-to-chest.
- Use ONLY these states: noticing, concerned.
- Use ONLY these hand shapes (kind "hand", side "left"|"right", shape): relaxed, open, reach, fist, point, grip, withheld, pinch.
- Other allowed directions: look (at, head 0..1), weight (to -1..1), bend (amount 0..1), turn (degrees, body "upper"|"whole").
- Do NOT invent props, external URLs, or unknown fields. Keep performers to 1 (or 2 max at [-0.6, 0] and [0.6, 0]).
- Keep duration between 5 and 9 seconds, and all beat "at" times strictly inside [0.2, duration - 1.0].
- Voices (when voice is requested): "local:af_heart" (warm female) or "local:am_adam" (warm male). Keep spoken text concise (3-14 words total) so it fits inside duration.`;

function buildUserMessage(input: GenerateBeatSheetInput): string {
  const parts: string[] = [];
  if (input.previousSheetJson && input.revisionNote) {
    parts.push(`Current beat sheet JSON:\n${input.previousSheetJson}`);
    parts.push(`Revision requested by user: "${input.revisionNote}"`);
    parts.push(`Original prompt: "${input.prompt}"`);
  } else {
    parts.push(`Create a hologram beat sheet for this prompt: "${input.prompt}"`);
  }
  parts.push(`Required avatar finish: "house:${input.finish}".`);
  if (input.includeVoice) {
    parts.push(`Include 1 short natural spoken line ("say": { "text": "...", "voice": "local:af_heart" or "local:am_adam" }) that fits cleanly inside the duration.`);
  } else {
    parts.push(`Do NOT include any "say" fields (silent acting only).`);
  }
  if (input.repairErrors) {
    parts.push(`Your previous JSON failed validation with these errors — fix every one and return valid JSON only:\n${input.repairErrors}`);
  }
  return parts.join("\n\n");
}

function extractJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json|jsonc)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("LLM response did not contain a JSON object.");
  }
  const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LLM response was not a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

/** Deterministic zero-cost mock director for tests and offline local dev. */
function buildMockBeatSheet(input: GenerateBeatSheetInput): Record<string, unknown> {
  const text = `${input.prompt} ${input.revisionNote ?? ""}`.toLowerCase();
  const isSad = /\b(sad|sorry|miss|goodbye|tired|worried|concern)\b/.test(text);
  const isShrug = /\b(shrug|dunno|confused|wonder|question)\b/.test(text);
  const isNod = /\b(nod|agree|yes|proud|ready|finally)\b/.test(text);
  const isMaleVoice = /\b(he|him|man|boy|dad|brother|guy|adam)\b/.test(text);

  const primaryExpression = isSad ? "sad" : "smile";
  const primaryGesture = isShrug ? { kind: "gesture", name: "shrug" } : isNod ? { kind: "gesture", name: "nod" } : { kind: "gesture", name: "wave", side: "right", count: 2 };
  const titleWords = input.prompt
    .replace(/[^a-zA-Z0-9\s'-]/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join(" ");
  const title = titleWords ? titleWords[0]!.toUpperCase() + titleWords.slice(1) : "Directed Hologram";

  const quotedMatch = input.prompt.match(/["'“]([^"'”]{2,80})["'”]/);
  const spokenLine = quotedMatch?.[1] ?? (isSad ? "I just wanted to tell you I care." : "Hey there, good to see you.");

  const beats: Array<Record<string, unknown>> = [
    {
      id: "notice",
      performer: "me",
      at: 0.3,
      hold: 1.2,
      intent: "They notice the viewer and look up.",
      directions: [
        { kind: "state", name: isSad ? "concerned" : "noticing", at: "viewer" },
        { kind: "look", at: "viewer", head: 0.8 }
      ]
    },
    {
      id: "react",
      performer: "me",
      at: 1.6,
      hold: 2.6,
      intent: input.revisionNote ? `Revised moment: ${input.revisionNote}` : `Expresses: ${title}`,
      directions: [
        { kind: "expression", shape: primaryExpression, strength: 0.85 },
        { kind: "look", at: "viewer", head: 0.8 },
        primaryGesture
      ],
      ...(input.includeVoice
        ? { say: { text: spokenLine, voice: isMaleVoice ? "local:am_adam" : "local:af_heart" } }
        : {})
    },
    {
      id: "settle",
      performer: "me",
      at: 4.5,
      hold: 1.1,
      intent: "They settle warmly with a gentle nod.",
      directions: [
        { kind: "gesture", name: "nod" },
        { kind: "expression", shape: isSad ? "hope" : "small-smile", strength: 0.75 }
      ]
    }
  ];

  return {
    title,
    intent: input.prompt.slice(0, 140),
    story: {
      setup: { says: "Someone stands quietly on stage.", see: ["calm stance, eyes lifting"] },
      event: { says: input.prompt.slice(0, 120), see: ["head turns to viewer", "gesture begins"] },
      reaction: { says: isSad ? "They share a quiet moment." : "They warm up and connect.", see: [primaryExpression, "gentle nod"] }
    },
    duration: 6,
    performers: [
      {
        id: "me",
        avatar: `house:${input.finish}`,
        at: [0, 0],
        facing: 0,
        seed: 7,
        look: {
          build: "medium",
          skin: "caramel",
          eyes: "darkBrown",
          hair: { style: "wavyBob", colour: "espresso" },
          glasses: "none",
          clothing: "rustWalnut"
        }
      }
    ],
    marks: { viewer: [0, 1.55, 2.5] },
    beats
  };
}

export async function generateBeatSheet(input: GenerateBeatSheetInput): Promise<Record<string, unknown>> {
  const { llm } = input;
  if (llm.provider === "mock") {
    return buildMockBeatSheet(input);
  }

  const fetchFn = input.fetchImpl ?? fetch;
  const userMessage = buildUserMessage(input);

  try {
    if (llm.provider === "anthropic") {
      const response = await fetchFn("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": llm.apiKey ?? "",
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: llm.model,
          max_tokens: 1800,
          temperature: 0.6,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMessage }]
        })
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Anthropic API error (${response.status}): ${text.slice(0, 200)}`);
      }
      const data = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
      const text = data.content?.find((c) => c.type === "text")?.text ?? "";
      return extractJsonObject(text);
    }

    if (llm.provider === "openai" || llm.provider === "openrouter") {
      const url =
        llm.provider === "openrouter"
          ? "https://openrouter.ai/api/v1/chat/completions"
          : "https://api.openai.com/v1/chat/completions";
      const response = await fetchFn(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${llm.apiKey ?? ""}`,
          ...(llm.provider === "openrouter" ? { "HTTP-Referer": env.WEB_ORIGIN, "X-Title": "HoloIM" } : {})
        },
        body: JSON.stringify({
          model: llm.model,
          temperature: 0.6,
          max_tokens: 1800,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userMessage }
          ]
        })
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`${llm.provider} API error (${response.status}): ${text.slice(0, 200)}`);
      }
      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = data.choices?.[0]?.message?.content ?? "";
      return extractJsonObject(text);
    }

    if (llm.provider === "workers-ai") {
      const origin = env.WORKERS_AI_API_ORIGIN.replace(/\/$/, "");
      const url = `${origin}/accounts/${llm.accountId}/ai/run/${llm.model}`;
      const response = await fetchFn(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${llm.apiKey ?? ""}`
        },
        body: JSON.stringify({
          max_tokens: 1800,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userMessage }
          ]
        })
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Workers AI error (${response.status}): ${text.slice(0, 200)}`);
      }
      const data = (await response.json()) as { result?: { response?: string } };
      const text = data.result?.response ?? "";
      return extractJsonObject(text);
    }

    throw new Error(`Unsupported LLM provider: ${llm.provider}`);
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    throw new Error(redactSecret(raw, llm.apiKey));
  }
}
