# Authoring: directed performance

Tools for `docs/features/directed-performance.md`: read what a take does,
check whether an avatar can act, direct a take from a beat sheet into an
ordinary hologram GLB, and review whether it reads. Run everything from `apps/capture` with
`node --conditions=development --import tsx`; output goes to the ignored
`output/authoring/`.

| Script | What it does |
|---|---|
| `acting-report.ts <take.glb> [--against other.glb] [--json out.json]` | Per performer (found by skin): which bones and face shapes move and when, frozen spans, and whether fingers, face and eyes ever move. `--against` lists the spans where two takes differ. |
| `avatar-audition.ts <avatar.glb> [--json out.json]` | Can this avatar act: face-channel mesh displacement (mm), fingertip-to-palm distance for a fist and a point, reach error against fixed targets, one turn checked for interpenetration. A failing item names itself. |
| `direct.ts <sheet.json> [--out take.glb] [--style flat\|directed] [--against earlier.glb]` | Solves the beat sheet on each performer's avatar, writes the GLB and the sheet beside it, prints each reach's stop-short distance and the acting report. |
| `review.ts <take.glb> [--sheet take.beats.json] [--out dir] [--step 0.2] [--fps 30]` | Plays the take in viewer-web and writes a review pack (below): a real-time H.264 video at feed-card size and a close view per performer, frame sheets every `--step` s, the acting report, the face's height and per-second travel on the card, and a comparison to fill in. Same ports as `viewer-check.ts`. |
| `viewer-check.ts <take.glb> [--video out.mp4] [--frames dir] [--report out.json]` | Uploads the take to a local test API, opens it in a viewer-web test build and reads what plays: moving bones, fingers and face shapes per performer, and which performer holds the humanoid the viewer anchors on. `--video` records it as H.264; `--frames` saves twelve paused stills at exact take times. Uses ports 3341 and 3214 (`VIEWER_CHECK_API_PORT`, `VIEWER_CHECK_WEB_PORT`). |

## A beat sheet

`sheets/goodbye.json` and `sheets/two-avatars.json` are worked examples; the
types are in `lib/beats.ts`. A sheet has a `duration`, `performers` (an
`avatar`, a stage position `at: [x, z]` and `facing` degrees about +Y, 0
facing +Z), named `marks`, and `beats`. A performer's `avatar` is `stock`, a
`fixture:<name>` from `scripts/lib/avatar-fixtures.ts`, or a path relative to
the sheet. The first performer is the one the viewer frames.

A sheet states its `intent`, what a viewer should come away with, and each
beat its own `intent`, in a viewer's words ("she wants him to stay"); `note`
is the author's working note on what the performer does. The review compares
a fresh reader's account with the intents, so a beat without one cannot be
checked (the review lists them).

Each beat belongs to a performer, starts `at` a time and holds `directions`:

- `look` at a point (`head` sets how much of it the head takes);
- `expression`, a named one (`held`, `hope`, `sad`, `smile`, `small-smile`,
  `breath`, `resolve`, `eyes-down`; `EXPRESSIONS` in `lib/beats.ts`) or face
  channels, with a `strength`. On the stock avatar only mouth-led shapes
  (`smile`, `sad`) read at feed-card size; brow and lip-press shapes move
  the mesh under 5 mm and do not (`face-legibility.ts`);
- `reach` with a hand toward a point, stopping `stopShort` metres from it;
- `hand` shape (`relaxed`, `open`, `reach`, `fist`, `point`, `grip`, `withheld`);
- `weight` shift, `turn` (`upper` twists and returns, `whole` stays), `step`.

A point is `[x, y, z]`, a mark's name, or `"<performer>.<humanoid bone>"`.
A point on a performer is where that bone is at the moment the direction
plays, so a reach at someone who steps away lands where they are. A
performer leans into a reach beyond their arm; one that still ends more than
2 cm from where it was asked because it is beyond reach is reported when
built ("out of reach even leaning").
Every direction has `anticipation`, `attack`, `hold` and `settle` (defaults
per kind in `DEFAULT_TIMING`).

What every piece inherits: arms hang at the sides with the elbows back (a
neutral rest), and breath, a slow sway, head drift, blinks, eye movement and
finger settle run underneath unless `life` is false, sized so head and
hands move more than a CSS pixel a second on the card. Fresh readers judging
from stills still call a long held ending frozen, so give one a beat (a
glance, a weight shift) rather than relying on life. `style: "flat"` (or `--style flat`)
plays the same blocking as straight lines with no life, face or fingers, for
comparison.

Each direction is a closed form of time, so revising one beat changes only its
own span; a `whole` turn and a step also move what follows. Check with
`direct.ts <sheet> --out revised.glb --against earlier.glb`.

## Reviewing a take

A take reads when someone who was not told the intent sees it. The loop:

1. **Build:** `direct.ts sheets/<piece>.json`.
2. **Review:** `review.ts output/authoring/<piece>.glb`. The pack goes to
   `output/authoring/review/<piece>/`:
   - `reader/`: `review.mp4` (card left, close views right, real time),
     `sheet-card-NN.jpg` (the card framing cropped to the cast at the
     phone's true device pixels), `sheet-close-<n>-NN.jpg`, one still every
     0.2 s labelled with the time only, and the reader's `README.md`;
   - `on-screen.json`: the face's height on the card in CSS px, device px
     and mm on a phone, and per second how far head and hands travel on the
     card (under 1 CSS px is flagged `still`: a hold that reads as frozen);
   - `acting-report.json`; `comparison.json`; `pack.json`.
3. **Read, fresh:** give a reader who has not seen the sheet, its intents or
   earlier packs only the `reader/` folder and its `README.md`. A person, or
   a fresh agent session or subagent with no other context. The reader says
   what happens overall, what each time span shows and means, and what they
   could not read.
4. **Compare:** save the account as `reader.md` beside the pack and fill
   `comparison.json` per beat: `seen` (the reader's words for that span),
   `reads` (true when they match the intent, without the reader having been
   told it) and `revise` (what to change). Do the same for the piece.
5. **Revise only the beats that did not read**, build with
   `--against <previous>.glb` to confirm nothing else moved, and review again
   into a new `--out` with a new reader.

Keep both packs and both comparisons: they are the evidence that a piece
reads, and the list of what the system could not express.

A pack takes about eight minutes for a nine-second take (the real-time video
and a still every 0.2 s). For a quick look at framing first,
`viewer-check.ts <take.glb> --frames <dir>` saves twelve stills in about a
minute; `node packages/tooling-testing/src/preview.mjs <dir>` (from the
repository root) tiles them.

Not covered by these tools yet (`docs/features/directed-performance.md`,
"Not covered yet"): sets and props, a held prop's grip, and publishing.
A take is published like a showcase piece, with
`scripts/showcase/upload.mjs`.

## The file

The GLB holds every performer's own avatar file, merged with gltf-transform,
each under a wrapper node: the first is `RecordedAvatar` and the only one
declared in `HOLOIM_humanoid` (listed in `extensionsUsed` only), as a captured
export does. `asset.extras.holoim.authored` is `synthetic`, with the author,
title and method, as showcase pieces mark themselves. The published format is
unchanged. The writer registers no glTF extensions, so an avatar's own (VRM,
MToon, `KHR_materials_*`) are not carried into the take.

The solver imports capture's `AvatarRig`, `HumanoidSkeleton`, `FaceRig`,
`LivenessFace`, `ArmIkSolver`, `legIk` and `palmFrame` and never edits them;
hand shapes, weight shifts, steps (procedural leg IK, not
`LocomotionAnimator`'s clips) and the writer are new here.
