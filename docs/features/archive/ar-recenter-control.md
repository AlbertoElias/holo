# Feature brief: Capture AR recenter control

**Lead:** Muse (quartz-orbit)
**Status:** Verifying

## User outcome

During a capture AR session, the user can re-place the scene in front of
themselves on demand when the automatic entry placement settles badly on
a device, without exiting and re-entering AR.

## Scope

**Included:** An `ar` app mode published while an AR session is presenting;
a "Recenter AR" button in the capture DOM overlay, visible only in AR
mode, wired through `CaptureUiBridge.recenterAr()` to
`AppOrchestrator.requestRecenterAr()`, which re-runs the existing
`placeArWorldInFrontOfViewer()`; a guarded no-op outside AR.
**Excluded:** An in-headset 3D panel (the UI/interaction redesign owns
in-scene surfaces); `dom-overlay` session features; changing the
automatic 36-frame entry recenter window; the viewer's existing
"Recenter Model" button.

## Acceptance criteria

- [x] In AR mode the overlay shows a "Recenter AR" button; in every other
  mode it does not.
- [x] Clicking it re-places the AR world in front of the current viewer
  pose exactly once (no change to the automatic entry window).
- [x] Triggering recenter outside an AR session is a no-op.
- [x] Existing capture checks still pass (`verify:fast`, XR suites
  unaffected).

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Invalid/NaN XR camera pose at click time | Reuses `placeArWorldInFrontOfViewer()`, which already guards non-finite vectors with fallbacks |
| Recenter fired after AR exit | `requestRecenterAr()` checks the session is still an AR session presenting; otherwise no-op |
| Button leaks into VR/desktop UI | Overlay renders it only when the published mode is `ar`; unit test covers mode publishing |
| DOM button invisible inside a headset | Accepted limit, recorded below; in-scene surface is the redesign's scope |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Muse (quartz-orbit) | Brief, integration, final handoff |
| Design reviewer | Muse (quartz-orbit, pre-implementation pass) | Read-only review before implementation |
| Implementer | Muse (quartz-orbit) | `apps/capture/src/types/contracts.ts`, `ui/UIStateStore.ts`, `ui/captureUiBridge.ts`, `ui/CaptureOverlay.tsx`, `app/AppOrchestrator.ts`, `app/createApp.ts`, focused unit test |
| Independent verifier | Muse (quartz-orbit, fresh pass) | Read-only verification; test artifacts only |

## Design decision

Mirror the viewer's proven DOM pattern ("Recenter Model") rather than
inventing an in-scene surface the redesign will replace. The DOM overlay
is visible in AR spectator/emulation and on companion screens; the
orchestrator stays the single owner of world placement, and the new
public entry point is a guarded wrapper over the existing private
placement method. The automatic entry window is left untouched so
existing AR entry behavior cannot regress.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Button only in AR mode | Unit test on `UIStateStore.publishMode('ar')` mode/controls contract | `UIStateStore.test.ts` failed before the change (controls text), passes after: 2/2 |
| Recenter re-places world; no-op outside AR | `verify:fast` plus code-path inspection; IWER has no AR-placement suite for capture today | Guarded `requestRecenterAr()` reuses the finite-pose-safe placement; a socket-free Playwright probe (`/tmp/verify-recenter2.mjs`, serves `dist` via request interception, no port, no escalation) covers AR/VR/desktop/mobile visibility, click re-placement, and idempotence, but Chromium segfaults at launch inside this sandbox, so live browser behavior is unverified here — run it from a normal terminal to execute it |
| No regression | `pnpm --filter @holoim/capture run verify:fast` | Exit 0: lint, `tsc --noEmit`, 13/13 unit tests |

## Physical-device limits

In-headset visibility of a DOM button depends on `dom-overlay` support,
which capture does not request; on a physical Quest the button is a
spectator/companion-screen control until the redesign adds an in-scene
AR surface. Real-device AR placement feel remains a physical-headset
check, separate from IWER evidence.
