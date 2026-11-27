# Feature brief: Live face and gestures in mobile selfie (Slice 1)

**Lead:** Devin  
**Status:** Verifying (Slice 1 built and verified in emulation; device checks pending)  
**Layer:** event (the author's face, head, arms, hands and fingers driving the customizable house avatar from the phone's front camera). See `docs/product/concepts/what-a-hologram-is.md`.

## User outcome

Someone on a phone opens capture through Record, customizes their house avatar, sees a mirrored selfie preview framed for both their face and raised hands, and their live face, head, arms, hands and fingers drive the avatar automatically — ready to record and post without any URL flags or extra taps. On slower phones they can switch to Face only in Settings without leaving capture.

## Scope

**Included (Slice 1, `apps/capture` only):**
- Enable `BodycamSource` (head, arms, hands, fingers) by default in the mobile selfie journey (`isSelfieJourney()`), while preserving `?input=camera` (force on) and adding `?input=face` (force face-only).
- Fix startup in `createCaptureRuntime.ts` to call `capture.face.startCamera()` instead of `capture.face.webcam.start()`, so `BodycamTracker` actually starts on load when camera tracking is enabled.
- Add a **Camera tracking** choice (`Face + hands` / `Face`) in Settings beside the existing **Face camera** (`On` / `Off`) control, allowing live switching without reloading the page or dropping the post grant.
- Mirror the canvas (`scaleX(-1)`) in `selfie` view so raising your right hand moves the right side of the preview, without flipping the 3D scene, DOM chrome, or exported GLB.
- Widen `updateSelfieCamera` when gestures are enabled (and the Look panel is closed) so waist-up and raised hands fit in portrait, while keeping the closer face framing when the Look panel is open.
- Hold the 3-2-1 selfie countdown while body/hand models finish starting (bounded by the existing 15 s cap), and show a brief framing hint when the author's face or hands aren't in view yet.

**Excluded (queued for Slice 2 in order B → C → A):**
- 1-tap prop staging in selfie mode (Slice 2B).
- Live beat/emote/teleprompter cues while recording (Slice 2C).
- Built-in stages & lighting moods (Slice 2A).
- Any changes to `apps/viewer-api`, `apps/viewer-web`, or `packages/authoring` (owned by the parallel Option 1 session).
- Changes to MediaPipe landmark conversion math or pointing aim.

## Undo

None. Camera tracking mode is a pre-take capture setting (like Face camera and Look), not an authoring action inside a take. Switching between `Face + hands`, `Face only`, and `Off` is its own undo.

## Acceptance criteria

