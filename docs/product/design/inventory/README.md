# UI inventory

**Status:** Reference, captured 2026-10-22 from `main` at `f5f7345`. Step 1 of the
design-language process in [design-language.md](../../concepts/design-language.md):
capture what exists before writing principles, a styleguide, or redesigns.
Nothing in the apps was changed to make these.

This folder holds one screenshot per screen and state of `apps/viewer-web` and
`apps/capture`, on every surface they run on, with the component that renders
each one. Use it as the "before" for the redesign.

## How to read it

- **Surfaces.** Desktop is a 1440x900 Chromium window. Mobile (Chromium) is a
  390x844 viewport at 2x with touch. Mobile (iOS) is real Safari on an iPhone 15
  Simulator (iOS 17.2), at 3x and scaled to 1170 px wide. VR and AR are Chromium
  with IWER emulation of a Meta Quest 3.
- **Every VR and AR screenshot is emulated (IWER), not a physical headset or
  phone.** Rows say so in the Surface column ("VR (IWER)", "AR (IWER)") and in
  their notes. IWER has no camera passthrough, so AR backgrounds are its
  synthetic room or the capture scene, never a camera feed.
- **Emulator chrome is not HoloIM UI.** The "Enter XR" pill at the top of
  localhost desktop shots and the panel in `vr-entry-with-iwer-devui.jpg` belong
  to IWER's DevUI. The ENTER VR / ENTER AR buttons at the bottom of capture are
  HoloIM's.
- **Data.** The feed shows a real capture recording (exported by the capture run
  below, with audio) under three made-up names. The viewer API is mocked at the
  network layer, so empty, slow, failing, and corrupt states are reachable on
  demand.
- **Component paths** are relative to the app folder (`apps/viewer-web/` or
  `apps/capture/`) unless they start with `packages/`.
- Each folder also has a `manifest.json` with the same rows plus file sizes.

## Counts

| App | Desktop | Mobile (Chromium) | Mobile (iOS Safari) | VR (IWER) | AR (IWER) | Total |
|---|---|---|---|---|---|---|
| viewer-web | 22 | 28 | 7 | none (no VR mode) | 7 | 64 |
| capture | 11 | 2 | 2 | 8 | 1 | 24 |

## Reproducing

The screenshots come from scripts in `scripts/ui-inventory/`, which start each
app's own dev server on a private port (capture 5179, viewer 3179; override
with `CAPTURE_INVENTORY_PORT` / `VIEWER_INVENTORY_PORT`) and need no API
server or database.

```bash
node scripts/ui-inventory/capture-app.mjs   # capture: desktop, phone, VR, AR (IWER); exports the seed GLB first
node scripts/ui-inventory/viewer-web.mjs    # viewer: feed, upload, portal, AR notices, immersive AR, Quick Look (iPhone UA)
node scripts/ui-inventory/ios-sim-server.mjs 3180   # viewer build + mocked API over http://localhost for iOS Safari
node scripts/ui-inventory/readme-table.mjs  # prints the tables below from the manifests
```

`INVENTORY_ONLY=feed,ar,immersive,quicklook` re-runs only some viewer sections
and merges them into the manifest. iOS shots were taken with `xcrun simctl
openurl` and `xcrun simctl io booted screenshot`; feed states are chosen with
`?feed=quicklook-ready|quicklook-preparing|quicklook-failed|plain|empty`. For
capture on iOS, `vite build` capture into `output/ui-inventory/capture-dist`,
copy `public/gltf/models/*.glb` beside it, and serve it over
`http://localhost`. The capture script deletes the emulator input recordings
that VR recording writes to `apps/capture/fixtures/input-recordings/`.

## Screens and states

### viewer-web (64: Desktop 22, Mobile 35, AR 7)

