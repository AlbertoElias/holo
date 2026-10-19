# Quick Look previews

The original GLB is canonical. `glb_to_usdz.py` produces a self-contained phone
preview for the viewer's existing `rel="ar"` link. Quick Look is opt-in per
upload (`quickLookEnabled`, default off, set by the upload checkbox): opted-in
uploads are queued at upload time and converted asynchronously by the API's
embedded worker, which stores the versioned `*-ql2.usdz`, records it as
`usdzPath` with `usdzStatus=ready`, and the Quick Look endpoint then redirects
to that stored package. A failed conversion leaves the GLB untouched, marks
the record `failed`, and a later Quick Look request re-queues it.

## Install and run

Use Python 3.11+ and ffmpeg/ffprobe. Install the complete pinned Python graph in a
virtual environment, then point the API at its Python:

```sh
python3 -m venv /private/tmp/holoim-usdz-python
/private/tmp/holoim-usdz-python/bin/python -m pip install -r apps/viewer-api/tools/requirements.txt
USDZ_PYTHON=/private/tmp/holoim-usdz-python/bin/python pnpm run dev:viewer
```

On Linux use a suitable local venv path. CI installs the same requirements and
ffmpeg. `USDZ_PYTHON` is an executable path, not a shell command.

Standalone conversion and independent readback:

```sh
python apps/viewer-api/tools/glb_to_usdz.py recording.glb recording.usdz
python apps/viewer-api/tools/inspect_usdz.py recording.glb recording.usdz report.json
python apps/viewer-api/tools/exercise_usdz.py recording.glb output/quicklook-challenges
```

The production pipeline records Chromium's actual synthetic microphone through
MediaRecorder, exports a real GLB, uploads through the viewer, races two preview
requests, downloads the USDZ, checks it independently, and challenges derived
complete GLBs with moving facial weights/ancestors, alpha/PBR/UV changes, silence,
nonloop audio and unsupported/corrupt inputs. It saves the GLB, USDZ and JSON under `output/quicklook/pipeline-<timestamp>/` (also attached to Playwright results). `E2E_SCREENSHOTS=1` adds capture/feed screenshots. CI keeps
the primary GLB, USDZ and reports for seven days.

```sh
USDZ_PYTHON=/path/to/venv/bin/python E2E_SCREENSHOTS=1 pnpm run test:smoke:pipeline
```

For concurrent local work, use the overrides documented in `AGENT_CONTRACT.md`.
This feature's isolated ports are 5374/3374/3201/5375 (capture XR/viewer/API/pipeline
capture). Do not reuse another session's servers.

## Representation

- Capture's single `RecordedMotion` clip drives scene/root transforms, bones and
  facial blend shapes. Conversion samples at 30 Hz plus source keys; STEP
  boundaries are retained. The first clip is selected for other GLBs.
- Shared non-joint ancestors stay in an exact matrix transform outside the
  skeleton. Bind and geometry transforms use that skeleton space. Identical
  skins emitted per avatar mesh become one USD rig. An evaluated animation-wide
  extent avoids the oversized default skeleton padding bound.
- Embedded PNG/JPEG images, UV sets, sampler wrapping, texture transforms,
  base color/alpha, metallic/roughness, normals, occlusion and emission map to
  `UsdPreviewSurface`. Material factors are baked into texture pixels in linear
  light where Apple does not support generic texture scale/bias. Normal maps use
  raw sampling and explicit signed-vector decoding. Cutouts retain thresholds.
  Explicit reversed faces approximate authored double-sided surfaces.
- The bubble is pinned at its first recorded pose. Its original radius is kept.
  Static scenery is trimmed to that sphere using 128 clipping planes followed by
  an inward projection, with UVs/normals interpolated at the boundary. A faint
  matte blue shell avoids a reflective highlight over the performer. Avatar
  animation remains untrimmed. This deliberate diorama differs from the moving
  feed bubble and cannot reproduce browser clipping/shader effects.
- Embedded capture `KHR_audio` WebM/Opus is transcoded to packaged AAC M4A and
  authored as global `UsdMedia.SpatialAudio` at timeline zero. The stage uses
  Apple's top-level `autoPlay=true` and `playbackMode="loop"` metadata. Capture's
  looped source uses `loopFromStage`; a nonloop source uses `onceFromStart`.
  Source gain is preserved. Stage autoplay intentionally replaces capture's
  browser-controlled `autoPlay:false`. Silent recordings need no ffmpeg process.
  Audio bytes/duration are preserved; stage-driven looping defines playback at
  the animation boundary. Synthetic manual-clock captures can have a longer
  real-time audio track than their simulation timeline; readback reports both.

Optional lights/material extensions use the documented core-material fallback.
Unsupported **required** extensions fail explicitly. Browser lighting, arbitrary
shaders, transmission and per-frame point animation are not reproduced.

## Limits and failure handling

The API runs at most two converter processes and queues at most eight additional
conversions across uploads. Conversion runs during the upload request; Quick
Look requests never convert. Deletion removes both formats. This is a
**single API process** design, matching the current SQLite/local-file
deployment; multiple API workers would require a shared lifecycle lock before
deployment.

All resources must be embedded. The converter rejects external buffers/images,
unsupported audio demuxers, excessive object/accessor/pixel/sample counts,
recordings longer than 600 seconds, and excessive geometry/baking work. The CLI
limits input to 100 MB (the API upload limit remains 25 MB), output to 400 MB,
conversion to 100 seconds and ffmpeg to 30 seconds. ffmpeg uses only local
file/pipe protocols and is killed as a process group on interruption. Conversion
writes private temporary assets and atomically replaces the destination after a
complete, uncompressed, aligned USDZ is packaged. The API also uses a private
output name and atomic publication. Failed jobs remove temporary files and can
be retried by uploading again; deletion removes both formats.

Bump `USDZ_CONVERTER_VERSION` whenever a released converter changes, so new
uploads store a new versioned package. Stored packages are served as-is and
are not regenerated when missing.

## Evidence boundaries

`inspect_usdz.py` independently decodes GLB accessors and column-vector math,
then uses actual USD skin/blend-shape evaluation to compare every vertex at
representative source keys, extrema and midpoints. It checks transforms,
weights, material connections/decoded pixels, UVs, bounds, package alignment and
AAC playback metadata. These checks establish authored data, not phone rendering.

On a Mac, `usdchecker --arkit file.usdz` validates Apple's supported package
profile. For repeatable RealityKit visual evidence, compile `preview_usdz.swift`
with `xcrun swiftc` and pass the source bubble center/radius from readback JSON.
It saves 60 frames of live imported animation; capture cadence depends on the
renderer and does not establish synchronized audio playback. Optional Metal/SceneKit/RealityKit renders are useful visual evidence,
but each has different import/render behavior. No macOS preview proves iPhone
placement, transparency, autoplay, sound synchronization or device performance.
Open the downloaded USDZ from Safari on an iPhone/iPad for that final acceptance.

Primary references:

- [Apple Quick Look gallery: animation and audio](https://developer.apple.com/quick-look-gallery/)
- [Apple: validating feature support](https://developer.apple.com/documentation/usd/validating-usd-files)
- [Apple: autoplay](https://developer.apple.com/documentation/usd/autoplay)
- [Apple: build AR experiences with Reality Composer (audio)](https://developer.apple.com/videos/play/wwdc2020/10613/)
- [OpenUSD: skeletal animation](https://openusd.org/release/api/usd_skel_page_front.html)
- [OpenUSD: SpatialAudio](https://openusd.org/release/api/class_usd_media_spatial_audio.html)
