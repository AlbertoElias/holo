# Authoring: directed performance

Tools for slices 0 and 1 of `docs/features/directed-performance.md`: read what
a take does, check whether an avatar can act, and direct a take from a beat
sheet into an ordinary hologram GLB. Run everything from `apps/capture` with
`node --conditions=development --import tsx`; output goes to the ignored
`output/authoring/`.

| Script | What it does |
|---|---|
| `acting-report.ts <take.glb> [--against other.glb] [--json out.json]` | Per performer (found by skin): which bones and face shapes move and when, frozen spans, and whether fingers, face and eyes ever move. `--against` lists the spans where two takes differ. |
| `avatar-audition.ts <avatar.glb> [--json out.json]` | Can this avatar act: face-channel mesh displacement (mm), fingertip-to-palm distance for a fist and a point, reach error against fixed targets, one turn checked for interpenetration. A failing item names itself. |
| `direct.ts <sheet.json> [--out take.glb] [--style flat\|directed] [--against earlier.glb]` | Solves the beat sheet on each performer's avatar, writes the GLB and the sheet beside it, prints each reach's stop-short distance and the acting report. |
| `viewer-check.ts <take.glb> [--video out.mp4] [--frames dir] [--report out.json]` | Uploads the take to a local test API, opens it in a viewer-web test build and reads what plays: moving bones, fingers and face shapes per performer, and which performer holds the humanoid the viewer anchors on. `--video` records it as H.264; `--frames` saves twelve paused stills at exact take times. Uses ports 3341 and 3214 (`VIEWER_CHECK_API_PORT`, `VIEWER_CHECK_WEB_PORT`). |

## A beat sheet

`sheets/goodbye.json` and `sheets/two-avatars.json` are worked examples; the
types are in `lib/beats.ts`. A sheet has a `duration`, `performers` (an
`avatar`, a stage position `at: [x, z]` and `facing` degrees about +Y, 0
facing +Z), named `marks`, and `beats`. A performer's `avatar` is `stock`, a
`fixture:<name>` from `scripts/lib/avatar-fixtures.ts`, or a path relative to
the sheet. The first performer is the one the viewer frames.

Each beat belongs to a performer, starts `at` a time and holds `directions`:

- `look` at a point (`head` sets how much of it the head takes);
- `expression`, a named one from `EXPRESSIONS` or face channels, with a `strength`;
- `reach` with a hand toward a point, stopping `stopShort` metres from it;
- `hand` shape (`relaxed`, `open`, `reach`, `fist`, `point`, `grip`, `withheld`);
- `weight` shift, `turn` (`upper` twists and returns, `whole` stays), `step`.

A point is `[x, y, z]`, a mark's name, or `"<performer>.<humanoid bone>"`.
Every direction has `anticipation`, `attack`, `hold` and `settle` (defaults
per kind in `DEFAULT_TIMING`). Breath, blinks, eye movement and finger settle
run underneath unless `life` is false. `style: "flat"` (or `--style flat`)
plays the same blocking as straight lines with no life, face or fingers, for
comparison.

Each direction is a closed form of time, so revising one beat changes only its
own span; a `whole` turn and a step also move what follows. Check with
`direct.ts <sheet> --out revised.glb --against earlier.glb`.

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
