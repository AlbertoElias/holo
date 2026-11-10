import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Page, TestInfo } from "@playwright/test";
import type * as Three from "three";
import { CONTROL_NAMES } from "@holoim/xr-ui-core";

import { assertViewerShell, expect, expectConsoleErrors, test } from "./bootstrap";
import { measureFloor } from "./floor-proof";
import { writeFixture } from "./place-fixture";
import { shotDifference, shotStats } from "./place-pixels";
import { animationFrames, cardCenter, readPortal, waitForPortalReady } from "./portal-helpers";
import { recordWalkTake } from "./pipeline-takes";

// A scanned place around a take (docs/features/splat-place.md). The scan is
// a PLY this spec writes at runtime: a floor off the origin, a table band,
// floaters under the floor, coloured boxes, clutter of every size and a
// magenta ring placed just past the glass of the dome the baseline run
// measured. A real walk take (the pipeline spec's) plays inside it; the
// faked-API cases cover a missing scan. Screenshots and the place report go to
// output/place/.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const avatarGlb = path.resolve(testDir, "../../capture/public/gltf/models/avatar.glb");
const outputDir = path.resolve(testDir, "../../../output/place");
const DESKTOP = { width: 800, height: 440 };
const SCAN_PATH = "/place-fixtures/room.ply";
/** The scan's floor, put on the take's floor, within this, metres. */
const FLOOR_TOLERANCE_METERS = 0.02;
/** The author's foot bone is the ankle, this far above the floor at most; never under it by more than the floor's tolerance. */
const ANKLE_HEIGHT_METERS = 0.2;
/** The playback time the dome is checked at again: part way through the walk, where it has moved along the hillside. */
const WALK_SECONDS = 0.5;

type Dome = { base: { x: number; y: number; z: number }; radii: { x: number; y: number; z: number }; exponent: number };
type CardReading = {
  dome: Dome;
  /** The recorded set's visibility; null for a model without one. */
  setVisible: boolean | null;
  rimGated: boolean;
  shift: [number, number, number];
};
type PlaceWindow = Window & { __HOLOIM_PLACE__?: PlaceReading };
type PlaceReading = {
  status: string;
  url: string;
  splatsLoaded: number;
  splatsKept: number;
  floorFound: boolean;
  floorFoundY: number;
  floorBandY: number;
  scanFloor: number;
  takeFloor: number;
  feetY: number;
  outside: number;
  shown: number;
  clipStale: boolean;
  sorted: boolean;
  loadMs: number;
  dirtyFrames: number;
};

/** The same dome: base (apart from where the walk has carried it), radii and exponent agree to a millimetre. */
function expectSameDome(actual: Dome, expected: Dome, message: string, shift: [number, number, number] = [0, 0, 0]): void {
  const close = (a: number, b: number) => Math.abs(a - b) < 0.001;
  expect([close(actual.base.x - shift[0], expected.base.x), close(actual.base.y - shift[1], expected.base.y), close(actual.base.z - shift[2], expected.base.z), close(actual.radii.x, expected.radii.x), close(actual.radii.y, expected.radii.y), close(actual.radii.z, expected.radii.z), actual.exponent === expected.exponent], message).toEqual(Array(7).fill(true));
}

function fakeItem(key: string) {
  return {
    id: `place-${key}`,
    url: `/uploads/place-${key}.glb`,
    usdzUrl: null,
    quickLookEnabled: false,
    createdAt: "2026-10-19T00:00:00.000Z",
    sizeBytes: 2048,
    filenameOriginal: `place-${key}.glb`,
    hologramName: `Place ${key}`,
    submittedBy: "automation"
  };
}

