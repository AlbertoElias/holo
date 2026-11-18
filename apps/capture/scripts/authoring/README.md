# Authoring: directed performance

Tools for `docs/features/directed-performance.md`: read what a take does,
check whether an avatar can act, direct a take from a beat sheet into an
ordinary hologram GLB, and review whether it reads. Run everything from `apps/capture` with
`node --conditions=development --import tsx`; output goes to the ignored
`output/authoring/`.

| Script | What it does |
|---|---|
| `acting-report.ts <take.glb> [--against other.glb] [--json out.json]` | Per performer (found by skin): which bones and face shapes move and when, frozen spans, and whether fingers, face and eyes ever move. `--against` lists the spans where two takes differ. |
| `avatar-audition.ts <avatar.glb\|.gltf> [--geometry] [--out dir] [--json out.json]` | Grades any avatar against the audition bar (`lib/audition-bar.ts`): one row per bar with its measured value and pass or fail, in `audition.json` (below). Exits 1 when a binding row fails. |
| `direct.ts <sheet.json> [--out take.glb] [--style flat\|directed] [--against earlier.glb]` | Solves the beat sheet on each performer's avatar, writes the GLB and the sheet beside it (and, with objects, `<take>.objects.json`), prints each reach's stop-short distance, each grip, put and aim's miss, and the acting report. Exits 1 when a grip, put or aim misses past its limit (the files are still written). |
| `review.ts <take.glb> [--sheet take.beats.json] [--out dir] [--step 0.2] [--fps 30]` | Plays the take in viewer-web and writes a review pack (below): a real-time H.264 video at feed-card size and a close view per performer, frame sheets every `--step` s, the acting report, the face's height and per-second travel on the card, and a comparison to fill in. Same ports as `viewer-check.ts`. |
| `publish.ts <take.glb\|sheet.json> [--title t] [--description d] [--credit c] [--api <origin>] [--web <origin>] [--production] [--no-quick-look] [--check]` | Validates a take and publishes it through the normal upload route (below). |
| `viewer-check.ts <take.glb> [--video out.mp4] [--frames dir] [--report out.json]` | Uploads the take to a local test API, opens it in a viewer-web test build and reads what plays: moving bones, fingers and face shapes per performer, which performer holds the humanoid the viewer anchors on, and each recorded object (meshes, whether it moves, its credit). `--video` records it as H.264; `--frames` saves twelve paused stills at exact take times. Uses ports 3341 and 3214 (`VIEWER_CHECK_API_PORT`, `VIEWER_CHECK_WEB_PORT`). |

## Publishing a take

```
HOLOIM_AGENT_TOKEN=… node --conditions=development --import tsx scripts/authoring/publish.ts sheets/goodbye.json --api http://127.0.0.1:3001
```

Takes a `.glb` (title, `description` and `credit` come from the sheet beside
it, `<take>.beats.json`) or a sheet, which it builds first. Flags win.
Before any network call it refuses, listing every problem, a take that is
over the API's 100 MB cap, has no declared performer (`HOLOIM_humanoid`), has
a performer no animation reaches, or (unless `--no-quick-look`) is over the
Quick Look converter's extent budget (100 M deformed, 500 M rigid
point-frames). `--check` stops there.

- **Target:** the local API (`http://127.0.0.1:3001`) unless `--api` says
  otherwise; any non-loopback host (production is
  `https://holoim-api.fly.dev`) also needs `--production`.
- **Credential:** `HOLOIM_AGENT_TOKEN` (or `HOLOIM_SESSION`), else the
  Keychain entry for the host (`scripts/agent-upload-token.sh setup`). With
  none it refuses and uploads nothing. The code is
  `scripts/showcase/lib/upload.mjs`, shared with `showcase/upload.mjs`.
- **Result:** waits until the hologram is on the feed (and, unless
  `--no-quick-look`, its Quick Look preview settled), then prints one JSON
  line and `feed: <web>/h/<id>` (web origin `--web`, `https://localhost:3174`
  for a local API, none for another host without `--web`). Exit 2 means
  uploaded but the preview failed; do not publish it again.
