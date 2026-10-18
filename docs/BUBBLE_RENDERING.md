# Recorded bubble semantics and rendering evidence

`RecordedBubbleSphere` in the capture GLB is the canonical sphere. Capture exports
its root motion in `RecordedMotion` and includes nearby scene triangles sampled
along the recording path in `RecordedSceneBubble`. That scene is a union across
time, so a translucent shell alone cannot keep it inside the current sphere.

The desktop feed plays the recorded sphere motion. Immersive AR deliberately
removes only sphere transform tracks, pins the sphere at placement, and keeps
avatar/root/bone/morph animation running. A recording with only sphere animation
has no remaining AR animation after filtering. Other scene transforms remain.

The browser clips every content material after skinning/morph deformation against
the current world-space sphere, fading at the inner edge. It draws a translucent
back-face glass shell; its normal and eye direction use the same view coordinates
for each eye. AR's aura uses the same world radius, compensating for its scaled
parent. The supported model transform is a rigid transform plus uniform scale;
nonuniform scales become ellipsoids and are not covered by the spherical contract.

Clipping refreshes before each draw, after animation and placement have updated
transforms. Material arrays keep their groups. The clipping hook owns its material
clones and restores materials, render order and callbacks on cleanup. Feed scene
clones share loader-cached source assets and must not dispose those shared assets.

## USDZ approximation contract

The separate Quick Look conversion path should preserve avatar animation and
represent the AR policy with a pinned sphere, approximate translucent glass and
actual clipping of the exported surroundings/content. Merely adding a transparent
sphere leaves sampled scenery protruding. Browser Fresnel shaders, soft per-fragment
clipping, animated clipping and additive aura may need a documented approximation;
geometry/object counts do not establish visual parity. Record any chosen deviation
and validate animation, materials and actual playback separately.

## Reproduce browser evidence

Run from the repository root, with the ports free:

```bash
E2E_BASE_URL=https://localhost:3274 E2E_API_PORT=3101 \
  pnpm run test:xr:viewer
E2E_BASE_URL=https://localhost:3274 E2E_API_PORT=3101 \
  E2E_CAPTURE_URL=https://127.0.0.1:5275/ pnpm run test:smoke:pipeline
```

The first gate includes `ar-bubble.spec.ts`: a controlled valid GLB with moving
sphere/avatar, positive inside/outside pixel controls, explicit IWER stereo at
64 mm IPD, common camera/model rotation, actual headset yaw/pitch movement,
grouped material mount/reconfiguration/unmount, and morph clipping with a transform
changed immediately before drawing. The pipeline also includes
`bubble-capture.pipeline.spec.ts`: real capture export, API upload, feed and
immersive AR pixel readbacks, animated feed sphere and pinned AR sphere.

Artifacts are written to `output/bubble-rendering/after/` and
`output/bubble-rendering/capture/`: PNGs, JSON metrics, head poses and the exported
GLB. The feature brief records the baseline revision and comparison video.
Offscreen readbacks use the real renderer, loaded model and actual XR eye cameras;
room meshes are hidden to make content and glass contributions measurable.

IWER establishes deterministic emulated rendering. No physical headset tracking,
comfort, performance, transparency, or Apple Quick Look playback is established.