/** Probes for the card the way portal.spec and floor-proof read it, and a still page: the cloche's burn and the stage light follow the page clock. */
async function installProbes(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const hooks = window as unknown as {
      __portalProbes?: Record<string, unknown>;
      __feedProbe?: unknown;
      __HOLOIM_FEED_TEST_OBSERVER__?: (probe: { url: string }) => void;
    };
    hooks.__portalProbes = {};
    hooks.__HOLOIM_FEED_TEST_OBSERVER__ = (probe) => {
      hooks.__portalProbes![probe.url] = probe;
      hooks.__feedProbe = probe;
    };
  });
}

async function serveScan(page: Page, file: string): Promise<void> {
  await page.route((url) => url.pathname === SCAN_PATH, (route) => route.fulfill({ path: file, contentType: "application/octet-stream" }));
}

async function readCard(page: Page): Promise<CardReading> {
  return page.evaluate(() => {
    type Vec = { x: number; y: number; z: number };
    const probe = (window as unknown as { __feedProbe: {
      model: { getObjectByName: (name: string) => { visible: boolean } | undefined };
      cloche: { shape: { current: { base: Vec; radii: Vec; exponent: number } | null }; fitted: { current: Vec | null } };
      rim: { gated: boolean };
      bubble: { active: boolean; center: Vec };
    } }).__feedProbe;
    const shape = probe.cloche.shape.current!;
    const fitted = probe.cloche.fitted.current;
    const set = probe.model.getObjectByName("RecordedSceneBubble");
    return {
      dome: { base: { ...shape.base }, radii: { ...shape.radii }, exponent: shape.exponent },
      setVisible: set ? set.visible : null,
      rimGated: probe.rim.gated,
      shift: fitted && probe.bubble.active ? [probe.bubble.center.x - fitted.x, probe.bubble.center.y - fitted.y, probe.bubble.center.z - fitted.z] : [0, 0, 0]
    };
  });
}

async function readPlace(page: Page): Promise<PlaceReading> {
  return page.evaluate(() => ({ ...(window as PlaceWindow).__HOLOIM_PLACE__ }) as PlaceReading);
}

/**
 * Pauses the card, then seeks the take to `seconds` as floor-proof's seekTake
 * does and waits for what is drawn to catch up. The pause lands a frame after
 * it is asked for, and a seek before that would be played on from.
 */
async function seek(page: Page, seconds: number, withPlace: boolean): Promise<void> {
  type SeekProbe = { actions: Record<string, { time: number }>; mixer: { update: (dt: number) => void }; renderer: { info: { render: { frame: number } } }; portal: { setPaused: (paused: boolean) => void } };
  const frame = () => page.evaluate(() => (window as unknown as { __feedProbe: SeekProbe }).__feedProbe.renderer.info.render.frame);
  await page.evaluate(() => (window as unknown as { __feedProbe: SeekProbe }).__feedProbe.portal.setPaused(true));
  const paused = await frame();
  await page.waitForFunction((from) => (window as unknown as { __feedProbe: SeekProbe }).__feedProbe.renderer.info.render.frame >= from + 4, paused);
  const from = await page.evaluate((seconds) => {
    const probe = (window as unknown as { __feedProbe: SeekProbe }).__feedProbe;
    for (const action of Object.values(probe.actions)) action.time = seconds;
    probe.mixer.update(0);
    return probe.renderer.info.render.frame;
  }, seconds);
  await page.waitForFunction((from) => (window as unknown as { __feedProbe: SeekProbe }).__feedProbe.renderer.info.render.frame >= from + 3, from);
  if (withPlace) await page.waitForFunction(() => (window as PlaceWindow).__HOLOIM_PLACE__?.clipStale === false && (window as PlaceWindow).__HOLOIM_PLACE__?.sorted, undefined, { timeout: 60_000 });
  await animationFrames(page, 3);
}

async function cardShot(page: Page, id: string, file: string): Promise<Buffer> {
  const box = await page.locator(`.feed-card[data-card-id="${id}"]`).boundingBox();
  if (!box) throw new Error("card not laid out");
  // The controls answer the cursor; the card is what is compared.
  return page.screenshot({ path: path.join(outputDir, file), clip: box, style: ".portal-controls { visibility: hidden !important; }" });
}

