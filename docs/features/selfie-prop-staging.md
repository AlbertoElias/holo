# Feature brief: 1-tap prop staging in mobile selfie (Slice 2B)

**Lead:** Devin  
**Status:** Verifying (Slice 2B built and verified in emulation; device checks pending)  
**Layer:** event (props staged into the take alongside the performer). See `docs/product/concepts/what-a-hologram-is.md`.

## User outcome

In mobile selfie mode, a creator taps **Find**, taps a 1-tap starter prop chip (or searches), and taps a result — the prop loads into the tray and stages directly beside their avatar in frame in a single tap, ready to gesture around and record. Tapping any tray slot stages it beside them (`Auto`, `Left`, `Right`, or `Front`), and **Clear** puts staged props back into the tray (undoable).

## Scope

**Included (Slice 2B, `apps/capture` only):**
- `StageSpot` (`'auto' | 'left' | 'right' | 'front'`) staging in `CaptureObjects.stageFromTray`, placing props relative to the avatar's root and `lookYaw` (lifted to waist height for small props `< 0.75 m` so they read in portrait selfie view; grounded for tall props), facing the selfie camera.
- `CaptureObjects.clearStagedProps` to put all staged event props back into the tray (each joining `CaptureHistory`).
- `CaptureObjects.stageUrl` (via `bridge.stagePropUrl`) so picking a result in selfie mode adds it to the tray and stages it immediately in 1 tap.
- 1-tap quick-search chips (`Coffee`, `Laptop`, `Plant`, `Chair`, `Lamp`, `Mic`) in `ObjectFinder` so phone creators don't have to type common prop queries.
- Compact selfie staging bar in `TrayRow` (`Auto` / `Left` / `Right` / `Front` + `Clear` when props are staged); tapping a tray slot in selfie mode stages beside the avatar instead of gluing to the right hand.

**Excluded:**
- Desktop and VR summon-to-hand behavior (unchanged).
- Live beat/emote/teleprompter cues (Slice 2C) and stages/lighting moods (Slice 2A).
- Any changes to `apps/viewer-api`, `apps/viewer-web`, or `packages/authoring`.

## Undo

Every staged prop uses `placeFromTray` → `tray.summon`, which pushes an `event` entry (`Summon`) onto `CaptureHistory`. Undo puts the staged prop back into the tray; redo brings it back at its staged pose. `Clear` calls `putBack` on each staged prop, pushing `Put back` entries so Undo restores them.

## Acceptance criteria

- [x] In mobile selfie mode, `ObjectFinder` displays 1-tap starter prop chips; tapping a chip populates and runs the search.
- [x] In mobile selfie mode, tapping a search result or a tray slot stages the prop directly beside the avatar in frame (never glued to the right hand), cycling `Left → Right → Front` under `Auto` or placing at the selected spot.
- [x] Small props (`< 0.75 m` tall) stage at waist height inside the portrait selfie frame; tall props stand on the ground.
- [x] **Clear** puts all staged props back into the tray, and Undo restores a cleared or undoes a staged prop.
- [x] Exported takes include the staged props at their staged poses.
- [ ] Desktop and VR tray/summon flows remain unchanged; `verify:hosted` passes.
- [x] Proof video recorded under ignored `output/` showing 1-tap selfie prop staging, spot switching, clear, and recording.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Staging when tray is full or prop fetch fails | `stageUrl` checks `loadTrayUrls` result and only stages if a new slot was actually added; error message stays in tray state. |
| Props pile on top of each other on repeated taps | `Auto` cycles `left → right → front` across staged props. |
| Small prop sits at the avatar's feet outside the waist-up selfie frame | Props shorter than `0.75 m` are lifted to waist height (`root.y + avatarHeight * 0.52` on sides, `0.42` in front). |
| Desktop/VR e2e tests expect tray tap to summon into right hand | Selfie staging path is gated strictly on `isSelfieJourney()` (`selfie` flag in `CaptureOverlay`). |
| Existing `ObjectFinder` tests query by role/label | Quick-search chips use distinct button labels (`Search Coffee`, etc.) and never collide with `Find` or `Speak`. |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead & Implementer | Devin | `apps/capture/src/objects/CaptureObjects.ts`, `apps/capture/src/types/contracts.ts`, `apps/capture/src/ui/UIStateStore.ts`, `apps/capture/src/ui/captureUiBridge.ts`, `apps/capture/src/runtime/createCaptureRuntime.ts`, `apps/capture/src/ui/ObjectFinder.tsx`, `apps/capture/src/ui/TrayRow.tsx`, `apps/capture/src/ui/CaptureOverlay.tsx` |

## Design decision

Reuse `CaptureObjects.placeFromTray` (already proven in Phone AR for hand-free, physics-free placement with full undo history and GLB export) rather than creating a second prop placement pipeline. Keep desktop/VR summon-to-hand untouched.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Selfie 1-tap staging, spots, clear, undo, recording | Pixel 7 Playwright proof run (`output/selfie-props/verify-selfie-props.ts`) | Pass (`chipCount=6`, `findClosedAfterPick=true`, `stagedTwoAndCleared=true`, `postReady=true`, `errors=[]`); proof video in ignored `apps/capture/output/selfie-props-proof.mp4` |
| Capture unit & XR UI checks | `pnpm --filter @holoim/capture run test:unit && test:xr:ui` | Pass (37 unit tests + `test:xr:ui` in 32.5s) |
| Workspace & hosted pre-merge gate | `pnpm run doctor && pnpm run verify:hosted` | pending |

## Physical-device limits

Playwright emulates Pixel 7 viewport and touch taps; real-phone touch ergonomics and network latency for Poly Pizza / registry prop fetches remain a physical-device check.
