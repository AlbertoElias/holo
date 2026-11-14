# Feature brief: Direct, preview and revise a performance

**Lead:** Claude (planning session, 2026-11-13)  
**Status:** Reviewed (approved by the user and design-reviewed against the
code, 2026-11-13; build not started)  
**Layer:** event (the acted body is the hologram's raw material; see
`docs/product/concepts/what-a-hologram-is.md`)

Source: "The part I didn't say", a 12 s two-person poem authored by ChatGPT
(Astra) on 2026-11-13 (production hologram `cmwfkilam0001oeir1gvn495q`,
working files in the ignored `output/platform-poem/` of the
`feature/poem-character-models` worktree), and Astra's own notes on it;
Claude's showcase pieces (`docs/product/concepts/agent-authored-holograms.md`,
IDEA-076); the two mandates in flight, `docs/features/phone-capture.md`
(branch `feature/phone-capture`) and `docs/features/natural-avatar-motion.md`
(branch `feature/natural-avatar-motion`), both drafts; and the user's
direction on avatars (2026-11-13): the shipped avatar is a stand-in found
online; avatars should be expressive, match the hologram's style and what
the author is saying, be personalisable, be able to look like the author,
and come in many design styles.

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
| Fingers | Driven | None | Finger bones present, never keyed |
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
   The styleguide's identity-hue rim stays on every finish.
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
possible as one more avatar source that must pass the audition.

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
samples a GLB into the joint positions it reads. It has no category for an
authored take, so its numbers are reported without a verdict until the
motion owner adds one.

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

### Slice 2: the first house base (runs beside slice 1)

- Two or three style directions as 2D sheets, judged against
  `docs/product/design/styleguide.md`; the soft, rounded pair approved for
  the poem is one. The user picks.
- One base in that style, built for expression: readable eyes, brows and
  mouth, good hands, and real shapes for the face channels.
- Identity parameters (proportions, face shape, hair, clothing, colours)
  set by hand, enough to make the poem's two characters from one base.
  They are applied when a character is built and baked into its mesh and
  rest pose, one avatar file per character. Bones are never scaled:
  `retargetClips.ts` rejects a rig with uneven scale.
- It passes the audition and the motion owner's report before anything
  uses it. It loads through `?avatar=` first. Becoming capture's default
  is a later, separate step: change `DEFAULT_AVATAR_URL` only, when the
  motion owner agrees its numbers hold, and leave `avatar.glb` in place.
  The fixtures, the locomotion library, the face build, `doctor` and the
  viewer and API tests all read that file. Its download size is checked
  against the phone journey first (the phone brief measured 2.3 MB of
  avatar and scene load).

### Slice 3: the six-second test

The goodbye, two takes on the same two house characters (one flat, one
directed), shown muted and without the verse; then the same question after
orbiting.

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

### Slice 5: likeness and a second finish

The identity card read from a selfie and applied to the house base, as a
one-time setup outside the phone journey's two minutes; and one second
finish on the same base, to prove a piece can be re-dressed.

### Later, each against the audition

A second family; an imported style (a VRM) as a first-class choice;
reconstruction from images (Astra's local path) as an avatar source.

## How this lines up with the mandates

| Session | It owns | This brief touches | This brief needs from it |
|---|---|---|---|
| Phone capture mandate | The journey: Record, post grant, selfie mode, share | None of its files | Nothing until slice 4. Slice 2 gives it an expressive default avatar and slice 5 "an avatar that looks like you", both of which its "want to send" needs and its brief excludes |
| Natural avatar motion (motion owner) | Driving, IK, retargeting, smoothing, `motion-quality.ts`, the camera driver | Imports its solving modules and the instrument; edits none of its files | Notice when the instrument is on `main`; a category for authored takes in it, or agreement that their numbers carry no verdict; its report run on the house base before that becomes the default; notice when `?input=camera` is on `main`; at slice 4, whether a recording can keep raw face channels and hand goals |

The mandates come first. Slices 0 to 3 add scripts under
`apps/capture/scripts/` and avatar files; they change no file either
session owns.

## Scope

**Included:** slices 0 to 3; slice 4 once camera driving is on `main`;
slice 5 after slice 3 passes.  
**Excluded:** an avatar editor in the app; more than one family and two
finishes; synthesized speech; a prompt box in the app; an MCP tool (the CLI
comes first); more local image-to-3D work; changing the published GLB's
format; an all-hologram regression corpus.

## Undo

None: this adds no authoring action inside a capture take.

## Acceptance criteria

- [ ] The acting report runs on the three baselines and reproduces the
  poem's result (8 of 102 channels, last change at 4.0 s, no face).
- [ ] The audition report runs on the stock avatar and the house base, and
  names what each cannot express.
- [ ] The house base passes every audition item and the motion owner's
  report, and the poem's two characters are made from it by parameters
  alone, with no scaled bones.
- [ ] One beat sheet, solved on two different avatars, plays in
  `viewer-web` with face shapes and fingers moving (weights read back from
  the GLB), and a hand that stops short of a target stops at the same
  distance on both.
- [ ] A published authored piece says in its file that it was authored,
  and the viewer's framing and hand traces follow its first performer.
- [ ] The six-second test: fresh critics shown only the muted directed take
  name the hesitation; the flat take scores lower; the owner's verdict is
  recorded. Orbiting is tested as a second question.
- [ ] Revising one beat changes only that span in the report, and rebuilds
  in under 30 s.
- [ ] A second agent (Astra) authors a take using only the CLI and its
  README.
- [ ] Authored pieces stay within the Quick Look extent budget (B-057) and
  the hologram size budgets with two house characters on stage, and
  `check_usdz_tools.sh` passes on the two-character piece.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Direction becomes a second solver that disagrees with capture's | Import capture's arm, leg, face and locomotion solving unchanged; only hand shapes, weight shifts and steps are new; the report runs on both |
| The viewer picks the wrong performer in a two-character piece | The first performer is named `RecordedAvatar` and is the only one declared; the pipeline check reads the anchors back |
| A directed take passes for a recording | The file is marked as authored (principle 7 of `what-a-hologram-is.md`) |
| The avatar work grows into a character creator before one character is good | One family and one finish until the audition and the six-second test pass on it |
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
audition scripts, the house base's source and its exported avatar file, and
this brief. Not owned here: `apps/capture/src/**`, the viewer and the API.

## Open decisions for the user

1. **House style:** picked from the slice 2 sheets. Nothing to answer
   until they exist.
2. **Does the house base wait for the early reading?** The design review
   would build it only if the slice 1 reading shows the stock face is the
   limit. This brief keeps it beside slice 1 (recommended), because the
   stock avatar is a stand-in whatever the reading says and the phone
   mandate needs an avatar worth sending. Waiting saves the work only if
   the stand-in turns out to be good enough to keep.

Decided on 2026-11-13: Astra draws the style sheets; Astra authors a second
take with the CLI; the build starts after the user has answered the two
mandate briefs.

## Test plan and evidence

- The acting and audition reports on their baselines (numeric, saved as
  JSON).
- One pipeline check: a directed take on two avatars through upload and
  render, with the stop-short distance and the viewer's anchors read back.
- `check_usdz_tools.sh` by hand on the two-character piece.
- The six-second test's critic answers and the owner's verdict.
- Proof video under ignored `output/`.

## Physical-device limits

None for slices 0 to 3. Slice 4 inherits the phone brief's pending device
checks. Quick Look playback of a two-avatar authored piece on an iPhone,
and the house base's frame rate in phone capture, are pending the owner.
