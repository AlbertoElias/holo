# Photo-look fixtures

These are the photos the phone e2e (`../../phone-photo-look.pipeline.spec.ts`)
and the IWER check `headset-photo-look` (`apps/capture/scripts/lib/look-take.mjs`)
read. See docs/features/directed-performance.md, slice 5b.

| File | What it is | Source and status |
|---|---|---|
| `portrait.jpg` | The official portrait of a member of the US Congress, bioguide ID B001243, 675 × 825 px. SHA-256 `fcda12acb3cc77472a2e540e499d056fb38b43b5bf431d912b685b064b245db6` | `https://unitedstates.github.io/images/congress/original/B001243.jpg`, from the official Congressional portraits that the GPO publishes. It is a work of the US government, so it is in the public domain in the United States. |
| `house-face.jpg` | The house base rendered close up in a known card, made by `apps/capture/scripts/authoring/photo-look-data.ts fixture` | Made in this repository. |

The owner chose on 2026-11-26 to commit this one portrait as the e2e photo,
because the house render is found as a face but sets no trait. Do not add
other photos of real people here. The parity set from slice 5a stays
outside the repository (`PHOTO_LOOK_PARITY_DIR`).