| App | Surface | Route or entry | Screen | State | File | Component | Notes |
|---|---|---|---|---|---|---|---|
| viewer-web | Desktop | `/` | Feed | Empty (no holograms) | [desktop-feed-empty.jpg](viewer-web/desktop-feed-empty.jpg) | src/features/feed/FeedPage.tsx | No empty-state message; the feed area is blank. |
| viewer-web | Desktop | `/` | Feed | Error: API unreachable | [desktop-feed-error-offline.jpg](viewer-web/desktop-feed-error-offline.jpg) | src/features/feed/FeedPage.tsx | "Unable to reach API…" message. |
| viewer-web | Desktop | `/` | Feed | Error: API returned 500 | [desktop-feed-error-server.jpg](viewer-web/desktop-feed-error-server.jpg) | src/features/feed/FeedPage.tsx | Shows the API error text in .feed-error. |
| viewer-web | Desktop | `/` | Feed | Loading feed | [desktop-feed-loading.jpg](viewer-web/desktop-feed-loading.jpg) | src/features/feed/FeedPage.tsx | Plain "Loading…" text; no skeleton. |
| viewer-web | Desktop | `/` | Feed | Scrolled to the second card | [desktop-feed-second-card.jpg](viewer-web/desktop-feed-second-card.jpg) | src/features/feed/FeedPage.tsx | Scroll-snap feed; the active card is the one 70%+ visible. |
| viewer-web | Desktop (IWER) | `/` | Feed card | AR trigger visible (WebXR AR supported), hover | [desktop-card-ar-trigger-hover.jpg](viewer-web/desktop-card-ar-trigger-hover.jpg) | src/features/feed/HologramCard.tsx | Emulated (IWER, Meta Quest 3 profile, office_small synthetic room), not a physical device. The AR icon button only shows where immersive-ar is supported and not on iOS. |
| viewer-web | Desktop | `/` | Feed card | Audio available, muted (default) | [desktop-card-audio-muted.jpg](viewer-web/desktop-card-audio-muted.jpg) | src/features/feed/HologramCard.tsx | Mute toggle appears only when the GLB carries audio. |
| viewer-web | Desktop | `/` | Feed card | Hologram file corrupted (not a GLB) | [desktop-card-corrupt.jpg](viewer-web/desktop-card-corrupt.jpg) | src/features/feed/HologramCard.tsx |  |
| viewer-web | Desktop | `/` | Feed card | Hologram loading (availability check pending) | [desktop-card-loading.jpg](viewer-web/desktop-card-loading.jpg) | src/features/feed/HologramCard.tsx | "Loading hologram..." inside the empty bubble. |
| viewer-web | Desktop | `/` | Feed card | Hologram file missing (404) | [desktop-card-missing.jpg](viewer-web/desktop-card-missing.jpg) | src/features/feed/HologramCard.tsx |  |
| viewer-web | Desktop | `/` | Feed card | Populated, active card playing (Follow view) | [desktop-feed-populated-playing.jpg](viewer-web/desktop-feed-populated-playing.jpg) | src/features/feed/HologramCard.tsx; src/features/feed/HologramCardCanvas.tsx; src/features/portal/PortalControls.tsx | Recorded hologram in the bubble portal, Pause control, meta line. Upload panel expanded on the left. |
| viewer-web | Desktop | `/` | Feed card | Keyboard focus on the bubble portal | [desktop-portal-bubble-focus.jpg](viewer-web/desktop-portal-bubble-focus.jpg) | src/features/feed/HologramCard.tsx | Space pauses, arrows look around, +/- zoom, Escape returns. |
| viewer-web | Desktop | `/` | Portal controls | Paused, free look (dragged), Return-to-author control | [desktop-portal-free-look.jpg](viewer-web/desktop-portal-free-look.jpg) | src/features/portal/PortalControls.tsx | Return control appears once the view leaves Follow. |
| viewer-web | Desktop | `/` | Portal controls | Hover on Pause | [desktop-portal-pause-hover.jpg](viewer-web/desktop-portal-pause-hover.jpg) | src/features/portal/PortalControls.tsx |  |
| viewer-web | Desktop | `/` | Portal controls | Paused (portal captured) | [desktop-portal-paused.jpg](viewer-web/desktop-portal-paused.jpg) | src/features/feed/HologramCard.tsx; src/features/portal/PortalControls.tsx | Play icon replaces Pause; card gets .portal-captured in the freeze variant. |
| viewer-web | Desktop | `/` | Portal controls | Paused, zoomed in to eye level (wheel) | [desktop-portal-zoomed-in.jpg](viewer-web/desktop-portal-zoomed-in.jpg) | src/features/feed/HologramCard.tsx; global.css (--portal-open) | Bubble chrome fades as --portal-open rises. |
| viewer-web | Desktop | `/` | Upload panel | Expanded, empty form | [desktop-upload-empty.jpg](viewer-web/desktop-upload-empty.jpg) | src/features/upload/UploadPanel.tsx (packages/ui-dom UiPanel/UiField/UiInput/UiButton/UiNotice) | Upload button disabled until a file is chosen. |
| viewer-web | Desktop | `/` | Upload panel | Focus on Hologram name | [desktop-upload-field-focus.jpg](viewer-web/desktop-upload-field-focus.jpg) | src/features/upload/UploadPanel.tsx (packages/ui-dom UiPanel/UiField/UiInput/UiButton/UiNotice) |  |
| viewer-web | Desktop | `/` | Upload panel | File selected, Quick Look checked, ready | [desktop-upload-ready.jpg](viewer-web/desktop-upload-ready.jpg) | src/features/upload/UploadPanel.tsx (packages/ui-dom UiPanel/UiField/UiInput/UiButton/UiNotice) |  |
| viewer-web | Desktop | `/` | Upload panel | Server error (413 too large) | [desktop-upload-server-error.jpg](viewer-web/desktop-upload-server-error.jpg) | src/features/upload/UploadPanel.tsx (packages/ui-dom UiPanel/UiField/UiInput/UiButton/UiNotice) |  |
| viewer-web | Desktop | `/` | Upload panel | Uploading (in progress) | [desktop-upload-uploading.jpg](viewer-web/desktop-upload-uploading.jpg) | src/features/upload/UploadPanel.tsx (packages/ui-dom UiPanel/UiField/UiInput/UiButton/UiNotice) | Fields and button disabled, button reads "Uploading..."; no progress bar or percentage. |
| viewer-web | Desktop | `/` | Upload panel | Validation error (missing submitter) | [desktop-upload-validation-error.jpg](viewer-web/desktop-upload-validation-error.jpg) | src/features/upload/UploadPanel.tsx (packages/ui-dom UiPanel/UiField/UiInput/UiButton/UiNotice) | Danger UiNotice under the button. |
| viewer-web | Mobile (iOS 17.2 Safari, iPhone 15 Simulator) | `/ar/:id` | AR view | iOS opening /ar/:id is sent back to the feed | [ios-sim-ar-route.jpg](viewer-web/ios-sim-ar-route.jpg) | src/features/ar/useArController.ts (isIOSDevice redirect) | Real iOS Safari in the Simulator; production build served over http://localhost with a mocked API (scripts/ui-inventory/ios-sim-server.mjs). |
| viewer-web | Mobile (390x844, Chromium) | `/ar/:id` | AR view | Error: hologram file missing | [phone-ar-file-missing.jpg](viewer-web/phone-ar-file-missing.jpg) | src/features/ar/ARView.tsx |  |
| viewer-web | Mobile (390x844, Chromium) | `/ar/:id` | AR view | Loading hologram | [phone-ar-loading.jpg](viewer-web/phone-ar-loading.jpg) | src/features/ar/ARView.tsx (UiNotice) |  |
| viewer-web | Mobile (390x844, Chromium) | `/ar/:id` | AR view | Error: hologram not found | [phone-ar-not-found.jpg](viewer-web/phone-ar-not-found.jpg) | src/features/ar/ARView.tsx (UiNotice danger, UiButton ghost) |  |
| viewer-web | Mobile (390x844, Chromium) | `/ar/:id` | AR view | Preparing hologram for AR (model check pending) | [phone-ar-preparing.jpg](viewer-web/phone-ar-preparing.jpg) | src/features/ar/ARView.tsx (UiNotice) |  |
| viewer-web | Mobile (390x844, Chromium) | `/ar/:id` | AR view | Error: AR session refused (camera permission denied) | [phone-ar-session-failed.jpg](viewer-web/phone-ar-session-failed.jpg) | src/features/ar/ARView.tsx | Stands in for the OS camera-permission denial, which is browser/OS chrome. |
| viewer-web | Mobile (390x844, Chromium) | `/ar/:id` | AR view | Error: AR not supported in this browser | [phone-ar-unsupported.jpg](viewer-web/phone-ar-unsupported.jpg) | src/features/ar/ARView.tsx; src/features/ar/arController.ts (resolveArSupportMessage) |  |
| viewer-web | Mobile (iOS 17.2 Safari, iPhone 15 Simulator) | `/` | Feed | Empty (no holograms) | [ios-sim-feed-empty.jpg](viewer-web/ios-sim-feed-empty.jpg) | src/features/feed/FeedPage.tsx | Real iOS Safari in the Simulator; production build served over http://localhost with a mocked API (scripts/ui-inventory/ios-sim-server.mjs). |
| viewer-web | Mobile (390x844, Chromium) | `/` | Feed | Empty (no holograms) | [phone-feed-empty.jpg](viewer-web/phone-feed-empty.jpg) | src/features/feed/FeedPage.tsx | No empty-state message; the feed area is blank. |
| viewer-web | Mobile (390x844, Chromium) | `/` | Feed | Error: API unreachable | [phone-feed-error-offline.jpg](viewer-web/phone-feed-error-offline.jpg) | src/features/feed/FeedPage.tsx | "Unable to reach API…" message. |
| viewer-web | Mobile (390x844, Chromium) | `/` | Feed | Error: API returned 500 | [phone-feed-error-server.jpg](viewer-web/phone-feed-error-server.jpg) | src/features/feed/FeedPage.tsx | Shows the API error text in .feed-error. |
| viewer-web | Mobile (390x844, Chromium) | `/` | Feed | Loading feed | [phone-feed-loading.jpg](viewer-web/phone-feed-loading.jpg) | src/features/feed/FeedPage.tsx | Plain "Loading…" text; no skeleton. |
| viewer-web | Mobile (390x844, Chromium) | `/` | Feed | Scrolled to the second card | [phone-feed-second-card.jpg](viewer-web/phone-feed-second-card.jpg) | src/features/feed/FeedPage.tsx | Scroll-snap feed; the active card is the one 70%+ visible. |
| viewer-web | Mobile (iOS 17.2 Safari, iPhone 15 Simulator) | `/` | Feed card | Quick Look not enabled: no AR entry on iOS | [ios-sim-feed-no-quicklook.jpg](viewer-web/ios-sim-feed-no-quicklook.jpg) | src/features/feed/HologramCard.tsx | Real iOS Safari in the Simulator; production build served over http://localhost with a mocked API (scripts/ui-inventory/ios-sim-server.mjs). iOS never shows the WebXR AR button. |
| viewer-web | Mobile (390x844, Chromium) | `/` | Feed card | Audio available, muted (default) | [phone-card-audio-muted.jpg](viewer-web/phone-card-audio-muted.jpg) | src/features/feed/HologramCard.tsx | Mute toggle appears only when the GLB carries audio. |
| viewer-web | Mobile (390x844, Chromium) | `/` | Feed card | Hologram file corrupted (not a GLB) | [phone-card-corrupt.jpg](viewer-web/phone-card-corrupt.jpg) | src/features/feed/HologramCard.tsx |  |
| viewer-web | Mobile (390x844, Chromium) | `/` | Feed card | Hologram loading (availability check pending) | [phone-card-loading.jpg](viewer-web/phone-card-loading.jpg) | src/features/feed/HologramCard.tsx | "Loading hologram..." inside the empty bubble. |
| viewer-web | Mobile (390x844, Chromium) | `/` | Feed card | Hologram file missing (404) | [phone-card-missing.jpg](viewer-web/phone-card-missing.jpg) | src/features/feed/HologramCard.tsx |  |
| viewer-web | Mobile (390x844, Chromium) | `/` | Feed card | Populated, active card playing (Follow view) | [phone-feed-populated-playing.jpg](viewer-web/phone-feed-populated-playing.jpg) | src/features/feed/HologramCard.tsx; src/features/feed/HologramCardCanvas.tsx; src/features/portal/PortalControls.tsx | Recorded hologram in the bubble portal, Pause control, meta line. Upload panel collapsed to "⬆ Upload". |
| viewer-web | Mobile (iOS 17.2 Safari, iPhone 15 Simulator) | `/` | Feed card, Quick Look entry | USDZ failed: "Preview unavailable" (disabled) | [ios-sim-feed-quicklook-failed.jpg](viewer-web/ios-sim-feed-quicklook-failed.jpg) | src/features/ar/ARQuickLookLink.tsx; src/features/feed/HologramCard.tsx | Real iOS Safari in the Simulator; production build served over http://localhost with a mocked API (scripts/ui-inventory/ios-sim-server.mjs). |
| viewer-web | Mobile (iOS 17.2 Safari, iPhone 15 Simulator) | `/` | Feed card, Quick Look entry | USDZ converting: "Preparing preview…" (disabled) | [ios-sim-feed-quicklook-preparing.jpg](viewer-web/ios-sim-feed-quicklook-preparing.jpg) | src/features/ar/ARQuickLookLink.tsx; src/features/feed/HologramCard.tsx | Real iOS Safari in the Simulator; production build served over http://localhost with a mocked API (scripts/ui-inventory/ios-sim-server.mjs). Captured mid-playback; the camera was inside scenery at that moment. |
| viewer-web | Mobile (iOS 17.2 Safari, iPhone 15 Simulator) | `/` | Feed card, Quick Look entry | USDZ ready: "View in AR" link (rel="ar") | [ios-sim-feed-quicklook-ready.jpg](viewer-web/ios-sim-feed-quicklook-ready.jpg) | src/features/ar/ARQuickLookLink.tsx; src/features/feed/HologramCard.tsx | Real iOS Safari in the Simulator; production build served over http://localhost with a mocked API (scripts/ui-inventory/ios-sim-server.mjs). Tapping hands off to AR Quick Look (OS-owned; not captured). The ⬆ in "Upload" renders as an emoji on iOS. |
| viewer-web | Mobile (iPhone UA, Chromium) | `/` | Feed card, Quick Look entry | USDZ failed: "Preview unavailable" (disabled) | [phone-ios-quicklook-failed.jpg](viewer-web/phone-ios-quicklook-failed.jpg) | src/features/ar/ARQuickLookLink.tsx | Emulated iOS detection (user agent and platform). Real iOS Safari captures are under ios-sim-*. |
| viewer-web | Mobile (iPhone UA, Chromium) | `/` | Feed card, Quick Look entry | USDZ converting: "Preparing preview…" (disabled) | [phone-ios-quicklook-preparing.jpg](viewer-web/phone-ios-quicklook-preparing.jpg) | src/features/ar/ARQuickLookLink.tsx | Emulated iOS detection (user agent and platform). Real iOS Safari captures are under ios-sim-*. |
| viewer-web | Mobile (iPhone UA, Chromium) | `/` | Feed card, Quick Look entry | USDZ ready: "View in AR" link (rel="ar") | [phone-ios-quicklook-ready.jpg](viewer-web/phone-ios-quicklook-ready.jpg) | src/features/ar/ARQuickLookLink.tsx | Emulated iOS detection (user agent and platform). Real iOS Safari captures are under ios-sim-*. |
| viewer-web | Mobile (iOS 17.2 Safari, iPhone 15 Simulator) | `/?portal=tilt` | Portal controls | Tilt variant: "look around by tilting" control above Pause | [ios-sim-portal-tilt-variant.jpg](viewer-web/ios-sim-portal-tilt-variant.jpg) | src/features/portal/PortalControls.tsx; src/features/portal/portalVariant.ts | Real iOS Safari in the Simulator; production build served over http://localhost with a mocked API (scripts/ui-inventory/ios-sim-server.mjs). The iOS motion-permission prompt appears only after tapping the control (not captured). |
| viewer-web | Mobile (390x844, Chromium) | `/` | Portal controls | Paused, free look (dragged), Return-to-author control | [phone-portal-free-look.jpg](viewer-web/phone-portal-free-look.jpg) | src/features/portal/PortalControls.tsx | Return control appears once the view leaves Follow. |
| viewer-web | Mobile (390x844, Chromium) | `/` | Portal controls | Paused (portal captured) | [phone-portal-paused.jpg](viewer-web/phone-portal-paused.jpg) | src/features/feed/HologramCard.tsx; src/features/portal/PortalControls.tsx | Play icon replaces Pause; card gets .portal-captured in the freeze variant. |
| viewer-web | Mobile (390x844, Chromium) | `/` | Upload panel | Collapsed toggle | [phone-upload-collapsed.jpg](viewer-web/phone-upload-collapsed.jpg) | src/features/upload/UploadPanel.tsx (packages/ui-dom UiPanel/UiField/UiInput/UiButton/UiNotice) |  |
| viewer-web | Mobile (390x844, Chromium) | `/` | Upload panel | Expanded, empty form | [phone-upload-empty.jpg](viewer-web/phone-upload-empty.jpg) | src/features/upload/UploadPanel.tsx (packages/ui-dom UiPanel/UiField/UiInput/UiButton/UiNotice) | Upload button disabled until a file is chosen. |
| viewer-web | Mobile (390x844, Chromium) | `/` | Upload panel | Focus on Hologram name | [phone-upload-field-focus.jpg](viewer-web/phone-upload-field-focus.jpg) | src/features/upload/UploadPanel.tsx (packages/ui-dom UiPanel/UiField/UiInput/UiButton/UiNotice) |  |
| viewer-web | Mobile (390x844, Chromium) | `/` | Upload panel | File selected, Quick Look checked, ready | [phone-upload-ready.jpg](viewer-web/phone-upload-ready.jpg) | src/features/upload/UploadPanel.tsx (packages/ui-dom UiPanel/UiField/UiInput/UiButton/UiNotice) |  |
| viewer-web | Mobile (390x844, Chromium) | `/` | Upload panel | Server error (413 too large) | [phone-upload-server-error.jpg](viewer-web/phone-upload-server-error.jpg) | src/features/upload/UploadPanel.tsx (packages/ui-dom UiPanel/UiField/UiInput/UiButton/UiNotice) |  |
| viewer-web | Mobile (390x844, Chromium) | `/` | Upload panel | Uploading (in progress) | [phone-upload-uploading.jpg](viewer-web/phone-upload-uploading.jpg) | src/features/upload/UploadPanel.tsx (packages/ui-dom UiPanel/UiField/UiInput/UiButton/UiNotice) | Fields and button disabled, button reads "Uploading..."; no progress bar or percentage. |
| viewer-web | Mobile (390x844, Chromium) | `/` | Upload panel | Validation error (missing submitter) | [phone-upload-validation-error.jpg](viewer-web/phone-upload-validation-error.jpg) | src/features/upload/UploadPanel.tsx (packages/ui-dom UiPanel/UiField/UiInput/UiButton/UiNotice) | Danger UiNotice under the button. |
| viewer-web | AR (IWER, phone portrait) | `/ar/:id` | Immersive AR | Session started, placement stage "placed" | [ar-phone-no-hit-test-entering.jpg](viewer-web/ar-phone-no-hit-test-entering.jpg) | src/features/ar/ARView.tsx; packages/xr-ui-r3f HeadLockedActionBar; src/features/ar/ARHologramModel.tsx | Emulated (IWER, Meta Quest 3 profile, office_small synthetic room), not a physical device. The head-locked 3D action bar (Exit AR, Recenter Model, placement status) is what shows in-session; the DOM overlay copies of those buttons sit under IWER's composited view. The bar's apparent size depends on the emulated field of view. |
| viewer-web | AR (IWER, phone portrait) | `/ar/:id` | Immersive AR | No hit-test or planes: waiting, then fallback placement (stage/mode/reason: locked / visibility-fallback / hit-test-unavailable) | [ar-phone-no-hit-test-settled.jpg](viewer-web/ar-phone-no-hit-test-settled.jpg) | src/features/ar/ARView.tsx; src/features/ar/ARHologramModel.tsx; src/features/ar/ARBubbleAura.tsx | Emulated (IWER, Meta Quest 3 profile, office_small synthetic room), not a physical device. No camera passthrough in emulation; the background is IWER's synthetic room. |
| viewer-web | AR (IWER, phone portrait) | `/ar/:id` | Immersive AR | Session started, placement stage "anchored" | [ar-phone-placed-entering.jpg](viewer-web/ar-phone-placed-entering.jpg) | src/features/ar/ARView.tsx; packages/xr-ui-r3f HeadLockedActionBar; src/features/ar/ARHologramModel.tsx | Emulated (IWER, Meta Quest 3 profile, office_small synthetic room), not a physical device. The head-locked 3D action bar (Exit AR, Recenter Model, placement status) is what shows in-session; the DOM overlay copies of those buttons sit under IWER's composited view. The bar's apparent size depends on the emulated field of view. |
| viewer-web | AR (IWER, phone portrait) | `/ar/:id` | Immersive AR | Placed on a surface (hit-test) (stage/mode/reason: anchored / hit-test / hit-test-anchor) | [ar-phone-placed-settled.jpg](viewer-web/ar-phone-placed-settled.jpg) | src/features/ar/ARView.tsx; src/features/ar/ARHologramModel.tsx; src/features/ar/ARBubbleAura.tsx | Emulated (IWER, Meta Quest 3 profile, office_small synthetic room), not a physical device. No camera passthrough in emulation; the background is IWER's synthetic room. |
| viewer-web | AR (IWER) | `/ar/:id` | Immersive AR | Session started, placement stage "" | [ar-placed-entering.jpg](viewer-web/ar-placed-entering.jpg) | src/features/ar/ARView.tsx; packages/xr-ui-r3f HeadLockedActionBar; src/features/ar/ARHologramModel.tsx | Emulated (IWER, Meta Quest 3 profile, office_small synthetic room), not a physical device. The head-locked 3D action bar (Exit AR, Recenter Model, placement status) is what shows in-session; the DOM overlay copies of those buttons sit under IWER's composited view. The bar's apparent size depends on the emulated field of view. |
| viewer-web | AR (IWER) | `/ar/:id` | Immersive AR | Head pitched down: the action bar follows the head and still fills the view | [ar-placed-look-down.jpg](viewer-web/ar-placed-look-down.jpg) | src/features/ar/ARHologramModel.tsx; src/features/ar/ARBubbleAura.tsx; packages/xr-ui-r3f HeadLockedActionBar | Emulated (IWER, Meta Quest 3 profile, office_small synthetic room), not a physical device. |
| viewer-web | AR (IWER) | `/ar/:id` | Immersive AR | Placed on a surface (hit-test) (stage/mode/reason: anchored / hit-test / hit-test-anchor) | [ar-placed-settled.jpg](viewer-web/ar-placed-settled.jpg) | src/features/ar/ARView.tsx; src/features/ar/ARHologramModel.tsx; src/features/ar/ARBubbleAura.tsx | Emulated (IWER, Meta Quest 3 profile, office_small synthetic room), not a physical device. No camera passthrough in emulation; the background is IWER's synthetic room. |

