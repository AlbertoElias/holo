# Feature brief: Direct, preview and revise a performance

**Lead:** Claude (planning session, 2026-11-13)  
**Status:** In progress: slices 0 and 1 built and verified (2026-11-13);
re-scoped 2026-11-14 to a creation system. Slice 1b built and verified
(2026-11-14): the review loop, three defaults, face numbers and a second
piece, which reads only as "watering a plant" after one revision. Its gap
log (props, sets, publishing, gestures) now leads "Not covered yet". Slice 1c
(props and sets in the beat sheet) built and verified (2026-11-14), on
`main` 2026-11-15 after the user approved open decision 4; neither slice 1c
build is published (the owner published the slice 1b watering take). The
owner lifted the hold on the house avatar on 2026-11-17: slice 2 is now
the avatar flow, approved by the owner on 2026-11-17 ("Approve all",
open decision 5); 2a and 2b come next, and nothing in it is built yet.  
**Layer:** event (the acted body is the hologram's raw material; see
`docs/product/concepts/what-a-hologram-is.md`)

Source: "The part I didn't say", a 12 s two-person poem authored by ChatGPT
(Astra) on 2026-11-13 (production hologram `cmwfkilam0001oeir1gvn495q`,
working files in the ignored `output/platform-poem/` of the
`feature/poem-character-models` worktree), and Astra's own notes on it;
Claude's showcase pieces (`docs/product/concepts/agent-authored-holograms.md`,
IDEA-076); the two mandates in flight, `docs/features/phone-capture.md`
(approved, slices 1 and 2 on `main`) and
`docs/features/natural-avatar-motion.md` (reviewed, on branch
`feature/natural-avatar-motion`, not on `main` yet); and the user's
direction on avatars (2026-11-13): the shipped avatar is a stand-in found
online; avatars should be expressive, match the hologram's style and what
the author is saying, be personalisable, be able to look like the author,
and come in many design styles.

## Direction (2026-11-14)

The user, in their words: "were not trying to build the best avatar for
this specific hologram, but an overal hologram creation system using this
hologram as reference". Consequences, which override the older wording of
this brief wherever they differ:

- The poem's goodbye is a **reference fixture**, not a goal. It stays as
  `sheets/goodbye.json`. Repeating the reading on the goodbye is dropped as
  a next step; slice 3 below is therefore a general test, not the goodbye's.
- The product is a **system any author (an agent or a person) can use to go
  from a short brief to a published hologram**, with a loop that says
  whether it reads before they publish. The poem exposed the gaps; it is not
  what is optimised.
- **Slice 1b** (below) comes before the house avatar.
- **The house avatar (slice 2) stays gated.** It starts only if the evidence
  of slice 1b shows that avatars are what limits the system, and on the
  user's decision. Nothing in it is started. (Lifted by the owner on
  2026-11-17; see the next section.)
- "Not covered yet" (below) lists what a whole creation system needs and
  this brief leaves out, to be filled from the second piece's gap log.

## Direction (2026-11-17): the avatar flow

The owner lifted the hold on the house avatar. Their words: "we also need
to figure out the avatar flow. this is going to be key for people to feel
that they can express themselves. but its also complex, we need to do an
80/20 thing here where we can have very expressive avatars that can align
to what the creator needs in both looks and style, and can work easily
with the hologram creation flows. we'll end up with 2 capturing flows
(fully ai or embodying it) that will work on all devices. and in all
cases: the avatar is what the creator needs; the surrounding world is what
the creator needs; it can use objects, gestures etc to support the
content; it's mobile first but greatly enhanced if done from a headset".
Asked whether to lift the hold and write this up as the avatar slice,
starting with the style sheets and the audition bar: "yes, lift the hold.
and ignore the other worktree for now" (the `poem-character-models`
worktree, about realistic and expressive movement, is left alone).

The 80/20 they agreed "makes sense": **one expressive base rig built to
read on a phone feed card, not an avatar creator.** Style is two or three
finishes on that base; likeness is a short list of traits each finish
interprets; any outside avatar is allowed if it passes the audition;
photo-to-avatar likeness and a full editor are deferred. Slice 2 below is
that flow. The 2026-11-13 "Wait for reading" and the 2026-11-14 gate no
longer hold.

**The two capture flows.** *Fully AI*: an agent writes a beat sheet and
`direct.ts` solves it (slices 1 to 1c). *Embodying*: a person drives the
avatar from a phone camera or a headset (the two mandates). Both drive the
same bones (`HumanoidSkeleton`) and the same 52 face channels (`FaceRig`),
so an avatar that passes the audition works in both, with nothing per
flow.

### Acceptance criteria for the whole system (the four "in all cases")

These hold for the creation system as a whole, not only this brief. Each
is met when it holds in both capture flows, on a phone first.

| Requirement | What meets it | Today (2026-11-17) |
|---|---|---|
| **The avatar is what the creator needs**, in looks and style | The creator picks a finish and sets their traits, or brings an avatar that passed the audition, and it reads on the phone card: a fresh reader names the expression, not only a smile | **Not met.** One stock stand-in, unrelated to anyone. Capture binds any humanoid given by `?avatar=<url>`, and a beat sheet names an avatar file per performer, but there is no finish, no trait and no picker. On the card only a smile reads (3 of 7 blind); its glasses cover the brows (slice 1b evidence) |
| **The surrounding world is what the creator needs** | The creator gets a set that fits the piece without building it by hand | **Partly.** A beat sheet builds a set from primitives, local GLBs and Poly Haven (slice 1c). Capture loads a scene by `?scene=` or a scanned place; the phone journey records on the default scene. Nothing turns a creator's words into a world |
| **It can use objects, gestures and so on** to support the content | Props are picked up, used and put down; a gesture or expression can be asked for by name | **Partly.** Sheets hold, use and put down props (slice 1c); capture records objects a person grabs. No nod, head shake or named expression ("concerned", "noticing"), and nothing changes in the world (gaps 4 and 5) |
| **Mobile first, greatly enhanced from a headset** | A phone alone makes a hologram that reads; a headset adds whole-body and hand acting | **Partly.** Phone selfie journey built and verified in emulation, device checks pending (`phone-capture.md`); camera driving of the body and fingers is the motion owner's and not on `main`. A headset tracks body and fingers but its face shows gaze only, because WebXR exposes no expressions (`archive/avatar-face.md`), so a headset take today has *less* face than a phone take. The AI flow is a CLI an agent runs; a person cannot start one from a phone |

Slice 2 serves the first row; the others stay with slice 1c, "Not covered
yet" and the mandates. The headset's face gap stands: the avatar flow does
not close it, and the phone face camera beside a headset (IDEA-078) is the
mandate's.

## User outcome

An author, a person or an agent, makes an acted scene from a short brief.
The characters are expressive, fit the style of the piece, and can be made
to look like a particular person. The acting is a take that can be
previewed, graded and revised one beat at a time. The take can come from an
agent's direction, from the owner's own phone recording, or from both, and
is not tied to one character's look.

First proof: six seconds of the poem's goodbye in which a viewer
understands "she wants him to stay, but stops herself" before reading the
verse, and understands it better after walking around the pair.

## Measured today (2026-11-13)

Bodies are made three different ways, and no two share anything.

| | Capture avatar | Claude's showcase figures | Astra's poem |
|---|---|---|---|
| Body | A stand-in found online, or any humanoid the resolver binds (`?avatar=<url>`) | Jointed primitives rebuilt per scene (`showcase/introspection/figures.mjs`) | Two meshes reconstructed from images (TRELLIS), simple Blender rigs |
| Face | 52 ARKit channels tracked, routed onto 21 shapes on the head; the shapes were synthesized because no licensed expressive avatar was found (`archive/avatar-face.md`) | None | None (0 meshes with morph targets) |
| Fingers | Driven | None | None (17 joints per rig, no finger bones) |
| Acting comes from | Headset, desktop, phone camera (spike, unmerged) | Pose keys written by hand per scene (`introspection2/acting.mjs`, 22 KB for one piece) | 8 of 102 animation channels change; the last change is at 4.0 s of 12.0 s |
| Looks | One stock character, unrelated to any piece or author | Stylised primitives | Custom and recognisable at scene scale, soft up close (hands, hair, surface) |
| Cost of a new piece | None | Days of scene code | 9.2 GB working directory, a patched local TRELLIS port, separate head reconstruction and repair |
| Graded by | The motion-quality report (draft) | Critic subagents on contact sheets, ray and fit checks | "Uploads, plays, orbits" only |

The poem's numbers were read from its GLB by a prototype of slice 0, not
taken from Astra's notes; they match the notes.

What this says:

1. **Three body systems, none shared.** The only rig with a working face
   and fingers is the one agents never use, so every authored piece starts
   by building a worse body.
2. **Looks came first and acting last.** Most of the poem's effort went
   into reconstruction; the acting, which is the event, got two arms and a
   head for four seconds.
3. **Nothing asks whether the acting moves or lands.** Every check on the
   poem passed while both performers stood frozen for 8 of 12 seconds.
4. **No avatar we have was made to express anything.** The stock one is a
   stand-in with synthesized face shapes; the others have no face.
5. **The phone mandate and agent authoring need the same two things:** a
   body that reads as a person, and a character that reads as *that*
   person. The phone brief's "want to send" fails on the second today and
   excludes fixing it.

## Design decision

### One way to drive an avatar, three drivers

Every avatar is driven through the same two things: the canonical humanoid
bones (`HumanoidSkeleton`) and the 52 face channels (`FaceRig`). A person
drives them through the phone camera or a headset (the mandates); an agent
drives them through direction (this brief).

What is shared is that interface, not a file. The design review checked the
export: a published GLB is baked into one avatar. Its tracks are local
rotations and positions on that avatar's own bones, its face is weights on
that avatar's own shapes after routing, and `HOLOIM_humanoid` is only a map
from bone to node (`GltfExportComposer.ts`, `GLTFHumanoidPlugin.ts`). So
there are two kinds of take:

- **An authored take is its beat sheet.** Playing it on another avatar
  means solving the beat sheet again on that avatar.
- **A captured take is its GLB.** It carries its rig and bone map, so it
  can be moved to another avatar by rotation (`retargetClips.ts`). That
  loses hips travel, contacts, and any face detail the recording avatar
  could not show. Keeping a capture's raw channels needs changes to the
  recording path, which the mandate sessions own; that is slice 4.

### An avatar is anything that passes the audition

What an avatar must *do* is fixed; how it *looks* is free. Capture already
reports whether an avatar binds: missing bones, facing, disabled features
and locomotion (`HumanoidBindingReport`), which face channels bind and what
turns the eyes (`FaceBindingReport`), and all 30 finger bones
(`check-avatar-bindings.ts`). The audition adds only what those cannot
say, which is whether the avatar can act:

- how far each face channel moves the mesh at full strength, in
  millimetres (a weak or synthesized shape shows up here);
- fingertip-to-palm distance for a fist and for a point;
- how far a reach lands from each of a fixed set of targets;
- one turn checked for parts passing through each other.

An imported VRM, a house character and a generated mesh face the same bar,
and an avatar that fails part of it says which part.

### Style at three levels of cost

1. **Finish:** material and palette on the same body (for example clay,
   ink line, a body of light). The cheapest way to match a piece's style.
   The styleguide's identity-hue rim on avatars is not drawn by the viewer
   yet and is left to a later viewer change (open decision 5h).
2. **Identity:** proportions, face shape, hair, clothing and colours within
   one base. Personalisation lives here.
3. **Family:** a new base with its own design language (soft and rounded,
   anime, realistic, non-human). Added only when a style cannot be reached
   by the first two.

### Likeness is a set of traits each style interprets

A photo is read once into an identity card: face shape, skin tone, hair,
eye colour, glasses, facial hair, build, height. Each family turns the card
into its own version of that person, so one author can be soft and rounded
in a poem and ink-line in an explainer. Astra did this by hand in 2D for
the poem (green eyes, straight dark hair, head size) and it was the part of
that process that worked. Reconstructing a person's mesh from images stays
possible as one more avatar source that must pass the audition. (Since
2026-11-17 the card is set by hand from a fixed list in slice 2; reading
it from a photo is slice 5, deferred.)

### Each avatar says how it expresses

The signal stays the 52 face channels. The face binding report already says
which of them an avatar can show and how. How much a style exaggerates (a
cartoon amplifies, a minimal face reduces the channels to a few) is added
when a second family needs it, not before.

Two consequences for authored takes:

- **The performance is kept apart from the look.** The beat sheet is kept
  beside the published GLB, so a piece can be re-dressed by solving it
  again. The published GLB's format is unchanged.
- **Contacts survive a change of proportions.** "Her hand stops 18 cm
  short of his sleeve" is a goal in the beat sheet, solved per avatar, so
  it holds when arm length changes. This needs no change to
  `retargetClips.ts`, which moves clips by rotation and belongs to the
  motion owner.

### Generate what does not act; build what does

Hair, clothing, textures and palette can be generated from an approved 2D
sheet. The face and hands are built once per family, by hand, to pass the
audition. The poem's reconstruction lost detail exactly in the face and
hands.

### Rejected

More image-to-3D engineering before the acting loop exists (it improves
the part that was not the weak link); a cast that lives only in Blender (a
fourth body system); taking the final verdict on the stock avatar (it has
21 synthesized face shapes, so a failed test would not say whether the
direction or the face failed; a flat take against a directed take on it is
still a useful early reading, and slice 1 ends with one); a character
creator before one character is good; replaying agent input through the
live capture runtime (real time only, limited to what a tracker reports, no
two-character scenes).

The design review confirmed the last one and its cost. These capture
modules load in Node and are imported, never edited: `HumanoidSkeleton`,
`FaceRig`, `LivenessFace` (blinks and eye movement), `ArmIkSolver`,
`legIk`, `LocomotionAnimator`, `retargetClips`, and `AvatarRig` with a stub
renderer (`scripts/lib/locomotion-retarget-check.ts` is the precedent).
Slice 1 imports `AvatarRig`, `HumanoidSkeleton`, `FaceRig`, `LivenessFace`,
`ArmIkSolver`, `legIk` and `palmFrame`; a step is placed feet solved with
`legIk`, not `LocomotionAnimator`'s clips, so it can land on a mark, and
nothing needed `retargetClips`.
These do not, because they expect a live tracking stream or a browser:
`HandFingerRetargeter`, `FaceDriver`, `VrBodySolver` and the exporter
(`GltfExportComposer` uses a Worker). So hand shapes, weight shifts, steps
and writing the GLB are new code in this brief.

## Slices

Each ends with the reports re-run and a proof video.

### Slice 0: the acting report and the audition

A script that reads any hologram GLB, authored or captured, and reports per
performer (found by skin, since only one performer is named in a file):
which bones and face shapes move and when, frozen spans, and whether
fingers, face and eyes ever move. Baselines: the poem, "The way down II"
and one captured take. The audition and its report are built here and run
on the stock avatar as the first baseline.

The feet and jitter numbers come from the motion owner's instrument, which
is not on `main` yet. Once it is, a small adapter in the authoring scripts
samples a GLB into the joint positions it reads. The motion owner has added
a category for authored takes (`MotionSource` `authored`, commit
`5ad3d6c96477` on `feature/natural-avatar-motion`), so the adapter reports a
verdict once both are on `main`. Slices 0 and 1 leave the adapter out.

### Slice 1: direction (the agent as driver)

A TypeScript authoring module under `apps/capture/scripts/authoring/`, run
the way `check-avatar-bindings.ts` is. It loads avatars and offers
direction, not raw keys: look at a target, an expression and its strength,
reach with a hand toward a target and stop short by a distance, hand shape
and grip, shift weight, turn, step. Each has timing (anticipation, hold,
settle), and breath, blinks, eye movement and finger settle run underneath
so a performer is never frozen. A take is a beat sheet as data; changing
one beat rebuilds in seconds and the report shows what changed. A CLI wraps
it so any agent can author.

It writes the GLB with gltf-transform, as the locomotion library build
does, because the showcase writer has no skins. The first performer is
named `RecordedAvatar` and is the only one declared in `HOLOIM_humanoid`,
since the viewer anchors framing and hand traces to one performer
(`humanoidAnchors.ts`). The file is marked as authored, as the showcase
pieces are, so recorded and authored stay distinguishable.

