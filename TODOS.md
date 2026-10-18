# TODOs

Use this for planned work that has not yet been started. Record verified defects in
[`BUGS.md`](BUGS.md), and leave the next-session context in
[`HANDOFF.md`](HANDOFF.md). Once work starts, its feature brief (indexed in
[`docs/features/README.md`](docs/features/README.md)) is the authority; link to
it from the item below instead of duplicating its status here.

## Now

- [ ] Record real Quest hand input for `test:xr:hands` and recalibrate the
  fidelity thresholds against it. Current thresholds come from synthetic IWER
  poses. Owned by [`docs/features/hand-tracking-fidelity.md`](docs/features/hand-tracking-fidelity.md).
- [ ] On a physical headset, check only what IWER cannot emulate: real-tracking
  pinch stability (noise, self-occlusion, joint dropouts), Quest browser session
  events (permission prompt, system menu, headset removal or sleep,
  controller↔hand switching), and frame rate, latency, and comfort. IWER
  already covers pinch/release logic, VR enter/exit flows, and retargeting math
  (B-002, B-005 in [`docs/archive/closed-bugs.md`](docs/archive/closed-bugs.md)).
- [x] Make the XR locomotion command report a reliable final completion status and
  clean up all child processes locally. Delivered in
  [`docs/features/archive/reliability-foundation.md`](docs/features/archive/reliability-foundation.md).

## Next

- [ ] Add realistic walking, crouching, and jumping animations in both XR and
  desktop 2D, with natural transitions and movement that adapts to walls,
  inclines, and other environment geometry. Start in a dedicated session;
  coordinate avatar transforms with the XR height-adaptation work.
- [ ] Adapt the XR avatar to the person's height, keeping feet grounded and
  head/hands aligned with tracked input. Start in a dedicated session;
  coordinate avatar scale and calibration with the locomotion-animation work.
- [ ] Decide the production persistence model for uploads: authentication,
  authorization, durable object storage, and a production database. The current API
  intentionally uses local filesystem storage and SQLite.
- [x] Move the generated development SQLite databases out of version control. Local
  setup now runs committed Prisma migrations; route tests own temporary database and
  upload fixtures; generated database files are ignored.
- [x] Add isolated API route tests for upload/static serving, pagination, deletion,
  and USDZ-conversion failure handling.
- [ ] Expand contract-focused tests for `xr-ui-core` and capture orchestration
  only — the durable public behavior and state-transition contracts that survive
  a UI/interaction redesign. Run them in the appropriate `verify:agent` or
  `verify:pr` tier. Tests for `ui-dom`, `xr-ui-r3f`, and `xr-ui-three` are
  deferred to the redesign item below, which owns their new contracts.
- [ ] Redesign all UI (2D and 3D) and interaction systems (2D and XR) in a
  dedicated session with its own feature brief. That brief owns: the new
  contract tests for `ui-dom`, `xr-ui-r3f`, and `xr-ui-three` (currently
  `--passWithNoTests`), written against the redesigned contracts rather than
  the current single-file APIs; and the port of the capture XR check scripts
  (`.mjs`, ~880 lines plus `scripts/lib/`) to TypeScript scenario groups,
  since the scripts drive the app through the interaction hooks the redesign
  will change. Preserve the `xr-ui-core` state contracts and the IWER
  behavior checks (`test:xr:*`) across the redesign.

## Later

- [ ] Evaluate IWSDK-native ECS/scene composition only when a concrete authoring
  workflow requires it; the current tooling integration intentionally preserves
  HoloIM's custom Three/Rapier runtime.
- [x] Evaluate MetaVR as an explicit opt-in for physical Quest automation after
  reviewing its device access, native dependencies, and install-script requirements.
  Set up as the opt-in `metavr` MCP server in
  [`docs/features/metavr-setup.md`](docs/features/metavr-setup.md); host install
  and the one-time on-headset USB-debugging accept remain operator steps.
- [x] Migrate the capture TypeScript config to the shared config chain and run
  the whole workspace on stable TypeScript 7. The stated blocker was stale:
  `tsgo` resolves package `extends`; the real fixes were dropping `baseUrl`
  (removed in TypeScript 7) and declaring `@holoim/config-ts` in capture.
  Delivered in
  [`docs/features/archive/tsgo-typescript7-migration.md`](docs/features/archive/tsgo-typescript7-migration.md):
  catalog `typescript@^7.0.2` everywhere, `typescript-eslint` 8.71.2 bridged
  on the `@typescript/typescript6` sidecar until it supports the TS7 API.
- [x] Decide whether the capture app needs a user-visible AR recenter control for
  device-specific placement recovery. Delivered as a "Recenter AR" overlay
  button shown only in AR mode in
  [`docs/features/archive/ar-recenter-control.md`](docs/features/archive/ar-recenter-control.md).
- [ ] Select one `IDEA-###` from [`docs/product/IDEAS.md`](docs/product/IDEAS.md) for a bounded PRD;
  do not begin implementation until the user outcome
  and success signal are explicit.

## Maintenance

- Check off finished items in the same change that implements them.
- Add newly discovered, reproducible defects to `BUGS.md`; do not add speculative
  risks as bugs.
- Before pausing work, refresh `HANDOFF.md` with only the exact next action and
  the validation that remains; keep feature status in its brief.
