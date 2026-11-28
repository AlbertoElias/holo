import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bearer, exposeMagicLinksForTests, signIn, type SessionBody } from "./fixtures/auth.js";

// Prompt-to-hologram routes (docs/features/prompt-to-hologram.md), driven by the
// brief's failure list: auth gating, private preview isolation, BYOK key never
// persisted or leaked in errors, automatic repair retry on invalid beat sheet,
// revision chaining, idempotent publish, and real direct.ts subprocess build.

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = (name: string) => path.join(apiRoot, "node_modules", ".bin", name);

/** Minimal valid GLB header ("glTF" magic + version 2 + length 12). */
function minimalGlbBuffer(): Buffer {
  const buf = Buffer.alloc(12);
  buf.write("glTF", 0, "ascii");
  buf.writeUInt32LE(2, 4);
  buf.writeUInt32LE(12, 8);
  return buf;
}

describe("prompt-to-hologram routes", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let runner: { waitForIdle: () => Promise<void> };
  let testRoot: string;
  let previousEnv: Record<string, string | undefined>;
  let restoreExpose: () => void;
  let alice: SessionBody;
  let bob: SessionBody;
  let failNextBuildOnce = false;
  let lastFetchUrl = "";
  let lastFetchAuth = "";
  let nextFetchErrorKeyLeak: string | null = null;

  beforeAll(async () => {
    testRoot = await mkdtemp(path.join(tmpdir(), "holoim-prompt-routes-"));
    const uploadsRoot = path.join(testRoot, "uploads");
    await mkdir(uploadsRoot, { recursive: true });
    const databaseUrl = `file:${path.join(testRoot, "prompt.db")}`;
    execFileSync(bin("prisma"), ["migrate", "deploy"], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "ignore"
    });

    previousEnv = {
      DATABASE_URL: process.env.DATABASE_URL,
      PROMPT_LLM_PROVIDER: process.env.PROMPT_LLM_PROVIDER,
      PROMPT_ENABLE_VOICE: process.env.PROMPT_ENABLE_VOICE
    };
    process.env.DATABASE_URL = databaseUrl;
    process.env.PROMPT_LLM_PROVIDER = "mock";
    process.env.PROMPT_ENABLE_VOICE = "false";
    restoreExpose = exposeMagicLinksForTests();
    vi.resetModules();

    const [{ buildApp }, { prisma: prismaClient }, { createMediaStorage }, { createPromptRunner }] = await Promise.all([
      import("../src/app.js"),
      import("../src/lib/prisma.js"),
      import("../src/services/media-storage.js"),
      import("../src/services/prompt-runner.js")
    ]);
    prisma = prismaClient;
    const storage = createMediaStorage(uploadsRoot);
    const fakeFetch: typeof fetch = async (input, init) => {
      lastFetchUrl = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      lastFetchAuth = headers.authorization ?? headers["x-api-key"] ?? "";
      if (nextFetchErrorKeyLeak) {
        const leak = nextFetchErrorKeyLeak;
        nextFetchErrorKeyLeak = null;
        return new Response(`Invalid API key: ${leak}`, { status: 401 });
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  title: "BYOK Wave",
                  intent: "Waves hello from BYOK.",
                  duration: 6,
                  performers: [{ id: "me", avatar: "house:ink", at: [0, 0], facing: 0, seed: 3 }],
                  marks: { viewer: [0, 1.55, 2.5] },
                  beats: [
                    {
                      id: "wave",
                      performer: "me",
                      at: 0.5,
                      hold: 2,
                      intent: "Waves hello.",
                      directions: [{ kind: "gesture", name: "wave", side: "right", count: 2 }]
                    }
                  ]
                })
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    const promptRunner = createPromptRunner({
      storage,
      fetchImpl: fakeFetch,
      buildTake: async (sheet) => {
        if (failNextBuildOnce) {
          failNextBuildOnce = false;
          throw new Error("beat 1: unknown expression 'hyper-grin'");
        }
        const glb = minimalGlbBuffer();
        const beats = Array.isArray(sheet.beats) ? sheet.beats : [];
        return {
          glbBuffer: glb,
          sizeBytes: glb.length,
          title: typeof sheet.title === "string" ? sheet.title : "AI Hologram",
          intent: typeof sheet.intent === "string" ? sheet.intent : "",
          durationSec: typeof sheet.duration === "number" ? sheet.duration : 6,
          beatCount: beats.length,
          hasVoice: false
        };
      }
    });
    runner = promptRunner;
    app = buildApp({ logger: false, uploadsRoot, storage, promptRunner });
    await app.ready();
  });

  beforeEach(async () => {
    await prisma.promptJob.deleteMany();
    await prisma.hologram.deleteMany();
    await prisma.session.deleteMany();
    await prisma.magicLinkToken.deleteMany();
    await prisma.user.deleteMany();
    failNextBuildOnce = false;
    lastFetchUrl = "";
    lastFetchAuth = "";
    nextFetchErrorKeyLeak = null;
    alice = await signIn(app, "alice@example.com", "Alice");
    bob = await signIn(app, "bob@example.com", "Bob");
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    restoreExpose?.();
    for (const [k, v] of Object.entries(previousEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(testRoot, { recursive: true, force: true });
  });

  it("exposes capabilities and requires sign-in for prompt creation", async () => {
    const caps = await app.inject({ method: "GET", url: "/api/prompts/capabilities" });
    expect(caps.statusCode).toBe(200);
    expect(caps.json()).toMatchObject({
      serverLlmAvailable: true,
      serverProvider: "mock",
      supportedByokProviders: ["anthropic", "openai", "openrouter"]
    });

    const unauth = await app.inject({
      method: "POST",
      url: "/api/prompts",
      payload: { prompt: "Smile and wave hello" }
    });
    expect(unauth.statusCode).toBe(401);
  });

  it("keeps previews private until published, supports revise, and makes publish idempotent", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/prompts",
      headers: bearer(alice),
      payload: { prompt: "Smile warmly and wave hello", finish: "ink" }
    });
    expect(created.statusCode, created.body).toBe(202);
    const job = created.json<{ id: string }>();

    await runner.waitForIdle();

    const status = await app.inject({ method: "GET", url: `/api/prompts/${job.id}`, headers: bearer(alice) });
    expect(status.statusCode).toBe(200);
    const ready = status.json<{ status: string; previewUrl: string; finish: string; publishedHologramId: string | null }>();
    expect(ready.status).toBe("ready");
    expect(ready.finish).toBe("ink");
    expect(ready.previewUrl).toBe(`/api/prompts/${job.id}/preview.glb`);
    expect(ready.publishedHologramId).toBeNull();

    // Feed stays empty before publish.
    const feedBefore = await app.inject({ method: "GET", url: "/api/holograms" });
    expect(feedBefore.json<{ items: unknown[] }>().items).toHaveLength(0);

    // Bob cannot view, download preview, revise, or publish Alice's job.
    expect((await app.inject({ method: "GET", url: `/api/prompts/${job.id}`, headers: bearer(bob) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/prompts/${job.id}/preview.glb`, headers: bearer(bob) })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: "POST", url: `/api/prompts/${job.id}/revise`, headers: bearer(bob), payload: { note: "sadder" } })).statusCode
    ).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/prompts/${job.id}/publish`, headers: bearer(bob) })).statusCode).toBe(404);

    // Alice can download her private preview GLB.
    const preview = await app.inject({ method: "GET", url: `/api/prompts/${job.id}/preview.glb`, headers: bearer(alice) });
    expect(preview.statusCode).toBe(200);
    expect(preview.rawPayload.subarray(0, 4).toString("ascii")).toBe("glTF");

    // Alice revises the hologram.
    const revised = await app.inject({
      method: "POST",
      url: `/api/prompts/${job.id}/revise`,
      headers: bearer(alice),
      payload: { note: "Make it sadder and slower", finish: "light" }
    });
    expect(revised.statusCode).toBe(202);
    const revisedJob = revised.json<{ id: string; parentJobId: string; finish: string }>();
    expect(revisedJob.parentJobId).toBe(job.id);
    expect(revisedJob.finish).toBe("light");
    await runner.waitForIdle();

    // Alice publishes the revised job; second publish is idempotent.
    const pub1 = await app.inject({
      method: "POST",
      url: `/api/prompts/${revisedJob.id}/publish`,
      headers: bearer(alice),
      payload: { hologramName: "Quiet Goodbye" }
    });
    expect(pub1.statusCode, pub1.body).toBe(201);
    const holo1 = pub1.json<{ id: string; hologramName: string; submittedBy: string }>();
    expect(holo1.hologramName).toBe("Quiet Goodbye");
    expect(holo1.submittedBy).toBe("Alice");

    const pub2 = await app.inject({
      method: "POST",
      url: `/api/prompts/${revisedJob.id}/publish`,
      headers: bearer(alice)
    });
    expect(pub2.statusCode).toBe(200);
    expect(pub2.json<{ id: string }>().id).toBe(holo1.id);

    const feedAfter = await app.inject({ method: "GET", url: "/api/holograms" });
    expect(feedAfter.json<{ items: Array<{ id: string }> }>().items.map((i) => i.id)).toEqual([holo1.id]);
  });

  it("uses BYOK headers without persisting or leaking the API key", async () => {
    const secretKey = "sk-byok-super-secret-12345";
    const ok = await app.inject({
      method: "POST",
      url: "/api/prompts",
      headers: { ...bearer(alice), "x-llm-provider": "openai", "x-llm-api-key": secretKey },
      payload: { prompt: "Wave hello in ink style", finish: "ink" }
    });
    expect(ok.statusCode).toBe(202);
    const okJob = ok.json<{ id: string }>();
    await runner.waitForIdle();

    expect(lastFetchUrl).toBe("https://api.openai.com/v1/chat/completions");
    expect(lastFetchAuth).toBe(`Bearer ${secretKey}`);

    const row = await prisma.promptJob.findUnique({ where: { id: okJob.id } });
    expect(row?.status).toBe("ready");
    expect(JSON.stringify(row)).not.toContain(secretKey);

    // If upstream echoes the key in an error, it must be redacted before saving.
    nextFetchErrorKeyLeak = secretKey;
    const failed = await app.inject({
      method: "POST",
      url: "/api/prompts",
      headers: { ...bearer(alice), "x-llm-provider": "openai", "x-llm-api-key": secretKey },
      payload: { prompt: "Trigger error" }
    });
    const failJob = failed.json<{ id: string }>();
    await runner.waitForIdle();

    const failedRow = await prisma.promptJob.findUnique({ where: { id: failJob.id } });
    expect(failedRow?.status).toBe("failed");
    expect(failedRow?.error).toContain("[REDACTED]");
    expect(failedRow?.error).not.toContain(secretKey);
  });

  it("retries once with repair when the first build fails validation", async () => {
    failNextBuildOnce = true;
    const res = await app.inject({
      method: "POST",
      url: "/api/prompts",
      headers: bearer(alice),
      payload: { prompt: "Wave and smile" }
    });
    const job = res.json<{ id: string }>();
    await runner.waitForIdle();

    const status = await app.inject({ method: "GET", url: `/api/prompts/${job.id}`, headers: bearer(alice) });
    expect(status.json<{ status: string }>().status).toBe("ready");
  });

  it("builds a real GLB through the direct.ts subprocess", async () => {
    const { buildPromptTakeWithDirect } = await import("../src/services/prompt-builder.js");
    const { generateBeatSheet } = await import("../src/services/prompt-llm.js");
    const sheet = await generateBeatSheet({
      prompt: "Smile warmly and wave hello",
      finish: "clay",
      includeVoice: false,
      llm: { provider: "mock", model: "mock-director-v1", isByok: false }
    });
    const built = await buildPromptTakeWithDirect(sheet, { timeoutMs: 150_000 });
    expect(built.sizeBytes).toBeGreaterThan(100_000);
    expect(built.glbBuffer.subarray(0, 4).toString("ascii")).toBe("glTF");
    expect(built.beatCount).toBeGreaterThanOrEqual(3);
  }, 160_000);
});
