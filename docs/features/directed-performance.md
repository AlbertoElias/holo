# Feature brief: Direct, preview and revise a performance

**Lead:** Claude (planning session, 2026-11-13)  
**Status:** Draft (awaiting the user's approval, 2026-11-13)
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
| Face | 52 ARKit channels, driven; the shapes were synthesized because no licensed expressive avatar was found (`archive/avatar-face.md`) | None | None (0 meshes with morph targets) |
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

### One take format, three drivers

A take is animation on canonical bones and face channels, which is what
capture already exports (`HOLOIM_humanoid`, the 52 ARKit names). A person
drives it through the phone camera or a headset (the mandates); an agent
drives it through direction (this brief). All three produce the same take.

### An avatar is anything that passes the audition

What an avatar must *do* is fixed; how it *looks* is free. Any avatar, from
any source, plays one short audition take (blink, smile, frown, surprise,
look around, grip, point, wave, turn, walk) and gets a report of what reads
on it. This extends the resolver's binding report (`HumanoidSkeleton.ts`:
missing bones, disabled features) from "does it bind" to "can it act". An
imported VRM, a house character and a generated mesh face the same bar,
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

### Each avatar declares how it expresses

The captured signal stays the 52 face channels. An avatar declares how it
shows them (shapes, bones, swapped face textures) and how much it
exaggerates: a cartoon amplifies, a minimal face reduces them to a few.

Two consequences:

- **The performance is kept apart from the look.** Today a take is baked
  into one avatar. Authoring keeps the canonical take beside the baked
  GLB so a piece can be re-dressed; the published GLB is unchanged.
- **Retargeting is by goals, not joint angles.** "Her hand stops 18 cm
  short of his sleeve" must survive a change in arm length, so hand and
  gaze targets are stored relative to what they aim at.
  `apps/capture/src/animation/retargetClips.ts` moves clips by rotation
  today; that is enough for locomotion, not for contact.

### Generate what does not act; build what does

Hair, clothing, textures and palette can be generated from an approved 2D
sheet. The face and hands are built once per family, by hand, to pass the
audition. The poem's reconstruction lost detail exactly in the face and
hands.

### Rejected

More image-to-3D engineering before the acting loop exists (it improves
the part that was not the weak link); a cast that lives only in Blender (a
fourth body system); judging the acting on the stock avatar (its face is a
stand-in, so a failed test would not say whether the direction or the face
failed); a character creator before one character is good; replaying agent
input through the live capture runtime (real time only, limited to what a
tracker reports, no two-character scenes). The last is for the design
review to confirm: direction that writes tracks directly must reuse
capture's arm and finger solving where it can, or it becomes a second
solver that drifts.

## Slices

Each ends with the reports re-run and a proof video.

### Slice 0: the acting report and the audition

A script that reads any hologram GLB, authored or captured, and reports per
performer: which bones and face channels move and when, frozen spans,
whether fingers, face and eyes ever move, and, on a humanoid rig, the feet
and jitter numbers from the motion owner's instrument. Baselines: the poem,
"The way down II" and one captured take. The audition take and its report
are built here and run on the stock avatar as the first baseline.

### Slice 1: direction (the agent as driver)

A Node authoring module beside `apps/capture/scripts/showcase/` that loads
avatars and offers direction, not raw keys: look at a target, an expression
and its strength, reach with a hand toward a target and stop short by a
distance, hand shape and grip, shift weight, turn, step, wave. Each has
timing (anticipation, hold, settle), and breath, blinks, eye movement and
finger settle run underneath so a performer is never frozen. A take is a
beat sheet as data; changing one beat rebuilds in seconds and the report
shows what changed. A CLI wraps it so any agent can author. Built against
the stock avatar as a stand-in; no verdict on the acting is taken there.

### Slice 2: the first house base (runs beside slice 1)

- Two or three style directions as 2D sheets, judged against
  `docs/product/design/styleguide.md`; the soft, rounded pair approved for
  the poem is one. The user picks.
- One base in that style, built for expression: readable eyes, brows and
  mouth, good hands, its own declared expression map and exaggeration.
