# Feature Briefs

Index of feature briefs. The brief is the single authority for a feature while
it is in flight: scope, acceptance criteria, and evidence live there, not in
`TODOS.md` or `HANDOFF.md`. Create one from
[`../templates/FEATURE_BRIEF.md`](../templates/FEATURE_BRIEF.md) and follow
[`../FEATURE_WORKFLOW.md`](../FEATURE_WORKFLOW.md).

| Feature | Status | Brief |
| --- | --- | --- |
| Standard avatar formats (slice 1) | Complete | [avatar-formats.md](archive/avatar-formats.md) |
| Shared XR interface and viewer VR/AR | Complete | [viewer-xr-interface.md](archive/viewer-xr-interface.md) |
| Creator accounts (IDEA-052) | Complete | [creator-accounts.md](archive/creator-accounts.md) |
| Find an object by asking (PRD-060) | Delivered; device checks open | [object-search.md](object-search.md) |
| Commit to deploy in under five minutes | Verifying on CI | [ci-under-5m.md](ci-under-5m.md) |
| Snappy feed first load | Shipped | [snappy-feed-first-load.md](snappy-feed-first-load.md) |
| Redesign UI and interaction across capture and viewer | Shipped; Android and Quest checks Unverified | [ui-redesign.md](ui-redesign.md) |
| AR recording (the phone as a camera-only author) | Complete | [ar-recording.md](archive/ar-recording.md) |
| Summon and place while speaking | Complete | [summon-and-place.md](archive/summon-and-place.md) |
| Explain with an object | Complete | [explain-with-an-object.md](archive/explain-with-an-object.md) |
| Portal view on flat screens | Implementing | [portal-view.md](portal-view.md) |
| Face and expressions on avatars | Complete | [avatar-face.md](archive/avatar-face.md) |
| Expired upload-intent cleanup | Complete | [upload-intent-cleanup.md](archive/upload-intent-cleanup.md) |
| Self-resolving pointing | Verifying | [self-resolving-pointing.md](self-resolving-pointing.md) |
| VR thumbstick locomotion and snap turn | Complete | [vr-thumbstick-locomotion.md](archive/vr-thumbstick-locomotion.md) |
| Natural full-body motion from room-scale movement | Verifying | [room-scale-body-motion.md](room-scale-body-motion.md) |
| Native IWSDK capture runtime refactor | Complete | [archive/iwsdk-runtime-refactor.md](archive/iwsdk-runtime-refactor.md) |
| IWSDK runtime prototype (evaluation spike) | Complete | [archive/iwsdk-runtime-prototype.md](archive/iwsdk-runtime-prototype.md) |
| Knowledge Atlas | Complete | [archive/knowledge-atlas.md](archive/knowledge-atlas.md) |
| Natural locomotion and terrain response | Complete | [archive/avatar-locomotion.md](archive/avatar-locomotion.md) |
| Bubble rendering across feed and XR | Complete | [archive/bubble-rendering.md](archive/bubble-rendering.md) |
| Animated Quick Look phone demo | Complete | [archive/quicklook-phone-demo.md](archive/quicklook-phone-demo.md) |
| XR height refit and visual evidence | Complete | [archive/xr-height-refit.md](archive/xr-height-refit.md) |
| XR avatar height adaptation | Complete | [archive/xr-height-adaptation.md](archive/xr-height-adaptation.md) |
| Hand-tracking fidelity from real headset input | Verifying | [hand-tracking-fidelity.md](hand-tracking-fidelity.md) |
| Capture AR recenter control | Complete | [archive/ar-recenter-control.md](archive/ar-recenter-control.md) |
| MetaVR setup for physical Quest automation | Complete | [archive/metavr-setup.md](archive/metavr-setup.md) |
| Live deployment (Fly + R2 + async USDZ) | Verifying | [live-deployment.md](live-deployment.md) |
| Migrate workspace typechecking to tsgo / TypeScript 7 | Complete | [archive/tsgo-typescript7-migration.md](archive/tsgo-typescript7-migration.md) |
| Deterministic, lean CI | Complete | [archive/deterministic-lean-ci.md](archive/deterministic-lean-ci.md) |
| Development reliability foundation | Complete | [archive/reliability-foundation.md](archive/reliability-foundation.md) |

## Rules

- Add a row when a brief is created; update only the status column as it moves.
- On completion, set the brief status to Complete and move it to `archive/`.
- Link the brief from the `TODOS.md` item it implements, when one exists.
