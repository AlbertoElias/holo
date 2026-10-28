import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { chromium, type Page } from "@playwright/test";

import { launchXrBrowser } from "@holoim/tooling-testing/xr-env";

import { assertViewerShell, expect, reachFor, test } from "./bootstrap";
import { animationFrames, cardCenter, installProbe, readPortal, waitForPortalReady } from "./portal-helpers";
import { MARKS, MIDPOINTS, OUTSIDE_TIMES, buildPointingGlb } from "./pointing-fixture";
import { CONTROL_NAMES } from "@holoim/xr-ui-core";

// Self-resolving pointing in the viewer (PRD-022): the referent lights up while
// the author points. Two kinds of take go through the real upload → feed → render
// path: capture's own exports, each recorded when a test first needs it (the desktop
// take is recorded-style, the IWER replay is inferred-style, and the held-mark
// takes are a phone touch hold and IWER hands mixing both), and a
// hand-built GLB, kept only for what the exports cannot cover: a large-surface
// ring, an inferred link on a scene object next to a recorded one, and an old
// recording without the extension.
// Time is driven by the primary action, so every state is checked by seeking
// the paused animation instead of waiting on a software-rendered clock.

const DESKTOP = { width: 800, height: 440 };
const evidenceDir = path.resolve(import.meta.dirname, "../../../output/pointing-viewer");

type LinkReading = {
  index: number;
  style: "recorded" | "inferred";
  strength: number;
  referent: string;
  emissive: number | null;
  line: boolean;
  glow: boolean;
  ring: boolean;
};

async function upload(page: Page, name: string, glb: Buffer): Promise<{ id: string; url: string }> {
  const response = await page.request.post("/api/holograms", {
    multipart: {
      hologramName: `${name} ${Date.now()}`,
      submittedBy: "pointing-e2e",
      file: { name: `${name}.glb`, mimeType: "model/gltf-binary", buffer: glb }
    }
  });
  expect(response.ok(), "upload accepted").toBe(true);
  return (await response.json()) as { id: string; url: string };
}

async function showOnly(page: Page, id: string): Promise<void> {
  await page.route("**/api/holograms?*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { items: Array<{ id: string }> };
    await route.fulfill({ response, json: { ...body, items: body.items.filter((item) => item.id === id), nextCursor: null } });
  });
}

/** Move the paused animation to `seconds`, as playback would have. */
async function seek(page: Page, modelPath: string, seconds: number): Promise<void> {
  await page.evaluate(([target, time]) => {
    const probes = (window as unknown as { __portalProbes: Record<string, {
      actions: Record<string, { time: number } | null>;
      mixer: { update: (delta: number) => void };
    }> }).__portalProbes;
    const probe = Object.entries(probes).find(([url]) => url.endsWith(target as string))![1];
    for (const action of Object.values(probe.actions)) if (action) action.time = time as number;
    probe.mixer.update(0);
  }, [modelPath, seconds] as const);
}

async function links(page: Page, modelPath: string): Promise<LinkReading[]> {
  return page.evaluate((target) => {
    const probes = (window as unknown as { __portalProbes: Record<string, { pointing: { links: LinkReading[] } }> }).__portalProbes;
    return JSON.parse(JSON.stringify(Object.entries(probes).find(([url]) => url.endsWith(target))![1].pointing.links)) as LinkReading[];
  }, modelPath);
}

async function settle(page: Page, modelPath: string, seconds: number, expected: number): Promise<LinkReading[]> {
  await seek(page, modelPath, seconds);
  await expect.poll(async () => (await links(page, modelPath)).length, { timeout: 15_000 }).toBe(expected);
  // One more frame so the screenshot shows the state that was read.
  await page.waitForTimeout(400);
  return links(page, modelPath);
}

async function shot(page: Page, id: string, name: string): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  await page.locator(`.feed-card[data-card-id="${id}"]`).screenshot({ path: path.join(evidenceDir, `${name}.png`) });
}

type Expected = { referent: string; style: "recorded" | "inferred"; start: number; end: number };

