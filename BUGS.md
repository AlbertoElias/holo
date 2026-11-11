# Open Bugs

This is the repository's verified-bug tracker. Keep entries short, reproducible,
and current. Use [`TODOS.md`](TODOS.md) for planned work and
[`HANDOFF.md`](HANDOFF.md) for session context. When a bug closes, move its
entry to [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md).

## Open

### B-042 — Agent-authored holograms have no Quick Look preview

- **Area:** `apps/capture/scripts/showcase/upload.mjs`, `apps/viewer-api/tools/glb_to_usdz.py`
- **Severity:** P2 (the sixteen showcase pieces cannot be opened in AR on an iPhone)
- **Observed:** 2026-11-10. All sixteen live items by "Claude (agent-authored)" have `quickLookEnabled: false` and `usdzStatus: "none"`.
- **Cause 1, fixed here:** Quick Look is opt-in per upload (`quickLookEnabled`, the upload panel's checkbox). The showcase upload script never sent the field, so no conversion was ever queued, and no route can turn it on afterwards. The script now takes `--quick-look`, waits for the conversion and prints its status.
- **Cause 2, open:** the converter drops vertex colours (`COLOR_0`). Every showcase piece uses them, four almost entirely (Blue hour 29 of 29 primitives, Walk around the year 24 of 24, bath 36 of 41, strings 60 of 67). The converted Blue hour is valid (the inspector and `usdchecker --arkit` pass) but renders white in RealityKit on macOS. RealityKit also ignored a `UsdPrimvarReader_float3` on `displayColor` in a probe, so the colours need baking into a texture. This is why `--quick-look` is off by default. **Decision (user, 2026-11-11): bake them in the converter**, so any upload with vertex colours converts in colour and the live GLBs stay unchanged.
- **Cause 3, open:** converter budgets. Locally 14 of 16 convert. `rain` fails ("Animation exceeds channel limit", 2362 channels over 2048, and then the baked-animation budget); `hearts` fails ("Animation extent evaluation exceeds conversion budget"; it converts in 48 s with that budget raised). `words` and `murmuration` take 79 s and 74 s on a loaded laptop against the 100 s alarm, and produce 17 MB and 30 MB packages.
- **Expected:** an authored piece opens in Quick Look with its colours.
- **Reproduction:** `showcase:build blue-hour`, start a local API with `USDZ_PYTHON` set, `showcase:upload --api <local> blue-hour` (status stays `none`), then again with `--quick-look` (status `ready`).
- **Not done:** the sixteen live items are unchanged. Not seen on a real iPhone.

### B-039 — The face XR check fails on `main`: IWER has no gaze device

- **Area:** `apps/capture/scripts/ci-face-playwright.ts` (eye-gaze sweep), IWER device setup
- **Severity:** P2 (it breaks `verify:pr`'s `test:xr:smoke`)
- **Observed:** 2026-10-28, while verifying `feature/object-resize`. The check fails the same way on `origin/main` (`69f0795382b9`), in a clean worktree.
- **Evidence:** `page.evaluate: TypeError: Cannot set properties of undefined (setting 'connected')` at `ci-face-playwright.ts:230`, because `window.IWER_DEVICE.gaze` is undefined. Every other check in `test:xr:smoke` passes.
- **Intermittent:** the same check passed in a later `test:xr:smoke` run of the same day (ports 5295/5296/3295), so the gaze device is sometimes there.
- **Expected:** the face check's eye-gaze sweep finds a gaze device, or it sets one up.
- **Reproduction:** `cd apps/capture && pnpm run test:xr:face`.

## Entry template

```md
### B-### — Short symptom

- **Area:** app/package
- **Severity:** P0 | P1 | P2 | P3
- **Observed:** YYYY-MM-DD
- **Evidence:** link, error, or test name
- **Expected:** behavior
- **Reproduction:** minimal steps
- **Fix:** commit hash and validation (when closed)
```
