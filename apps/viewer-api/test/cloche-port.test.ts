import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

// The USDZ builder's cloche (tools/cloche.py) is a port of @holoim/xr-ui-core's
// fit and burns; its standard-library check reads the golden vectors the
// TypeScript tests also check, so the two cannot drift apart.
describe("the Quick Look cloche port", () => {
  it("reproduces the TypeScript fit, seed offsets and burns", async () => {
    const script = path.join(import.meta.dirname, "..", "tools", "test_cloche.py");
    const { stdout } = await execFileAsync(process.env.USDZ_PYTHON ?? "python3", ["-I", script], { timeout: 60_000 });
    expect(stdout).toMatch(/cloche port matches \d+ fits/);
  });
});
