import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { APIRequestContext, Browser, TestInfo } from "@playwright/test";
import { createXrContext, waitForTextContentPrefix } from "@holoim/tooling-testing/xr-env";
import { CONTROL_NAMES } from "@holoim/xr-ui-core";

import { captureEvidence, expect } from "./bootstrap";

// One real walking take per Playwright worker, shared by the pipeline specs
// that need the same content (capture-to-viewer's Quick Look path and
// bubble-capture's feed and AR draws). It is recorded in the running capture
// app on first use, never committed, and written to a fixed path under
// output/ so the Quick Look tool check (apps/viewer-api test:usdz-tools) can
// run on the same export. Specs that need other content (pointing, object,
// summon, avatar formats) record their own. Capture's own XR recording check
// still runs separately, so sharing the take hides no capture regression.

const captureUrl = process.env.E2E_CAPTURE_URL ?? "https://127.0.0.1:5175/";
export const RECORDED_SECONDS = 1.5;
/** Where the shared walk take lands; the USDZ tool check reads it from here. */
export const WALK_TAKE_PATH = path.resolve(import.meta.dirname, "../../../output/pipeline-takes/walk.glb");

type CaptureWindow = Window & {
  __setManualClock: (enabled: boolean) => void;
  __setMockInput: (input: { forward?: boolean }) => void;
  advanceTime: (ms: number) => void;
  __pipelineAudioBytes?: number;
};

export type GltfJson = {
  animations?: Array<{ samplers: Array<{ input: number }> }>;
  accessors?: Array<{ max?: number[] }>;
  nodes?: Array<{ name?: string }>;
  skins?: unknown[];
  extensions?: Record<string, unknown>;
};

export type WalkTake = { glbPath: string; bytes: Buffer; gltf: GltfJson };

export function readGlbJson(bytes: Buffer): GltfJson {
  expect(bytes.readUInt32LE(0), "GLB magic").toBe(0x46546c67);
  expect(bytes.readUInt32LE(4), "GLB version").toBe(2);
  expect(bytes.readUInt32LE(8), "GLB declared length").toBe(bytes.length);
  const jsonLength = bytes.readUInt32LE(12);
  expect(bytes.readUInt32LE(16), "first chunk is JSON").toBe(0x4e4f534a);
  return JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8")) as GltfJson;
}

function animationDurationSeconds(gltf: GltfJson): number {
  let duration = 0;
  for (const animation of gltf.animations ?? []) {
    for (const sampler of animation.samplers) {
      duration = Math.max(duration, gltf.accessors?.[sampler.input]?.max?.[0] ?? 0);
    }
  }
  return duration;
}

let walkTake: Promise<WalkTake> | undefined;

/**
 * The shared walking take: settle, walk forward for 70% of 1.5 s, stand, with
 * Chromium's synthetic microphone recorded through the real MediaRecorder.
 * A failed recording fails every spec that asks for it, with the same error.
 */
export function recordWalkTake(browser: Browser, testInfo: TestInfo): Promise<WalkTake> {
  walkTake ??= recordWalk(browser, testInfo);
  return walkTake;
}

async function recordWalk(browser: Browser, testInfo: TestInfo): Promise<WalkTake> {
  const context = await createXrContext(browser);
  try {
    const capture = await context.newPage();
    // Exercise the real microphone → MediaRecorder → embedded WebM path using
    // Chromium's synthetic microphone. A timeslice lets us await captured bytes
    // instead of assuming an arbitrary wall-clock delay produced audio.
    await capture.addInitScript(() => {
      const originalStart = MediaRecorder.prototype.start;
      MediaRecorder.prototype.start = function () {
        this.addEventListener("dataavailable", (event) => {
          if (event.data.size > 0) (window as CaptureWindow).__pipelineAudioBytes = event.data.size;
        });
        originalStart.call(this, 100);
      };
    });
    const captureErrors: string[] = [];
    capture.on("pageerror", (error) => captureErrors.push(`pageerror: ${error.message}`));
    capture.on("console", (message) => {
      if (message.type() === "error") captureErrors.push(`console.error: ${message.text()}`);
    });

    await capture.goto(captureUrl, { waitUntil: "networkidle" });
    await waitForTextContentPrefix(capture, "#status", "loaded");
    await capture.evaluate(() => {
      const hooks = window as CaptureWindow;
      hooks.__setManualClock(true);
      // Let spawn gravity/contact settle before recording a walking phone demo.
      hooks.advanceTime(5000);
    });

    await capture.getByRole("button", { name: CONTROL_NAMES.startRecording }).click();
    await expect(capture.getByRole("button", { name: CONTROL_NAMES.stopRecording })).toBeVisible();
    // Walk forward so the export carries real root motion and locomotion clips.
    // Real time passes between steps so the microphone records real audio.
    const steps = 30;
    for (let step = 0; step < steps; step += 1) {
      await delay(RECORDED_SECONDS * 1000 / steps);
      await capture.evaluate(({ moving, milliseconds }) => {
        const hooks = window as CaptureWindow;
        hooks.__setMockInput({ forward: moving });
        hooks.advanceTime(milliseconds);
      }, { moving: step < steps * 0.7, milliseconds: RECORDED_SECONDS * 1000 / steps });
    }
    await expect.poll(() => capture.evaluate(() => (window as CaptureWindow).__pipelineAudioBytes ?? 0),
      { message: "real MediaRecorder produced microphone audio" }).toBeGreaterThan(0);
    await captureEvidence(capture, testInfo, "capture-recording-in-progress");
    const downloadPromise = capture.waitForEvent("download");
    await capture.getByRole("button", { name: CONTROL_NAMES.stopRecording }).click();
    await mkdir(path.dirname(WALK_TAKE_PATH), { recursive: true });
    await (await downloadPromise).saveAs(WALK_TAKE_PATH);
    await capture.close();
    expect(captureErrors, "capture runtime errors").toEqual([]);
  } finally {
    await context.close();
  }

  const bytes = await readFile(WALK_TAKE_PATH);
  const gltf = readGlbJson(bytes);
  expect(gltf.extensions?.KHR_audio, "real recording embeds audio").toBeDefined();
  expect(gltf.skins?.length ?? 0, "exported skins").toBeGreaterThan(0);
  expect(gltf.nodes?.some((node) => node.name === "RecordedBubbleSphere"), "exported scene bubble").toBe(true);
  expect(animationDurationSeconds(gltf), "exported animation length").toBeGreaterThan(RECORDED_SECONDS * 0.9);
  return { glbPath: WALK_TAKE_PATH, bytes, gltf };
}

/**
 * Waits on the hologram's own conversion state (GET /api/holograms/:id) at a
 * short interval. Unlike the Quick Look endpoint, which re-queues a failed
 * conversion and answers 202 again, this fails as soon as conversion fails.
 */
export async function waitForUsdzReady(request: APIRequestContext, id: string, timeoutMs = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let status = "unknown";
  while (Date.now() < deadline) {
    const response = await request.get(`/api/holograms/${id}`);
    expect(response.ok(), `hologram ${id} readable`).toBe(true);
    const record = (await response.json()) as { usdzStatus: string; usdzUrl: string | null };
    status = record.usdzStatus;
    if (status === "failed") throw new Error(`USDZ conversion failed for ${id}`);
    if (status === "ready") {
      expect(record.usdzUrl, "a ready conversion publishes its package").toMatch(/-ql3\.usdz$/);
      return record.usdzUrl!;
    }
    await delay(250);
  }
  throw new Error(`USDZ conversion of ${id} still ${status} after ${timeoutMs} ms`);
}