### capture (24: Desktop 11, Mobile 4, VR 8, AR 1)

| App | Surface | Route or entry | Screen | State | File | Component | Notes |
|---|---|---|---|---|---|---|---|
| capture | Desktop | `/` | Capture runtime | First-person camera (V) | [desktop-first-person-idle.jpg](capture/desktop-first-person-idle.jpg) | src/ui/CaptureOverlay.tsx | Same overlay; camera inside the avatar. |
| capture | Desktop | `/` | Capture runtime | Loading scene (first paint) | [desktop-loading.jpg](capture/desktop-loading.jpg) | src/ui/CaptureOverlay.tsx | Status panel before the scene and avatar finish loading. |
| capture | Desktop | `/` | Capture runtime | Microphone permission denied | [desktop-mic-denied.jpg](capture/desktop-mic-denied.jpg) | src/ui/CaptureOverlay.tsx | Warning notice: recording exports without audio. |
| capture | Desktop | `/` | Capture runtime | Microphone permission pending | [desktop-mic-pending.jpg](capture/desktop-mic-pending.jpg) | src/ui/CaptureOverlay.tsx | Headless run: the permission prompt itself is browser chrome and is not in the page. |
| capture | Desktop | `/` | Capture runtime | Loaded, third-person camera, idle, mic granted | [desktop-third-person-idle.jpg](capture/desktop-third-person-idle.jpg) | src/ui/CaptureOverlay.tsx; src/runtime/xrEntry.ts (createEntryButton) | Default view. ENTER VR / ENTER AR buttons are offered because IWER emulation is active on localhost. |
| capture | Desktop | `/` | Recording panel | Idle after export (GLB downloaded) | [desktop-after-export.jpg](capture/desktop-after-export.jpg) | src/ui/CaptureOverlay.tsx | The export is a browser download (avatar-recording-1792651568598.glb); there is no in-app success message. |
| capture | Desktop | `/` | Recording panel | Exporting (export progress) | [desktop-exporting.jpg](capture/desktop-exporting.jpg) | src/ui/CaptureOverlay.tsx | Button disabled with the export message; no percentage progress is shown. |
| capture | Desktop | `/` | Recording panel | Keyboard focus on Start Recording | [desktop-record-button-focus.jpg](capture/desktop-record-button-focus.jpg) | src/ui/CaptureOverlay.tsx; packages/ui-dom UiButton | Focus ring from packages/ui-dom. |
| capture | Desktop | `/` | Recording panel | Recording (walking) | [desktop-recording.jpg](capture/desktop-recording.jpg) | src/ui/CaptureOverlay.tsx | Pill reads "recording"; button turns danger-toned "Stop Recording". |
| capture | Desktop | `/` | XR entry buttons | Hover on ENTER VR | [desktop-enter-vr-hover.jpg](capture/desktop-enter-vr-hover.jpg) | src/runtime/xrEntry.ts (createEntryButton) | Buttons go from 50% to 100% opacity on hover; three.js VRButton look. |
| capture | Desktop | `/ (LAN origin, no IWER)` | XR entry buttons | No headset: VR NOT SUPPORTED / AR NOT SUPPORTED | [desktop-no-xr.jpg](capture/desktop-no-xr.jpg) | src/runtime/xrEntry.ts (createEntryButton) | What a desktop browser without a headset sees; IWER only activates on localhost. |
| capture | Mobile (iOS 17.2 Safari, iPhone 15 Simulator) | `/` | Capture runtime | Scene/avatar load error, microphone permission prompt (iOS system dialog), WEBXR NOT AVAILABLE | [ios-sim-load-error-mic-prompt.jpg](capture/ios-sim-load-error-mic-prompt.jpg) | src/ui/CaptureOverlay.tsx; src/runtime/xrEntry.ts (createWebXrUnavailableNotice) | Real iOS Safari in the Simulator. Load error reached because the out-of-tree static build lacked the model files; the error panel is the real app state. |
| capture | Mobile (iOS 17.2 Safari, iPhone 15 Simulator) | `/` | Capture runtime | Loaded on iOS: mic prompt over the scene, WEBXR NOT AVAILABLE | [ios-sim-loaded.jpg](capture/ios-sim-loaded.jpg) | src/ui/CaptureOverlay.tsx; src/runtime/xrEntry.ts | Real iOS Safari in the Simulator; production build over http://localhost. The status copy still lists desktop keyboard controls on a phone. |
| capture | Mobile (390x844, Chromium) | `/` | Capture runtime | Loaded, idle | [phone-idle.jpg](capture/phone-idle.jpg) | src/ui/CaptureOverlay.tsx; src/runtime/xrEntry.ts (createEntryButton) | Mode pill reads "mobile". Panels overlap the scene; ENTER VR/AR shown because of IWER on localhost. |
| capture | Mobile (390x844, Chromium) | `/` | Recording panel | Recording | [phone-recording.jpg](capture/phone-recording.jpg) | src/ui/CaptureOverlay.tsx | No touch locomotion controls exist on phones. |
| capture | VR (IWER) | `/ → ENTER VR` | Immersive VR session | Just entered: height fit pending ("Hold neutral posture…"), IWER DevUI visible | [vr-entry-with-iwer-devui.jpg](capture/vr-entry-with-iwer-devui.jpg) | src/ui/VrHud.ts, src/ui/VrRecordingPanel.ts, packages/xr-ui-three (ThreeRecordingActionPanel, ThreeLabelPill); src/ui/CaptureOverlay.tsx | Emulated (IWER, Meta Quest 3 profile), not a physical headset. The IWER DevUI controls are emulator chrome, not HoloIM UI. |
| capture | VR (IWER) | `/ → ENTER VR` | VR recording panel | Exporting | [vr-exporting.jpg](capture/vr-exporting.jpg) | src/ui/VrHud.ts, src/ui/VrRecordingPanel.ts, packages/xr-ui-three (ThreeRecordingActionPanel, ThreeLabelPill) | Emulated (IWER, Meta Quest 3 profile), not a physical headset. Amber pill with the export message. |
| capture | VR (IWER) | `/ → ENTER VR` | VR recording panel | Hand touch on the record pill (starts recording) | [vr-hand-touch-record.jpg](capture/vr-hand-touch-record.jpg) | src/ui/VrHud.ts, src/ui/VrRecordingPanel.ts, packages/xr-ui-three (ThreeRecordingActionPanel, ThreeLabelPill) | Emulated (IWER, Meta Quest 3 profile), not a physical headset. Touch radius 0.14 m. |
| capture | VR (IWER) | `/ → ENTER VR` | VR recording panel | Hand tracking, hands raised (no controllers) | [vr-hands-idle.jpg](capture/vr-hands-idle.jpg) | src/ui/VrHud.ts, src/ui/VrRecordingPanel.ts, packages/xr-ui-three (ThreeRecordingActionPanel, ThreeLabelPill); src/xr/HandEmbodiment.ts | Emulated (IWER, Meta Quest 3 profile), not a physical headset. Hands drive the avatar's hands; no aim rays. Touching the pill presses it. |
| capture | VR (IWER) | `/ → ENTER VR` | VR recording panel | Controller ray hovering the record pill | [vr-hover-record.jpg](capture/vr-hover-record.jpg) | src/ui/VrHud.ts, src/ui/VrRecordingPanel.ts, packages/xr-ui-three (ThreeRecordingActionPanel, ThreeLabelPill) | Emulated (IWER, Meta Quest 3 profile), not a physical headset. Ray turns white and shortens to the panel on hover. |
| capture | VR (IWER) | `/ → ENTER VR` | VR recording panel | Controller ray hovering Refit height | [vr-hover-refit.jpg](capture/vr-hover-refit.jpg) | src/ui/VrHud.ts, src/ui/VrRecordingPanel.ts, packages/xr-ui-three (ThreeRecordingActionPanel, ThreeLabelPill) | Emulated (IWER, Meta Quest 3 profile), not a physical headset. |
| capture | VR (IWER) | `/ → ENTER VR` | VR recording panel | Idle, height fitted, controllers with aim rays | [vr-idle-controllers.jpg](capture/vr-idle-controllers.jpg) | src/ui/VrHud.ts, src/ui/VrRecordingPanel.ts, packages/xr-ui-three (ThreeRecordingActionPanel, ThreeLabelPill) | Emulated (IWER, Meta Quest 3 profile), not a physical headset. Floating Start Recording and Refit height pills under the view; the 2D overlay stays on the flat page. |
| capture | VR (IWER) | `/ → ENTER VR` | VR recording panel | Recording; refit locked | [vr-recording.jpg](capture/vr-recording.jpg) | src/ui/VrHud.ts, src/ui/VrRecordingPanel.ts, packages/xr-ui-three (ThreeRecordingActionPanel, ThreeLabelPill) | Emulated (IWER, Meta Quest 3 profile), not a physical headset. Pill turns red "Stop Recording"; refit pill greys to "Refit after recording". |
| capture | AR (IWER) | `/ → ENTER AR` | Capture AR spectator | Immersive AR session, idle | [ar-session.jpg](capture/ar-session.jpg) | src/xr/ArSpectator.ts; src/ui/CaptureOverlay.tsx | Emulated (IWER, Meta Quest 3 profile), not a physical headset. Overlay status switches to AR. IWER has no camera passthrough, so the spectator shows the scene; the recording panel with Recenter AR did not appear in this capture. |