const captureUrl = process.env.E2E_CAPTURE_URL ?? "https://127.0.0.1:5175/";
const captureRoot = path.resolve(import.meta.dirname, "../../capture");
const takeDir = path.resolve(import.meta.dirname, "../../../output/pointing-viewer/takes");

// The real exports are recorded here, in the running capture app, by the same
// takes capture's own pointing check scores: a scripted desktop point action
// (recorded style) and the IWER headset replay (inferred style). Nothing is
// committed, so a break in capture's export shows up as a failure in this spec.
const exportsByLabel = new Map<string, Promise<{ file: string; expected: Expected[] }>>();

function expectedFrom(glb: Buffer): Expected[] {
  const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8")) as {
    nodes: Array<{ name?: string }>;
    extensions: { HOLOIM_meaning: { marks: Array<{ anchor: { to: { node: number } }; span: { start: number; end: number }; provenance: { value: "recorded" | "inferred" } }> } };
  };
  return gltf.extensions.HOLOIM_meaning.marks.map((mark) => ({
    referent: gltf.nodes[mark.anchor.to.node]!.name!,
    style: mark.provenance.value,
    start: mark.span.start,
    end: mark.span.end
  }));
}

type ExportLabel = "desktop-recorded" | "iwer-inferred" | "phone-held" | "hands-held";

/**
 * Records one capture export the first time a test asks for it, in its own
 * XR browser, so a shard that runs only some of these tests records only
 * their takes (CI splits this spec across two runners).
 */
function exportFor(label: ExportLabel): Promise<{ file: string; expected: Expected[] }> {
  let recording = exportsByLabel.get(label);
  if (!recording) {
    recording = recordExport(label);
    exportsByLabel.set(label, recording);
  }
  return recording;
}

async function recordExport(label: ExportLabel): Promise<{ file: string; expected: Expected[] }> {
  // The held-mark takes save here without creating it; a shard may record
  // only those.
  await mkdir(takeDir, { recursive: true });
  const browser = await launchXrBrowser(chromium);
  const consoleErrors: string[] = [];
  try {
    const run = { browser, baseUrl: captureUrl, artifactDir: takeDir, consoleErrors };
    let report: { failures: unknown[]; glb: string };
    if (label === "desktop-recorded") {
      const { runDesktopPointingCheck } = await import("../../capture/scripts/lib/pointing-desktop-take.ts");
      report = await runDesktopPointingCheck(run);
    } else if (label === "iwer-inferred") {
      const { replayPointingTake } = await import("../../capture/scripts/lib/pointing-iwer-replay.ts");
      report = await replayPointingTake({
        ...run, captureRoot, labelsDir: "fixtures/pointing-labels", labelFile: "iwer-pointing-targets.json"
      });
    } else {
      // Held marks (slice 5): a phone touch hold, and headset hands where held
      // marks and inferred points share one take.
      const { runHeldMarkPhase } = await import("../../capture/scripts/lib/held-mark-takes.ts");
      report = await runHeldMarkPhase(run, label === "phone-held" ? "phone" : "hands");
    }
    expect(report.failures, `${label} take`).toEqual([]);
    expect(consoleErrors, `${label}: capture runtime errors`).toEqual([]);
    return { file: report.glb, expected: expectedFrom(await readFile(report.glb)) };
  } finally {
    await browser.close();
  }
}

const REAL_EXPORTS = [
  { label: "desktop-recorded", styles: ["recorded"] },
  { label: "iwer-inferred", styles: ["inferred"] },
  { label: "phone-held", styles: ["recorded"] },
  { label: "hands-held", styles: ["recorded", "inferred"] }
] as const;