Built against the stock avatar as a stand-in. It ends with an early
reading: the goodbye as a flat take and a directed take on two copies of
the stock avatar, shown to critics. A clear difference says the direction
works; no difference does not say why, which is what slice 3 settles.

### Slice 1b: the review loop, defaults and a second piece (2026-11-14)

All under `apps/capture/scripts/authoring/`; nothing under `apps/capture/src/**`,
the viewer or the API is edited. Slice 1's early reading showed that the
acting report measures motion, not meaning (50 of 67 bones moved and two
critics still could not read the intent), that the tool's defaults act when
nobody directed them, and that faces are too small at feed-card size.

1. **A review step.** A beat sheet states an intent for the piece and for
   each beat. `review.ts` renders a built take in the real viewer at
   two framings (the feed card's, and a close view) and writes a review pack:
   an H.264 MP4, time-stamped frame sheets dense enough to show timing
   within a beat, and the acting report. The README gives the protocol: a
   fresh reader who has not seen the intent says what they see; the author
   compares that with the stated intent per beat and revises only the beats
   that did not read. The pack and the comparison are files.
2. **Defaults every piece inherits**, each shown before and after with the
   review pack on a neutral test sheet (not by scoring the goodbye): a rest
   pose that reads as neutral; always-on life large enough that a held
   ending does not read as frozen; a reach or look whose target can be
   another performer who moves, so it lands where they are at that moment.
3. **Face legibility at card size, measured, not fixed:** how many pixels
   tall a standing performer's face is at the card framing, and at what
   framing an expression becomes readable. The numbers and the options
   become a decision for the user; the viewer is not changed here.
4. **A second piece, different in kind from the poem**, authored end to end
   from a three-line written brief using only the CLI and its README: one
   performer, one prop, a simple set, a practical tone, ten seconds or less.
   One full loop: build, review, revise the beats that did not read, review
   again; then the local upload and render pipeline. Nothing is published
   to production. A log of every step that needed something outside the tool
   becomes "Not covered yet".

### Slice 1c: props and sets in the beat sheet (2026-11-14)

Open decision 3, option A: items 1, 2, 3, 6 and 7 of "Not covered yet", so an
author never post-processes a take by hand. All under
`apps/capture/scripts/authoring/`. Nothing under `apps/capture/src/**`, the
viewer or the API is edited, and the published format is unchanged.

**What the repo already has, and what this slice reuses** (inventory,
2026-11-14):

| Already there | Where | Used here |
|---|---|---|
| Objects in a take: a world-space `RecordedObject` wrapper node per object, with position and rotation tracks per frame, declared in the `HOLOIM_objects` v0 root extension (origin, source name, presence spans, `holds` per hand) | `packages/objects/src/objects.ts`, `apps/capture/src/recording/objectExport.ts` | **Yes, as the file format.** Sheet objects are written exactly as capture writes them. viewer-web already keeps their own materials, outside the hologram shader, the sphere clip and the ground field (`hologramScene.ts`, `sphereClipping.ts`, `groundField.ts`), and reads their credits |
| A held object's rule: at grab, `offset = hand⁻¹ · object`; each frame, `object = hand · offset` | `apps/capture/src/objects/ObjectInteraction.ts` (grab and anchor) | **Yes, the same rule.** The tool also chooses the grab pose (the grip), which capture leaves to the person |
| Credit on a packed model (`asset.extras.holoimCredit`, `holoimCredit` on the node) | `packages/objects/src/credit.ts`, viewer-api's packers | **Yes:** a sourced object's credit is copied onto its node |
| Poly Haven models packed as GLB at real-world size, no key | viewer-api `GET /api/objects/polyhaven/<id>.glb` (`services/polyhaven.ts`) | **Yes, as a source** (`polyhaven:<id>`), fetched once from an API origin and cached under the ignored `output/`. Not imported across apps |
| Poly Pizza | viewer-api, needs `POLYPIZZA_API_KEY`; no real-world size | No: no size, and a key. A local GLB covers it |
| The e2e registry stubs (`registryFixtureServer.ts`) | viewer-api tests | No: one-triangle models generated at runtime |
| Object search and the tray | `apps/capture/src/objects/objectSearch.ts`, `ObjectTray.ts` | No: browser-only, and an author names a source instead of searching |
| Scanned places (SPZ through Spark) | `packages/place`, `apps/capture/src/place/` | No: headless decoding is unverified. A later slice |
| Showcase parts (`box`, `cyl`, `sphere`, rooms, figures) | `apps/capture/scripts/showcase/introspection/` | No: they write through the showcase's own GLB writer, not gltf-transform. Three's geometries make the primitives instead |

No pot, plant, can or pedestal builder exists anywhere. The sheet composes
them from primitives.

**Design**, in the order of the gap log's cost, as revised by the design
review (2026-11-14):

1. **Objects and a set in the sheet.** A sheet gains `objects`, keyed by id.
   Each object is made one of three ways:
   - a `shape`: `box`, `cylinder`, `cone` or `sphere`, with a `size`
     `[width, height, depth]`;
   - `parts`: several shapes, each with its own `name`, size, colour,
     `at` (where its bottom centre sits) and `rotate` (degrees, about its
     bottom centre) in the object's frame;
   - a `source`: a GLB path relative to the sheet, or `polyhaven:<id>`,
     scaled to a `height` in metres when one is given. A static child under
     the wrapper moves the model's origin to its bottom centre and carries the
     scale; the wrapper itself stays at unit scale, because its scale is the
     presence channel. A sourced model's credit is copied onto the node
     (`holoimCredit`) and into `asset.copyright`, with its `sha256` and, for
     Poly Haven, the API origin it was fetched from (both in
     `asset.extras.holoim.sources`; the cache is kept per origin). A local GLB needs a
     `credit` unless it is marked as the author's own.

   An object's frame has its origin at the bottom centre, +Y up and +Z as its
   front. The object is placed `at` a place, or `on` another object (sitting
   on its top), and turned by `facing` (degrees, or toward a point; default
   the facing of the performer it is placed from). The set is the objects
   nobody picks up. Every object gives anchors that beats can aim at:
   - `<id>.top`, `.center`, `.bottom`, `.front` (reserved: no part or anchor
     may use these names);
   - `<id>.<part>`, the far end of that part's +Y axis;
   - any named `anchors`.

   An anchor of a held object moves with it. Performers, objects and marks
   share one table of ids, checked unique, so `"<id>.<name>"` means one thing.
   A bare object id is an error; `"<performer>.<bone>"` keeps working.
2. **Placement relative to a performer.** Anywhere a point is taken (marks,
   object places, beat targets), a place can be
   `{ "of": "<performer or object>", "forward", "right", "up", "height" }`,
   measured in that frame: forward is +Z, right is −X in the frame's own
   sense, `height` sets the height above the floor and `up` adds to the
   frame's origin. Giving both is an error. Places in marks and objects are
   fixed at the first frame; a place in a beat is fixed at that direction's
   start, where the performer stands then. Cycles in `on` and `of` are
   rejected. Each distance is metres or a measure with a factor (`"0.5 step"`),
   and a height can be a landmark; both come from the place's performer (or
   the first performer; `"q:waist"` names another), measured on the solved
   rest pose, not the bind pose:

   | Name | Source |
   |---|---|
   | `step` | 0.35 × stature |
   | `arm` | upper arm + forearm + the palm's offset from the wrist |
   | `hand-length` | the hand rig's wrist to middle fingertip |
   | `stature` | the avatar's height |
   | `knee`, `hip`, `waist`, `elbow`, `chest`, `shoulder` | the lower leg, upper leg, spine, forearm, chest and upper arm bones' heights at rest |
   | `hanging-hand` | the hanging palm's centre at rest |
   | `chin`, `eye`, `crown` | the head bone, the eye bones (or head + 0.45 × the stature above the head bone), the avatar's height |

   So "at her right hand's height, a step in front of her" is
   `{ "of": "p", "forward": "step", "height": "hanging-hand" }`. Sizes take
   the same measures, so a pedestal can be as tall as her waist.
3. **A held prop, with pick up and put down.** A performer can
   `hold: { "right": "can" }` from the first frame. Two directions are added,
   persistent like a step:
   - `take` (`side`, `object`): a reach to the object's grip, the hand
     opening on the way and closing on arrival;
   - `put` (`side`, `object`, `at` or `on`): a reach that carries the object
     so its bottom lands on the place, the hand opening on arrival.

   **The grip.** An object declares `grip` as a part (its centre and long
   axis) or as a point and an axis. For a `take`, the hand is solved to the
   object, not the object to the hand: the hand turns so the grip axis lies
   across the palm, from index to little finger, and the grip point sits in
   the closed fist. The object stays where it is until the hand closes, then
   follows the hand bone with a fixed offset until a put (capture's rule).
   Only a `hold` from the first frame turns the object into the hand, keeping
   it as upright as that allows. A `put` solves the hand so the object lands
   upright. The hand's turn is one function: a roll of the forearm, capped at
   about ±85° from neutral, then a wrist bend within the wrist's limits (flex
   60°, extend 55°, toward the thumb 20°, toward the little finger 30°),
   solved inside the reach's correction loop, because turning the hand moves
   the palm. While a hand holds, it keeps a grip shape whatever reaches it
   makes; a `hand` direction on a holding hand is rejected. A held object
   moves the resting hand out from the thigh by its half-width. The build
   reports how far each grip and each put landed from where it was asked, and
   fails beyond 1 cm and 5° for a grip, 1 cm and 3° of tilt for a put.
4. **A tool axis.** An object declares `tool` as a part (its tip and +Y
   axis) or as a tip and an axis. One more direction, `aim` (`side`, `at`,
   timing), turns the held object by the smallest turn that points its tool
   axis from the tip at the target (the roll about the tool axis is left
   free), iterated since the tip moves as the object turns. It works the same
   whichever hand holds it, because the axis is the object's and the turn is
   solved on the hand that holds it, with the same roll and wrist limits.
   Orientation precedence on a hand: an aim, then the grip, then a reach's
   `palm`. An aim from a hanging hand needs a reach with it. The build
   reports how many degrees short each aim ends and fails beyond 10°. "Pour"
   is an aim of the spout at the soil; "point with it" is an aim of the
   pointer's tip at a target. A hand aiming or reaching at the object it
   holds is rejected.
5. **The file stays valid.** The writer adds the objects itself: one
   unit-scale `RecordedObject` node each, with tracks only for an object that
   moves, and a `HOLOIM_objects` entry checked with `assertHoloimObjects`
   (origin `prepared`, presence the whole take, `holds` from the takes and
   puts, for the first performer only, since a hold has no performer field).
   Object poses are updated after each performer's arms, so a later look at a
   held object's anchor sees where it is now. The performer stays
   `RecordedAvatar`, the only one declared in `HOLOIM_humanoid`, so nothing
   re-declares it afterwards. `apps/viewer-api/tools/check_usdz_tools.sh` is
   run by hand on both pieces, since it is not in `verify:pr`.

**As built, where it differs from the design above** (2026-11-14):

- **A held object hangs about its grip axis.** A fist holds a handle, not a
  rigid bracket: each frame the held object turns about its grip axis,
  through the grip's centre, as far as gravity would swing it, so a can
  carried by its top handle stays upright while the wrist rolls. A rigid
  offset put the can on its side as soon as the arm lifted.
- **A turn the wrist cannot make lifts the elbow.** When an aim, a grip axis
  or a put's upright needs more than the forearm's roll and the wrist's bend,
  the elbow swings about the shoulder-to-hand line, as a person lifts the
  elbow to pour. The swing is chosen once per direction, from ±15° steps up
  to ±90°, by the smallest remaining error at the full turn, and eased in
  with the direction's envelope. Without it the pour ended about 100° past
  the wrist's roll.
- **Where the hand can point decides the staging.** A grip lies across the
  fist, so what it holds points roughly square to the forearm, give or take
  the wrist's 20–30° of sideways bend. A pointer aimed straight ahead from an
  outstretched arm is out of reach. Held close to the body, with the forearm
  across it, the pointer is in reach. The sheets record what worked: the pour
  place at the right of her chest, the pointer's show place close in front of
  her left hip, a pointer leaning 40° in its cup, and its stand scaled to
  1 m so the fist meets it with the forearm level.
- **The viewer check reads objects:** each `RecordedObject` the viewer
  loaded, its mesh count, whether the take moves it, and its credit.