## Current visual styling sources

| Source | What it styles |
|---|---|
| `packages/ui-dom/src/index.tsx` (`uiDomTokens`, `UiPanel`, `UiButton`, `UiField`, `UiInput`, `UiNotice`, `UiPill`, `UiStack`, `UiFixedSurface`, `UiActionRow`) | The only shared 2D tokens, as inline styles: translucent navy panels (`rgb(6 13 22 / 88%)`, 14 px blur, 16 px radius), pill buttons with a blue gradient (`rgb(29 105 160)` → `rgb(12 68 107)`), text `#ebf6ff` / muted `#b7d6f5`, danger `#ff9ea6`, success `#76f0c3`. Used by viewer's upload panel and AR notices and by capture's overlay. |
| `apps/viewer-web/src/styles/global.css` (about 1,000 lines) | Everything else in the viewer: radial navy page background, the feed and scroll snap, the bubble portal (glow, aura, rim, base, `--portal-open` fade), card badge and meta, AR, Quick Look, mute and portal control buttons, upload panel layout and its mobile toggle. Font stack `"Space Grotesk", "Avenir Next", sans-serif`, but no font is loaded, so Macs and iPhones get Avenir Next and other systems a generic sans. |
| Inline SVG icons in `HologramCard.tsx` and `PortalControls.tsx` | AR, mute, play/pause, return-to-author and tilt icons, hand-drawn per component. |
| `packages/xr-ui-r3f/src/index.tsx` (`HeadLockedActionBar`) | Viewer's in-session AR bar (`@react-three/uikit`): Exit AR `#7a2530`/`#ff9ca6`, Recenter `#112234`/`#6f9cc5`, primary `#1a5d8f`/`#8ccfff`, panel `#07131f` with border `#8bc8ff`, plus the placement status line. |
| `packages/xr-ui-core/src/index.ts` | Copy and state for XR UI shared by both apps: recording labels ("Start Recording", "Stop Recording", export message), AR notices, immersive action list, placement state. No visuals. |
| `packages/xr-ui-three/src/index.ts` (`ThreeLabelPill`, `ThreeRecordingActionPanel`) | Capture's VR pills, drawn on a 2D canvas texture: idle `#1a5d8f`/`#8fcfff`, recording `#7a2530`/`#ff9ca6`, exporting `#6f5a1e`/`#f7cf7a`. |
| `apps/capture/src/ui/VrRecordingPanel.ts`, `src/ui/VrHud.ts` | Refit pill colours (`#14354a`/`#8fcfff`, disabled text `#92a4af`) and controller aim rays (`#8fcfff`, white on hover). |
| `apps/capture/src/ui/CaptureOverlay.tsx` | Capture's 2D overlay layout, built from `ui-dom` with a few inline overrides (mint pill `#c9ffef`). |
| `apps/capture/src/runtime/xrEntry.ts` | ENTER VR / ENTER AR / NOT SUPPORTED / WEBXR NOT AVAILABLE buttons, copied from three.js's `VRButton` look (13 px sans, white 1 px border, 50% opacity). |
| `apps/capture/index.html` | Page background `#0f1012`, text `#eceff4`, system UI font. |
| `apps/capture/src/debug/HeightEvidenceView.ts`, `DiagnosticViews.ts` | Debug-only canvas labels and overlays used by tests; not product UI. |