- **Credit:** the upload carries a name and `submittedBy`, and the agent
  account's display name replaces the latter. `description` and `credit` are
  reported in the result, not stored by the API.

`publish-check.ts` is the end-to-end check: a local API that refuses
anonymous uploads, a registered agent token, a take directed from
`sheets/goodbye.json`, published and read back from the feed, then each
refusal. It writes `output/authoring/publish-check/report.json` (port
`PUBLISH_CHECK_API_PORT`, 3355). Run it by hand after changing the
publish path; it is not in `verify:pr`.

## Auditioning an avatar

```
node --conditions=development --import tsx scripts/authoring/avatar-audition.ts <avatar.glb|.gltf> [--geometry] [--out dir]
```

One command grades any humanoid glTF/GLB: the house base (slice 2c), each
finish (2f), every trait value (2d) and an outside avatar (2g). It writes
`output/authoring/audition/<name>/audition.json` (or `--out`); `rows` holds
every row of the bar with `id`, `tier`, `bar`, `value` and `pass`, and
`fails` names each binding row that fails. An avatar that does not load or
bind gets one failing `file.binds` row that says why. Exit code 1 means a
binding row failed.

- **File:** size against the base's 1.8 MB.
- **Geometry** (Node, seconds; `lib/face-geometry.ts`): each face shape's
  travel (the 90th percentile of the vertices it moves by 1 mm or more),
  left/right symmetry, whether `eyeBlink*` closes the lid, how much of the
  brow the card's camera sees past other meshes, and whether any face
  vertex goes into glasses or hair. Regions come from the shapes and the eye
  bones, so an outside avatar needs nothing marked up. Millimetre bars are
  stated for 1.7 m and scale with the avatar's height.
- **Render** (the viewer, about 30 s; `lib/audition-render.ts`): a still
  take of the avatar on the phone card for the face box (brow line to chin)
  and the eye opening in device px, and a front render for brow contrast
  (OKLab L). `--geometry` skips it; its rows then read `pass: null`. Same
  ports as `viewer-check.ts`.
- **Motion:** gaze, fist, point, reach and the turn, as before.

**The base (2c)** is graded with the full command and passes when `fails`
is empty; then the blind reading (`face-legibility.ts`) is the gate. **An
outside avatar** runs the same command; its verdict is `fails`, each row
named. The bar's numbers are provisional (`docs/features/directed-performance.md`,
"The audition bar, in numbers").

## A beat sheet

