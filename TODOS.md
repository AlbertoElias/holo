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

- [x] Adapt the XR avatar to the person's height, keeping its base grounded and
  neutral head/hands aligned with tracked input. Delivered in
  [`docs/features/archive/xr-height-adaptation.md`](docs/features/archive/xr-height-adaptation.md).

- [ ] Decide the production persistence model for uploads: authentication,
  authorization, durable object storage, and a production database. The current API
  intentionally uses local filesystem storage and SQLite.
- [x] Move the generated development SQLite databases out of version control. Local
  setup now runs committed Prisma migrations; route tests own temporary database and
  upload fixtures; generated database files are ignored.
- [x] Add isolated API route tests for upload/static serving, pagination, deletion,
  and USDZ-conversion failure handling.
- [ ] Expand contract-focused tests for capture orchestration and the `ui-dom`,
  `xr-ui-r3f`, and `xr-ui-three` packages, which currently use `--passWithNoTests`.
  Start with public behavior and state-transition contracts, and run them in the
  appropriate `verify:agent` or `verify:pr` tier.

## Later

- [ ] Port the capture XR check scripts to TypeScript scenario groups. Browser
  reuse and stage timing are done (one VR and one desktop page, respawn between
  trials) in [`docs/features/archive/deterministic-lean-ci.md`](docs/features/archive/deterministic-lean-ci.md);
  sharding is unnecessary at current runtimes.
- [ ] Evaluate IWSDK-native ECS/scene composition only when a concrete authoring
  workflow requires it; the current tooling integration intentionally preserves
  HoloIM's custom Three/Rapier runtime.
- [ ] Evaluate MetaVR as an explicit opt-in for physical Quest automation after
  reviewing its device access, native dependencies, and install-script requirements.
- [ ] Migrate the capture TypeScript config to the shared config chain once `tsgo`
  supports the needed `baseUrl` and non-relative `extends` behavior.
- [ ] Decide whether the capture app needs a user-visible AR recenter control for
  device-specific placement recovery.
- [ ] Select one `IDEA-###` from [`docs/product/IDEAS.md`](docs/product/IDEAS.md) for a bounded PRD;
  do not begin implementation until the user outcome
  and success signal are explicit.

## Maintenance

- Check off finished items in the same change that implements them.
- Add newly discovered, reproducible defects to `BUGS.md`; do not add speculative
  risks as bugs.
- Before pausing work, refresh `HANDOFF.md` with only the exact next action and
  the validation that remains; keep feature status in its brief.