## Not captured

| UI | Why |
|---|---|
| AR Quick Look itself (after tapping "View in AR" on iOS) | The OS owns that screen, and the Simulator panel's tap access was not granted during this run, so nothing could be tapped. The entry link in its three states is captured on real iOS Safari. |
| iOS states that need a tap: upload panel expanded, portal paused, motion-permission prompt for tilt | Same: no tap access to the Simulator. The same states are captured in Chromium at phone width; the motion prompt has no Chromium equivalent. |
| Android Chrome AR (camera permission prompt, real passthrough, real plane finding) | No Android device or emulator here. Immersive AR is covered with IWER; `phone-ar-session-failed.jpg` stands in for a refused camera permission. |
| Physical Quest (VR and passthrough AR) | Out of scope for emulation; MetaVR automation is opt-in. Every VR/AR row is IWER. |
| Capture's VR panel with the 2D overlay in the same view | IWER draws the immersive view over the page, so the 2D overlay is not visible during VR. Its VR-mode copy ("vr" pill, Refit height button) exists in `CaptureOverlay.tsx`. |
| Viewer's DOM overlay buttons during immersive AR (Recenter Model / Exit AR in the top right) | Same reason: they sit under IWER's composited view. The head-locked 3D bar with the same actions is captured. |
| Capture AR recording panel with Recenter AR | The capture AR run showed the AR status but not the bottom recording panel; not investigated further. |
| Viewer immersive VR | viewer-web has no VR mode, only `immersive-ar`. |
| Feed "load more" spinner, upload success toast | Load more shows the same "Loading…" text as the first load; a successful upload just prepends the card, with no message. |
| `drag` and `freeze` portal variants side by side | They differ only in gestures, not visuals; the default variant is shown, and `tilt` adds the extra control captured on iOS. |
| Microphone permission prompt in Chromium | Browser chrome is outside the page in headless Chromium; the real iOS prompt is captured instead. |

## Observations for the redesign

Noted while capturing; not fixed here.

- On desktop the feed's error text renders at the top left, under the upload panel, so `desktop-feed-error-*.jpg` look almost the same as the empty feed. The empty feed has no message at all.
- In emulated AR the head-locked action bar fills most of the view, and on a portrait phone it is cut off at both sides (`ar-phone-*.jpg`).
- Capture's exporting pill in VR shows a full file path squeezed to fit (`vr-exporting.jpg`).
- Capture on a phone shows the desktop keyboard instructions, and its two panels cover most of the scene (`phone-idle.jpg`, `ios-sim-loaded.jpg`).
- The ⬆ glyph in the viewer's "Upload" toggle renders as a colour emoji on iOS.
- Export progress and upload progress are text-only ("Exporting…", "Uploading..."), with no percentage or success state.
