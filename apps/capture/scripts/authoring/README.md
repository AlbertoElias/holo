# Authoring: directed performance

Tools for `docs/features/directed-performance.md`: read what a take does,
check whether an avatar can act, direct a take from a beat sheet into an
ordinary hologram GLB, and review whether it reads. Run everything from `apps/capture` with
`node --conditions=development --import tsx`; output goes to the ignored
`output/authoring/` (recorded takes: `output/take-input/`).

| Script | What it does |
|---|---|
| `acting-report.ts <take.glb> [--against other.glb] [--json out.json]` | Per performer (found by skin): which bones and face shapes move and when, frozen spans, and whether fingers, face and eyes ever move. `--against` lists the spans where two takes differ. |
| `avatar-audition.ts <avatar.glb\|.gltf> [--geometry] [--out dir] [--json out.json]` | Grades any avatar against the audition bar (`lib/audition-bar.ts`): one row per bar with its measured value and pass or fail, in `audition.json` (below). Exits 1 when a binding row fails. |
| `direct.ts <sheet.json> [--out take.glb] [--style flat\|directed] [--against earlier.glb] [--avatar spec]` | Solves the beat sheet on each performer's avatar (`--avatar` casts every performer on that avatar instead: a spec as in a sheet, or a GLB path relative to the working directory), writes the GLB and the sheet beside it (and, with objects, `<take>.objects.json`; with sound, each padded source in `<take>.audio/`), prints each reach's stop-short distance, each grip, put and aim's miss, each sound's place and padded length, and the acting report. Exits 1 when a grip, put or aim misses past its limit (the files are still written). |
| `house-base.ts [--params file] [--build name] [--out file.glb] [--blender path] [--install-mpfb]` | Makes the house base avatar (slice 2c) from CC0 parts in headless Blender: fetches MPFB 2.0.18 and the faceunits01 pack at pinned sha256 into `output/authoring/house-base/cache/`, and runs `house-base/build.py` with every value from `house-base/base.json` once per build in its `builds` (with `fit.enabled`, the human is first wrapped onto `house-base/fit-target.glb` by `house-base/fit.py`, slice 2c2), writing `assets/house-base/wardrobe-<build>.glb` (the body, loose garments, and every hair and glasses part). It then writes `public/gltf/models/house-base.glb`, the medium wardrobe dressed in base.json's `defaultLook` by `@holoim/avatar-look`, with its credits in `asset.copyright` and the scene's `holoimAvatar` extras. `--build` makes only that wardrobe (to `--out` if given) and leaves the public file alone. Change the look in `base.json`, never in the GLB. Re-runs give the same geometry, but Blender may order the eye and mouth triangles differently, so the sha256 can change. Run with `node --conditions=development --import tsx`. |
| `house-traits.ts [--geometry] [--only n] [--finish clay\|ink\|light]` | Slice 2d's trait audition: dresses eight looks that between them cover every trait value at its extreme (it fails if one is missing), puts each in the finish (slice 2f; default clay), auditions each, and writes `output/authoring/house-traits/[<finish>/]<n>-<look>/audition.json` and `report.json` (fails, rows not run, size per look). The audition's geometry tier leaves out the ink outline, which is line work, not a surface. Exits 1 on any fail. Run with `node --conditions=development --import tsx`. |
| `house-likeness.ts [--glb file] [--sheets dir] [--out dir] [--blender path]` | Slice 2c2's likeness check: `house-base/likeness.py` renders the base (default the medium wardrobe) in the clay turnaround's framing and writes the silhouette IoU per view, whole figure and head, to `likeness.json`. It also writes "which is the drawing?" pairs for fresh readers (`pairs/`, answers in `pairs/key.json`) and a contact sheet of the base beside each sheet. The sheets are the owner's, read from the main checkout's ignored `output/avatar-sheets/`. Writes `output/authoring/house-likeness/`. Run with `node --conditions=development --import tsx`. |
| `house-base/generate-target.py <clay-turnaround.png> <out.glb>` | Makes the fit target from the turnaround sheet with Hunyuan3D-2mv, locally on MPS or the CPU. Its licence excludes the EU, the UK and South Korea (open decision 10 in the brief). Needs the model's source and weights; see its docstring. Run by hand only; the committed `fit-target.glb` is its decimated output. |
| `import-take.ts <recorded.glb> [--out dir] [--fps n]` | Turns a capture-recorded GLB into the tool's own take (`lib/take.ts`, `<name>.take.json`): bone rotations away from bind, the hips' path, face channels and measures, resampled to 30 fps, with the beats found in its motion. Writes `<name>.import.md`. |
| `recast-take.ts <take.json\|recorded.glb> --to <avatar> [--to …] [--out dir]` | Plays the take on each avatar (`stock`, `fixture:<name>` or a path) as an ordinary hologram GLB, and writes `<name>.recast.md` / `.json`: what survives and what is lost (hips, feet, limbs, wrist placement, face, gaze), against rotation-only retargeting on the same avatar. |
| `edit-take.ts <edit.json> [--to <avatar>] [--out dir]` | Applies an edit file (`lib/edit.ts`: retime, hold, look) to a take, writes the edited take and both the original and edited takes on the avatar, and `<name>.edit.md` / `.json`. Exits 1 when a frame outside the edits differs from the recording. |
| `compare-takes.ts <person.glb> <agent.glb> [--out dir]` | The acting report and motion numbers (beats, hold stillness, hand speed, hesitations and back-and-forth strokes, head range, travel) on two takes side by side, in `<a>-vs-<b>.compare.md` / `.json`. |
| `review.ts <take.glb> [--sheet take.beats.json] [--out dir] [--step 0.2] [--fps 30] [--until s] [--card-only] [--orbit deg]` | Plays the take in viewer-web and writes a review pack (below): a real-time H.264 video at feed-card size and a close view per performer (with sound: the take's own, mixed from clip time 0, and a face view per performer so the lips can be read), frame sheets every `--step` s, the acting report, the face's height and per-second travel on the card, and a comparison to fill in. Same ports as `viewer-check.ts`. |
| `six-second-test.ts prepare <sheet.json> [--avatars stock,house-base] [--readers 3] [--until 6] [--orbit 90] [--out dir]` / `score <dir>` | The six-second test (below): builds a flat and a directed take per avatar, renders the first six seconds muted at card size and after an orbit as blind frame sheets, and, after fresh readers and graders have answered, scores each take against the sheet's intent. |
| `publish.ts <take.glb\|sheet.json> [--title t] [--description d] [--credit c] [--api <origin>] [--web <origin>] [--production] [--no-quick-look] [--check]` | Validates a take and publishes it through the normal upload route (below). |
| `viewer-check.ts <take.glb> [--video out.mp4] [--frames dir] [--report out.json]` | Uploads the take to a local test API, opens it in a viewer-web test build and reads what plays: moving bones, fingers and face shapes per performer, which performer holds the humanoid the viewer anchors on, and each recorded object (meshes, whether it moves, its credit). `--video` records it as H.264; `--frames` saves twelve paused stills at exact take times; `--audio out.webm` presses the card's unmute control, records what the card sends to its speakers over one real-time pass, and prints where each sound in the file is heard (exit 1 when one is not heard within 100 ms of its place); with `--video` that recording is the video's soundtrack. Uses ports 3341 and 3214 (`VIEWER_CHECK_API_PORT`, `VIEWER_CHECK_WEB_PORT`). |
| `speech-report.ts <take.glb> [--json out.json]` | Reads a take with sound from the GLB alone: decodes each `KHR_audio` source as embedded (its length against the clip, where it sounds) and measures the mouth opening (mm along each face mesh's own `jawOpen`, else `mouthOpen`, else `viseme_aa`) against the voice: each phrase's mouth onset against its sound, the mouth in the voice's pauses, and how closely it follows the loudness; with the sheet beside the take, each line's first sound against its beat. Exits 1 past its bars (below). |

## Publishing a take

```
HOLOIM_AGENT_TOKEN=… node --conditions=development --import tsx scripts/authoring/publish.ts sheets/goodbye.json --api http://127.0.0.1:3001
```

Takes a `.glb` (title, `description` and `credit` come from the sheet beside
it, `<take>.beats.json`) or a sheet, which it builds first (refused when a
grip, put or aim misses its mark, as `direct.ts` exits 1). Flags win.
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
`fixture:<name>` from `scripts/lib/avatar-fixtures.ts`, a path relative to
the sheet, or the house base in a finish, `house:clay`, `house:ink` or
`house:light`, with an optional `look` card (`@holoim/avatar-look`; see
`sheets/poem-pair.json`), which `direct.ts` dresses from the build's
wardrobe, puts in the finish (`applyFinish`), and records in the GLB's
`asset.extras.holoim.looks` (the card, and the finish when not clay). The first performer is the one the viewer frames.

A sheet states its `intent`, what a viewer should come away with, and each
beat its own `intent`, in a viewer's words ("she wants him to stay"); `note`
is the author's working note on what the performer does. The review compares
a fresh reader's account with the intents, so a beat without one cannot be
checked (the review lists them).

Each beat belongs to a performer, starts `at` a time and holds `directions`:

- `look` at a point (`head` sets how much of it the head takes);
- `expression`, a named one (`held`, `hope`, `sad`, `smile`, `small-smile`,
  `breath`, `resolve`, `eyes-down`, and the states' faces `noticing` and
  `concerned`; `FACE_MIXES` in `lib/beats.ts`) or face channels, with a `strength`. On the stock avatar only mouth-led shapes
  (`smile`, `sad`) read at feed-card size; brow and lip-press shapes move
  the mesh under 5 mm and do not (`face-legibility.ts`);
- `reach` with a hand toward a point, stopping `stopShort` metres from it;
- `hand` shape (`relaxed`, `open`, `reach`, `fist`, `point`, `grip`, `withheld`);
- `weight` shift, `turn` (`upper` twists and returns, `whole` stays), `step`;
- `gesture` by `name`, in one line: `nod`, `head-shake`, `shrug`, `wave`
  (optionally `at` someone), `rub` (something between the fingers, eyes on
  the hand) and `hand-to-chest`; a hand gesture takes a `side` (right by
  default), a repeated one a `count`, and any a `strength`. Its timing,
  repeats and how long it holds come from `GESTURES` in `lib/beats.ts`;
- `state` by `name`, `noticing` (alert: a quick lift, eyes wide, the head
  turning to an optional `at`) or `concerned` (brows knit, lips pressed, the
  head down and tilted, the body a little forward), held for the beat's hold;
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
verdicts. Life alone moves mostly in depth, which a side view does not see,
so a performer facing another (their head within 35° of straight ahead,
fading out by 55°) also attends: small listening nods every few seconds and,
now and then, the hands coming loosely together in front of the waist and
apart again, both in the plane a side view sees. It is drawn on streams of
its own, gives way to directions like the rest, and `"attend": false` on a
performer turns it off; `direct.ts` prints it for takes with more than one
performer.
`style: "flat"` (or `--style flat`)
plays the same blocking as straight lines with no life, face or fingers, for
comparison.

Each direction is a closed form of time, so revising one beat changes only its
own span; a `whole` turn and a step also move what follows. Check with
`direct.ts <sheet> --out revised.glb --against earlier.glb`.

## Sound: a spoken line, lips and an effect

Sound brief slice 1a (`docs/features/sound-voice-captions.md`). A beat can
say a line, and a sheet can tie an effect to a put; both are written into
the take as `KHR_audio`, which the feed card and Quick Look already play.

```json
{ "id": "turn", "performer": "p", "at": 4.6, "hold": 2.6,
  "say": { "text": "That one is the tallest. Almost twice the first.", "voice": "local:af_heart" } }
...
"sounds": [{ "id": "clink", "file": "synth:cup-clink", "at": { "beat": "put", "event": "put" }, "on": "cup" }]
```

- **Voice.** `local:<voice>` speaks the text with Kokoro-82M (kokoro-js
  1.2.1 and onnx-community/Kokoro-82M-v1.0-ONNX q8, both Apache-2.0) on this
  machine: no key, no cost. Its phonemiser (phonemizer 1.2.1) runs eSpeak
  NG, GPL-3.0, as WASM; nothing of it is committed or shipped, only the
  audio it helps make. The first build installs them at pinned versions into
  the ignored `output/authoring/tools/kokoro/` (the model, 96 MB, is cached
  there too), and each line is cached in `output/authoring/sound/` by a
  hash of the versions, voice and text. `file:<path>` takes a recording
  instead (relative to the sheet) and needs a `credit`. A line is placed by
  its first voiced sound, so a voice's lead-in silence does not make it
  late; `delay` (s after the beat, never before) and `gain` are optional.
- **Lips.** `lib/lips.ts` lays the line's phones (from the same
  phonemiser) over the voiced time of the audio itself, and turns them into
  the 15 Oculus visemes, which `@holoim/avatar-face` routes onto any avatar
  that passes the audition (its own viseme shapes, else `jawOpen` and the lip
  shapes). The mouth leads the sound by 40 ms, opens with the voice's
  loudness and closes in its pauses; the face's life yields while the line
  plays. The flat style has no face, so no lips.
- **Effects.** `synth:cup-clink` is generated here (CC0, this project's own);
  a file path takes a free-licence recording with its `credit`. `at` names a
  beat, optionally its `put` landing, plus a `delay`; `on` is an object, or
  `<performer>.head`. Each place carries one sound (one emitter per node),
  so a performer speaks one line per take for now.
- **In the file.** KHR_audio has no start time: the viewer and the Quick Look
  converter start every source at clip time 0 and loop it with the clip. So
  each source is padded with silence to the clip length, encoded as
  Opus (64 kbps mono, 48 kHz, which needs an ffmpeg with libopus: `FFMPEG`,
  else the first `ffmpeg` that has it, Homebrew's included) and checked
  against the clip within a frame. Each sound is a positional emitter on its
  node: the voice on the performer's head bone, an effect on its object.
  Credits go into `asset.copyright` and `asset.extras.holoim.sounds`.
- **Checks.** `speech-report.ts <take.glb>` bars, set before the first
  measurement: every source within a frame of the clip, each phrase's mouth
  onset within ±80 ms of its sound, the mouth in pauses of 0.25 s or more
  below 15 % of its speaking level, and a correlation with the loudness of at
  least 0.4, and each line's first sound within a frame of its beat (when
  the sheet is beside the take). `viewer-check.ts <take.glb> --audio heard.webm` hears the card.

The example is `sheets/spoken-line.json`, which is `tallest-bar` with a line
on its turn and a clink on its put.

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

## Change in the world

A sheet's `world` lists what changes in the set, one line each:

- `{ "kind": "pour", "object": "can" }`: drops leave a held tool's tip while
  its axis points below `tilt` (degrees under the horizontal, 0), more of
  them the further it tips (`rate` 60 a second at full flow), at `speed`
  0.8 m/s along the axis, and fall under gravity to land where the aim
  points (`onto`, else the target of the beat that aims that object).
  Each drop is a `size` 0.045 m bead (about 8 px wide on the card) stretched along its fall so drops overlap into a stream (`color` a light water blue).
  `wet` (0.06 m, or `false`) leaves a darker disc on the surface that grows as
  water lands and stays to the end.
- `{ "kind": "burst", "at", "when" }`: `count` 24 sparks thrown `spread`
  0.25 m out over the upper half, gone within `life` 1.2 s.
- `{ "kind": "drift", "at", "when", "until" }`: `count` 12 motes released
  between the two cues, each rising `rise` 0.3 m over about `life` 2 s.
- `{ "kind": "change", "object", "when" }`: the object turns (`turn`
  `[x, y, z]` degrees), scales (`scale`, one number or three), lifts (`lift`
  m) or changes colour (`color`, in `steps` 4) over `over` 1.5 s, eased, from
  `from` (or where its last change left it) to the state the line names.
  What a line leaves out returns to how the sheet made the object, so
  `{ "when": 5.3, "from": { "turn": [36, 0, 16] } }` stands a slumped plant
  back up. A line with `show` (`true` or `false`) and nothing else makes the
  object appear or disappear at its cue.

A cue is seconds, a beat id (its `at`) or `<beat>.end`. A point is an
object's anchor, a mark or `[x, y, z]`. The build prints a line per change
(how many drops, where they land, the colour steps, when the object is
present) and fails on a cue outside the take, a pour with no tool axis, a
held object made to appear or disappear, a colour change on a sourced
model (it keeps its own materials), a pour aimed at a performer point or a
place (give `onto`), an object that changes again before its last change
ends, or one shown and hidden at the same time. A pour whose tool never
tips far enough only says so (`no water`).

Limits: a world point follows its object's own track, not its change, so
a drift at `lamp.top` after the lamp lifts starts where the lamp was, and
an object `on` a changing one does not follow the change. A drop aims at
where its target is when it leaves the spout. Unknown keys are refused
only on `change` lines.

Everything is node animation, so it plays on the card, in AR and in
Quick Look: each pour, burst or drift is a summoned `RecordedObject` whose
children are the drops or motes (a pour's drops take turns on about sixteen
nodes, keyed on the take's own frames, which keeps the Quick Look readback
within its time limit), and a changing object gains a
`<id>-change` node between its wrapper and its shape. Quick Look cannot
blend a colour: a colour change is `steps` copies of the shape, one shown at
a time, so it changes in visible steps everywhere. Drops are rigid beads,
not a fluid; nothing splashes or soaks in beyond the wet disc.
`sheets/world-test.json` exercises every line but the pour; `watering.json`
pours.

## A recorded take as input

Slice 4a of the brief: a person's take, recorded by capture, becomes
something the tool can play on another avatar and edit by beat, without any
change to capture or the recording format.

```
node --conditions=development --import tsx scripts/authoring/import-take.ts output/ci-pointing/headset-open-fist-pinch-point-wave-reach.glb
node --conditions=development --import tsx scripts/authoring/recast-take.ts output/take-input/headset-open-fist-pinch-point-wave-reach.take.json --to stock --to fixture:unreal-cm
node --conditions=development --import tsx scripts/authoring/edit-take.ts scripts/authoring/takes/headset-reach.edit.json
node --conditions=development --import tsx scripts/authoring/direct.ts scripts/authoring/takes/headset-reach.agent.json --out output/take-input/headset-reach.agent.glb
node --conditions=development --import tsx scripts/authoring/compare-takes.ts <recorded.glb> output/take-input/headset-reach.agent.glb
```

The recorded inputs come from the repository's own checks, not a device:
`pnpm --filter @holoim/capture run test:xr:pointing` (with
`XR_REPLAY_ONLY=open-fist`) writes the owner's headset hand take, and
`test:xr:bodycam` the camera-driven one. The example edit file names its
take by a path relative to itself, `output/take-input/sources/headset-reach.glb`:
copy the recorded GLB there first (`mkdir -p output/take-input/sources && cp
output/ci-pointing/headset-open-fist-pinch-point-wave-reach.glb
output/take-input/sources/headset-reach.glb`), or edit the path.

- **The take** (`lib/take.ts`): bind poses come from the skins (a recorded
  file's nodes hold its last pose, not bind). Frames at either end where a
  bone jumps faster than 4 m/s (the recorder starting or stopping) are
  trimmed. Beats are found from motion: a hold is at least 0.4 s with both
  wrists under 0.18 m/s and the head turning under 25 °/s.
- **Recast** (`lib/recast.ts`): each bone turns away from the target's bind
  by the take's rotation, after lining the target's bind limb up with the
  recording avatar's; the hips follow the take's path scaled by leg length.
  `hips: 'fixed'` is rotation-only retargeting, the baseline the loss
  report compares against: hips at bind as capture's `retargetClips` keeps
  them, though with this tool's bind correction on every limb where
  `retargetClips` corrects only the arms and hands. A recast GLB is marked
  `synthetic` like any authored take, with the recording as its source.
- **Edits** (`lib/edit.ts`): `retime` plays a span (seconds or a beat id)
  over a new duration; `hold` freezes the take at a time for `add` seconds,
  filled with life from `lib/life.ts` (breath, glances, sighs, blinks, eased
  in and out; a blink needs a hold of about 1.6 s) unless `life` is false; `look` turns the head (and a share of
  neck and chest, and the eyes) toward a yaw and pitch over a span, eased.
  Retimes and holds may not overlap each other; a look may span them.
  Everything outside the edits is the imported take's own frames, shifted
  in time, checked frame by frame.

## The six-second test

Does a stranger, shown only the first six seconds muted at card size, see
what the sheet intends, and does the directed take read better than the flat
one? Slice 3 of the directed-performance brief; the pass bar is in the brief
and in `manifest.json`.

1. A sheet needs a sidecar `sheets/<name>.six-second.json` naming the
   hesitation and feeling beat ids (see `goodbye.six-second.json`).
2. `six-second-test.ts prepare sheets/goodbye.json` builds each avatar x
   {flat, directed} take, reviews it with `review.ts --until 6 --card-only
   --orbit 90`, and writes blind frame sheets (`../readers/<code>/card`, `/orbit`, outside the sheet's folder so the path and the key stay out of a reader's reach;
   the code hides style and avatar), `manifest.json` (the key) and
   `prompts.md`.
3. Follow `prompts.md`: `--readers` fresh Sonnet readers per code (default 3;
   card question, then the orbit as a follow-up) and one fresh grader per code; save
   `answers/<code>/reader-<n>.json` and `grades/<code>.json`.
   `prepare` re-renders a reader sheet under 30 KB (a renderer flake gives a black sheet) up to three times. Every beat in the sheet is scored, so give each beat an `intent`.
   More readers cut noise (three give about 0.1) and change the sample size,
   not the bar: the reader-count bars (hesitation 2, feeling 2 of 3) scale in
   proportion (4 of 6), the manifest records the count, the score bars do not move.
   `--avatars` takes a cast per entry, `;` separated when any has `=`:
   `pair=her:house:clay,him:house:clay` gives each performer an avatar, and a
   `house:` avatar keeps the performer's `look`.
4. `six-second-test.ts score <dir>` writes `report.md` / `report.json` and exits
   1 if a row of the bar fails. Never change the bar after seeing a run.

## Reviewing a take

A take reads when someone who was not told the intent sees it. The loop:

1. **Build:** `direct.ts sheets/<piece>.json`.
2. **Review:** `review.ts output/authoring/<piece>.glb`. The pack goes to
   `output/authoring/review/<piece>/`:
   - `reader/`: `review.mp4` (card left, close views right, real time; for a take with sound, the take's sound and a face view per performer, rightmost, with `sheet-face-<performer>-NN.jpg`; not written with `--card-only`, which also skips the close and face sheets, and `--until` cuts the take short),
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
"Not covered yet"): handing an object between performers and collisions.
Publishing is `publish.ts` ("Publishing a take" above).

## The file

The GLB holds every performer's own avatar file, merged with gltf-transform,
each under a wrapper node: the first is `RecordedAvatar` and the only one
declared in `HOLOIM_humanoid` (listed in `extensionsUsed` only), as a captured
export does. `asset.extras.holoim.authored` is `synthetic`, with the author,
title and method, as showcase pieces mark themselves. The published format is
unchanged. The writer registers no glTF extensions but `KHR_audio` when the take has
sound, so an avatar's own (VRM, MToon, `KHR_materials_*`) are not carried
into the take.

The solver imports capture's `AvatarRig`, `HumanoidSkeleton`, `FaceRig`,
`LivenessFace`, `ArmIkSolver`, `legIk` and `palmFrame` and never edits them;
hand shapes, weight shifts, steps (procedural leg IK, not
`LocomotionAnimator`'s clips) and the writer are new here.
