import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { Page } from "@playwright/test";

import { assertViewerShell, expect, test } from "./bootstrap";
import { cardCenter, installProbe, readPortal, waitForPortalReady } from "./portal-helpers";
import { MARKS, MIDPOINTS, OUTSIDE_TIMES, buildPointingGlb } from "./pointing-fixture";

// Self-resolving pointing in the viewer (PRD-022): the referent lights up while
// the author points. Capture does not write HOLOIM_meaning yet, so a hand-built
// GLB carries the record; the upload → feed → render path is the real one.
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

test("pointing highlights follow the recorded links, styles, orbit and toggle", async ({ page }) => {
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
  await card.getByRole("button", { name: "Pause" }).click();
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

  // The toggle hides and shows them, by keyboard too.
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

  await expect(card.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Highlight what the author points at" })).toHaveCount(0);
  await seek(page, uploaded.url, MIDPOINTS[0]!);
  await page.waitForTimeout(400);
  expect(await links(page, uploaded.url)).toEqual([]);
  await shot(page, uploaded.id, "7-no-extension");
});