for (const { label, styles } of REAL_EXPORTS) {
  test(`real capture export ${label}: highlights follow the links, orbit and toggle`, async ({ page }) => {
    test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs a live API.");
    // Includes recording the take in capture (11-70 s on a hosted runner).
    test.setTimeout(240_000);

    const { file, expected } = await exportFor(label);
    expect(expected.length, "links in the export").toBeGreaterThan(0);
    for (const mark of expected) expect(styles).toContain(mark.style);
    const uploaded = await upload(page, label, await readFile(file));
    await page.setViewportSize(DESKTOP);
    await installProbe(page);
    await showOnly(page, uploaded.id);
    await page.goto("/");
    await assertViewerShell(page);
    const card = page.locator(`.feed-card[data-card-id="${uploaded.id}"]`);
    await waitForPortalReady(page, uploaded.id, uploaded.url);
    await expect(card).toHaveAttribute("data-model-bubble", "active");
    await card.getByRole("button", { name: CONTROL_NAMES.pause }).click();
    await expect(card).toHaveAttribute("data-portal-paused", "true");
    const toggle = card.getByRole("button", { name: "Highlight what the author points at" });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    // Before the first span and in every gap: nothing shows.
    const gaps = [expected[0]!.start - 0.4, ...expected.slice(1).map((m, i) => (expected[i]!.end + m.start) / 2).filter((t, i) => expected[i + 1]!.start - expected[i]!.end > 0.2)];
    for (const time of gaps) expect(await settle(page, uploaded.url, time, 0), `nothing at ${time}s`).toEqual([]);
    await shot(page, uploaded.id, `${label}-0-outside-span`);

    // Each span's midpoint: exactly one link, in the export's provenance style, on its referent.
    for (const [i, mark] of expected.entries()) {
      const [reading, ...rest] = await settle(page, uploaded.url, (mark.start + mark.end) / 2, 1);
      expect(rest).toEqual([]);
      expect(reading, `span ${i}`).toMatchObject({ style: mark.style, referent: mark.referent, line: true });
      if (mark.referent === "LeftHand") {
        expect(reading!.glow, "body parts get the bone glow").toBe(true);
        expect(reading!.emissive, "body parts leave the avatar's materials alone").toBeNull();
      } else {
        expect(reading!.emissive, "scene referent glows by emissive").toBeGreaterThan(0);
      }
      await shot(page, uploaded.id, `${label}-${i + 1}-${mark.style}-${mark.referent}`);
    }
    await settle(page, uploaded.url, expected.at(-1)!.end + 0.4, 0);

    // Orbit: the highlight stays on the referent from another angle.
    const first = expected[0]!;
    const center = await cardCenter(page, uploaded.id);
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x - 20, center.y - 5, { steps: 2 });
    await page.mouse.move(center.x - 220, center.y - 30, { steps: 6 });
    await page.mouse.up();
    await expect(card).toHaveAttribute("data-portal-mode", "free");
    expect((await readPortal(page, uploaded.url)).yaw).not.toBe(0);
    const [orbited] = await settle(page, uploaded.url, (first.start + first.end) / 2, 1);
    expect(orbited).toMatchObject({ referent: first.referent, style: first.style, line: true });
    await shot(page, uploaded.id, `${label}-5-orbited`);

    // The toggle hides and shows them, by keyboard too. It is a reach control,
    // folded once the cursor has been still for a while (a slow settle), so
    // reach for it as a cursor would.
    await reachFor(card);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await settle(page, uploaded.url, (first.start + first.end) / 2, 0);
    await shot(page, uploaded.id, `${label}-6-toggled-off`);
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect((await settle(page, uploaded.url, (first.start + first.end) / 2, 1))[0]).toMatchObject({ referent: first.referent });
  });
}

