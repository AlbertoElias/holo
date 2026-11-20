import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "./bootstrap";
import { chartTakeGltf, setTakeGltf } from "./bubble-fixture";
import { readCard, type Reading } from "./card-reading";

// A far recorded object must not shrink the performer on the feed card
// (feature brief card-framing-objects, option B, styleguide 3.4). The same
// performer is opened with a chart standing inside her silhouette (the
// reference: it widens nothing, and a card with an object has the same
// viewing box as the ones below) and with a chart 0.5, 2, 3 and 5 m off to
// her side and toward the viewer. Her height on the card, read by projecting
// her own mesh through the card's camera, never falls under 75 % of the
// reference; she is always wholly on the card; and the chart sits wholly on
// it while it is near and only partly, or not at all, once it is far.

const artifactDir = resolve(import.meta.dirname, "../../../output/card-framing-floor");
const FLOOR = 0.75;
const PHONE = { width: 390, height: 844 };

type Placement = { label: string; at: readonly [number, number] };
// A lone performer stands at least a third of the phone's height on the card (styleguide 3.4).
const LEAST_SHARE_OF_SCREEN = 1 / 3;

const placements: Placement[] = [
  { label: "chart inside her", at: [0, 0] },
  { label: "chart 0.5 m to her side", at: [0.5, 0] },
  { label: "chart 2 m to her side", at: [2, 0] },
  { label: "chart 3 m to her side", at: [3, 0] },
  { label: "chart 5 m to her side", at: [5, 0] },
  { label: "chart 3 m toward the viewer", at: [0, 3] },
  { label: "chart 5 m toward the viewer", at: [0, 5] }
];

test.use({ viewport: PHONE });

test("a far recorded object leaves the performer at 75 % or more of her size, wholly on the card", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const readings: Reading[] = [];
  for (const placement of placements) {
    const { baseURL } = testInfo.project.use;
    const context = await browser.newContext({ viewport: PHONE, ignoreHTTPSErrors: true, ...(baseURL ? { baseURL } : {}) });
    const page = await context.newPage();
    try {
      readings.push(await readCard(page, chartTakeGltf(placement.at), placement.label));
    } finally {
      await context.close();
    }
  }
  await mkdir(artifactDir, { recursive: true });
  await writeFile(resolve(artifactDir, "report.json"), `${JSON.stringify(readings, null, 2)}\n`);
  const reference = readings[0]!;
  expect(reference.performerPx, "the performer is read at a usable size").toBeGreaterThan(100);
  expect(reference.chartOnCard, "the reference chart is on the card").toBe(1);
  for (const reading of readings) expect(reading.performerPx, `${reading.label}: the performer is a third of the phone's height or more`).toBeGreaterThanOrEqual(PHONE.height * LEAST_SHARE_OF_SCREEN);
  for (const reading of readings.slice(1)) {
    expect(reading.performerPx, `${reading.label}: the performer keeps ${FLOOR * 100} % of her size without the chart widening the frame (${reference.performerPx.toFixed(0)} px)`).toBeGreaterThanOrEqual(reference.performerPx * FLOOR - 2);
    expect(reading.performerOnCard, `${reading.label}: she is wholly on the card`).toBe(1);
  }
  const chartOnCard = (label: string) => readings.find((reading) => reading.label === label)!.chartOnCard!;
  expect(chartOnCard("chart 0.5 m to her side"), "a near chart is wholly on the card").toBe(1);
  expect(chartOnCard("chart 3 m to her side"), "a chart 3 m off is only partly on the card, the performer being kept large").toBeLessThan(1);
  expect(chartOnCard("chart 5 m to her side"), "and further, less of it").toBeLessThanOrEqual(chartOnCard("chart 3 m to her side"));
});

// A wide recorded set (a phone take's default or scanned scene) widened the
// dome until the performer stood a few dozen pixels tall on a phone. The
// performer comes first (styleguide 3.4): against a dome fitted to her and
// her reach alone she keeps 75 % of her size or more (the far-object floor),
// wholly on the card, and a wide set runs off the card instead.
const setWidths = [1, 6, 12, 24] as const;

test("a wide recorded set leaves the performer at 75 % of her own size or more, wholly on the card", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const readings: Reading[] = [];
  for (const width of setWidths) {
    const { baseURL } = testInfo.project.use;
    const context = await browser.newContext({ viewport: PHONE, ignoreHTTPSErrors: true, ...(baseURL ? { baseURL } : {}) });
    const page = await context.newPage();
    try {
      readings.push(await readCard(page, setTakeGltf(width), `set ${width} m wide`));
    } finally {
      await context.close();
    }
  }
  await mkdir(artifactDir, { recursive: true });
  await writeFile(resolve(artifactDir, "set-report.json"), `${JSON.stringify(readings, null, 2)}\n`);
  const reference = readings[0]!;
  expect(reference.performerPx, "the performer is read at a usable size").toBeGreaterThan(100);
  for (const reading of readings.slice(1)) {
    expect(reading.performerPx, `${reading.label}: the performer keeps ${FLOOR * 100} % of her size on a set no wider than she is (${reference.performerPx.toFixed(0)} px)`).toBeGreaterThanOrEqual(reference.performerPx * FLOOR - 2);
    expect(reading.performerOnCard, `${reading.label}: she is wholly on the card`).toBe(1);
  }
  for (const reading of readings) expect(reading.performerPx, `${reading.label}: the performer is a third of the phone's height or more`).toBeGreaterThanOrEqual(PHONE.height * LEAST_SHARE_OF_SCREEN);
  const widest = readings.at(-1)!;
  expect(widest.setOnCard, "the widest set runs off the card, the performer being kept large").toBeLessThan(1);
});

// A performer who walks across a wide set: the framing holds her whole walk,
// so at every moment of the take her head and feet are on the card, and she
// stays a third of the phone's height or more where she walks least far.
const walks = [0, 2, 4] as const;
const moments = [0, 0.5, 1, 1.5, 2] as const;

test("a performer walking on a wide set stays wholly on the card for the whole take", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const readings: Reading[] = [];
  for (const walk of walks) {
    const { baseURL } = testInfo.project.use;
    const context = await browser.newContext({ viewport: PHONE, ignoreHTTPSErrors: true, ...(baseURL ? { baseURL } : {}) });
    const page = await context.newPage();
    try {
      readings.push(await readCard(page, setTakeGltf(24, { walk }), `walk ${walk} m on a 24 m set`, moments));
    } finally {
      await context.close();
    }
  }
  await mkdir(artifactDir, { recursive: true });
  await writeFile(resolve(artifactDir, "walk-report.json"), `${JSON.stringify(readings, null, 2)}\n`);
  for (const reading of readings) {
    for (const moment of reading.over) expect(moment.performerOnCard, `${reading.label} at ${moment.time} s: her head and feet are on the card`).toBe(1);
  }
  expect(readings[0]!.performerPx, "standing still, she is a third of the phone's height or more").toBeGreaterThanOrEqual(PHONE.height * LEAST_SHARE_OF_SCREEN);
});