`sheets/goodbye.json` and `sheets/two-avatars.json` are worked examples
(`sheets/watering.json` and `sheets/tallest-bar.json` for objects); the
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
- `weight` shift, `turn` (`upper` twists and returns, `whole` stays), `step`;
- `take` an object by its grip (with an optional `palm`, as a reach's, for
  the hand's facing as it closes), `put` it `at` a point or `on` another
  object, and `aim` what a hand holds at a point (below).

A point is `[x, y, z]`, a mark's name, `"<performer>.<humanoid bone>"`,
`"<object>.<anchor>"`, or a place: `{ "of": "<performer or object>",
"forward", "right", "up" or "height" }`, metres or measures of the
performer (`"0.5 step"`, `"hanging-hand"`; `MEASURES` and `LANDMARKS` in
`lib/stage.ts`).
A point on a performer is where that bone is at the moment the direction
plays, so a reach at someone who steps away lands where they are. A
performer leans into a reach beyond their arm; one that still ends more than
2 cm from where it was asked because it is beyond reach is reported when
built ("out of reach even leaning").
Every direction has `anticipation`, `attack`, `hold` and `settle` (defaults
per kind in `DEFAULT_TIMING`).

What every piece inherits: arms hang at the sides with the elbows back (a
neutral rest), and unless `life` is false a held pose keeps living through
seeded events (`lib/life.ts`): the weight moves to the other leg and the
posture resettles, the eyes and then the head glance away and back (a large
glance turns the chest too), a sigh lifts and drops the shoulders, and a
hanging hand lifts and fidgets. The face rides those events: the lips part
on a sigh's in-breath and round as it goes out, the lips press or a corner
tugs as a weight shift settles, and the brows lift through a sigh and flash
as a glance comes back. Under them run quiet breath, sway, head drift,
blinks and eye movement. Life gives way to directions (fully while one
moves, partly while it holds; a directed `expression` owns the face) and
never moves a hand that holds something or that another performer reaches
to. Each performer's schedule
comes from its `seed` alone, so revising a beat changes life only near that
beat. `direct.ts` prints each performer's life events and motion-quality
verdicts. Fresh readers call a hold facing the viewer alive, but two people
in profile still read as mostly frozen through a long held ending, so give
that one a beat (a glance at the other, a step) rather than relying on life.
`style: "flat"` (or `--style flat`)
plays the same blocking as straight lines with no life, face or fingers, for
comparison.

Each direction is a closed form of time, so revising one beat changes only its
own span; a `whole` turn and a step also move what follows. Check with
`direct.ts <sheet> --out revised.glb --against earlier.glb`.

## Objects and a set

A sheet's `objects`, keyed by id, are the set and the props, written into the
take as capture writes recorded objects (`RecordedObject` nodes declared in
`HOLOIM_objects`), so the viewer draws them solid, outside the hologram. Each
is a `shape` with a `size` `[width, height, depth]`; `parts`, each a shape
with its own `name`, `size`, `at` (its bottom centre), `rotate` and `color`;
or a `source`, a GLB relative to the sheet or `polyhaven:<id>` (packed by the
API, cached per API origin under `output/authoring/objects/`, credited on
its node and in `asset.copyright`, with its sha256 and origin in
`asset.extras.holoim.sources`; a local GLB needs a `credit` or `"own"`).
`height` scales a source.

An object's frame has its origin at the bottom centre, +Y up and +Z its
front. It stands `at` a point or `on` another object, turned by `facing`
(degrees, or toward a point). Objects and marks are placed once, on the
first frame, in the order they depend on each other (a mark counts as the
point it names); a circle, or a place measured from an object that is in a
hand from the first frame, is refused. Its anchors are `top`, `center`, `bottom`,
`front`, each named part (the far end of its +Y axis) and its own `anchors`.

A prop declares a `grip` (a part, or `{ at, axis }`) where a fist closes
across it, and a `tool` (a part's tip and +Y axis, or `{ tip, axis }`) that an
`aim` points. A performer can `hold: { "right": "can" }` from the first
frame; `take` and `put` pick it up and set it down for the rest of the
take, and the hand must arrive (`at` plus `attack`) before the take ends. A held object hangs about its grip axis, and an aim the wrist cannot
make swings the elbow. Even so, a grip lies across the fist, so the hand
points what it holds roughly square to the forearm: stage an aim with the
hand close to the body rather than at arm's length, and lean a prop the hand
must take from low down. The build fails when a grip lands more than 1 cm
or 5° off, a put more than 1 cm off or 3° from upright, or an aim more than
10° off its target; it still writes the take, so you can look at the miss.
Keep a held prop's take `hold` until the next reach starts, or the hand
falls back to the thigh in between and hides what it holds.

The feed card frames the whole dome, and the dome is fitted around everything
the take draws, recorded objects included, so a set the sheet places is on
the card. The tallest-bar chart, 1.15 m from her, fills about 58×154 CSS px
of a phone card. Each object widens the dome, so the performer gets smaller:
about 160 CSS px tall with that chart against about 178 without it, and
nothing caps how far an object can widen it yet. The review pack's card
stills keep the cast and every object on the card. Its close view widens to
an object while a beat names it, and while it is held. `on-screen.json`
gives each object's size on the card. The 1c reader who saw the pointer
aimed at nothing was given stills cropped to the cast, a fault in the review
tool, not in the viewer (fixed).

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
"Not covered yet"): change in the world (water, a plant that responds),
handing an object between performers, collisions, and publishing.
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
