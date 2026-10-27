import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { chromium, type Page } from "@playwright/test";

import { launchXrBrowser } from "@holoim/tooling-testing/xr-env";

import { assertViewerShell, expect, test } from "./bootstrap";
import { installProbe, waitForPortalReady } from "./portal-helpers";

// Find an object by asking (PRD-060), the real chain with no fakes of ours:
// capture's Find field -> viewer-api search and GLB packing (against the
// fixture Poly Haven registry the pipeline config starts, never the live one)
// -> a desktop take that summons the found model twice and an uncredited
// bracket once -> the exported GLB -> upload -> the feed card's credit line ->
// the converted USDZ's customLayerData.

const execFileAsync = promisify(execFile);
const DESKTOP = { width: 1280, height: 720 };
const evidenceDir = path.resolve(import.meta.dirname, "../../../output/object-search-viewer");
const captureRoot = path.resolve(import.meta.dirname, "../../capture");
const captureUrl = process.env.E2E_CAPTURE_URL ?? "https://127.0.0.1:5175/";
const QUERY = "chair";

type Credit = { source: string; title: string; author: string; licence: string; sourceUrl: string };
type TakeReport = { glb: string; failures: string[]; searches: Array<{ url: string; status: number }>; resultNames: string[]; shown: string; summoned: string[] };

let take: TakeReport | undefined;

test.beforeAll(async () => {
  if (process.env.RUN_E2E_PIPELINE !== "1") return;
  test.setTimeout(300_000);
  // @ts-expect-error capture's .mjs scripts are untyped
  const { runDesktopFindApiTake } = await import("../../capture/scripts/lib/summon-take.mjs");
  const browser = await launchXrBrowser(chromium);
  const consoleErrors: string[] = [];
  try {
    take = (await runDesktopFindApiTake({ browser, baseUrl: captureUrl, captureRoot, artifactDir: path.join(evidenceDir, "take"), consoleErrors, query: QUERY })) as TakeReport;
    expect(take.failures, "capture take").toEqual([]);
    expect(consoleErrors, "capture runtime errors").toEqual([]);
  } finally {
    await browser.close();
  }
});

const USD_PROBE = `
import json, sys
from pxr import Usd
stage = Usd.Stage.Open(sys.argv[1])
print(json.dumps(dict(stage.GetRootLayer().customLayerData)))
`;

