import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Locator, Page } from "@playwright/test";

import { assertViewerShell, captureEvidence, expect, reachFor, test } from "./bootstrap";
import { installProbe, readPortal, scrollFeedToTop, touchPinch, waitForPortalReady } from "./portal-helpers";
import { withCaptions } from "./captions-fixture";
import { SPATIAL_CLIP_S, spatialAudioGlb } from "./spatial-audio-fixture";

// Speech captions on the feed card (docs/features/sound-voice-captions.md,
// slice 3, decisions 2 and 8): while the card plays muted, the cue that the
// clip clock is inside shows on a chip over the bottom of the picture; when
// the viewer unmutes it goes; a GLB with no HOLOIM_captions shows nothing.
// Every frame of one clip pass is sampled (the clip time and the caption the
// page shows), so the sync error is measured, not assumed.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const reportPath = path.resolve(testDir, "../../../output/test-results/captions-report.json");
const CUES = [
  { from: 1.0, to: 3.0, text: "The bell rings first.", kind: "speech" },
  { from: 4.0, to: 6.5, text: "Then the orbiter answers.", kind: "speech", speaker: "RecordedAvatar" },
  // A kind a viewer does not show yet: never on the chip.
  { from: 6.8, to: 7.6, text: "A title, not speech.", kind: "title" }
];
/** A frame within this of a cue's edge may show either side: the caption is set the frame after the clock moves (s). */
const EDGE_S = 0.1;
/** WCAG AA for body text. */
const MIN_CONTRAST = 4.5;

const item = (id: string) => ({
  id,
  url: `/uploads/${id}.glb`,
  usdzUrl: null,
  quickLookEnabled: false,
  createdAt: "2026-11-19T00:00:00.000Z",
  sizeBytes: 2048,
  filenameOriginal: `${id}.glb`,
  hologramName: "Said aloud",
  submittedBy: "automation"
});

const captionedGlb = () => withCaptions(spatialAudioGlb(), CUES);

async function openFeed(page: Page, id: string, glb: Buffer): Promise<Locator> {
  await installProbe(page);
  await page.route("**/api/holograms?*", (route) => route.fulfill({ json: { items: [item(id)], nextCursor: null } }));
  await page.route("**/uploads/**", (route) => route.fulfill({ body: glb, contentType: "model/gltf-binary" }));
  await page.goto("/");
  await assertViewerShell(page);
  await waitForPortalReady(page, id, item(id).url);
  await scrollFeedToTop(page);
  return page.locator(`.feed-card[data-card-id="${id}"]`);
}

type Sample = { t: number; caption: string };