async function showOnly(page: Page, id: string): Promise<void> {
  await page.route("**/api/holograms?*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { items: Array<{ id: string }> };
    await route.fulfill({ response, json: { ...body, items: body.items.filter((item) => item.id === id), nextCursor: null } });
  });
}

test.describe("a scanned place around a take", () => {
  test.beforeAll(async () => {
    await mkdir(outputDir, { recursive: true });
  });

  test("a missing scan leaves today's card, with one warning and no error state", async ({ page }) => {
    test.setTimeout(120_000);
    const item = fakeItem("a");
    await installProbes(page);
    await page.route("**/api/holograms?*", (route) => route.fulfill({ json: { items: [item], nextCursor: null } }));
    await page.route("**/uploads/**", (route) => route.fulfill({ path: avatarGlb, contentType: "model/gltf-binary" }));
    const warnings: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "warning" && /Place .* did not load/.test(message.text())) warnings.push(message.text());
    });

    // Today's card, once, and again, for what a render differs from itself by.
    await page.goto("/");
    await assertViewerShell(page);
    await waitForPortalReady(page, item.id, item.url);
    await seek(page, 0, false);
    const first = await cardShot(page, item.id, "avatar-baseline.png");
    const baseline = await readCard(page);
    await page.reload();
    await waitForPortalReady(page, item.id, item.url);
    await seek(page, 0, false);
    const second = await cardShot(page, item.id, "avatar-baseline-again.png");
    const noise = await shotDifference(page, first, second);

    // The same card with a scan that is not there.
    expectConsoleErrors(page, /404|Failed to load resource/);
    await page.route((url) => url.pathname === SCAN_PATH, (route) => route.fulfill({ status: 404, body: "no such scan" }));
    await page.goto(`/?place=${SCAN_PATH}`);
    await waitForPortalReady(page, item.id, item.url);
    await page.waitForFunction(() => (window as PlaceWindow).__HOLOIM_PLACE__?.status === "failed");
    await seek(page, 0, false);
    const missing = await cardShot(page, item.id, "avatar-missing-scan.png");
    const afterMissing = await readCard(page);
    const card = page.locator(`.feed-card[data-card-id="${item.id}"]`);

    expect(await shotDifference(page, first, missing), "a missing scan draws today's card").toBeLessThanOrEqual(noise + 0.0005);
    expectSameDome(afterMissing.dome, baseline.dome, "and today's dome");
    expect(afterMissing.rimGated, "and today's rim").toBe(baseline.rimGated);
    expect(warnings, "one warning").toHaveLength(1);
    await expect(card).toHaveAttribute("data-model-state", "rendered");
    await expect(card.getByText("Hologram failed to load")).toHaveCount(0);
    expect((await readPlace(page)).status).toBe("failed");
    await writeFile(path.join(outputDir, "missing-scan-report.json"), JSON.stringify({ noise, warnings, status: "failed" }, null, 2));
  });

  test("a scan shows around an avatar with no recorded set, on the dome's floor", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const item = fakeItem("b");
    await installProbes(page);
    await page.route("**/api/holograms?*", (route) => route.fulfill({ json: { items: [item], nextCursor: null } }));
    await page.route("**/uploads/**", (route) => route.fulfill({ path: avatarGlb, contentType: "model/gltf-binary" }));
    await page.goto("/");
    await waitForPortalReady(page, item.id, item.url);
    await seek(page, 0, false);
    const baseline = await readCard(page);
    const baseShot = await cardShot(page, item.id, "avatar-b-baseline.png");

    // The scan's floor is wherever the avatar's dome stands: its recorded floor is the dome's base. Magenta splats ring the dome just past its glass.
    const radius = Math.max(baseline.dome.radii.x, baseline.dome.radii.z) * 1.06 + 0.1;
    const fixture = await writeFixture(testInfo.outputPath("fixture"), "avatar-room.ply", { half: radius + 1.5, ring: { x: 0, z: 0, radius } });
    await serveScan(page, fixture.file);
    await page.goto(`/?place=${SCAN_PATH}`);
    await waitForPortalReady(page, item.id, item.url);
    await page.waitForFunction(() => (window as PlaceWindow).__HOLOIM_PLACE__?.status === "ready", undefined, { timeout: 60_000 });
    await seek(page, 0, true);
    const place = await readPlace(page);
    const card = await readCard(page);
    const shot = await cardShot(page, item.id, "avatar-b-place.png");
    const stats = await shotStats(page, shot);

    expect(place.floorFound, "the scan's floor is found").toBe(true);
    expect(Math.abs(place.scanFloor - place.takeFloor), "on the dome's floor").toBeLessThan(FLOOR_TOLERANCE_METERS);
    expect(Math.abs(place.takeFloor - baseline.dome.base.y), "the take's floor is the dome's base without a set").toBeLessThan(0.001);
    expect(place.shown, "splats are drawn").toBeGreaterThan(500);
    expect(place.outside, "none outside the dome").toBe(0);
    expect(stats.magenta, "the ring outside the glass is not drawn").toBe(0);
    expect(await shotDifference(page, baseShot, shot), "the card shows the place").toBeGreaterThan(0.005);
    expectSameDome(card.dome, baseline.dome, "the dome is today's");
  });

  test("a scan shows around a real walk take, on its floor, clipped by the moving dome, with the portal still working", async ({ page, browser }, testInfo) => {
    test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs the capture dev server and a live API.");
    test.setTimeout(420_000);
    const take = await recordWalkTake(browser, testInfo);
    const response = await page.request.post("/api/holograms", {
      multipart: {
        hologramName: `Place ${testInfo.testId.slice(0, 6)}-${Date.now()}`,
        submittedBy: "place-e2e",
        file: { name: "place-walk.glb", mimeType: "model/gltf-binary", buffer: take.bytes }
      }
    });
    expect(response.ok(), "upload accepted").toBe(true);
    const uploaded = (await response.json()) as { id: string; url: string };

    await page.setViewportSize(DESKTOP);
    await installProbes(page);
    await showOnly(page, uploaded.id);
    const withoutId = uploaded.id;

    // 1. Today's card: the baseline, twice for the render's own noise.
    await page.goto("/");
    await assertViewerShell(page);
    await waitForPortalReady(page, withoutId, uploaded.url);
    await expect(page.locator(`.feed-card[data-card-id="${withoutId}"]`)).toHaveAttribute("data-model-bubble", "active");
    await seek(page, 0, false);
    const baseline = await readCard(page);
    const baseShot = await cardShot(page, withoutId, "baseline-t0.png");
    const recordedFloor = (await measureFloor(page, "feed")).recordedFloorY;
    await seek(page, 0, false);
    const baseShotAgain = await cardShot(page, withoutId, "baseline-t0-again.png");
    const noise = await shotDifference(page, baseShot, baseShotAgain);
    expect(baseline.setVisible, "without a place the recorded set is drawn").toBe(true);
    expect(baseline.rimGated, "without a place the rim may run").toBe(true);

    // Where the dome stands part way through the walk, from the same card without a place.
    await seek(page, WALK_SECONDS, false);
    const walked = await readCard(page);
    const moved = Math.hypot(...walked.shift);

    // 2. A scan with a ring of magenta splats centred where the dome will stand at that time, just past its glass there, at the height of the scan's floor:
    // hidden once the dome is there, shown while it stands where it started. The take is on a hillside, so the dome moves down as well as along.
    const { dome } = baseline;
    const sectionAt = (shiftY: number): number => {
      const height = recordedFloor - (dome.base.y + shiftY);
      return height >= dome.radii.y * 0.95 || height < 0 ? 0 : Math.max(dome.radii.x, dome.radii.z) * (1 - (height / dome.radii.y) ** dome.exponent) ** (1 / dome.exponent);
    };
    expect(sectionAt(0), "the dome is cut by the scan's floor at the start").toBeGreaterThan(1);
    expect(sectionAt(walked.shift[1]), "and still part way through the walk").toBeGreaterThan(1);
    const ring = { x: walked.shift[0], z: walked.shift[2], radius: sectionAt(walked.shift[1]) * 1.06 + 0.1 };
    const fixture = await writeFixture(testInfo.outputPath("fixture"), "room.ply", { half: Math.hypot(ring.x, ring.z) + ring.radius + 1.5, ring });
    await serveScan(page, fixture.file);
    await page.goto(`/?place=${SCAN_PATH}`);
    await waitForPortalReady(page, withoutId, uploaded.url);
    await page.waitForFunction(() => (window as PlaceWindow).__HOLOIM_PLACE__?.status === "ready", undefined, { timeout: 60_000 });
    await seek(page, 0, true);
    const atStart = await readPlace(page);
    const placeCard = await readCard(page);
    const placeShot0 = await cardShot(page, withoutId, "place-t0.png");
    const stats0 = await shotStats(page, placeShot0);

    // The scan's floor is the fixture's, found among a table and floaters, put on the take's floor.
    expect(atStart.floorFound).toBe(true);
    expect(Math.abs(atStart.floorFoundY - fixture.floorY), "the histogram finds the room's floor, not the table or a floater").toBeLessThanOrEqual(FLOOR_TOLERANCE_METERS);
    expect(Math.abs(atStart.floorBandY - atStart.takeFloor), "the placed scan's floor is within 2 cm of the take's floor").toBeLessThanOrEqual(FLOOR_TOLERANCE_METERS);
    expect(Math.abs(atStart.takeFloor - recordedFloor), "the take's floor is the recorded floor the author stands on").toBeLessThanOrEqual(0.05);
    expect(baseline.dome.base.y, "and the cloche's foot is no higher").toBeLessThanOrEqual(atStart.takeFloor + 0.05);
    expect(atStart.feetY - atStart.takeFloor, "the author's feet are not under the scan's floor").toBeGreaterThanOrEqual(-0.05);
    expect(atStart.feetY - atStart.takeFloor, "and stand on it").toBeLessThanOrEqual(ANKLE_HEIGHT_METERS);
    expect(atStart.splatsLoaded, "the scan is whole").toBe(fixture.count);
    expect(atStart.splatsKept, "the crop kept the dome's part").toBeGreaterThan(1000);
    expect(atStart.splatsKept).toBeLessThan(atStart.splatsLoaded);

    // The cloche is the same with a place: the fit saw the set, which is hidden after; the rim is off.
    expectSameDome(placeCard.dome, baseline.dome, "a place does not change the cloche");
    expect(placeCard.setVisible, "the recorded set is hidden while a place shows").toBe(false);
    expect(placeCard.rimGated, "and the rim is off").toBe(false);

    // The card shows the scan (and not the ring beyond the glass).
    expect(await shotDifference(page, baseShot, placeShot0), "the scan changes the card").toBeGreaterThan(0.02);
    expect(stats0.boxes, "the scan's coloured boxes are drawn").toBeGreaterThan(50);
    expect(stats0.magenta, "the ring is drawn where the dome is, near the start").toBeGreaterThan(15);

    // 3. No splat's extent leaves the glass, at two times of the walk, where the dome has moved.
    expect(atStart.shown, "splats are drawn at the start").toBeGreaterThan(500);
    expect(atStart.outside, "start: no splat's extent is outside the dome").toBe(0);
    await seek(page, WALK_SECONDS, true);
    const later = await readPlace(page);
    const laterCard = await readCard(page);
    const placeShot1 = await cardShot(page, withoutId, "place-t1.png");
    const stats1 = await shotStats(page, placeShot1);
    expect(moved, "the bubble, and the dome with it, moved over the walk").toBeGreaterThan(1);
    expect(later.shown, "splats are drawn later").toBeGreaterThan(500);
    expect(later.outside, "later: no splat's extent is outside the moved dome").toBe(0);
    expect(later.sorted, "sorted for the view").toBe(true);
    expectSameDome(laterCard.dome, baseline.dome, "the dome keeps its shape while it moves");
    expect(stats1.magenta, "the dome has left the ring: the place's edge follows it").toBe(0);
    expect(await shotDifference(page, placeShot0, placeShot1), "the card changes between the two times").toBeGreaterThan(0.005);

    // 4. The portal works with a scan: orbit, Free, zoom over the scan, Return and Play.
    const card = page.locator(`.feed-card[data-card-id="${withoutId}"]`);
    await seek(page, 0, true);
    const start = await readPortal(page, uploaded.url);
    expect(start.mode).toBe("follow");
    const center = await cardCenter(page, withoutId);
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x - 180, center.y, { steps: 3 });
    await page.mouse.up();
    await expect(card).toHaveAttribute("data-portal-mode", "free");
    const orbited = await readPortal(page, uploaded.url);
    expect(orbited.yaw - start.followYaw, "dragging left orbits").toBeGreaterThan(0.3);
    expect(orbited.cameraDistance, "orbit keeps the distance").toBeCloseTo(start.cameraDistance, 2);
    await animationFrames(page, 3);

    // Over the scan: a point in the glass, above the floor and clear of the recorded set, which is hidden.
    const overScan = await page.evaluate(async ({ dome }) => {
      const { Vector3 } = (await (window as unknown as { __HOLOIM_TEST_MODULES__: Promise<{ three: typeof Three }> }).__HOLOIM_TEST_MODULES__).three;
      const probe = (window as unknown as { __feedProbe: { camera: Three.Camera; renderer: { domElement: HTMLElement }; portal: { runtime: { hitTest: (x: number, y: number) => boolean } } } }).__feedProbe;
      const rect = probe.renderer.domElement.getBoundingClientRect();
      // Inside the glass, half way up it on the side away from the author, in front of nothing recorded.
      const world = new Vector3(dome.base.x - dome.radii.x * 0.55, dome.base.y + dome.radii.y * 0.35, dome.base.z);
      const ndc = world.project(probe.camera);
      const x = rect.left + ((ndc.x + 1) / 2) * rect.width;
      const y = rect.top + ((1 - ndc.y) / 2) * rect.height;
      return { x, y, hit: probe.portal.runtime.hitTest(x, y), inView: Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1 };
    }, { dome: placeCard.dome });
    expect(overScan.inView, "the point in the glass is on the card").toBe(true);
    expect(overScan.hit, "with a place, the glass over the scan counts as the hologram").toBe(true);
    await page.mouse.move(overScan.x, overScan.y);
    await page.mouse.wheel(0, -900);
    await expect.poll(async () => (await readPortal(page, uploaded.url)).zoom, { message: "the wheel zooms over the scan", timeout: 15_000 }).toBeLessThan(orbited.zoom - 0.05);
    await cardShot(page, withoutId, "place-zoomed.png");
    await card.getByRole("button", { name: CONTROL_NAMES.returnToAuthorView }).click();
    await expect(card).toHaveAttribute("data-portal-mode", "follow");
    await card.getByRole("button", { name: CONTROL_NAMES.play }).click();
    await expect(card).toHaveAttribute("data-portal-paused", "false");

    const report = { fixture: { floorY: fixture.floorY, count: fixture.count, ring }, noise, baseline, recordedFloor, atStart, later, moved, shift: laterCard.shift, magenta: [stats0.magenta, stats1.magenta], boxes: [stats0.boxes, stats1.boxes] };
    await writeFile(path.join(outputDir, "place-report.json"), JSON.stringify(report, null, 2));
    await attachReport(testInfo, report);
  });
});

async function attachReport(testInfo: TestInfo, report: unknown): Promise<void> {
  await testInfo.attach("place-report", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
}