async function upload(page: Page, glb: Buffer): Promise<{ id: string; url: string }> {
  const response = await page.request.post("/api/holograms", {
    multipart: {
      hologramName: `Find ${Date.now()}`,
      submittedBy: "object-search-e2e",
      quickLookEnabled: "true",
      file: { name: "object-search-take.glb", mimeType: "model/gltf-binary", buffer: glb }
    }
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as { id: string; url: string };
}

test("found object: search, summon twice, credit survives the GLB, the feed card and the USDZ", async ({ page }) => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs a live API.");
  test.setTimeout(240_000);
  const recorded = take!;

  // The search came from the real API, and the picked result is one fixture chair.
  expect(recorded.searches.length, "the Find field called the API").toBeGreaterThan(0);
  expect(recorded.searches.every((entry) => entry.status === 200 && entry.url.includes("/api/objects/search")), "searches succeeded").toBe(true);
  expect(recorded.resultNames.length, "at most six results").toBeLessThanOrEqual(6);
  expect(recorded.resultNames.length, "results came back").toBeGreaterThan(0);
  expect(recorded.shown).toMatch(/Chair Maker · Poly Haven · CC0/);

  // The GLB.
  // @ts-expect-error capture's .mjs scripts are untyped
  const glbLib = await import("../../capture/scripts/lib/object-glb.mjs");
  const glbBuffer = await readFile(recorded.glb);
  const parsed = glbLib.loadTake(glbBuffer) as { json: { asset: { copyright?: string }; nodes: Array<{ name?: string; extras?: { holoimCredit?: Credit } }> }; validation: { ok: boolean; errors?: string[]; value: { version: number; objects: Array<{ node: number }> } } | null };
  expect(parsed.validation?.ok, `HOLOIM_objects valid: ${parsed.validation?.errors?.join("; ")}`).toBe(true);
  expect(parsed.validation!.value.version).toBe(0);
  const nodes = glbLib.objectNodes(parsed) as number[];
  expect(nodes.length, "three RecordedObject nodes (two found, one bracket)").toBe(3);
  const credited = nodes.filter((node) => parsed.json.nodes[node]?.extras?.holoimCredit);
  const plain = nodes.filter((node) => !parsed.json.nodes[node]?.extras?.holoimCredit);
  expect(credited.length, "found model summoned twice").toBe(2);
  expect(plain.length, "bracket carries no credit").toBe(1);
  const credit = parsed.json.nodes[credited[0]!]!.extras!.holoimCredit!;
  expect(parsed.json.nodes[credited[1]!]!.extras!.holoimCredit).toEqual(credit);
  expect(credit).toMatchObject({ source: "Poly Haven", author: "Chair Maker", licence: "CC0-1.0" });
  expect(credit.title).toMatch(/^Chair 0\d$/);
  expect(credit.sourceUrl).toMatch(/^https:\/\/polyhaven\.com\/a\/Chair_0\d$/);
  const line = `Object: “${credit.title}” by ${credit.author}, Poly Haven, CC0`;
  const copyright = parsed.json.asset.copyright ?? "";
  expect(copyright.split("\n").length, "one credit line in asset.copyright").toBe(1);
  expect(copyright).toContain(`“${credit.title}” by ${credit.author}, Poly Haven, CC0`);

  // The feed card.
  const uploaded = await upload(page, glbBuffer);
  await page.setViewportSize(DESKTOP);
  await installProbe(page);
  await page.route("**/api/holograms?*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { items: Array<{ id: string }> };
    await route.fulfill({ response, json: { ...body, items: body.items.filter((item) => item.id === uploaded.id), nextCursor: null } });
  });
  await page.goto("/");
  await assertViewerShell(page);
  const card = page.locator(`.feed-card[data-card-id="${uploaded.id}"]`);
  await waitForPortalReady(page, uploaded.id, uploaded.url);
  const creditLine = card.getByTestId("object-credit");
  await expect(creditLine).toHaveText(line);
  await expect(creditLine.locator(".feed-card-credit-entry")).toHaveCount(1);
  await expect(creditLine.locator("a")).toHaveAttribute("href", credit.sourceUrl);
  const observed = await page.evaluate((url) => {
    const probes = (window as unknown as { __portalProbes?: Record<string, { credits?: unknown[] }> }).__portalProbes ?? {};
    return Object.entries(probes).find(([key]) => key.endsWith(url))?.[1]?.credits ?? null;
  }, uploaded.url);
  expect(observed, "the feed observer reports the credits").toHaveLength(1);
  await mkdir(evidenceDir, { recursive: true });
  const screenshot = path.join(evidenceDir, "card.png");
  await card.screenshot({ path: screenshot });

  // The USDZ.
  const quickLookUrl = `/api/holograms/${uploaded.id}/usdz`;
  await expect.poll(async () => (await page.request.get(quickLookUrl, { timeout: 30_000 })).status(), { timeout: 120_000, intervals: [2_000] }).toBe(200);
  const usdzPath = path.join(evidenceDir, "object-search-take.usdz");
  await writeFile(usdzPath, await (await page.request.get(quickLookUrl, { timeout: 120_000 })).body());
  const { stdout } = await execFileAsync(process.env.USDZ_PYTHON ?? "python3", ["-c", USD_PROBE, usdzPath], { timeout: 60_000, maxBuffer: 1024 * 1024 });
  const layer = JSON.parse(stdout) as Record<string, unknown>;
  expect(layer["holoim:copyright"]).toBe(copyright);
  const usdCredits = JSON.parse(layer["holoim:credits"] as string) as Credit[];
  expect(usdCredits).toHaveLength(1);
  expect(usdCredits[0]).toMatchObject({ title: credit.title, author: credit.author, sourceUrl: credit.sourceUrl });

  await writeFile(
    path.join(evidenceDir, "report.json"),
    JSON.stringify({ query: QUERY, searches: recorded.searches, results: recorded.resultNames, picked: recorded.shown, summoned: recorded.summoned, glb: recorded.glb, objectNodes: nodes, creditedNodes: credited, uncreditedNodes: plain, credit, copyright, hologram: uploaded.id, cardCreditText: line, observerCredits: observed, usdz: usdzPath, usdzLayer: layer, screenshot }, null, 2)
  );
});
