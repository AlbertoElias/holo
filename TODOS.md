# TODOs

Use this for planned work that has not yet been started. Record verified defects in
[`BUGS.md`](BUGS.md), and leave the next-session context in
[`HANDOFF.md`](HANDOFF.md).

## Now

- [ ] Validate capture VR embodiment, hand/finger retargeting, and VR enter/exit
  behavior on a physical headset. The automated IWER checks cover deterministic
  browser flows but cannot replace device testing.
- [ ] Make the XR locomotion command report a reliable final completion status and
  clean up all child processes locally. It produced expected artifacts during the
  latest inspection, but the enclosing command did not return a complete transcript.

## Next

- [ ] Decide the production persistence model for uploads: authentication,
  authorization, durable object storage, and a production database. The current API
  intentionally uses local filesystem storage and SQLite.
- [ ] Move the tracked development SQLite databases out of version control, replace
  them with a documented seed/fixture workflow, and add an ignore rule.
- [ ] Add API route tests for upload, pagination, deletion, and USDZ-conversion
  failure handling. Current API tests cover CORS and file metadata validation only.
- [ ] Expand contract-focused tests for capture orchestration and the `ui-dom`,
  `xr-ui-r3f`, and `xr-ui-three` packages, which currently use `--passWithNoTests`.
  Start with public behavior and state-transition contracts, and run them in the
  appropriate `verify:agent`, `verify:pr`, or `verify:nightly` tier.

## Later

- [ ] Split the serial XR locomotion harness into named TypeScript scenario groups,
  then evaluate safe sharding or browser reuse. Preserve fresh IWER pages and
  sessions until stage timing and failure artifacts prove reuse does not
  reintroduce the pose-baseline races fixed in August 2026.

- [ ] Migrate the capture TypeScript config to the shared config chain once `tsgo`
  supports the needed `baseUrl` and non-relative `extends` behavior.
- [ ] Decide whether the capture app needs a user-visible AR recenter control for
  device-specific placement recovery.
- [ ] Select one `IDEA-###` from `docs/product/IDEAS.md` for a bounded PRD and
  communication experiment; do not begin implementation until the user outcome
  and success signal are explicit.

## Maintenance

- Check off finished items in the same change that implements them.
- Add newly discovered, reproducible defects to `BUGS.md`; do not add speculative
  risks as bugs.
- Before pausing work, refresh `HANDOFF.md` with the exact next action and the
  validation that remains.