- Identity parameters (proportions, face shape, hair, clothing, colours)
  set by hand, enough to make the poem's two characters from one base.
- It passes the audition and the motion owner's report before anything
  uses it. It loads through `?avatar=` first and becomes capture's default
  only when the motion owner agrees its numbers hold.

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
| Natural avatar motion (motion owner) | Driving, IK, retargeting, smoothing, `motion-quality.ts`, the camera driver | Reads the instrument; edits none of its files | The instrument accepting a GLB take; its report run on the house base before that becomes the default (its fixtures are generated from the shipped rig); goal-based retargeting agreed with it, since it owns retargeting; notice when `?input=camera` is on `main` |

The mandates come first. Slices 0 to 3 add scripts under
`apps/capture/scripts/` and one avatar file; they change no file either
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
- [ ] The audition report runs on the stock avatar, the house base and one
  imported VRM, and names what each cannot express.
- [ ] The house base passes every audition item and the motion owner's
  report, and the poem's two characters are made from it by parameters
  alone.
- [ ] One take plays on two different avatars in `viewer-web`, with face
  channels and fingers moving (weights read back from the GLB), and a hand
  that stops short of a target stops at the same distance on both.
- [ ] The six-second test: fresh critics shown only the muted directed take
  name the hesitation; the flat take scores lower; the owner's verdict is
  recorded. Orbiting is tested as a second question.
- [ ] Revising one beat changes only that span in the report, and rebuilds
  in under 30 s.
- [ ] A second agent (Astra) authors a take using only the CLI and its
  README.
- [ ] Authored pieces stay within the Quick Look extent budget (B-057) and
  the hologram size budgets with two house characters on stage.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Direction becomes a second solver that disagrees with capture's | Reuse capture's solving modules where they are three.js only; the report runs on both |
| The avatar work grows into a character creator before one character is good | One family and one finish until the audition and the six-second test pass on it |
| The house base changes the motion owner's numbers or breaks fixtures generated from the shipped rig | `?avatar=` only until its report passes; the stock avatar stays in the repo for the fixtures |
| A stylised face cannot show a tracked channel | The avatar's declared map says so; the audition report lists it; the driver reduces rather than drops |
| Rotation retargeting loses a contact when proportions change | Hand and gaze goals stored relative to their targets; the stop-short criterion checks it |
| Always-on life (blinks, breath) reads as noise, not intent | Amplitudes taken from a person's take in slice 4; critics compare with and without |
| Critics share the author's blind spots | The final verdicts are the owner's and a different vendor's |
| Two skinned avatars exceed size or Quick Look budgets | The build already measures moving vertices × frames; check before upload |
| Generated hair or clothing clips through the body in motion | The audition includes the turn and the reach; parts that fail are rebuilt or dropped |
| A likeness the person did not agree to | The identity card is made only from the author's own photo, kept local, never from a third party's |

## Ownership

One lead owns `apps/capture/scripts/authoring/` (new), the report and
audition scripts, the house base's source and its exported avatar file, and
this brief. Not owned here: `apps/capture/src/**`, the viewer and the API.

## Open decisions for the user

1. **House style:** picked from the slice 2 sheets. Nothing to answer
   until they exist.
2. **Who draws the sheets:** Astra, who made the pair you approved
   (recommended), or Claude.
3. **Second author:** Astra authors a take with the CLI as the proof that
   it is common to agents (recommended), or Claude only.
4. **When:** after you have answered the two mandate briefs
   (recommended), or now in parallel.

## Test plan and evidence

- The acting and audition reports on their baselines (numeric, saved as
  JSON).
- One pipeline check: a directed take on two avatars through upload and
  render, with the stop-short distance read back.
- The six-second test's critic answers and the owner's verdict.
- Proof video under ignored `output/`.

## Physical-device limits

None for slices 0 to 3. Slice 4 inherits the phone brief's pending device
checks. Quick Look playback of a two-avatar authored piece on an iPhone,
and the house base's frame rate in phone capture, are pending the owner.
