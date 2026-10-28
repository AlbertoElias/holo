import { test } from "./bootstrap";
import { recordWalkTake } from "./pipeline-takes";

// Records the shared walk take in capture alone (E2E_CAPTURE_ONLY=1), so the
// Quick Look tool check (apps/viewer-api test:usdz-tools) converts a fresh
// export of this commit's capture without waiting for the pipeline specs.
// recordWalkTake asserts the export carries audio, skins, the scene bubble
// and the recorded length.

test("capture records and exports the walk take", async ({ browser }, testInfo) => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs the capture server.");
  test.setTimeout(120_000);
  await recordWalkTake(browser, testInfo);
});