/** Every frame of one pass of the clip, from near its start to near its end: the clip time and the caption shown. */
async function samplePass(page: Page, modelPath: string): Promise<Sample[]> {
  return page.evaluate(
    ({ modelPath, clip }) =>
      new Promise<Sample[]>((resolve, reject) => {
        const probes = (window as unknown as { __portalProbes: Record<string, { actions: Record<string, { time: number } | null> }> }).__portalProbes;
        const region = document.querySelector<HTMLElement>("[data-testid=card-caption]");
        const samples: Sample[] = [];
        let started = false;
        let frames = 0;
        const step = () => {
          frames += 1;
          // A guard, not a wait: a pass is about 8 s of frames.
          if (frames > 60 * clip * 4) return reject(new Error(`no full pass in ${frames} frames`));
          const action = Object.values(probes[modelPath]?.actions ?? {}).find(Boolean);
          const t = action?.time ?? -1;
          if (!started) started = t >= 0 && t < 0.4;
          if (started) {
            if (samples.length && t < samples[samples.length - 1]!.t) return resolve(samples);
            samples.push({ t, caption: region?.dataset.caption ?? "<no region>" });
          }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    { modelPath, clip: SPATIAL_CLIP_S }
  );
}

const expected = (t: number) => CUES.find((cue) => cue.kind === "speech" && t >= cue.from && t < cue.to)?.text ?? "";
const nearEdge = (t: number) => CUES.some((cue) => Math.abs(t - cue.from) < EDGE_S || Math.abs(t - cue.to) < EDGE_S);

/**
 * The lag (s) at each cue edge: from the first frame drawn past it to the first that showed it, so a slow frame rate (a
 * loaded machine draws a few a second) is not counted as lag; 0 is the caption painting with the pose it belongs to.
 */
function edgeLags(samples: Sample[]): Array<{ edge: string; lagS: number; framesLate: number }> {
  const lags: Array<{ edge: string; lagS: number; framesLate: number }> = [];
  for (const cue of CUES.filter((c) => c.kind === "speech")) {
    for (const [edge, at, want] of [["show", cue.from, cue.text], ["hide", cue.to, ""]] as const) {
      const first = samples.findIndex((s) => s.t >= at);
      const hit = samples.findIndex((s) => s.t >= at && (want ? s.caption === want : s.caption !== cue.text));
      lags.push({ edge: `${edge} "${cue.text}"`, lagS: first >= 0 && hit >= 0 ? samples[hit]!.t - samples[first]!.t : Infinity, framesLate: first >= 0 && hit >= 0 ? hit - first : Infinity });
    }
  }
  return lags;
}

/** The fewest frames drawn inside any speech cue away from its edges: enough to judge it, whatever the frame rate. */
const MIN_FRAMES_PER_CUE = 3;
const framesInside = (samples: Sample[]) => Math.min(...CUES.filter((c) => c.kind === "speech").map((c) => samples.filter((s) => s.t >= c.from + EDGE_S && s.t < c.to - EDGE_S).length));

function luminance([r, g, b]: number[]): number {
  const lin = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}
const rgba = (css: string) => (css.match(/[\d.]+/g) ?? []).map(Number);
const over = (top: number[], under: number[]) => {
  const a = top[3] ?? 1;
  return [0, 1, 2].map((i) => top[i]! * a + under[i]! * (1 - a));
};
const ratio = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const report: Record<string, unknown> = {};
test.afterAll(async () => {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), cues: CUES, edgeS: EDGE_S, ...report }, null, 2)}\n`);
});

test.describe.configure({ timeout: 90_000 });

test.describe("desktop", () => {
  test.use({ viewport: { width: 900, height: 700 } });

  test("feed captions: muted, each speech cue shows over its span and goes after it; unmuted, none; muted again, back; contrast AA", async ({ page }, testInfo) => {
    const card = await openFeed(page, "captioned-1", captionedGlb());
    const region = card.getByTestId("card-caption");
    await expect(region, "the feed starts muted, so the first cue shows").toHaveAttribute("data-caption", CUES[0]!.text, { timeout: 15_000 });
    await captureEvidence(page, testInfo, "captions-muted");

    const pass = await samplePass(page, item("captioned-1").url);
    const wrong = pass.filter((s) => !nearEdge(s.t) && s.caption !== expected(s.t));
    const lags = edgeLags(pass);
    report.desktop = { frames: pass.length, framesInsideCue: framesInside(pass), span: [pass[0]!.t, pass[pass.length - 1]!.t], wrongFrames: wrong.length, maxLagS: Math.max(...lags.map((l) => l.lagS)), lags };
    expect(framesInside(pass), "enough frames inside every speech cue to judge it").toBeGreaterThanOrEqual(MIN_FRAMES_PER_CUE);
    expect(wrong.slice(0, 5), "away from a cue's edges every frame shows the cue the clock is in, and nothing between cues").toEqual([]);
    for (const lag of lags) expect(lag.lagS, `${lag.edge}: within ${EDGE_S} s of the first frame past it`).toBeLessThan(EDGE_S);
    expect(pass.some((s) => s.caption === "A title, not speech."), "a non-speech cue never shows").toBe(false);

    // Contrast: the chip's text against its own fill, laid over the brightest and darkest picture.
    const chip = card.locator(".feed-card-caption-chip");
    await expect(region).toHaveAttribute("data-caption", /.+/, { timeout: 10_000 });
    const colors = await chip.evaluate((node) => ({ fill: getComputedStyle(node).backgroundColor, text: getComputedStyle(node.querySelector("p")!).color }));
    const worst = Math.min(...[[255, 255, 255], [0, 0, 0]].map((under) => ratio(over(rgba(colors.text), over(rgba(colors.fill), under)), over(rgba(colors.fill), under))));
    report.contrast = { ...colors, worstRatio: Number(worst.toFixed(2)) };
    expect(worst, `caption text on its chip over any picture: ${JSON.stringify(colors)}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
    const fontPx = await chip.locator("p").evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
    expect(fontPx, "the hologram caption role, 12.8 to 16 px").toBeGreaterThanOrEqual(12.8 - 0.01);
    expect(fontPx).toBeLessThanOrEqual(16 + 0.01);

    // The chip sits over the bottom of the picture, inside the card.
    const portal = (await card.locator(".feed-card-portal").boundingBox())!;
    const box = (await chip.boundingBox())!;
    expect(box.y + box.height, "the chip's foot is over the picture").toBeLessThanOrEqual(portal.y + portal.height + 0.5);
    expect(box.x).toBeGreaterThanOrEqual(portal.x - 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(portal.x + portal.width + 0.5);

    // Unmuted, the viewer hears the words: no caption.
    await reachFor(card);
    await card.getByRole("button", { name: "Unmute audio" }).click();
    await expect(region).toHaveAttribute("data-caption", "");
    const unmuted = await samplePass(page, item("captioned-1").url);
    report.unmuted = { frames: unmuted.length, shown: unmuted.filter((s) => s.caption).length };
    expect(unmuted.filter((s) => s.caption), "unmuted, no frame shows a caption").toEqual([]);

    await reachFor(card);
    await card.getByRole("button", { name: "Mute audio" }).click();
    await expect(region, "muted again, the captions come back").toHaveAttribute("data-caption", /^(The bell rings first\.|Then the orbiter answers\.)$/, { timeout: 15_000 });
    await expect(region).toHaveAttribute("aria-live", "polite");
  });

  test("feed captions: a GLB with no HOLOIM_captions shows no caption, muted, over a whole pass", async ({ page }) => {
    const card = await openFeed(page, "plain-1", spatialAudioGlb());
    const pass = await samplePass(page, item("plain-1").url);
    report.noCaptions = { frames: pass.length, shown: pass.filter((s) => s.caption).length };
    expect(pass.filter((s) => s.caption)).toEqual([]);
    await expect(card.locator(".feed-card-caption-chip")).toHaveCount(0);
  });
});

