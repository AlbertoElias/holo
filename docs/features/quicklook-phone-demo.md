# Feature brief: Animated Quick Look phone demos

**Lead:** Codex  
**Status:** Verifying

## User outcome

A phone can preview an uploaded HoloIM recording in Quick Look with its recorded
motion, textured appearance, audio where present, and a visible bubble approximation.
Browser and XR bubble semantics are owned by the separate bubble session.

## Scope

Included: GLB-to-USDZ fidelity for HoloIM capture exports, embedded audio conversion,
fixed clipped diorama bubble approximation, stale USDZ regeneration, repeatable pipeline
checks, dependency setup. Excluded: arbitrary glTF-extension parity,
identical lighting/custom shaders in Apple rendering, native iOS runtime, browser/XR shader and bubble changes.

## Acceptance criteria

- [ ] Real capture export → API upload → USDZ download produces an independently
  readable package with changing skeletal and scene transforms over the recording.
- [ ] Captured materials retain embedded texture assets, UVs, base color/alpha,
  normal/metallic/roughness/emissive maps used by the input.
- [ ] Recorded audio is packaged in a supported audio format with USD playback
  timing authored; silent captures still convert successfully.
- [ ] Bubble is a fixed translucent diorama; surrounding geometry stays within its
  initial sphere while avatar/root/joint/facial motion remains animated.
- [ ] Existing cached conversions regenerate after converter version changes;
  concurrent requests and conversion failure leave no corrupt reusable package.
- [ ] Required quality, build and browser workflow checks pass.

## Failure cases considered

| Failure | Prevention / evidence |
| --- | --- |
| Skeleton objects exist but joints or binding are wrong | Inspect deformed sampled geometry, not just prim counts |
| Non-joint transforms or animated scene objects freeze | Compare sampled world transforms with source recording |
| Multiple clips overwrite recording animation | Match actual capture timeline, explicit deterministic clip policy |
| UVs/textures disappear, alpha or normal maps misrender | Inspect packaged assets and texture/shader connections |
| Unsupported extension silently corrupts geometry | Explicit required-extension policy and documented degraded features |
| WebM audio is unsupported by Quick Look | Decode/transcode to packaged supported audio and verify duration |
| Bubble turns opaque or obscures avatar | Translucent USD approximation and renderer/device limitations |
| XR shader clips against wrong stereo/world coordinates | Real immersive rendering/pixel assertions |
| Old caches survive fixes; parallel requests corrupt file | Versioned cache name, per-item lock, atomic output |
| Missing Python/ffmpeg dependencies | Reproducible requirements and CI installation |
| New tests require proprietary Apple renderer | Portable package inspection plus explicit iPhone device acceptance gap |

## Ownership

| Role | Owner | Files/modules |
| --- | --- | --- |
| Lead / integration | Codex root | API service/routes, upload field ordering, pipeline check, CI, brief |
| Design reviewer | review agent | Read-only approach review |
| Implementer | converter agent | Python converter/helpers and requirements |
| Independent readback implementer | inspector agent | tools/inspect_usdz.py |
| Independent verifier | review agent after implementation | Acceptance review and artifacts |

## Design decision

Keep Quick Look as a preview of the canonical GLB. Translate its representable
content into USD instead of attempting to run browser code in Apple's viewer.
Apple documents Quick Look audio playback; use UsdMedia.SpatialAudio and convert
recorded WebM into supported packaged audio. Preserve custom shader differences
as a documented approximation. Review findings and evidence are recorded below.

## Test plan and evidence

Pipeline test: record actual capture, upload, request Quick Look USDZ, independently
inspect USD animation/material/media data and write JSON and exported files.
USD inspector: sampled deformed vertices, world transforms, facial weights, texture
connections, packaged audio and sphere bounds. Separate bubble session owns IWER evidence.
Integration: verify:agent, export/import scoped checks, verify:pr before merge.

Draft recovered with `git apply --check`, then applied on `codex/quicklook-phone-demo`.
Independent design/implementation review and numerical readback are in progress.
Runtime ports: capture XR 5374, viewer 3374, API 3201, pipeline capture 5375.
All checks and final findings will be recorded here.

## Physical-device limits

IWER proves emulated browser behavior only. USD package validation proves authored
assets and animation data, not Apple's renderer. Final visual likeness, automatic
animation/audio playback, transparency, and placement require a real iPhone/iPad
Quick Look session. No physical-device result will be claimed without that evidence.

## Review and verification findings

- Lifecycle review found publication/deletion races and unlimited cross-upload
  converters. One upload lock now covers publication, DB update and deletion;
  two active/eight queued conversion slots bound subprocess work. Real route,
  SQLite and filesystem tests cover stale/missing cache, partial-output failure,
  successful retry and deletion during conversion. A process fixture isolates
  lifecycle tests from Python availability; fidelity uses the real converter.
- A scaled-ancestor challenge exposed 7.2 mm of half-precision joint-scale error.
  Exact skeleton-space ancestry reduced joint error to approximately 13 µm and
  evaluated vertex error to approximately 10 µm. Actual capture readback checks
  all vertices, all four facial meshes, 20 images and packaged AAC audio.
- Native Apple validation exposed an invalid UV-reader input type and a temporary
  package accidentally included as an asset. Both are corrected. Fully clipped
  geometry now clears its normals/UVs, and evaluated animation-wide extents
  avoid default skeleton padding.
- A streaming upload failed once with trailing metadata. A file-first 2 MB route
  reproduction passes; sending metadata before file data follows Fastify's
  documented recommendation and removes that dependency from the viewer.
- Appearance review in local RealityKit shows the avatar, animated asset,
  textures, clipped surroundings and translucent shell. Its strong shell
  reflection prompted a matte-shell adjustment; final evidence is still running.
- See [converter notes](../../apps/viewer-api/tools/README.md) for conversion
  policy, reproducible commands, bounds and the single-process API requirement.