test("hand-built take: surface ring, inferred scene link, body part, orbit and toggle", async ({ page }) => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs a live API.");
  test.setTimeout(180_000);

  const uploaded = await upload(page, "pointing", buildPointingGlb());
  await page.setViewportSize(DESKTOP);
  await installProbe(page);
  await showOnly(page, uploaded.id);
  await page.goto("/");
  await assertViewerShell(page);
  const card = page.locator(`.feed-card[data-card-id="${uploaded.id}"]`);
  await waitForPortalReady(page, uploaded.id, uploaded.url);
  await expect(card).toHaveAttribute("data-model-bubble", "active");

  // Freeze playback; time is set by seeking from here on.
  await card.getByRole("button", { name: CONTROL_NAMES.pause }).click();
  await expect(card).toHaveAttribute("data-portal-paused", "true");

  const toggle = card.getByRole("button", { name: "Highlight what the author points at" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  // Outside every span nothing shows.
  for (const time of OUTSIDE_TIMES) {
    expect(await settle(page, uploaded.url, time, 0), `nothing at ${time}s`).toEqual([]);
  }
  await shot(page, uploaded.id, "0-outside-span");

  // At each span's midpoint: the one link, in its provenance style, on its referent.
  const names = ["TargetA", "TargetB", "leftHand", "Floor"];
  const shots = ["1-recorded-scene-object", "2-inferred-scene-object", "3-inferred-body-part", "4-recorded-large-surface"];
  const readings: LinkReading[] = [];
  for (const [i, time] of MIDPOINTS.entries()) {
    const [reading, ...rest] = await settle(page, uploaded.url, time, 1);
    expect(rest).toEqual([]);
    expect(reading).toMatchObject({ index: i, style: MARKS[i]!.provenance.value, referent: names[i], line: true, strength: 1 });
    readings.push(reading!);
    await shot(page, uploaded.id, shots[i]!);
  }
  const [recordedScene, inferredScene, body, surface] = readings as [LinkReading, LinkReading, LinkReading, LinkReading];
  expect(recordedScene.emissive, "scene referent glows by emissive").toBeGreaterThan(inferredScene.emissive!);
  expect(inferredScene.emissive).toBeGreaterThan(0);
  expect(recordedScene.glow, "no bone glow on a plain scene object").toBe(false);
  expect(body.glow, "body parts get the bone glow").toBe(true);
  expect(body.emissive, "body parts leave the avatar's materials alone").toBeNull();
  expect(surface.ring, "large surfaces get a ring").toBe(true);

  // Leaving the span restores the referent's own look.
  await settle(page, uploaded.url, OUTSIDE_TIMES[1]!, 0);

  // Orbit: the highlight stays on the referent at another angle.
  const center = await cardCenter(page, uploaded.id);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x - 20, center.y - 5, { steps: 2 });
  await page.mouse.move(center.x - 220, center.y - 30, { steps: 6 });
  await page.mouse.up();
  await expect(card).toHaveAttribute("data-portal-mode", "free");
  expect((await readPortal(page, uploaded.url)).yaw).not.toBe(0);
  const [orbited] = await settle(page, uploaded.url, MIDPOINTS[0]!, 1);
  expect(orbited).toMatchObject({ referent: "TargetA", style: "recorded", line: true });
  await shot(page, uploaded.id, "5-orbited");

  // The toggle hides and shows them, by keyboard too. It is a reach control,
  // folded once the cursor has been still for a while (a slow settle), so
  // reach for it as a cursor would.
  await reachFor(card);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await settle(page, uploaded.url, MIDPOINTS[0]!, 0);
  await shot(page, uploaded.id, "6-toggled-off");
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect((await settle(page, uploaded.url, MIDPOINTS[0]!, 1))[0]).toMatchObject({ referent: "TargetA" });
});

test("a recording without the extension renders unchanged, with no pointing control", async ({ page }) => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs a live API.");
  test.setTimeout(120_000);

  const uploaded = await upload(page, "pointing-none", buildPointingGlb({ withMeaning: false }));
  await page.setViewportSize(DESKTOP);
  await installProbe(page);
  await showOnly(page, uploaded.id);
  await page.goto("/");
  await assertViewerShell(page);
  const card = page.locator(`.feed-card[data-card-id="${uploaded.id}"]`);
  await waitForPortalReady(page, uploaded.id, uploaded.url);

  await expect(card.getByRole("button", { name: CONTROL_NAMES.pause })).toBeVisible();
  await expect(card.getByRole("button", { name: "Highlight what the author points at" })).toHaveCount(0);
  await seek(page, uploaded.url, MIDPOINTS[0]!);
  await animationFrames(page, 24);
  expect(await links(page, uploaded.url)).toEqual([]);
  await shot(page, uploaded.id, "7-no-extension");
});