test.describe("phone", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("feed captions on a phone: when the reach controls stack above Play, the caption lifts above them", async ({ page }, testInfo) => {
    const card = await openFeed(page, "captioned-1", captionedGlb());
    const chip = card.locator(".feed-card-caption-chip");
    const controls = card.locator(".portal-controls");
    // Looking around and paused, the reach controls stack on a line above Play (as redesign.spec.ts sets it up): a pinch
    // moves the view in, and a tap on the picture pauses it. Paused, the card shows the cue at the paused time, so the tap
    // must land inside a cue; under load it can land between two, and then the viewer's own tap resumes and pauses again.
    const region = card.getByTestId("card-caption");
    await expect(region).toHaveAttribute("data-caption", /.+/, { timeout: 15_000 });
    const portalBox = (await card.locator(".feed-card-portal").boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    await touchPinch(page, cdp, { x: portalBox.x + portalBox.width / 2, y: portalBox.y + portalBox.height / 2 }, 60, 260);
    await expect.poll(async () => (await readPortal(page, item("captioned-1").url)).zoom).toBeLessThan(0.9);
    // Near the top of the picture: the pinch may already have unfolded the controls, and a tap at the centre can land on one.
    const tapPicture = () => card.locator(".feed-card-portal").tap({ force: true, position: { x: portalBox.width / 2, y: 40 } });
    let taps = 0;
    for (;;) {
      await expect(region).toHaveAttribute("data-caption", /.+/, { timeout: 15_000 });
      await tapPicture();
      taps += 1;
      await expect(card).toHaveAttribute("data-portal-paused", "true");
      if (await region.getAttribute("data-caption")) break;
      expect(taps, "a tap paused the card inside a cue").toBeLessThan(5);
      await tapPicture();
      await expect(card).toHaveAttribute("data-portal-paused", "false");
    }
    await expect(controls).toHaveAttribute("data-reach", "shown");
    await expect(card.locator(".feed-card-foot")).toHaveAttribute("data-reach-row", "stacked");
    // The chip's lift is a CSS change, not a transition: its box is final once the rule matches.
    const caption = (await chip.boundingBox())!;
    const rows = await controls.evaluate((node) => [...node.querySelectorAll("button, .portal-timecode")].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0).map((r) => r.top));
    const top = Math.min(...rows);
    report.phone = { taps, captionBottom: caption.y + caption.height, controlsTop: top };
    await captureEvidence(page, testInfo, "captions-phone-stacked");
    expect(caption.y + caption.height, "the caption ends above the top of the reach controls").toBeLessThanOrEqual(top + 0.5);
    expect(caption.x).toBeGreaterThanOrEqual(-0.5);
    expect(caption.x + caption.width).toBeLessThanOrEqual(390 + 0.5);
  });
});