- **Every reach re-solves a little differently.** The reach's arm solve now
  starts from where the wrist must be for the palm to land, with eight
  passes, not from the target with six. Every existing reach moves (the
  goodbye's right arm by up to 25° over frames 33–108, two-avatars by up to
  14°), and the reports improve or hold: the defaults test's palm lands 19.6
  mm off, asked 20 (slice 1b's row says 11.8 with the doubled life), the
  goodbye's stays at 148.6 mm, asked 160, and two-avatars' at 100.0 and
  100.2 mm, asked 100.
- **The card frames the set; the review stills did not.** Corrected
  2026-11-16; this line first said the card frames only the performer.
  - viewer-web's card frames the whole dome (`clocheFraming`), and the dome
    is fitted around everything drawn, recorded objects included
    (`drawnPoints`, `HologramCardCanvas.tsx`).
  - On a phone card the tallest-bar chart is wholly visible, about 58×154
    CSS px, at every time measured.
  - The reader missed it because `review.ts` cropped its card stills to the
    cast's key points, leaving 15% of the chart's box, and its close view
    was planned head to hips, around her alone. That was a review-tool fault, not a viewer one.
  - Nor did the close view show that plan: its
    camera kept the card's view offset, so since 2026-10-25 it showed a whole
    body small and off centre. Fixed with the crop.
  - The stills now keep every object on the card, and the close view widens
    to the objects a beat names (`docs/features/card-framing-objects.md`).
  - Objects do cost performer size: about 160 CSS px with the chart against
    about 178 without it. Nothing caps that yet (gap 13).

**Revision locality.** `take`, `put` and `hold` change where the object is
for the rest of the take, as a step does. Other directions stay closed forms
of time; `--against` shows a revised aim changes only its own span.

**Open for the user:** whether the set renders as recorded objects (solid,
own materials, outside the hologram shader, the sphere clip and the ground
field, as capture's prepared objects do; recommended by the design review) or
as part of the hologram body, as the hand-dressed 1b set did. Built as
recorded objects until decided.

**Evidence the slice ends with:**

- `sheets/watering.json` rebuilt, with its pedestal, pot, soil, plant and can
  declared in the sheet, placed relative to her, and no outside script;
- a second sheet, different in kind, using a take, an aim and a put with the
  left hand throughout, and one `polyhaven:` object;
- grip, put and aim reports within their limits on both;
- `viewer-check` reporting the objects it resolved, their credits and the
  `RecordedAvatar` anchor, with card and close frames showing the set inside
  the dome;
- `check_usdz_tools.sh` passing on both pieces;
- both reviewed with `review.ts` by a fresh reader under the neutral title
  "Take", with the accounts recorded below whether or not they read;
- the README updated, and a proof video.

**Later, not in this slice:**

- change in the world: water, particles, a plant that responds;
- new gestures (nod, "this is dry");
- publishing as one command;
- the house avatar (slice 2);
- scanned places as a set;
- handing an object between performers;
- collisions (an object can pass through a body or a table; the review is
  what catches it).

### Slice 1d: life as events, not oscillation (2026-11-16)

"Not covered yet" item 12. Life was tried twice as continuous sines (sway,
head drift, breath) and failed both times, the second time doubled: a few
pixels of slow drift do not show between stills, and the owner judged the
video frozen. A person standing still is not oscillating; they **hold, then
do something small**: put their weight on the other leg, glance away and
back, take a deeper breath, fidget a hand. Each is a change of shape a
viewer sees, separated by real stillness. This slice replaces most of the
oscillation with those events. The schedule is in
`apps/capture/scripts/authoring/lib/life.ts`, applied in `lib/direct.ts`;
nothing under `apps/capture/src/**`, the viewer or the API changes, and
`life: false` and `style: "flat"` still turn it all off.

**The events** (per performer, seeded by its `seed`):

Weight, glance and sigh share one seeded sequence of slots (the first at
0.4 to 1.0 s, then every 1.0 to 2.0 s), so no stretch of a hold goes long
without something; each slot prefers a kind (weight 30%, glance 45%, sigh
25%) and gives way to another while that kind is still under way.

| Event | What moves | Spacing, timing |
|---|---|---|
| Weight on one leg | Hips toward the standing foot (wherever a step left it), 5 cm at 0.7 to 1.0 of that, and down 6 mm; pelvis rolled 4° so the free hip drops and the free knee bends; the chest counters 0.7 of the roll, so the shoulder line tilts against the hips. Each shift also resettles the posture (design 2): the spine leans to a new seeded angle, −1.5 to 3.5° forward, spread up the spine with the neck taking 0.6 of it back, and the hips sit up to 1.5 cm forward or back, which is what a weight shift shows from the side. Starts on a seeded leg and alternates | at least 2 s on a leg, over 0.9 to 1.3 s (quintic ease) |
| Glance | Eyes first (0.12 s), head and neck 0.06 s later (0.3 s, 75% of the angle), hold 0.5 to 1.4 s, head back over 0.45 s; 20 to 40° to a side (design 2; was 18 to 35), and past 10° of head turn the upper chest takes 0.35 of the rest, so the shoulders turn too; 65% of them 8 to 15° down; saccades shrink while it lasts; a blink when the head turns more than 12° | from the slots |
| Sigh | Shoulders rise 6° and the chest lifts 2° over 0.9 s, then out over 1.5 s to half that below rest, head dipping 4°, back over 1.5 s | at least 3 s apart |
| Hand fidget | A hanging hand lifts 4 cm (the elbow bends), its forearm rolls 25° and its fingers curl and relax one after another | every 3 to 6 s per hand, in 0.6 s, out 0.9 s |

Under them, the continuous life drops to realistic postural noise: hips sway
6 by 4 mm (was 22 by 12) and head drift 1.5° (was 3.5°). Breath
(`BREATH_DEG`, `SHOULDER_LIFT_DEG`, `ARM_BREATH`), blinks and saccades are
unchanged; no amplitude is raised.

**Rules it keeps:**

- **Deterministic and local.** Each performer's schedule is drawn from its
  seed alone, event by event from t = 0, so it never depends on the beats
  or the duration. Directions only *mask* life near them: a life channel is
  scaled by 1 minus how busy that channel is at t, where "busy" is 1 while
  a direction moves, eases to a hold level while it holds (so a held look
  still glances, smaller), and eases to 0 over 0.4 s either side. So
  revising a beat changes life only within its own span plus 0.4 s, and
  `--against` confirms it.
- **Under directions, never against them.** Weight life gives way fully to
  `weight`, `step` and `aim` (and not to reaches: a level easing in and out
  under every reach moved the hips in jerks; the reach is solved after the
  hips anyway); a glance to `look` (hold level 0.65) and `reach`, `take`,
  `put`, `aim` (0.8); a hand fidget to that side's `hand`, `reach`, `take`,
  `put`, `aim`, to holding an object, and to another performer reaching to
  that arm or hand (its lift would move what they touch). The same goes
  for the posture and the chest turn: a performer another reaches to keeps
  the posture it had (a shift in that span plus 0.4 s is skipped, the next
  one catches up) and turns only its head, because a performer solved
  earlier in the cast aims at the others' previous frame. A sigh is scaled
  down while a reach leans. Reaches, grips and puts are still solved after
  life moves the body, so a palm still lands and a held object stays in
  the fist.
- **Feet planted.** Weight shifts move the hips only; the legs are solved to
  the same planted ankles (now aimed past the two-bone solve's few-millimetre
  miss when the pelvis rolls), and the body targets (skate, float,
  penetration, pops, joint limits) must not get worse. `direct.ts` now
  prints each performer's motion-quality verdicts against the authored
  targets.
- `direct.ts` prints each performer's life events in the take, so an author
  knows what a hold already has.

**Proof, on holds** (before and after, same sheets and seeds):
`sheets/defaults-test.json` (the held ending after B's step),
`sheets/rest.json` (no beats at all) and `sheets/watering.json` (the held
ending with the can in hand under a directed look). For each: a `review.ts`
pack under the neutral title; a fresh reader who sees only the reader folder
says whether the hold is alive; the on-card numbers and the motion-quality
body targets before and after; the reach and grip numbers unchanged within
a millimetre or two; a side-by-side before/after H.264 video of the holds
for the owner, whose judgement of the video is the acceptance test. If this
design fails with readers and a second design fails too, stop and report.

**Rejected:** more amplitude (failed twice); a recorded idle clip (the
stock rig has none and it would not respect masks or seeds); random events
re-drawn around the beats (breaks revision locality).

**State (2026-11-17):** built in two designs (design 2 added the posture
resettle and the chest turn for profile views) and landed on `main`. Fresh
readers call the front-facing holds alive and the profile pair still mostly
frozen; two designs failed there, so tuning stopped (evidence: slice 1d
below). The owner watched the before/after video on 2026-11-17:
"its a lot better" and "theres something in the mouth and eyebrows thats
missing, but almost there". The owner chose decision 6 (A) the same day,
and life now drives the mouth and brows from its events. Asked whether
the mouth and brows now read as alive in the close-view face video, the
owner answered "Yes, accept" (2026-11-17). **Life is accepted**
(evidence: "Face in idle life" in slice 1d's evidence); the profile-hold
follow-up stays open.

### Slice 2: the avatar flow (designed and approved 2026-11-17; 2a built)

The owner's 2026-11-17 direction, as an 80/20. The 2026-11-13 plan for one
house base is kept and narrowed: one base, a short list of traits, two or
three finishes, an audition with numbers, and a way to choose an avatar per
hologram in both capture flows. Nothing here is built. Sub-slices 2a to 2g
below are each verified on their own.

**What is in the 20%.** Faces that read on the phone card, because the
feed card is where every hologram is seen first and only a smile reads
there today. A creator's own look, from a few traits. A style that fits
the piece, from finishes. A way in for any outside avatar.

**What is deferred** (the other 80% of the cost): a likeness read from a
photo (slice 5); an avatar editor of any kind beyond the trait list; a
second family (a second base with its own design language); per-style
exaggeration of the face channels; facial hair and headwear (both cover
the face and need their own audition rows); an outside avatar uploaded and
auditioned inside the app; a stored creator profile on the server; and
reconstruction from images. Each is "Later", against the same audition.

#### The base rig

One body, built for expression at card size rather than for close-up
realism:

- **A larger head, eyes and brows.** The face (brow line to chin) is
  about 10% of the body's height on the card today: 29.5 of about 298
  device px. Reaching a 40 device px face means a face of about 13.5% of
  the height, a head of roughly a fifth of it, measured on the base, not
  assumed. A bigger face alone did not help the stock avatar (slice 1b's
  blind readings), so size is necessary, not enough. Eyes and brows are
  drawn larger than human proportion; a mouth with clear corners.
- **Real shapes for the 44 ARKit channels that are not gaze,** not routed
  from 21 synthesized ones as on the stock avatar (`archive/avatar-face.md`).
  The 8 `eyeLook*` channels turn eye bones; the 15 visemes route to jaw and
  lip shapes through `FaceRig`, as today (`FACE_CHANNELS` is the 52 ARKit
  channels plus 15 visemes).
- **Brows never hidden:** no glasses, fringe or hat over them in any
  trait, measured (below).
- **Hands** with all 30 finger bones, which the audition already checks.
- **The canonical humanoid bones** so `HumanoidSkeleton`, every capture
  driver and `direct.ts` bind it unchanged. Bones are never scaled
  unevenly: `retargetClips.ts` rejects a chain that mirrors or scales
  unevenly; a uniform scale of the whole avatar is allowed.
- **Budget,** measured where the feed pays it: the exported take and its
  USDZ, not only the source file, since capture re-exports the avatar
  with GLTFExporter (`GltfExportComposer.ts`). The stock's 21 shapes alone
  added 570 KB (`archive/avatar-face.md`), so 44 dense shapes would blow
  past the stock `avatar.glb`'s 1.8 MB: morph targets are sparse (only
  the face's vertices), and the base file stays within 1.8 MB including
  its build variants' shared textures. The phone journey measured 2.3 MB
  of avatar and scene load; 2g measures it again.

#### The audition bar, in numbers

`avatar-audition.ts` measures today: per channel, the most any vertex
moves at full strength (bar: 1 mm, for ten key channels); whether
anything turns the eyes; a fist and a point against hand length; reach to
seven targets (10 mm); and pass-through in a 75° turn. It runs on any GLB
in Node in seconds. 2a adds the rows below, all provisional until a house
base meets them and the blind reading confirms them; an avatar that fails
one says which.

The rows fall in two tiers:

- **Geometry, in Node, seconds per avatar:** the mm rows, symmetry, brow
  visibility (a ray cast from the card's camera direction) and face
  against accessories. Travel is the 90th percentile of the vertices a
  shape moves by 1 mm or more, not the single largest, so one stray
  vertex cannot pass a row. Regions come from the shapes themselves (the
  brow region is what the brow shapes move; the lids are what
  `eyeBlink*` moves, around the eye bones), so an outside avatar needs no
  landmarks.
- **Render, in the viewer through Playwright, about a minute per avatar
  and finish:** brow contrast, eyes at the card and the face box, from a
  short take solved from `sheets/expressions.json` (`face-legibility.ts`
  already does this). The blind reading is run by fresh readers on top.

The reader sees card pixels, and the card frames the content's bounds
(`viewer-web` `cameraFraming.ts`, margin 1.35), so mm change with height
while pixels do not. The pixel rows are the gate; the mm rows are the
fast loop, stated for an avatar 1.7 m tall with its face box at 40 device
px on the card, and scaled by the base's own face box. The face box is
measured from brow line to chin, not from every vertex a shape moves (as
`lib/review-page.ts` does now), so adding shapes cannot grow it. Height
for the card and for capture's height fit is taken from the head-top
bone without trait parts: today `AvatarRig` fits height and places the
eye at 0.92 of the whole model's box, so a tall hairstyle would shrink
the avatar and misplace the eye (2e changes this with the motion owner).

| Row | Today | Bar (any avatar the flow offers) | Stock avatar |
|---|---|---|---|
| Brows (`browInnerUp`, `browDown*`, `browOuterUp*`) | 1 mm | each at least **8 mm** (decided 2026-11-14) | 3.8–4.5 mm: fails |
| Lids (`eyeWide*`, `eyeSquint*`) | 1 mm | each at least **8 mm** (decided 2026-11-14); `eyeBlink*` closes the lid fully (upper lid meets lower, within 1 mm) | wide and squint 3.5–4.0 mm: fail; blink leaves 6 mm of eye showing: fails |
| Mouth corners (`mouthSmile*`, `mouthFrown*`, `mouthStretch*`) | 1 mm | each at least **14 mm** (the smile, the one shape that read, moves 15.7 mm at its largest vertex) | smile 12.9, frown 8.7, stretch 4.2 mm: fail |
| `jawOpen` | 1 mm | at least **15 mm** | 9.5 mm: fails |
| Lip shapes (`mouthPress*`, `mouthPucker`, `mouthFunnel`, `mouthRoll*`) | 1 mm | each at least **4 mm** | press 1.3, roll 2.8 mm: fail |
| The other non-gaze ARKit channels (cheeks, nose, jaw sideways, tongue) | not barred | at least 1 mm, reported | reported |
| Left and right | not checked | each pair within 15% of each other | within 3%: passes |
| **Brow visibility** (new) | none | of the vertices the brow shapes move by 1 mm or more, at least **90% visible** from the card's camera, at neutral and at `browInnerUp` 1, with every other mesh (glasses, hair) as an occluder except the meshes the brow shapes move (the brow itself) | 75%, the hair hides the rest: fails |
| **Brow contrast** (new, per finish) | none | in a front render at card framing, the brow region differs from the skin around it by at least **0.25 in OKLab L** | 0.353: passes |
| **Eyes at the card** (new) | none | the neutral eye opening at least **3 device px** on the phone card | 2.7–2.9 px: fails |
| **Face against accessories** (new) | none | no face vertex more than 2 mm inside a glasses or hair mesh at any channel at 1 (the smile's squint against the glasses, seen in 1b) | 9 vertices up to 4 mm into the hair: fails |
| **Face box on the card** (new, from `face-legibility.ts`) | reported only | at least **40 device px** tall on the phone card | 24.8 brow to chin: fails |
| **The blind reading** (new, the gate) | run by hand in 1b | `face-legibility.ts` at the card's face size, `sheets/expressions.json`: three fresh readers, **each at least 5 of 7** (chance about 1 in 7) | 3 of 7, one reader |
| Gaze, fist, point, reach, turn | as today | unchanged | passes |
| Size | none | sparse morph targets; base no larger than 1.8 MB; the exported take and its USDZ measured against the hologram budgets | the reference |

Two more, outside the script: the motion owner's report on a directed
take and a captured take on the base (their instrument, when it is on
`main`), and `check_usdz_tools.sh` by hand on a take with it, since
Quick Look is not in `verify:pr`.

The blind reading is the final gate. If the base
meets every mm row and still fails the reading, the bars are wrong and are
raised; if it passes the reading while missing a row, that row is lowered
and the change recorded here.

#### Finishes

A finish is a set of materials on the same mesh and bones, plus at most
one extra mesh (the ink line's outline), with no change to the face
shapes: the mm rows hold for every finish and only the render tier and
the blind reading are re-run per finish. A finish is a property of the
base's files, chosen when the take is made, and the take's GLB carries it.
Three are proposed, to be chosen from the style sheets (open decision 1):

1. **Soft clay:** matte, rounded, the soft pair approved for the poem.
2. **Ink line:** flat colour with an outline, an inverted-hull mesh that
   carries the same skin and face shapes as the body (so it moves with
   them), within the size budget, checked in Quick Look; brows drawn as
   line.
3. **Light:** a lit-from-within body made with alpha blend and emissive
   only, not transmission, which the USDZ path may not carry (checked in
   Quick Look). The riskiest for faces, since translucency lowers
   contrast; it ships only if it passes brow contrast and the reading.

Every finish is auditioned twice in the render tier: on an authored take
and on a captured take with a bubble, because the viewer makes every
material transparent when a take has one (`sphereClipping.ts`).

The styleguide's identity-hue rim on each person's avatar (`styleguide.md`
1.1) is not drawn by the viewer today, and cannot be baked into a file:
the hue is worked out when the take is viewed, from who submitted it
(`presence/identityHue.ts`), and a two-performer authored piece has no
single author. It stays a later viewer change, out of slice 2.

#### Traits: likeness without an editor

The trait card is a small JSON object, the same in every flow:

| Trait | Values | How it is applied |
|---|---|---|
| Skin | 8 tones | material colour |
| Hair | 6 styles × 8 colours; no style may cross the brow line | a swapped part skinned to the head, plus colour |
| Eyes | 6 colours | material colour |
| Build | 3 (slight, medium, broad) | one of three pre-built bodies of the base, each auditioned |
| Height | the person's own (headset), or 3 presets | uniform scale of the whole avatar, which capture's height fit already does; bones stay unscaled |
| Glasses | none, round, square; frames sit below the brows | a swapped part, checked by brow visibility and face against accessories |
| Clothing colours | top and bottom, from the finish's palette | material colour |

The card is applied to the glTF file before it is loaded, by one shared
function in a workspace package (gltf-transform runs in Node and in the
browser): it picks the build's file and finish, adds the hair and glasses
parts, and sets the colours. Both flows use it, so there is one trait
implementation, and the take carries the dressed avatar: `direct.ts`
writes the avatar file it was given (`lib/write-glb.ts`), not the scene it
loaded, and capture exports what it loaded. No combination needs its own
file and no service bakes avatars. Height is a uniform scale of the
performer's wrapper, applied before solving in `direct.ts` (a `height` on
the performer) and by capture's height fit in a headset.

The audition runs on every value of every trait at its extreme (all hair
styles, all glasses, all builds), not on every combination: about 20
geometry runs of seconds each, and the render tier on the hair and
glasses values only, about a minute each. The poem's two characters must
come from the card alone.

How a creator sets it:

- **Phone, embodying:** a "your look" step before Record in the selfie
  journey: the front camera's mirror shows the avatar, and a row of
  swatches per trait sets it, with the camera already driving the face so
  the choice is seen moving. The card is kept on the device and is the
  default for the next take. It sits in the phone journey's files, so it
  is built with the phone mandate's owner (2e).
- **Headset, embodying:** the same card in a mirror panel in the capture
  room (IWSDK UI), reached from the same entry; the card travels in the
  capture link (`?look=`), so a look set on the phone opens on the
  headset. The headset adds whole-body and hand acting; its face stays
  gaze-only until WebXR exposes expressions.
- **Fully AI:** a performer in a beat sheet names `avatar: "house:<finish>"`
  and a `look` card; the agent fills the card from the creator's words or
  takes the creator's saved card. The beat sheet is kept beside the GLB,
  so a piece can be re-dressed by solving it again with another card or
  finish.

#### Outside avatars

Any humanoid GLB or VRM that binds (`HumanoidBindingReport`) and passes the
audition can be used, as `?avatar=<url>` in capture or a file path in a
beat sheet, which both work today. What the flow adds: the audition's
verdict is printed with its failing rows, and the avatar carries a credit
(source, author, licence), read from VRM metadata where present, with the
same rule as slice 1c's objects (a credit or `"own"`, or it is refused).
An outside avatar is offered to a creator only when it passes every row,
as the owner set; one that fails is not offered, and the verdict names
the rows. `?avatar=` keeps loading anything that binds, as a developer
path, as today. Uploading and auditioning one inside the app is deferred.

#### Chosen per hologram; the default

The avatar is chosen when the take is made, not when it is viewed: the
export bakes the avatar into the GLB, so nothing changes in the viewer,
the API or the published format. Per hologram, the creator keeps their
last finish and card or changes them in the "your look" step (or the beat
sheet).

Replacing the stand-in: `DEFAULT_AVATAR_URL` (`apps/capture/src/config/runtimeConfig.ts`)
points at the house base with the neutral card once it passes every row
above and the motion owner agrees their numbers hold. Only that constant
changes; `avatar.glb` stays, since the fixtures, the locomotion library,
the face build, `doctor` and the viewer and API tests read it.

#### Making the base: three ways

| | Commission it, modelled by hand in Blender | Adapt an open-licence base | Generate, then re-rig |
|---|---|---|---|
| What | A character artist builds the base to the chosen sheet, with the 52 shapes made to the audition's numbers | Start from a CC0 human base with clean topology and a full rig (MakeHuman's MPFB, CC0 output), push its proportions to the sheet in Blender, and build the 52 shapes on it, landmark-fitted then tuned per row of the audition | Image-to-3D from the approved sheet (a hosted service or the local TRELLIS path), auto-rig, then add face shapes |
| Cost | Money: a quote is needed; a stylised base with 52 shapes is typically a few weeks of a specialist's time. Owner's decision (billing) | Agent and owner time in Blender, no licence cost; days per audition loop | Cheapest first mesh; then the most rework |
| Licence | Work for hire, full rights, if the contract says so | CC0 output; any Blender add-on used to fit shapes must allow commercial output, checked before use | Per service's terms; the generated mesh's rights vary |
| Risk | Waiting on a person; a mismatch with the bars found late unless the bars are in the contract | Pushing a realistic base to large stylised eyes may break its eye topology; the agent's sculpting skill limits the shapes | Topology unfit for face shapes and fingers: the poem lost detail exactly in face and hands. Breaks "generate what does not act; build what does" |

**Recommended: adapt an open-licence base (the middle column), bounded.**
It keeps the rights clean, costs no money, and the audition can drive it
in a tight loop. Generation is used only for what does not act (hair
styles, clothing), from the approved sheets. If the base misses the brow,
lid or mouth rows after two rounds of shape work, stop and ask the owner
whether to commission the face (the left column), with the audition's
bars in the brief to the artist.

#### Sub-slices, each verified on its own

| Slice | What | Evidence | Runs beside the motion and phone work? |
|---|---|---|---|
| **2a: the bar** | The new audition rows above, in `avatar-audition.ts` and `face-legibility.ts`; run on the stock avatar and the avatar-format fixtures | One command that audits any avatar file and writes audition JSON with every row; it is what grades the new base (2c), outside avatars and each finish. Sanity check only: the stock avatar, known to be poor, fails the brow, lid, mouth, visibility and face-box rows by name | **Yes.** Scripts under `apps/capture/scripts/authoring/` only |
| **2b: the sheets** | Astra draws the style sheets from the request below; the owner picks a finish set (open decision 1) | The sheets, judged against the acceptance list in the request; the owner's pick recorded here | **Yes.** No code |
| **2c: the base** | One base in the picked style, neutral finish, neutral card, made the recommended way | Every audition row passes; three blind readers at 5 of 7 or better at card size; a review pack of `sheets/expressions.json` and the watering piece on the base beside the stock; the motion owner's report; `check_usdz_tools.sh`; a proof video | **Yes.** Loads through `?avatar=` and beat sheets only; edits nothing the mandates own |
| **2d: traits** | The shared dressing function, used by `direct.ts` only; three builds; hair and glasses parts; the poem's two characters from cards | The audition on every trait value at its extreme; a contact sheet of the trait values; the poem's two characters made from cards alone, in a take whose GLB carries the look | **Yes.** A workspace package, authoring scripts and avatar files; nothing in `apps/capture/src/` |
| **2e: chosen per take** | `house:<finish>` and `look` in beat sheets; the dressing function in capture's avatar loading; height from the head-top bone; the "your look" step in the phone journey and the headset mirror; `?look=` | A phone e2e: set a look, record, upload, and the feed card shows it; an XR harness check of the mirror; a beat sheet re-dressed with another card; a proof video | **No.** Touches the phone journey (`CaptureOverlay.tsx` and its flow), owned by the phone mandate, and `src/avatar/` (loading, `AvatarRig`'s height fit), owned by the motion owner: built with both, after the phone's device checks |
| **2f: finishes** | The other one or two finishes as material sets | Brow contrast and the blind reading per finish; one authored piece re-dressed in each | **Yes.** Avatar files |
| **2g: the default and outside avatars** | `DEFAULT_AVATAR_URL` to the house base; the credit rule and verdict for outside avatars | Motion owner's agreement recorded; the phone journey's load measured against the 2.3 MB; an outside VRM passed and one refused, by name; a proof video | **No.** One constant in capture, on the motion owner's say |

2a and 2b start together and need nothing else. 2c needs both. 2d and 2f
need 2c and can run side by side. 2e and 2g come last and join the
mandates.

#### The request for Astra

The owner passes this to Astra (ChatGPT). It is the brief's text so it is
versioned with the bars it must meet.

> **Style sheets for HoloIM's house avatar.** HoloIM records short acted
> moments ("holograms") and shows them on a phone feed, where a whole
> standing person is about 200 CSS px tall and their face about 20 CSS px.
> We are building one base character that every creator dresses as
> themselves. We need 2D sheets to pick its style from, before anything is
> modelled. Please draw:
>
> 1. **One base character in three finishes:** (a) soft clay, matte and
>    rounded, in the spirit of the soft pair you drew for "The part I
>    didn't say"; (b) ink line, flat colour with a clean outline; (c)
>    light, a translucent figure lit from within. Same body, same pose,
>    same face in all three; only the surface changes. Gender-neutral
>    base, adult, neutral clothing (fitted top, trousers, simple shoes).
> 2. **Proportions for expression at small size:** head about one sixth
>    of the height (larger than a real person's); large eyes with visible
>    whites; thick, dark-enough brows that sit clear of everything; a
>    mouth with clear corners; hands slightly large, five fingers. No
>    hair, hat or glasses over the brows, in any drawing.
> 3. **A turnaround per finish:** front, three-quarter, side and back,
>    A-pose (arms about 45° down), on a plain mid-grey background,
>    2048 × 1024 px, with a height line.
> 4. **An expression sheet per finish:** neutral, smile, sad, holding
>    something back (lips pressed), determined, hopeful, looking down, and
>    also surprised, worried, noticing something (the last three are for
>    later gestures; only the first seven are judged). Each as a head at
>    512 px tall, then the same row again twice, shrunk so each face
>    (brow line to chin) is 30 px and 40 px tall in image pixels. The
>    small rows are the ones that matter: 30 px is today's face on a
>    phone's card, 40 px the size the new character is built for. Each
>    expression must be tellable from the others at those sizes by the
>    brows, lids and mouth, not by colour or a caption.
> 5. **Trait variations** on the soft-clay finish, as a grid of heads and
>    one full body per build: 8 skin tones; 6 hair styles (none may
>    cover the brows) each in 2 of 8 colours, with the 8 colours as
>    swatches; 6 eye colours; 3 builds (slight, medium, broad); glasses
>    none, round and square, with frames below the brows; 3 clothing
>    colour pairs.
> 6. **The two characters from your poem** made only from those traits,
>    to show the traits are enough.
>
> Deliver PNGs at the sizes above, one file per sheet, named
> `<finish>-<sheet>.png` (for example `clay-expressions.png`), with the
> trait values written under each head.
>
> **A sheet is acceptable when:** the 40 px row reads by this test: three
> people who have not seen the sheet each get the seven judged faces
> from it, shuffled and without captions, with the list of seven names,
> and each names at least 5 of 7 (the same test the 3D character must
> pass); the brows are visible in every
> drawing; the three finishes are clearly the same character; every trait
> value is drawn and labelled; the backgrounds are plain; and nothing
> copies an existing game, film or brand character.

The owner returns the sheets; 2b records the pick here and keeps the files
in the ignored `output/avatar-sheets/` of the main checkout.

**Sheets returned (2026-11-18).** The owner returned Astra's sheets; they
are in the main checkout's ignored `output/avatar-sheets/`: nine PNGs
(`base-finishes`; `<finish>-turnaround` and `<finish>-expressions` for
clay, ink and light; `clay-traits`; `clay-poem-pair`) and Astra's
`blind-reading-test.zip`. The lead checked them against the request
above: every sheet is there at the asked size, every trait value is drawn
and labelled, and the brows are clear. The owner has not picked a finish
yet (open decision 1), so no look work starts.

**The owner's pick (2026-11-18): "Clay, then ink."** Asked which finishes
the base build takes its look from, the owner picked soft clay first and ink
line second; light is not picked. 2c takes its proportions, colours and
surface from `clay-turnaround.png`, `base-finishes.png` and
`clay-traits.png`; ink (2f) waits until clay is through.

The lead ran Astra's blind test with three fresh Sonnet readers at 40 px.
No finish passes the 5-of-7 bar:

| Finish | Reader 1 | Reader 2 | Reader 3 |
|---|---|---|---|
| clay | 3 | 7 | 4 |
| ink | 5 | 7 | 4 |
| light | 3 | 3 | 4 |

Smile, sad and determined read reliably; the misses fall among neutral,
hopeful, holding something back and looking down. That is the same
confusion the 3D base showed in 2c (see open decision 7). The readers were
AI models; Astra's protocol asks for people, so this is evidence, not the
protocol's verdict. At the owner's request the lead drafted a revision
request to Astra for those four expressions
(`output/avatar-sheets/astra-revision-request.md` in the main checkout),
which went to Astra.

**Round 2 of the expression sheets (2026-11-18).** Astra redrew the four
expressions; the new sheets are in the main checkout's ignored
`output/avatar-sheets/round-2/`:
- `clay-expressions.png`, `ink-expressions.png` and
  `light-expressions.png`, each 5000 × 950;
- `expression-revision.zip`;
- `blind-reading-test.zip`, with a new shuffle and key.

These round 2 sheets are now the reference for neutral, hopeful, holding
something back and looking down. The other expressions still come from
round 1.

The lead reran Astra's blind test with three fresh Sonnet readers. Each saw
only its own three 40 px pages, in Astra's rotation order. Every reader
named all 7 on every finish:

| Finish | Round 1 (readers 1, 2, 3) | Round 2 (readers 1, 2, 3) |
|---|---|---|
| clay | 3, 7, 4 | 7, 7, 7 |
| ink | 5, 7, 4 | 7, 7, 7 |
| light | 3, 3, 4 | 7, 7, 7 |

All three readers said the pair they were least sure of was neutral against
holding something back. As in round 1, the readers were AI models, while
Astra's protocol asks for people.

### Slice 3: the six-second test (general; after slice 1b)

Two takes of one piece on the house characters (one flat, one directed),
shown muted and without the verse; then the same question after orbiting.
The goodbye is one fixture for it, not the aim. Slice 1b's review protocol
is its method.

### Slice 4: a person's take as input (joins the phone mandate)

Starts only when the motion owner lands camera driving on `main` behind
`?input=camera`. The owner acts the reach on a phone; that capture take is
imported, played on any avatar, and edited by beat (retime, lengthen a
hold, redirect a look). A two-person scene is two takes (IDEA-084). The
same report on the person's take and the agent's take shows how much
hesitation, weight and timing the agent produces on its own.

Moving a captured GLB to another avatar by rotation works today but loses
hips travel, contacts and face detail. Doing better means the recording
keeps the raw face channels and hand goals, which is a change to the
recording path for the mandate sessions to agree to when this slice
starts. Two declared performers in one file is a format extension and
would be its own brief.

### Slice 5: likeness from a photo (deferred)

The second finish moved into slice 2 (2f) on 2026-11-17. What is left is
the deferred half of likeness: a selfie read once into the slice 2 trait
card (skin, hair, eyes, glasses, build), as a one-time setup outside the
phone journey's two minutes, kept on the device and made only from the
creator's own photo. It changes no trait and no file format: it only
fills the card a creator can already set by hand. It starts after the
trait card has been used in both capture flows (2e).

### Later, each against the audition

A second family (a new base with its own design language); per-style
exaggeration of the face channels, when that family needs it; facial hair
and headwear, each with its own audition rows; uploading and auditioning
an outside avatar inside the app; a creator's card stored on the server;
reconstruction from images (Astra's local path) as an avatar source; a
full avatar editor.

## Not covered yet

What a whole creation system needs and the tools do not do yet. Confirmed
by the second piece's gap log (slice 1b evidence, "Does it need water?"):
each item was a step that needed something outside the CLI and its README.
Ordered by how much it cost the piece. Slice 1c covers items 1, 2, 3, 6
and 7 (its evidence, below); the second 1c piece added item 13.

1. **Props and sets.** A beat sheet has no objects. The piece's pedestal,
   pot, plant and watering can were added afterwards by a hand-written
   gltf-transform script (about 120 lines), placed in absolute metres by
   trial and error: the first set hid her and the can until 4 s.
2. **A held prop.** Holding the can needed an attachment node under the hand
   bone and a grip frame worked out by hand from the finger bones. There is
   no pick up or put down, so the can is in her hand from the first frame.
3. **Using a tool.** A hand has four palm facings and no tool axis. The pour
   is a palm roll, and which roll tips the can depends on how it was
   attached, which the author sees only in the review. The tip read late in
   both takes, on the roll back, not the roll asked for.
4. **Gestures and states with no direction.** No nod or head shake, no
   "rub the soil between the fingers", no "concerned" or "noticing"
   expression. "The soil is dry" was staged as looking at a fingertip, and
   read as checking a watch.
5. **Change in the world.** No water, particles or plant response: the
   reader saw "no water" and "the plant looks the same".
6. **Performer-relative placement.** Marks are absolute metres guessed from
   the avatar's size; nothing says "at her right hand's height" or "a
   step in front of her".
7. **Post-processing keeps the file valid.** Re-writing a take with
   gltf-transform drops `HOLOIM_humanoid`, so the set script re-declares the
   performer by node name.
8. **Publishing.** No publish step: the author writes a showcase `meta`
   module, copies the GLB to `output/showcase/<slug>.glb` and runs
   `scripts/showcase/upload.mjs` with a session.
9. **Review tooling.** A pack takes about eight minutes; the close view
   crops a long reach and shows the back of a performer who faces away; the
   README now documents a one-minute framing check (`viewer-check.ts
   --frames`).
10. **Revision locality for staging.** Moving the can to the other hand to
    keep it in view changed beats that had read (lift and pour), so "revise
    only what did not read" holds for timing, not for staging.
11. **Faces.** See the face numbers in slice 1b's evidence: on the stock
    avatar only mouth-led shapes read, and a smile's squint shows an
    artefact against the glasses in the close view. Slice 2 (the avatar
    flow, 2026-11-17) is the answer being designed.

12. **Life a reader can see.** Since slice 1d a hold facing the viewer
    reads as alive to fresh readers (rest: "mostly frozen" before, "a
    living person" after), but two people in profile through a long held
    ending still read as mostly frozen (defaults, after two designs). The
    owner judged the slice 1d video on 2026-11-17: "its a lot better" and
    "theres something in the mouth and eyebrows thats missing, but almost
    there". With the face layer from decision 6 (A), the owner accepted
    life on the face video: "Yes, accept" (2026-11-17). Still open: two
    people in profile through a long held ending read as mostly frozen to
    readers; authors give a profile hold a beat for now.

13. **A far object shrinks the performer.** The card frames every recorded
    object, so each widens the dome, and nothing caps it in an authoring
    take, which has no bubble. This item first said the card showed only
    the performer's surroundings. That was the review pack's crop, a
    review-tool fault fixed on 2026-11-16, not the viewer. Whether to cap
    the widening is open for the owner in `docs/features/card-framing-objects.md`.

Not exercised by the piece, still open: **voice and sound** (speech,
effects, music) and **titles and captions**.

## How this lines up with the mandates

| Session | It owns | This brief touches | This brief needs from it |
|---|---|---|---|
| Phone capture mandate | The journey: Record, post grant, selfie mode, share | None of its files until 2e | Nothing until 2e and slice 4. Slice 2 gives it an expressive default avatar and "an avatar that looks like you" from traits (slice 5 later from a photo), both of which its "want to send" needs and its brief excludes. 2e adds a "your look" step before Record, built with its owner after its device checks |
| Natural avatar motion (motion owner) | Driving, IK, retargeting, smoothing, `motion-quality.ts`, the camera driver | Imports its solving modules and the instrument; edits none of its files | Notice when the instrument is on `main`; a category for authored takes in it, or agreement that their numbers carry no verdict; its report run on the house base before that becomes the default (2c), and its agreement before `DEFAULT_AVATAR_URL` changes (2g); 2e edits its `src/avatar/` (loading and the height fit) with it; notice when `?input=camera` is on `main`; at slice 4, whether a recording can keep raw face channels and hand goals |

The mandates come first. Slices 0 to 3 and 2a to 2d and 2f add scripts
under `apps/capture/scripts/` and avatar files; they change no file either
session owns. 2e and 2g are the only parts that edit `apps/capture/src/`
(the phone journey's files and the motion owner's `src/avatar/`), and
each joins both owning sessions when it starts.

## Scope

**Included:** slices 0 to 3, with slice 2 as the avatar flow (2a to 2g);
slice 4 once camera driving is on `main`; slice 5 after 2e.  
**Excluded:** an avatar editor in the app beyond the trait card; more than
one family and three finishes; facial hair and headwear; uploading an
outside avatar inside the app; a creator profile on the server; synthesized speech; a prompt box in the app; an MCP tool (the CLI
comes first); more local image-to-3D work; changing the published GLB's
format; an all-hologram regression corpus.

## Undo

None: this adds no authoring action inside a capture take. The "your
look" step (2e) is set before a take starts, like the input mode, so it
is not in a take's undo history; changing the look again is its undo.

## Acceptance criteria

- [x] The acting report runs on the three baselines and reproduces the
  poem's result (8 of 102 channels, last change at 4.0 s, no face).
  Evidence: slice 0 below.
- [ ] The audition report runs on the stock avatar and the house base, and
  names what each cannot express. (Stock avatar done in slice 0; the house
  base is slice 2.)
- [ ] The house base passes every audition row in slice 2 (including the
  brow, lid and mouth mm bars, brow visibility, a 40 device px face box)
  and three fresh readers name at least 5 of 7 expressions at card size,
  in every shipped finish; it passes the motion owner's report; and the
  poem's two characters are made from trait cards alone, with no scaled
  bones.
- [ ] A creator sets a finish and a trait card on a phone before Record,
  and on a headset, and the published take carries that look; a beat
  sheet takes the same card. (2e)
- [ ] `DEFAULT_AVATAR_URL` points at the house base with the motion
  owner's agreement, `avatar.glb` stays for the fixtures, and the phone
  journey's load is no larger than before. (2g)
- [ ] An outside avatar that passes every row is offered; one that fails
  is not, and the verdict names the rows; each carries a credit. (2g)
- [ ] The four "in all cases" requirements (Direction, 2026-11-17) are
  re-assessed against the table there when slice 2 lands.
- [x] One beat sheet, solved on two different avatars, plays in
  `viewer-web` with face shapes and fingers moving (weights read back from
  the GLB), and a hand that stops short of a target stops at the same
  distance on both. Evidence: slice 1 below.
- [ ] A published authored piece says in its file that it was authored,
  and the viewer's framing and hand traces follow its first performer.
  (Checked through a local upload, not yet on a published piece: the file
  carries `authored: synthetic` and the viewer resolves its humanoid on the
  first performer only; see the framing note in slice 1 below.)
- [ ] The six-second test: fresh critics shown only the muted directed take
  name the hesitation; the flat take scores lower; the owner's verdict is
  recorded. Orbiting is tested as a second question.
- [x] Revising one beat changes only that span in the report, and rebuilds
  in under 30 s. Evidence: slice 1 below.
- [x] Slice 1b's review loop: a review command writes a pack (H.264 video
  at the card's framing and a close view, frame sheets, the acting report,
  on-screen sizes) and the README gives the fresh-reader protocol.
  Evidence: slice 1b below.
- [x] The three defaults shown before and after, each with its own review
  pack, on a neutral test sheet: a reach at a moving performer, a neutral
  rest and life in a held ending. Evidence: slice 1b below. Two are
  open: life still reads as frozen from stills, and the rest reads as
  folded arms in profile (neutral from the front).
- [x] Face height at the card and the blind readings recorded, with the
  options left as a decision for the user. Evidence: slice 1b below.
- [x] A second piece, different in kind, authored from a three-line brief
  with the CLI and README. Reviewed, revised, reviewed again, uploaded and
  rendered locally, not published. Its gap log fills "Not covered yet".
  The loop ran; the piece itself does not read (only "watering a plant"
  reads, half the beats) for the reasons in the gap log. Evidence: slice 1b
  below.
- [ ] A second agent (Astra) authors a take using only the CLI and its
  README.
- [ ] Authored pieces stay within the Quick Look extent budget (B-057) and
  the hologram size budgets with two house characters on stage, and
  `check_usdz_tools.sh` passes on the two-character piece. (Passes on the
  two stock-avatar piece; house characters are slice 2.)

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Direction becomes a second solver that disagrees with capture's | Import capture's arm, leg, face and locomotion solving unchanged; only hand shapes, weight shifts and steps are new; the report runs on both |
| The viewer picks the wrong performer in a two-character piece | The first performer is named `RecordedAvatar` and is the only one declared; the pipeline check reads the anchors back |
| A directed take passes for a recording | The file is marked as authored (principle 7 of `what-a-hologram-is.md`) |
| The avatar work grows into a character creator before one character is good | One family; a fixed trait card with listed values; finishes after the base passes (2f after 2c) |
| A trait hides the face (a fringe or frames over the brows) | Brow visibility and face against accessories run on every trait value at its extreme; a value that fails is dropped |
| A finish loses the face (translucency, an outline over the brows) | Brow contrast and the blind reading are re-run per finish; one that fails does not ship |
| The mm bars pass but faces still do not read | The blind reading is the gate; the bars are raised and the change recorded |
| 44 real shapes and an outline mesh make the avatar too heavy for a phone | Sparse morph targets; the exported take and its USDZ measured, not only the source; the phone journey's load measured in 2g |
| An outside avatar with an unclear licence | A credit or `"own"`, read from VRM metadata where present, as for slice 1c's objects; refused otherwise |
| A headset take has less face than a phone take | Stated, not fixed: WebXR exposes no expressions; the headset adds body and hands |
| The house base changes the motion owner's numbers or breaks fixtures generated from the shipped rig | `?avatar=` only until its report passes; the stock avatar stays in the repo for the fixtures |
| A stylised face cannot show a tracked channel | The face binding report says so; the audition lists how far each shape moves |
| A contact is lost when proportions change | Hand and gaze goals live in the beat sheet and are solved per avatar; the stop-short criterion checks it |
| Always-on life (blinks, breath) reads as noise, not intent | Amplitudes taken from a person's take in slice 4; critics compare with and without |
| Critics share the author's blind spots | The final verdicts are the owner's and a different vendor's |
| Two skinned avatars exceed size or Quick Look budgets | Two stock avatars over 12 s come to about 8.6 M moving vertex-frames against a 100 M budget; characters from one base share textures; `check_usdz_tools.sh` is run by hand on the piece, since it is not in `verify:pr` |
| Generated hair or clothing clips through the body in motion | The audition includes the turn and the reach; parts that fail are rebuilt or dropped |
| A likeness the person did not agree to | The identity card is made only from the author's own photo, kept local, never from a third party's |

## Ownership

One lead owns `apps/capture/scripts/authoring/` (new), the report and
audition scripts, the house base's source and its exported avatar files
(base, builds, trait parts, finishes), and this brief. Not owned here:
`apps/capture/src/**` (2e and 2g join its owners), the viewer and the API.

## Open decisions for the user

1. **House style:** answered 2026-11-18: "Clay, then ink" (slice 2b,
   "The owner's pick"). Light is not picked.
2. **Faces at card size** (numbers in slice 1b's evidence). On the stock
   avatar only the smile reads, at any size from 8 to 96 device px, so
   framing is not the limit. The options are:
   - **(A)** Keep the card framing, and author emotion through the body
     and mouth-led shapes. No cost; the README already says so.
   - **(B)** Frame closer in the viewer. That is not this brief's to
     change, and the blind readings say it would not help this avatar.
   - **(C)** An audition bar for any house avatar: brows not hidden, and
     brow and lid shapes moving the mesh at least 8 mm.

   Recommended: A now, and C as a requirement of slice 2 if it starts.

   **Decided on 2026-11-14:** A now, and C as a requirement of slice 2.
3. **What comes after slice 1b.** After one revision the second piece
   reads as watering a plant, not as checking whether it needs water. What it could not express was props, sets, tool use,
   gestures and change in the world, not the avatar. The options are:
   - **(A)** A slice for props and sets in the beat sheet: objects, a
     held prop with pick-up and put-down, and a tool axis. Then publish
     as one command.
   - **(B)** The house avatar (slice 2) as planned.

   Recommended: A. Slice 2 stays gated until a piece's reading names
   the avatar as the limit.

   **Decided on 2026-11-14:** A. Props, sets and tool use are being built
   in their own session; slice 2 stays gated.
4. **Slice 1c's two product calls:**
   - **(a)** Sheet objects are written as recorded objects
     (`RecordedObject` nodes in `HOLOIM_objects` v0), so an authored take
     and a captured take show props the same way, beside the body, as
     the concept's Event layer says.
   - **(b)** Every object from an outside file carries a credit (source,
     title, author, licence). A local GLB must name one, or be marked
     `"own"`. The build refuses one that does neither.

   Slice 1c is built this way.

   **Decided on 2026-11-15:** yes to both ("Sure").
5. **The avatar flow (slice 2), as designed on 2026-11-17.** Each part
   has a recommendation:
   - **(a) The plan:** one expressive base, a trait card, finishes, the
     audition as the bar for every avatar offered, chosen per take in both
     capture flows, in sub-slices 2a to 2g. Recommended: approve.
   - **(b) How the base is made:** commission, adapt an open-licence base,
     or generate and re-rig (table in slice 2). Recommended: adapt a CC0
     base (MPFB) in Blender, with generation only for hair and clothing;
     after two rounds that miss the face rows, come back to you about
     commissioning the face, which would be a billing decision.
   - **(c) The bars:** brows and lids at least 8 mm (already decided),
     mouth corners 14 mm, `jawOpen` 15 mm, lip shapes 4 mm, brows 90%
     visible, a 40 device px face box, and three blind readers at 5 of 7
     as the gate. Recommended: accept as provisional, moved by the blind
     reading and recorded here.
   - **(d) The finishes** Astra draws: soft clay, ink line and light.
     Recommended: all three on paper; build clay first, ink second, light
     only if it passes brow contrast and the reading.
   - **(e) The trait card:** skin, hair, eyes, build, height, glasses and
     clothing colours, each from a fixed list; facial hair and headwear
     later. Recommended: approve.
   - **(f) Outside avatars:** offered only when they pass every row, with
     a credit; `?avatar=` stays as a developer path. Recommended: approve,
     as your "if it passes the audition".
   - **(g) Start now:** 2a (the bar, scripts only) and 2b (you pass the
     Astra request in slice 2 to Astra) together, beside the motion and
     phone work. Recommended: yes.
   - **(h) The identity-hue rim on avatars** (styleguide 1.1) is not
     drawn by the viewer today and cannot live in the avatar file.
     Recommended: leave it out of slice 2, as a later viewer change.

   **Decided on 2026-11-17:** every recommendation, (a) to (h) ("Approve
   all"). Next: 2a (the bar) in its own session, and the owner passes the
   Astra request in slice 2 to Astra (2b).
6. **The face in idle life** (asked 2026-11-17, after the owner's judgement
   of the slice 1d video: "theres something in the mouth and eyebrows
   thats missing, but almost there"; numbers in slice 1d's evidence, "Face
   in idle life"). Today idle life moves only the eyes and the blinks. The
   options are:
   - **(A) The mouth now, the brows wired for the base.** Add a face layer
     to idle life, tied to the events it already has, so it stays seeded,
     masked and local to a revision:
     - the lips part a little on the in-breath and through a sigh
       (`jawOpen`, `mouthFunnel`);
     - the lips press or roll as a weight shift settles;
     - a corner tugs now and then;
     - the brows lift with an upward glance, and the inner brows lift
       through a sigh.

     Each moves at a fifth to a third of its shape, and a directed
     `expression` beat masks it, as a held hand masks the fidget. On the
     stock avatar the mouth should read in the close view and AR, while
     the brows barely move; the base inherits the brows when it meets the
     bars. Proof is the same three sheets, with readers on both the close
     view and the card, and a new video for the owner. The change is
     small and touches only `life.ts` and the face step in `direct.ts`,
     with no avatar change.
   - **(B) Wait for the base.** Build the face part of life with slice 2,
     once a base meets the bars in 2a. Nothing changes now, and life stays
     "almost there" until then.
   - **(C) The mouth now, and make the stock brows readable.** Take the
     glasses off the stock avatar and deepen its brow shapes to 8 mm. That
     is avatar work slice 2 owns (glasses become a trait-card choice), and
     it changes the avatar earlier takes used.

   **Recommended: (A).** It answers the mouth now on the avatar the owner
   watched, and puts the brows where the base will make them readable,
   with no avatar work. Caveat: on the phone card itself an idle mouth
   stays near a pixel, so (A) shows in the close view and AR first.
   **Decided on 2026-11-17:** (A) ("A, mouth now"). Built the same day
   (evidence: "Face in idle life" in slice 1d's evidence), with one change
   from the list above: life's glances are mostly down or level, so the
   brows flash as a glance comes back rather than lifting with an upward
   glance.
Decided on 2026-11-13: Astra draws the style sheets; Astra authors a second
take with the CLI; the build starts after the user has answered the two
mandate briefs. Both were answered the same day, so the build can start.

Decided on 2026-11-13: the house base waits for the early reading. The
brief had recommended building it beside slice 1; the user answered "Wait
for reading". Slice 2 starts only when the user decides on it from the
reading recorded in slice 1's evidence. **Lifted on 2026-11-17** ("yes,
lift the hold"); slice 2 is now the avatar flow, approved the same day
(decision 5).

7. **The house base's face (asked 2026-11-18, slice 2c; answered the same
   day).** The owner's answer, in their words: "Yes, match the sheets"
   (asked: "Rework the base's expressions to match Astra's round 2 sheets
   now?", against commissioning a face). So:
   - the base's face is not commissioned;
   - the expression mixes (`EXPRESSIONS` in `lib/beats.ts`, which every
     avatar shares) are reworked to the round 2 sheets, clay first;
   - the base's blind reading is then run again as 2c's gate.

   Outcome (2026-11-18): the mixes were reworked and the gate missed twice
   more (1, 3, 4 and then 2, 1, 4 of 7; slice 2c evidence, "The round 2
   mixes and the gate"). The face, not the mixes, is the limit: the base's
   eyes and mouth are one or two device pixels at 40 px, where the sheet's
   eyes span half the face. Matching needs a face made for big eyes, which
   is option A (spend), so it is back with the owner. **Decided by the agent
   in the owner's absence on 2026-11-18, for the owner to review:** the
   reworked mixes, the scripts and the base land on `main` with the base
   reachable only through `?avatar=` and beat sheets, marked here as not
   yet passing 2c; `DEFAULT_AVATAR_URL` is unchanged. Reverting is one
   commit (the mixes) and one file (the base).

   The question as first asked: The adapted
   MPFB base passes every face row of the audition but not the blind
   reading. After two rounds, three readers each scored 5, 3, 3 and then
   3, 1, 1 of 7. Options:
   - A. Commission the face (a sculpted head with blendshapes made for the
     card), keeping the generated body and rig. It costs money, and
     `house-base.ts` already takes everything else.
   - B. Make the expression mixes in `lib/beats.ts` stronger for every
     avatar, then read again. It costs nothing, but it changes how the stock
     and every directed piece act.
   - C. Wait for the style sheets (2b) and redo the face from them.

   Recommended: B first, because it is cheap and tests whether the mixes
   are the limit, then A if a third reading still misses.

   Evidence since (2026-11-18): Astra's drawn sheets, the ideal the base
   would copy, blur the same four expressions at 40 px (neutral, hopeful,
   holding something back, looking down; three AI readers per finish, see
   slice 2b, "Sheets returned"). So the expression designs, not the
   modelled face, look like the cause: commissioning a face (A) or redoing
   it from the sheets (C) would likely meet the same misses. The readers
   were AI models, not the people Astra's protocol asks for.

   Round 2 (2026-11-18): Astra redrew those four, and the redrawn sheets
   read 7 of 7 for every reader on every finish, again with three AI readers
   at 40 px (slice 2b, "Round 2 of the expression sheets"). The readers were
   least sure of neutral against holding something back. So a 7-of-7 design
   for the four now exists to aim the base's face at. The decision itself
   is unchanged and still the owner's.

## Test plan and evidence

- The acting and audition reports on their baselines (numeric, saved as
  JSON).
- One pipeline check: a directed take on two avatars through upload and
  render, with the stop-short distance and the viewer's anchors read back.
- `check_usdz_tools.sh` by hand on the two-character piece.
- The six-second test's critic answers and the owner's verdict.
- Proof video under ignored `output/`.

### Slice 0 evidence (2026-11-13)

Reports are JSON in the ignored `apps/capture/output/authoring/`.

- **The poem** (`report-poem.json`): 102 channels over 12.0 s, 8 change,
  the last at 4.0 s; Speaker moves 7 of 51 channels and Traveler 1 of 51,
  and both are frozen from about 4 s. No morph meshes and no finger bones
  (17 joints per rig), so face, fingers and eyes never move. Reproduced
  exactly.
- **The Way Down II** (`report-way-down-ii.json`): 169 channels, 152
  change, and no skinned performer: its figures are unskinned, so the
  report counts them as scene.
- **A captured phone take** (`report-phone-capture.json`): 141 channels
  over 17.5 s, 6 change. `RecordedAvatar`'s face moves 6 of 27 shapes and
  the eyes move, but fingers move 0 of 30, and it is frozen from 13.64 s to
  15.21 s. A headset take (`report-ci-summon.json`, 2.4 s) changes 14 of
  144 channels and its fingers never move either.
- **The audition, stock avatar** (`audition-stock.json`): passes. 55 of 59
  face channels displace the mesh by at least 1 mm (largest 15.7 mm), and
  gaze by eye bones moves 7.9 mm at 20°. A fist closes every fingertip to
  at most 46.8 mm from the palm, and a point holds the index 116.6 mm out.
  Every reachable target is met exactly; the two targets placed out of
  reach on purpose miss by 998 mm, as they should. A 75° turn slips the
  ankles 8.4 mm. Arm-in-torso contact is already there in the rest stance
  (16 vertices a side) and stays small in the turn (6 and 21 vertices, at
  most 25.3 mm deep); head in torso is 3 vertices.
- **The audition, `unreal-cm` fixture** (`audition-unreal-cm.json`): the
  same, except "FAIL face: nothing turns the eyes". It has no eye bones and
  no eye-look shapes, so a look on it is head-only.
- The motion owner's instrument is left out, as slice 0 says.

### Slice 1 evidence (2026-11-13)

- **One beat sheet on two avatars** (`sheets/two-avatars.json`, stock and
  the `unreal-cm` fixture): 196 frames at 30 fps, 114 channels, 3.6 MB,
  solved in 0.2 s. Uploaded to a local test API and played in a viewer-web
  test build (`viewer-check.ts`, `two-avatars-viewer.json`). Weights read
  back while playing:

  | Performer | Bones moving | Fingers moving | Face shapes moving (peak) | Anchor bones |
  |---|---|---|---|---|
  | `RecordedAvatar` (stock) | 51 of 67 | 30 of 40 | 9 of 27 (0.903) | 54 |
  | `Performer_cm` (`unreal-cm`) | 49 of 73 | 30 of 40 | 18 of 27 (0.971) | 0 |

  The viewer resolved its humanoid from `HOLOIM_humanoid` and tagged only
  `RecordedAvatar`'s bones. Both performers reach for the `between` mark
  with `stopShort` 0.1 m: the stock avatar's palm stopped 99.9 mm from it
  and `unreal-cm`'s 99.8 mm.
- **The file:** the first performer is `RecordedAvatar`, the only one in
  `HOLOIM_humanoid` (in `extensionsUsed`, not required);
  `asset.extras.holoim.authored` is `synthetic`.
- **Framing:** the anchors (hips and head focus, hand-trace scope, AR
  bounds) follow `RecordedAvatar`; the scene origin is the stage origin,
  since the wrapper's rest transform is identity. The card's camera
  frames the whole cloche, which wraps every performer, so with two
  performers the card shows both, and only the anchors favour the first. An authored
  take has no hand traces, since the viewer draws only author `trace`
  marks.
- **Revision locality:** changing the goodbye's withheld hand to a fist on
  one beat changed only 2.27 s to 4.27 s (15 channels) in the `--against`
  report, and the rebuild took 0.67 s.
- **`check_usdz_tools.sh`** on `two-avatars.glb`: passed, 4 of 4 cases
  (animated ancestor and face, silent, alpha UV PBR, unsupported required
  extension) in 80 s.
- **The goodbye, flat and directed** (`sheets/goodbye.json`, two stock
  avatars). In the viewer, the flat take moves 12 of 67 of her bones and 8
  of his, with no fingers or face; the directed take moves 50 of 67 on each,
  30 of 40 fingers, and 22 of 27 face shapes on her (peak 0.944). The
  acting reports agree: the directed take changes 109 of 111 channels, and
  the flat take changes 24 of 26 but is frozen from 4.7 s to 6 s (her) and
  2.77 s to 4.4 s (him). Her reach ends 262.9 mm from him against 160 mm
  asked, because he steps out of reach; the sheet should aim at where he
  will be.
- **The early reading:** two fresh critics, Opus and Sonnet, each saw
  twelve stills per take from the viewer, muted and labelled only by
  letter, in a different order.
  - Opus scored the flat take 5 of 10 and the directed take 6 of 10, and
    would show the directed one. It read the directed take as "a reach is
    refused, and the woman who made it folds back into herself while the
    other stands her ground", her hand back to her chest at 3.0 s as
    self-protective, and a glance back at 5.0 s. It read the flat take as
    "a woman reaches for someone who has already left, and gives up".
  - Sonnet scored the directed take 5 of 10 and the flat take 6 of 10, and
    would show the flat one, because his turn and open arms answer her. It
    read the directed take as "a woman reaches out once and is met with a
    folded-arms posture".
  - Both said the faces and eyes cannot be read at card scale, the last
    2.5 s are static, and his rest pose reads as hands on hips, an
    attitude nobody directed. Neither named "she wants him to stay but
    stops herself".

  **The gate for slice 2, plainly:**
  - **Did the directed take beat the flat one?** No. The critics split
    one each, by one point (6 to 5 both ways).
  - **What did they name?** A reach, a refusal and a withdrawal. Opus also
    saw her hand go back to her chest and a glance back. Neither named
    the hesitation the sheet directs, "she wants him to stay but stops
    herself".
  - **Was the stock face the limit?** Not shown either way. Neither critic
    could read a face or eyes at card scale, on either take. The directed
    take does move 22 of 27 face shapes (peak 0.944), and the audition
    measures up to 15.7 mm of mesh movement. So the reading cannot tell
    the 21 synthesized shapes apart from the face's size on screen.

  As slice 1 says, no clear difference does not say why; slice 3 settles
  it. The reading points to three causes for slice 3 to test: the
  face is too small to read at card scale, the life underneath is too
  small to carry the aftermath, and the arm rest pose (hands near the
  hips) reads as intent.

### Slice 1b evidence (2026-11-14)

Packs, readers' accounts and comparisons are in the ignored
`apps/capture/output/authoring/review/<pack>/`; every reader was a fresh
Claude Sonnet subagent given only the pack's `reader/` folder.

- **The review step.** `review.ts <take.glb> --sheet <sheet>` plays the take
  in a viewer-web test build and writes the pack: `reader/review.mp4` (H.264,
  real time, the card framing beside a close view per performer), card and
  close frame sheets every 0.2 s labelled by time only, `on-screen.json`
  (the face's height on the card and, per second, how far head and hands
  travel there; under 1 CSS px is `still`), the acting report and a
  `comparison.json` to fill per beat. Beat sheets carry an `intent` for the
  piece and each beat; the README gives the fresh-reader protocol. A pack
  takes about eight minutes for a nine-second take.
- **Defaults** (`sheets/defaults-test.json`: A reaches for B's arm as B
  steps back, then both hold; packs `defaults-before`, `defaults-after`,
  `defaults-after2`):

  | Default | Before | After | Read by |
  |---|---|---|---|
  | A reach at a moving performer lands where they are | Palm 177.4 mm from B's arm (asked 20); the goodbye's 262.9 mm (asked 160) | 18.5 mm (asked 20), 11.8 mm with the doubled life; the goodbye's 148.6 mm (asked 160) | The reader saw the hand land on B's shoulder; before, "where it lands is hidden" |
  | A neutral rest | B: "arms clasped or folded tight", an attitude | Elbows 5 cm back, 22° bend, hands at the thighs; from the front reads as standing at rest | See below |
  | Life under a held ending | B still (under 1 CSS px/s) at 1, 3, 5 and 7 s; "paused mannequins" | No still second for either performer on the card (head 0.9–5.9 and hands 0.6–4.5 CSS px/s in the holds) | Still "mostly frozen" to two readers in a row, from frame sheets 0.2 s apart; **open** |

  Life was checked twice and failed both times, so the loop stopped there
  as the brief requires. The numbers say the held ending moves on the card,
  but fresh readers still call it frozen. They judge from stills 0.2 s
  apart, where a slow sway of a few pixels does not show. Whether the video
  reads as alive was untested until the owner watched it on 2026-11-14:
  frozen. Bigger sway will not fix it. The next try
  is a different kind of life, not more of the same: occasional weight
  shifts, glances and posture changes, the motion a reader can see in
  stills. It should be judged from the video by a person.

  The rest pose is fixed in its geometry, not yet in every reading. Seen in
  profile, the readers still call the arms folded. The forearm crosses the
  torso's silhouette, and the armour's bright trim makes a band across it.
  A frontal take with no beats (`sheets/rest.json`, twelve stills from `viewer-check.ts --frames`) read to a fresh
  reader as "neutral standing at rest; no attitude or emotion", arms
  hanging at the sides. Life was doubled after the first after-pack read
  "held poses with a moving background, not as alive": sway amplitude 11 to 22 mm
  (peaks near 30 mm), head drift 1.8° to 3.5°, and breath about half again.
- **Face legibility at the card** (`face-legibility.ts`, `sheets/expressions.json`):
  a standing performer's face is 19.7 CSS px tall on a phone's card (29.5
  device px, 3.3 mm on the glass; the body is 199 CSS px). On a desktop it
  is 21.6 px at 1×, and 32.4 device px on a 2× display, where the card's canvas is capped at 1.5×. Fresh readers named seven
  expressions blind, from a face rendered at a set height (chance about 1 in
  7):

  | Face height, device px | 8 | 12 | 16 | 24 | 30 (card) | 32 | 48 | 64 | 96 |
  |---|---|---|---|---|---|---|---|---|---|
  | Correct of 7 | 1 | 2 | 1 | 2 | 3 | 3 | 2 | 2 | 1 |
  | Every expression at strength 1.8 | | | 1 | | 3 | | 3 | | 2 |

  Only the smile read, at every size; a bigger face did not help. The
  limit is the avatar, not the framing: its shapes move the mesh too
  little, and its glasses cover the brows. Mesh travel per channel:

  | Channels | Mesh travel |
  |---|---|
  | mouthSmile | 15.7 mm |
  | eyeBlink | 10.9 mm |
  | mouthFrown | 10.5 mm |
  | eyeWide, eyeSquint | 6–7 mm |
  | brow and cheek shapes | 3.6–4.5 mm |
  | lip press, jaw forward | 1.2–1.3 mm |

  The options are open decision 2 below.
- **A second piece**, "Does it need water?", authored from this three-line
  brief:
  - **Title:** Does it need water?
  - **Intent:** How to tell a potted plant needs water: push a finger into
    the soil, and if it is dry, water it.
  - **Constraints:** One performer, one watering can, a plant on a stand;
    practical tone; ten seconds or less.

  Sheet: `sheets/watering.json`, 9 s, eight beats. The set and the can were
  added after building with a gltf-transform script outside the tool.
  - **First review** (`watering-1`): the piece read as "watering a plant",
    but not as checking whether it needs water. Look, lift and pour read;
    grip, point, poke, the dry check and the satisfied ending did not.
    The can was hidden behind her body and the set until 4 s.
  - **Revision:** the can went to the right hand and the set moved, so the
    can is seen from the start. The check became lifting the finger and
    looking at it. The reach ends are within 5 mm as built for the
    review (poke 4.6, check 0.4, lift 0.9, pour 0.8; life was doubled later). `--against` reports 0.03 to 9 s changed, because
    swapping hands moves every beat that uses them.
  - **Second review, discarded** (`watering-2`): "someone tending a plant:
    checking it, deciding it needs water, watering it". The independent
    verifier found that the card showed the piece's title, "Does it need
    water?", which tells the reader the intent. Every pack before the fix
    showed its title the same way: goodbye, the defaults and watering-1.
    `review.ts` now uploads every take as "Take".
  - **Second review, neutral title** (`watering-2b`): "someone tending a
    plant, with a checking pause and then a watering". **The piece does not
    read:** the reader saw watering, not how to tell that a plant needs
    water. Four of eight beats read: look, grip, lift and pour (the tilt at
    4.4 s; no water is seen). Four did not:
    - the point: the hand at the pot is too small to see;
    - the poke: "can't tell what the hand does";
    - the check: "checking a wrist (a watch or device), or holding a
      thought";
    - the ending: "finishing and returning", with the face not readable.

    The beats that fail are the ones the gap log names: a gesture with no
    direction, contact with no change in the world, and a face at card
    size. Revising the sheet again cannot fix them, so the second piece
    stops here.
  - **Local upload and render:** `viewer-check.ts` on the revised take shows
    51 of 67 bones moving and 9 of 27 face shapes (peak 0.926), with the
    viewer anchoring on `RecordedAvatar`.
  - **Published by the owner** on 2026-11-14 as `cmwgvndd90001oeh37kuvfri7`
    (Quick Look ready), with this command, which the tool does not cover:

    ```
    mkdir -p output/showcase && cp apps/capture/output/authoring/watering/watering-2.glb output/showcase/does-it-need-water.glb
    cd apps/capture && node scripts/showcase/upload.mjs --api https://holoim-api.fly.dev ../../output/authoring/watering/publish
    ```

    It needs a session (`HOLOIM_SESSION` or the Keychain agent token).
    `publish.mjs` holds the slug, the name and "Claude (agent-authored)".
  - **Gap log:** every step that needed something outside the CLI and its
    README is now "Not covered yet", above. In short:
    - props, sets and a held prop's grip;
    - using a tool (the pour);
    - gestures with no direction (nod, "this is dry");
    - no change in the world (water);
    - performer-relative marks;
    - post-processing dropping the humanoid declaration;
    - publishing;
    - slow packs, and a close view that crops;
    - staging changes that break revision locality.
- **What this says about slice 2.** Avatars limit the face only. What kept
  the second piece from reading was everything around the performer:
  props, tool use, gestures and the world. That points to building props
  and sets before a house avatar.

### Slice 1c evidence (2026-11-14)

Builds, Quick Look runs and viewer checks are in the ignored
`apps/capture/output/authoring/c1/` and `c1b/`, and the review packs are in
`review/watering-1c/` and `review/tallest-bar-1c/`. Both readers were fresh
Claude Opus subagents. Each was given only the pack's `reader/` folder under
the neutral title "Take".

- **Two sheets, no outside script.** `sheets/watering.json` now declares its
  set and props: a Poly Haven pedestal (credited), a plant, a pot and a can.
  `sheets/tallest-bar.json` is the second piece, and it is different. A side
  table (Poly Haven, CC0, by James Ray Cock) holds a cup. She takes a pointer
  from the cup with the left hand, aims its tip at the tallest bar of a bar
  chart, looks back to the viewer, and puts the pointer back. Each sheet
  builds with `direct.ts` alone.
- **Build numbers** (limits: grip 1 cm/5°, put 1 cm/3°, aim 10°):

  | Piece | Reaches (stop-short miss) | Grip | Put | Aim |
  |---|---|---|---|---|
  | watering | poke 0.4, check 0.2, lift-can 0.4 mm | none (held from the first frame) | none | 3.3° |
  | tallest-bar | show 0.2 mm | 0.2 mm / 0.1° | 2.9 mm / 0.1° | 2.5° |

- **Regression.** goodbye and two-avatars rebuild with every reach
  re-solved (wrist-start, 8 passes):
  - goodbye: 148.6 mm, asked 160;
  - two-avatars: 100.0 and 100.2 mm, asked 100;
  - defaults palm: 19.6 mm, asked 20.

  The wrist turns at most 25° in goodbye and 14° in two-avatars. `--against`
  with two moving objects keys same-named nodes as `name#k` and reports
  "0-9.5 s (1 ch)".
- **File.** Both GLBs keep `RecordedAvatar` as the only performer declared
  in `HOLOIM_humanoid`, and declare their objects in `HOLOIM_objects` v0.
  `validateHoloimObjects` passes, and gltf-validator reports 0 errors. Each
  sourced object is credited in three places:
  - `holoimCredit` on its node;
  - `asset.copyright`;
  - `asset.extras.holoim.sources`, with its sha256 and the origin it was
    fetched from (a local file publishes only its basename).
- **Viewer** (`viewer-check.ts` on the `c1b` builds): the humanoid resolves
  to holoim in both.

  | | Bones moving | Fingers | Face shapes (peak) | Objects |
  |---|---|---|---|---|
  | tallest-bar | 50/67 | 30/40 | 9/27 (0.976) | table credited and still; cup still; pointer moves; chart still |
  | watering | 51/67 | 30/40 | 9/27 (0.926) | pedestal credited; two still objects; can moves |

  viewer-check names objects `RecordedObject_n`, not by their sheet names.
- **Quick Look.** `apps/viewer-api/tools/check_usdz_tools.sh <glb> [outdir]`,
  run by hand, passes 4/4 on both GLBs (`c1/quicklook-*/exercise-summary.json`).
- **Refusals**, each with a message that names the problem:
  - a mark cycle;
  - a take whose hand arrives after the take ends;
  - a place measured from an object held from the first frame;
  - a size of 0 or below;
  - a put at a point on the object itself;
  - a credit that does not parse.

  A mark that names an object declared later in the sheet now builds.
- **Reader, watering.** Overall: "tending a houseplant". These read:
  - looking at the plant;
  - lifting the can.

  These did not:
  - The touch is hidden behind the leaves.
  - The wrist check reads as checking a watch.
  - The pour reads only as "probably meant as pouring". The can is held
    still at chest height for about 2 s, to her right and never over the
    pot, and no water comes out.
  - The face is unreadable on the card (16.8 CSS px).

  The props now place, hold and aim as written, but what decides this piece
  is the pour's placement and the water, and the water is out of scope here.
- **Reader, tallest-bar.** Overall: "pick up the pointer, present or gesture
  with it, put it back". These read:
  - the take;
  - the put.

  These did not:
  - She never points at anything the reader could identify. The card
    showed the chart; the pack's card stills were cropped to the cast, and
    the close view, planned around her alone, rendered off centre through
    the card's view offset. This was a
    review-tool fault, fixed on 2026-11-16; a fresh reading of the fixed
    pack is in `docs/features/card-framing-objects.md`.
  - The pointer "disappeared" at 2.2–2.6 s. The take's hold (0.3 s) ended
    before the show reach began, so the hand fell back to her hip. The hold
    is now 1.6 s, and the pointer's lowest point between 1.5 and 3.2 s rose
    from 0.73 to 0.98 m. This was not re-reviewed.
  - It ends leaning about 45° in the cup. A put matches up to 0.1° but has
    no goal for the turn about vertical, so the shaft keeps the lean the
    hand gives it.
  - The shaft is a hairline on the card, and 3.4–6.2 s looks almost frozen.

  The README now covers framing on the phone card and keeping a take's hold
  until the next reach. "Not covered yet" item 13 now records the open
  question of capping how far objects widen the card.
- **Review fixes.** A code review and a fresh Opus verifier (given only this
  brief and the diff) found the following, now fixed:
  - the grip offset was taken at the rig's scale, so a scaled avatar's prop
    drifted;
  - marks were placed out of order;
  - late takes were accepted;
  - the source cache was not per origin;
  - credit was checked late;
  - non-positive sizes were accepted;
  - a put at the object itself was accepted;
  - an absolute local path could be published.

  Still open: no check proves the wrist limits or their precedence.
- **Not published.** Neither slice 1c build was uploaded (the published
  watering piece is the slice 1b take). The user approved open decision 4
  (recorded objects, required credit) on 2026-11-15.

### Slice 1d evidence (2026-11-17)

Before is `main` at the slice 1c merge; design 1 is the events as first
built; design 2 adds the posture resettle with each weight shift and the
chest turn on large glances (kept). Same sheets and seeds throughout. Each
take had a `review.ts` pack under its neutral title, and a fresh Sonnet
reader saw only a copy of the reader folder under a random name.

| Sheet | Before | Design 1 | Design 2 |
|---|---|---|---|
| `rest.json` (no beats, facing the viewer) | "Mostly frozen ... a posed figure with a faint idle" | "Mostly alive but subtle" (head tilt, arm, torso lean change still to still) | "Reads as a living person ... arms lift and drop, stance changes, head tilts" |
| `defaults-test.json` (two in profile, held ending 4.4–8 s) | "Frozen, mostly ... statues in a moving scene" | "Mostly frozen ... posed mannequins with occasional micro-adjustments" | "Mostly frozen ... posed statues with a faint sway" |
| `watering.json` (held pour, can in hand) | "Mostly alive" (the pour hold "slightly more posed") | "Reads as a living person" | "Reads as a living person ... never a locked, mannequin-like pose" |

`watering` was alive before too (its beats keep it busy), so it shows only
that life does not get in the way of a held prop. Readers of `rest` also
saw a hand "at the collar"; it is in the before frames too and is the
costume's shoulder piece, not a hand.

**Why the profile pair still fails.** In profile the weight shift is a
depth move, the face is about 20 CSS px and turned away half the time, and
the held ending had few events: A shifts at 2.5 s (under its reach) and 7.9
s, and B's only shift (2.3 s) falls while A touches it, so B keeps its
posture. The tail's on-card travel barely changed (A head 1.0/5.9/1.3 →
1.6/4.8/1.0 CSS px/s at 5–8 s). Larger amplitude was rejected in slice 1b;
what is left is a beat, or event density keyed to a hold's length, which
would break the seed-only schedule.

**Body and contact** (`direct.ts` verdicts against the authored targets;
jitter is P95 in mm, pass under 2):

| Take | Before | Design 2 |
|---|---|---|
| defaults A | jitter 2.51 (fail), pen 0.07 cm, pop 5.36 | jitter 2.7 (fail), skate 0.03 cm, pen 0.11 cm, pop 5.01 |
| defaults B | pen 0.56 cm (fail), jitter 2.27, skate 0.73 cm | jitter 2.21 (fail), skate 0.69 cm, pen 0.13 cm (now passes), pop 3.1 |
| rest | jitter 2.2 (fail), pen 0.13 cm, pop 0.07 | jitter 2.27 (fail), skate 0.02 cm, pen 0.08 cm, pop 0.9 |
| watering | jitter 2.29 (fail), pen 0.1 cm, pop 6.61, aim 3.3° | jitter 2.41 (fail), skate 0.02 cm, pen 0.05 cm, pop 6.64, aim 1.6° |

Jitter failed before and with design 2 under the measure of the time,
which counted any slow ease inside a "still" window. Measured again after
merging `main` (whose motion-quality measure changed for gap 3 of
`natural-avatar-motion.md`), every take passes every body target: jitter
0.69 and 0.95 mm (defaults A, B), 0.65 (rest), 0.71 (watering); no float or
penetration; pops 5.73, 3.4, 1.06 and 7.72 m/s²; B's skate 0.69 cm (the
step). Reaches are
unchanged: defaults 19.6 mm (asked 20), watering 0.4, 0.1 and 0.4 mm.
Penetration for B is fixed by aiming the leg solve past its ankle miss.

**On-card travel** (head / hands CSS px/s per second, from `on-screen.json`;
no still second in any take before or after): rest before head 1.6–3.9,
hands 1.4–4.0; design 2 head 1.0–5.9, hands 1.9–8.8 (the fidgets).

**Locality** (checked with `--against` on design 1; design 2 adds no beat
dependence except that a shift under another performer's reach keeps the
old posture until the next one): revising a beat changes life within its
span plus 0.4 s, and the schedule comes from the seed alone.

**Video.** A before/after H.264 video of the three holds (kept out of the
repository) went to the owner on 2026-11-17. **Owner's judgement
(2026-11-17):** "its a lot better" and "theres something in the mouth and
eyebrows thats missing, but almost there". Life was not accepted on that
video; the owner accepted it with the face layer (below).

**Face in idle life** (asked after the owner's second line, 2026-11-17;
built the same day as decision 6 (A), below). What idle life drove in the
face before it:

- **Blinks:** `LivenessFace`'s seeded blinks, plus one on a directed look
  that turns the head (`head` over 0.3) and one on a glance whose head
  turn passes 12° (`GLANCE_BLINK_DEG`).
- **Eyes:** saccades and fixational drift around straight ahead, shrunk
  while the eyes hold a target; on a glance the eyes lead the head. Gaze
  is by bones on the stock avatar.
- **Mouth: nothing.** `LivenessFace`'s jaw follows the voice level, which
  is 0 in an authored take, and `direct.ts` takes only the blink from it.
  The mouth moves only in a directed `expression` beat.
- **Brows, and lids beyond the blink: nothing.**

How far each face channel moves the stock avatar's mesh at full strength
(`avatar-audition.ts` on `public/gltf/models/avatar.glb`, 1.736 m,
2026-11-17), against decision 5c's bars, and what that is in pixels: on
the phone card at 0.17 device px per mm (the body is about 295 device px
for 1736 mm), and in the review's close view at about 0.65 px per mm
(estimated from a frame; about 0.4 after the side-by-side video's
scaling, which is what the owner watched):

| Channel (stock) | mm | Bar (5c) | Card px | Close px |
|---|---|---|---|---|
| `browInnerUp` 4.5, `browOuterUp*` 4.0, `browDown*` 3.8 | 3.8–4.5 | 8, and 90% visible: **fail** (glasses cover the brows) | 0.6–0.8 | 2.5–2.9, behind the rim |
| `eyeBlink*` | 10.8–10.9 | closes the lid: pass | 1.9 | 7.1 |
| `eyeWide*` 6.7, `eyeSquint*` 5.2–6.0 | 5.2–6.7 | 8: **fail** | 0.9–1.1 | 3.4–4.4 |
| `mouthSmile*` 15.7, `mouthFrown*` 10.5, `mouthStretch*` 4.2 | 4.2–15.7 | 14: smile passes, frown and stretch **fail** | 0.7–2.7 | 2.7–10.2 |
| `jawOpen` | 11.5 | 15: **fail** | 2.0 | 7.5 |
| `mouthPucker` 9.9, `mouthFunnel` 8.6, `mouthRoll*` 3.0, `mouthPress*` 1.3 | 1.3–9.9 | 4: pucker and funnel pass, roll and press **fail** | 0.2–1.7 | 0.8–6.4 |

Idle face motion would use a fifth to a third of a shape, so:

- **On the card, on the stock avatar,** no idle mouth or brow movement can
  be seen: a third of the smile is under 1 device px, and the brows sit
  behind the glasses.
- **In the close view, on a larger screen or walking up to an AR
  hologram** (the close view is where the owner saw the face), the stock
  mouth can carry it: a third of the smile, `jawOpen`, `mouthPucker` or
  `mouthFunnel` moves 2–3.5 px in the close view. The stock brows cannot:
  they are under the bar and behind the rim.
- **On the slice 2 base** (brows at least 8 mm and 90% visible, a face box
  of at least 40 device px), a brow at full is about 1.7 device px on the
  card and a third of it about 0.6 px. So idle brows read on the base in
  the close view and AR, and on the card only as an occasional larger
  event (a brow flash), not as a constant layer.

The options were open decision 6; the owner chose (A).

**Built (decision 6 (A), 2026-11-17).** `faceAt` in `lib/life.ts` adds a
face layer under the directed expressions in `direct.ts`. It rides life's
existing events and draws from two new seeded streams, so the body
schedule is unchanged:

- **Sigh:** the lips part (`jawOpen` 0.3) and the inner brows lift
  (`browInnerUp` 0.4) on the in-breath; on the out-breath the jaw closes,
  the lips round (`mouthFunnel` 0.35) and the brows come down over 0.6 of
  the out-breath.
- **Weight shift settling:** at 0.55 of the shift, either a lip press
  (`mouthPress*` 0.6, `mouthRollLower` 0.45, `mouthPucker` 0.2) or, on
  some, a one-sided corner tug (`mouthSmile` 0.3 on one side, the other
  side pressed). Held 0.3–0.8 s, at 0.7–1.0 strength.
- **Brow flash:** on 60% of glances, the inner and outer brows lift as the
  glance comes back (life's glances are mostly down or level, so a lift
  with the glance would not read).
- **Masks:** a directed `expression` beat owns the face
  (`MASKED_BY.face`); a directed look masks the flash with the glance.

Locality: the three takes rebuilt with the layer keep every body number
(jitter 0.65 / 0.69 / 0.95 / 0.71; pops 1.06 / 5.73 / 3.4 / 7.72; B's
skate 0.69 cm; reach errors 19.6, 0.4, 0.1 and 0.4 mm, all as before).
Only morph channels change: 15 of 27 face shapes move in the rest hold
(2 before), 11 and 13 in the defaults pair, 18 in watering (9 before,
from its directed expressions).

Readers: four fresh readers (Sonnet; rest, the defaults pair and watering
with the layer, plus rest without it as the control) read the same card
and close contact sheets as before. Their aliveness readings did not
change (rest alive, watering alive or mostly alive, the defaults pair
mostly frozen on the card), and none named a mouth or brow change, with
or without the layer. A contact-sheet tile shows the face at about 1–3 px
per mouth movement, which matches the table above. In crops of the close
view at full size, the lips part, round and press and a corner tugs where
the schedule says (rest: lips part at 3.1 s, round at 3.4 s, a corner
tugs at 4.8 s). So the layer is visible close up and not on the card, as
the decision's caveat said.

**Video.** A before/after H.264 video of face crops from the close view
(the three holds, without and with the layer, kept out of the repository)
went to the owner on 2026-11-17. Asked "Do the mouth and brows now read
as alive in the after clip?", the owner answered **"Yes, accept"**
(2026-11-17): life is accepted. The profile hold stays open (item 12).

**Follow-ups.** A directed `weight` direction rolls the pelvis so the free
hip rises (sign opposite to life's); a profile hold needs a beat or a different idea
(open).

### Slice 2a evidence (2026-11-17)

**The command.** `avatar-audition.ts <avatar.glb|.gltf>` grades any avatar
against every row of the bar and writes `audition.json` with each row's id,
tier, bar, value and pass (README, "Auditioning an avatar"). Geometry tier
2.6 s on the stock; with the render tier about 30 s.

**The stock avatar** (sanity check; 1.736 m, so mm bars × 1.02): 30 of 61
binding rows fail, by name:

- brows: `browInnerUp` 4.5 mm, `browDown*` 3.8, `browOuterUp*` 4.0 (bar 8.2);
  visibility 75% at neutral and at `browInnerUp` 1 (bar 90%): the **hair**
  hides 25%. The glasses hide none from the card's camera, which sits below
  the face (y 1.30 m); the brows sit above the frame. The 1b reading "the
  glasses cover the brows" was a close-up's;
- lids: `eyeWide*` 3.9–4.0 mm, `eyeSquint*` 3.5–3.6; `eyeBlink*` 1 leaves
  **6 mm of eye showing** (14–14.5 mm open at neutral): the upper lid stops
  above the lower one. The old row's "blink 10.9 mm" was one vertex's
  travel. Eye opening on the card 2.9 and 2.7 device px (bar 3);
- mouth corners: smile 12.8–12.9 mm, frown 8.4–8.7, stretch 4.2 (bar 14.3);
  `jawOpen` 9.5 (bar 15.3); lip shapes: press 1.3, roll 2.8 (bar 4.1;
  pucker 9.4 and funnel 8.2 pass);
- face box on the card, brow line to chin: **24.8 device px** (bar 40). The
  old box (every vertex a shape moves) read 29.5;
- face against accessories: smile, `browOuterUpRight` and `cheekPuff` push 9
  vertices up to 4 mm into the hair;
- size 1.83 MB (bar 1.8); the existing turn row (right arm 32 vertices into
  the torso, up to 26.9 mm), as before 2a.

Passing rows: symmetry (all pairs within 3%), brow contrast 0.353 OKLab L,
gaze, fist, point, reach. Other channels, reported: `mouthClose` and
`tongueOut` move nothing.

**The avatar-format fixtures** (all 17 from `scripts/lib/avatar-fixtures.ts`,
the stock remapped): each runs; `unmappable` gets one `file.binds` row
naming the missing bones. Formats without eye bones (`biped`, `unreal-cm`)
fail the blink and gaze rows with "no eye found". The render tier on
`mixamo-prefixed` and `vrm0-minus-z` finds the same face (box 24.8 and 23.9
px); brow contrast fails there (0.12–0.15) because fixtures carry no
textures. `vrm0-minus-z` first read every brow hidden: its `HumanoidFacing`
node is turned 180°, so the geometry tier now measures in that node's
parent frame (follow-up below).

**Choices made in 2a.**

- **Height, not face box, scales the mm bars** (height / 1.7). The bar's
  text above says "scaled by the base's own face box"; that needs the render
  tier, and the mm rows are the fast loop. The pixel rows already grade
  what the card shows.
- **Eye opening** is measured with rays from the card's direction over the
  eye's middle columns (the iris, not the corners): the eye shows where the
  first surface a ray meets is carried by the eye bone. The stock head has
  no hole around its eyes, so an edge-loop method found nothing.
- **Brow contrast** is the spread (90th − 10th percentile) of OKLab L at the
  brow vertices in a front render, so a dark brow on light skin and a light
  brow on dark skin both count. Hair in front of a brow vertex is sampled
  too.
- **Accessories** are head-skinned meshes with no face shapes, other than
  eyes, teeth and tongue.
- `face-legibility.ts` now measures the same brow-to-chin box (its
  `face.json` reads 25.3 device px on the stock's expressions take).

**Follow-up.** In `lib/avatar.ts` the body frame of an avatar with a
`HumanoidFacing` node is that node's own frame, which faces −Z for VRM 0
(`vrm0-minus-z`: the left hand at −X). Bind data, reach targets and
direction may be mirrored for such avatars; owner: the slice that next
directs a VRM 0 avatar.

### Slice 2c evidence (2026-11-18): stopped at the blind gate (base landed, not yet passing)

**Status: not done.** The base passes every face row of the audition. It
fails the blind reading in two rounds, so work stopped as the slice
requires. Commissioning the face is the owner's decision (open decision
below). The branch `feature/house-base-2c` is not merged.

**The base.** `house-base.ts` makes `public/gltf/models/house-base.glb`
(1.61 MB, under the 1.8 MB budget) in headless Blender, and every value
comes from `house-base/base.json`. Its parts and credits are in
`asset.copyright` and in the scene's `holoimAvatar` extras:

- the MakeHuman human from MPFB 2.0.18 (CC0 output; GPL-3.0 add-on, pinned by sha256);
- the 52 ARKit face shapes from faceunits01 (CC0, pinned by sha256);
- the ribbon brows, the eyeballs, the lips and the clay materials, made by
  `build.py` (the project's own).

No generated hair or clothing yet. The base has a bald head, a plain top,
trousers and shoes. The proportions are a 1.55× head, 1.5× eyes and
1.12× hands, and the brows are never covered. The rig and channels are
the stock's: 53 bones and the ARKit face set, driven by `direct.ts`
(directed takes of `expressions` and `watering`).

**Audition** (round 1, the base on the branch): 81 rows, all pass except:

- `turn.armR-in-torso`: 38 vertices, up to 28.1 mm. It is binding, and
  the stock fails it the same way (32, 26.9 mm). The vertices are at the
  shoulder and armpit, and no macro or proportion change moved them, so
  the row tests the point-cloud check, not this mesh. Owner: the motion owner.
- `other.tongueOut`: 0 mm, reported only (no tongue).

The key values:

| Rows | Values |
|---|---|
| Brows | browInnerUp 12.3, browDown 11.7, browOuterUp 9.4 mm |
| Lids | wide 13.5, squint 13.4 mm; blink closes |
| Jaw and mouth corners | jaw 39.4 mm; smile 21.4, frown 15.9, stretch 15.5 mm |
| Lip shapes | press 11.3, pucker 11.7, funnel 8, roll 7.5 mm |
| Brow visibility | 100% |
| The card render | brow contrast 0.366; eye opening 4.2 device px; face box 42.8 device px |

On the phone card in `review.ts`, the face is 54.3 device px (the stock's is 30.9).

**Blind reading at card size** (`face-legibility.ts`, 42 device px,
`sheets/expressions.json`; one Opus and two Sonnet readers, each fresh;
the list of names came with a one-line gloss each):

| Round | Change | Readers (of 7) |
|---|---|---|
| 1 | as above | 5, 3, 3 |
| 2 | smaller eye scale (1.4) with a wider falloff, browDown gain 2.6, mouthPress 1.7, jawOpen 0.5, lighter lips | 3, 1, 1 |

Only the smile read for every reader. Held, resolve and neutral were
confused with each other, and hope with eyes-down and sad. At round 1 the
eye-scale falloff left a ring that reads as glasses at card size, and the
dark lips read as an open mouth. Round 2 removed both, and the score
fell. Round 1 stays on the branch. The weak expressions are mixes of
channels at 0.25–0.6 (`EXPRESSIONS` in `lib/beats.ts`), so a channel can
pass its millimetres at 1 and still move too little in the mix. Making
those mixes stronger would change every avatar, so that is not 2c's to
do.

**Other findings.**

- **Reach.** The 1.55× head takes height from a 1.7 m figure: the
  shoulders are 1.25 m (the stock's 1.44 m) and the arms 7 cm shorter. In
  the watering take two reaches stop 17.5 mm and 23.1 mm short (stock
  under 1 mm), within `direct.ts`'s limits.
- **Quick Look.** `check_usdz_tools.sh` cannot run its material challenge
  on the base. The challenge needs two materials with embedded base-colour
  textures, and the clay base has colour factors and no UVs. The stock's
  expressions take passes all four cases. A base needs UVs and a texture,
  or the check needs a factor-only path.
- **The build.** It gives the same geometry on each run, but Blender can
  order the eye and mouth triangles differently, so the sha256 can change.

**Measure fixes found on the way** (in this branch; the stock's rows are
unchanged by them):

- the eye radius now spans every mesh the eye bone carries (it took the pupil);
- brow visibility no longer counts the brow's own meshes as occluders (the
  bar's row above is updated);
- the close-up aims at the face's centre and drops brow samples outside the frame.

**Revisit when the style sheets (2b) arrive:** the head, eye and hand
scales, the brow shape and colour, the lips and their colour, the skin and
clothing colours, and the height the head takes from the body (reach).
Hair and clothing are still to be generated. (Done for clay on 2026-11-18;
see "The clay look" below.)

#### The clay look (2026-11-18)

After the owner picked "Clay, then ink" (slice 2b), the base took its look
from Astra's `clay-turnaround.png`, `base-finishes.png` and
`clay-traits.png`. Every value is in `house-base/base.json`; the sRGB values
read from the sheets' lit midtones are kept there as `sheetSRGB`, beside the
linear `colours` the build uses.

- **Colours:**
  - skin is terracotta, sRGB 214, 128, 80 (it was a pale tan);
  - the brows are dark brown;
  - the lips are close to the skin, as drawn;
  - the eyes have warm whites and amber-brown irises;
  - the jumper is oatmeal, the trousers slate and the shoes brown.
- **Surface:** roughness 0.65 (was 0.85) for the soft clay sheen.
- **Head:**
  - scale 1.4 (was 1.55), toward the sheet's head of about 1/7.2 of the
    height;
  - `head-round` 0.9 (was 0.4) for the sheet's rounder skull.
- **Brows:** higher and thicker, as drawn: `low` 1.55, `thick` 0.6,
  `outer` 1.4.
- **Hands:** 1.15.
- **Eyes:** the iris is larger (0.65 rad).
- **Eye falloff:** eased (inner 1.0, outer 4.5), so the scaled eye region no
  longer leaves the ring that read as glasses.
- **Two build fixes in `build.py`:**
  - Both eyeballs now take the smaller fitted size. With the eyes scaled up,
    the lids' nearest vertex differed by side, and the eyeballs came out at
    18.5 and 26.7 mm.
  - A face split evenly between two garments, or between a garment and the
    neck, is now cloth, and toe tips weighted to no rig bone are now shoe.
    This removes the strip of skin at the waist and the bare toes.

The audition passes 79 of 81 rows. The same two miss as before:
`turn.armR-in-torso` (33 vertices, up to 28.2 mm), which the stock also
fails, and `tongueOut`, which is reported only. Key values:

| Row | Value | Bar |
|---|---|---|
| browInnerUp | 14.6 mm | ≥ 8 |
| browDown | 12.1 mm | ≥ 8 |
| eyeWide / eyeSquint | 12.7 / 12.8 mm | ≥ 8 |
| mouthSmile | 16.5 mm | ≥ 14 |
| jawOpen | 37.1 mm | ≥ 15 |
| brow visibility | 100% | ≥ 90% |
| brow contrast | 0.328 L | ≥ 0.25 |
| eye opening | 4.1 device px | ≥ 3 |
| face box | 40.4 device px | ≥ 40 |
| file size | 1.60 MB | ≤ 1.8 |

The blind reading was not rerun: decision 7 is open, and a revision of the
four confused expressions has been asked of Astra.

**What the build cannot match from the clay sheets:**

- **Clothing.** The jumper, trousers and shoes are colour regions painted on
  the body. They are skin-tight, show the chest, and the collar edge is
  uneven. The sheet's loose jumper, straight wide trousers and modelled
  shoes need garment meshes, which slice 2c leaves to generation (still not
  done).
- **Eye size.**
  - The sheet's eyes are about twice life size; the base's are 15 mm
    eyeballs in MPFB's sockets.
  - The eyeball is fitted to the nearest lid vertex.
  - Scaling the eye region past 1.5 brings back the glasses ring (tried at
    1.7).
  - Matching the sheet needs a face with sockets and lids made for big eyes:
    the commissioned face of decision 7 (A), or a new eye region.
- **The head and the face box.**
  - The sheet's head is smaller than the base's.
  - At the sheet's proportions the brow-to-chin height would be about
    177 mm. That is 36 device px on the card, under the bar's 40.
  - Head 1.4 with raised brows is the smallest head that passes, at
    40.4 px, with almost no margin.
- **Face detail:**
  - the sheet's large ears;
  - the soft cheeks and blush;
  - the eyelid lines and lashes;
  - the thin smiling mouth (the sheet's neutral face smiles);
  - the clay's fine surface texture (the base has no textures or UVs).
- **Body:**
  - The sheet's figure is flat-chested and narrow-hipped under loose
    clothes.
  - The MPFB macros at 0.5 give a mixed body that tight painted clothes
    show.
  - Garments would hide this; the macros are left for the trait builds
    (2d).

The side-by-side of the sheet and the base is in the worktree's ignored
`output/house-base-2c/clay-side-by-side.jpg`.

#### The round 2 mixes and the gate (2026-11-18)

Decision 7 was answered "Yes, match the sheets", so `EXPRESSIONS` in
`lib/beats.ts` now follows Astra's round 2 clay sheet:

- **Hopeful:** inner and outer brows high, eyes wide, the mouth a little
  open, no smile.
- **Holding something back:** lips pressed and rolled in, inner brows a
  little raised, lids a little lowered. A first try with the sheet's
  lowered brows read as determined to every reader.
- **Looking down:** lids lowered and the irises low (`eyeLookDown`).
  `FaceRig.apply` leaves `eyeLook*` out of the morphs, so `direct.ts` now
  adds an expression's eye-look channels to the gaze it passes in.
- **Determined:** brows fully down, eyes narrowed, mouth pressed.
- **Sad:** a little stronger. **Smile** is unchanged.

The mixes are shared, so the stock and every directed piece act the same
way; the stock read only a smile before (3 of 7) and has no brows to show.
The base's `browDown` gain went from 1.3 to 2.6 (12.1 to 23.9 mm), because
determined barely moved the brows at card size. The audition still passes
79 of 81 rows (the same two misses as above; face box 41.2 device px).

The blind reading at 40 px, three fresh AI readers each round:

| Round | Scores | What read |
|---|---|---|
| 1 | 1, 3, 4 of 7 | smile 3 of 3; holding back read as determined, determined as neutral |
| 2 (stronger brows, new holding back) | 2, 1, 4 of 7 | determined 3 of 3; looking down, hopeful and smile mixed up |

**The gate is not met, and the face is the limit.** At 40 px the base's
eyes are a pixel or two and its mouth barely more, while the sheet's eyes
span about half the face and its smile the full jaw. The cues that carry
the sheet (wide or lowered lids, iris position, open mouth) are below what
the card shows on this face. Scaling the eyes further brings back the
glasses ring (clay look, above), and a smaller head fails the face box.
What would meet it is a face made for big eyes: decision 7's option A, a
commission, which is spend and so the owner's. The side-by-side is the
worktree's ignored `output/house-base-2c/mixes-side-by-side.jpg`.

## Physical-device limits

None for slices 0 to 3. Slice 4 inherits the phone brief's pending device
checks. Quick Look playback of a two-avatar authored piece on an iPhone,
and the house base's frame rate in phone capture, are pending the owner.