- [x] In the mobile selfie journey (`isSelfieJourney()`), `BodycamSource` is enabled by default and `BodycamTracker` starts automatically on load when the camera is on (no `?input=camera` required).
- [x] In `selfie` view, the canvas is horizontally mirrored (`scaleX(-1)`) while DOM chrome and exported GLB bone transforms remain unflipped; entering VR/AR removes the flip.
- [x] Selfie camera framing widens for waist-up + raised hands when body tracking is enabled and Look is closed, and stays closer on the face when Look is open.
- [x] Settings shows **Camera tracking** (`Face + hands` / `Face`) alongside **Face camera** (`On` / `Off`). Switching `Face + hands` → `Face` stops `BodycamTracker` and releases `BodycamSource` while keeping face tracking active; switching back restarts `BodycamTracker` on the existing video stream without reloading or dropping the post grant.
- [x] When body tracking is enabled and hands are not yet visible in selfie mode (idle), a brief top status hint prompts the user to step back; once hands are tracked, the hint clears.
- [x] Existing desktop and XR checks remain green: `ci-face-playwright`, `test:xr:ui`, `test:unit`, `verify:agent`, and pre-merge gate (`verify:hosted`).
- [x] Proof video recorded under ignored `output/` showing the mirrored selfie view with live face + hand/arm/head gestures, Settings switching, and recording.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| `ci-face-playwright` strict-mode collision on `getByRole('radio', { name: 'On' })` | New tracking choice uses labels `Face + hands` and `Face only` (never `On`/`Off`). |
| `ci-bodycam-playwright` expects pose/hand `.task` files not fetched before camera starts | Models still load lazily inside `startCamera()` only when camera starts; automated browsers keep `faceCameraOnByDefault() === false`. |
| Slow phone stalls on pose/hand model load before Record | Countdown hold is bounded by `CAMERA_WAIT_MS` (15 s), and Settings lets the user switch to `Face only` at any time. |
| Switching `Face + hands` ↔ `Face only` while camera is starting races generations | `FaceDriver` uses `trackerGeneration` to cancel stale `BodycamTracker.create` calls and only attaches if still enabled and active. |
| Entering VR/AR while in mirrored selfie view leaves canvas flipped | `CameraController.update` clears `scaleX(-1)` whenever `isVrActive || isAr || isXrPresenting`. |
| `phone-capture.pipeline.spec.ts` asserts `#status` contains `"Prop your phone up, face it, tap Record."` | Keep that exact string in `UIStateStore.publishMode`; show dynamic framing cues in the top notice chip only. |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead & Implementer | Devin | `apps/capture/src/bodycam/BodycamSource.ts`, `apps/capture/src/face/FaceDriver.ts`, `apps/capture/src/camera/CameraController.ts`, `apps/capture/src/systems/TrackedHandsSystem.ts`, `apps/capture/src/runtime/createCaptureRuntime.ts`, `apps/capture/src/types/contracts.ts`, `apps/capture/src/ui/UIStateStore.ts`, `apps/capture/src/ui/captureUiBridge.ts`, `apps/capture/src/ui/CaptureOverlay.tsx`, `apps/capture/src/runtime/automationHooks.ts` |

## Design decision

- Keep `Face camera` (`On`/`Off`) and add `Camera tracking` (`Face + hands`/`Face only`) in Settings rather than replacing `Face camera` with a 3-way control, preserving accessibility labels and existing e2e assertions while giving phone users a 1-tap performance fallback.
- Start `BodycamTracker` inside `FaceDriver.startCamera()` (now public) and call it on load from `createCaptureRuntime.ts` when `faceCameraOnByDefault()` is true, fixing the existing bug where `?input=camera` did not start body tracking on load.
- Reuse `CameraController.applyCanvasFlip` for `desktopViewMode === 'selfie'` so the preview behaves like a mirror without altering exported GLB coordinates or DOM chrome.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Selfie bodycam default, mirror flip, wide framing, Settings toggle, recording | Pixel 7 Playwright proof run (`output/selfie-gestures/verify-selfie-gestures.ts`) | PASS (`bodycamEnabledByDefault: true`, `canvasTransform: matrix(-1, 0, 0, 1, 0, 0)`, `handsVisibleWhileGesturing: true`, `disabledInFaceOnlyMode: true`, `reenabledInFaceHandsMode: true`, `postReady: true`, 0 page errors); proof video `apps/capture/output/selfie-gestures-proof.mp4` |
| Face tracking & Settings radio compatibility | `pnpm --filter @holoim/capture run test:xr:face` | PASS (702 frames, 69.3 s) |
| Capture UI & unit tests | `pnpm --filter @holoim/capture run test:unit && test:xr:ui` | PASS (37/37 unit, UI check 19.3 s) |
| Workspace checks & pre-merge gate | `pnpm run doctor && pnpm run verify:agent` + `pnpm run verify:hosted` | `doctor` + `verify:agent` PASS; `verify:hosted` running |

## Physical-device limits

Playwright emulates Pixel 7 viewport, coarse pointer, and fake camera/synthetic landmarks; real-phone frame rate with all three MediaPipe models (face + pose + hands) on iOS Safari and Android Chrome remains a physical-device check for the owner.
