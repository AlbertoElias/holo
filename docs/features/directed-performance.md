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
IDEA-076); and the two mandates in flight: `docs/features/phone-capture.md`
(branch `feature/phone-capture`) and `docs/features/natural-avatar-motion.md`
(branch `feature/natural-avatar-motion`), both drafts.

## User outcome

An author, a person or an agent, makes an acted scene from a short brief.
The characters come from a cast whose faces, fingers and bodies already
work. The acting is a take that can be previewed, graded and revised one
beat at a time. The take can come from an agent's direction, from the
owner's own phone recording, or from both.

First proof: six seconds of the poem's goodbye in which a viewer
understands "she wants him to stay, but stops herself" before reading the
verse, and understands it better after walking around the pair.

## Measured today (2026-11-13)

Bodies are made three different ways, and no two share anything.

| | Capture avatar | Claude's showcase figures | Astra's poem |
|---|---|---|---|
| Body | Shipped avatar, or any humanoid the resolver binds (`?avatar=<url>`) | Jointed primitives rebuilt per scene (`showcase/introspection/figures.mjs`) | Two meshes reconstructed from images (TRELLIS), simple Blender rigs |
| Face | 52 ARKit channels, driven | None | None (0 meshes with morph targets) |
| Fingers | Driven | None | Finger bones present, never keyed |
| Acting comes from | Headset, desktop, phone camera (spike, unmerged) | Pose keys written by hand per scene (`introspection2/acting.mjs`, 22 KB for one piece) | 8 of 102 animation channels change; the last change is at 4.0 s of 12.0 s |
| Looks | One stock character | Stylised primitives | Custom and recognisable at scene scale, soft up close (hands, hair, surface) |
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
4. **The phone mandate and agent authoring need the same two things:** a
   body that reads as a person, and a character that reads as *that*
   person. The phone brief's "want to send" fails on the second today (a
   stock avatar) and excludes fixing it.

## Design decision: one cast, one take format, three drivers

- **Cast.** An avatar that binds through the existing humanoid resolver
  (`@holoim/meaning`), with the 52 ARKit face channels and fingers. The
  shipped avatar is the first member.
- **Take.** Animation on those canonical bones and channels, which is what
  capture already exports (`HOLOIM_humanoid`). A take is not tied to a
  character: `apps/capture/src/animation/retargetClips.ts` already moves
  clips between humanoid rigs.
- **Drivers.** A person through the phone camera or a headset (the
  mandates), or an agent through direction (this brief). All three produce
  the same take.
- **Looks are a separate input.** A new character joins the cast when the
  same take holds up on it at viewer zoom.

This keeps Astra's loop (brief → character and motion inputs → editable
take → viewer review → targeted revision) and changes three things in it:
the reusable cast is the capture rig, not a new Blender cast, so everything
the mandates build improves authored pieces too; the performed reference
moves from last to second, because it is the phone mandate's output; and a
numeric gate runs before anyone watches.

Rejected: more image-to-3D engineering before the acting loop exists (it
improves the part that was not the weak link); a cast that lives only in
Blender (a fourth body system); replaying agent input through the live
capture runtime (real time only, limited to what a tracker reports, no
two-character scenes). The last one is for the design review to confirm:
direction that writes tracks directly must reuse capture's arm and finger
solving where it can, or it becomes a second solver that drifts.

## Slices

Each ends with the acting report re-run and a proof video.

### Slice 0: the acting report

A script that reads any hologram GLB, authored or captured, and reports per
performer: which bones and face channels move and when, frozen spans,
whether fingers, face and eyes ever move, and, on a humanoid rig, the feet
and jitter numbers from the motion owner's instrument. Baselines: the poem,
"The way down II" and one captured take. The showcase build fails a piece
whose performer is still for longer than its beat sheet's marked holds.

### Slice 1: direct the cast (the agent as driver)

A Node authoring module beside `apps/capture/scripts/showcase/` that loads
cast members and offers direction, not raw keys: look at a target, an
expression and its strength, reach with a hand toward a target and stop
short by a distance, hand shape and grip, shift weight, turn, step, wave.
Each has timing (anticipation, hold, settle), and breath, blinks, eye
movement and finger settle run underneath so a performer is never frozen.
A take is a beat sheet as data; changing one beat rebuilds in seconds and
the report shows what changed. A CLI wraps it so any agent can author.

Test: the six-second goodbye, two takes on the same two cast members (one
flat, one directed), shown muted and without the verse.

### Slice 2: a person's take as input (joins the phone mandate)

Starts only when the motion owner lands camera driving on `main` behind
`?input=camera`. The owner acts the reach on a phone; that capture take is
imported, played on any cast member, and edited by beat (retime, lengthen
a hold, redirect a look). A two-person scene is two takes (IDEA-084). The
same report on the person's take and the agent's take shows how much
hesitation, weight and timing the agent produces on its own.

### Slice 3: a character that looks like someone (time-boxed experiment)

The bar is fixed before any candidate runs: the slice 1 take on the new
character, at viewer zoom, with a blink, a grip and a body turn holding
up, a clean binding report, and within the hologram budgets. Two
candidates against that bar: (a) a parametric rigged base dressed from an
approved 2D sheet (hair, clothing, colours, face shape), tool to be chosen
in the experiment; (b) Astra's local reconstruction fitted onto the cast
rig. The winner is also how a phone author gets an avatar that looks like
them, as a one-time setup outside the two minutes.

## How this lines up with the mandates

| Session | It owns | This brief touches | This brief needs from it |
|---|---|---|---|
| Phone capture mandate | The journey: Record, post grant, selfie mode, share | None of its files | Nothing until slice 2; slice 3 later offers "an avatar that looks like you", which that brief excludes |
| Natural avatar motion (motion owner) | Driving, IK, retargeting, smoothing, `motion-quality.ts`, the camera driver | Reads the instrument; edits none of its files | The instrument accepting a GLB take (to agree); notice when `?input=camera` is on `main` |

The mandates come first. Slices 0 and 1 are scripts under
`apps/capture/scripts/` and share no files with either session.

## Scope

**Included:** slices 0 and 1; slice 2 once camera driving is on `main`;
slice 3 as an experiment with a fixed bar.  
**Excluded:** synthesized speech; a prompt box in the app; an MCP tool (the
CLI comes first); more local image-to-3D work outside slice 3; an
all-hologram regression corpus.

## Undo

None: this adds no authoring action inside a capture take.

## Acceptance criteria

- [ ] The acting report runs on the three baselines and reproduces the
  poem's result (8 of 102 channels, last change at 4.0 s, no face).
- [ ] One take plays on two different cast members in `viewer-web`, with
  face channels and fingers moving (weights read back from the GLB).
- [ ] The six-second test: fresh critics shown only the muted directed take
  name the hesitation; the flat take scores lower; the owner's verdict is
  recorded. Orbiting is tested as a second question.
- [ ] Revising one beat changes only that span in the report, and rebuilds
  in under 30 s.
- [ ] A second agent (Astra) authors a take using only the CLI and its
  README.
- [ ] Authored pieces stay within the Quick Look extent budget (B-057).

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Direction becomes a second solver that disagrees with capture's | Reuse capture's solving modules where they are three.js only; the report runs on both |
| Always-on life (blinks, breath) reads as noise, not intent | Amplitudes taken from a person's take in slice 2; critics compare with and without |
| Critics share the author's blind spots | The final verdicts are the owner's and a different vendor's |
| Two skinned avatars exceed size or Quick Look budgets | The build already measures moving vertices × frames; check before upload |
| The shipped avatar may not be licensed for republished authored pieces, or there is no second character | Open decision 2; confirm the licence before upload |
| A captured take has tracker dropouts that retarget badly | Slice 2 imports only after the motion owner's guard passes on that take |

## Ownership

One lead owns `apps/capture/scripts/authoring/` (new), the report script
and this brief. Not owned here: `apps/capture/src/**`, the viewer and the
API.

## Open decisions for the user

1. **Order:** acting on the shared rig first (recommended), or character
   generation first.
2. **Cast for the test:** the stock avatar twice, restyled (recommended:
   the test is about acting), or wait for the soft, rounded pair you
   approved for the poem.
3. **Second author:** Astra authors a take with the CLI as the proof that
   it is common to agents (recommended), or Claude only.
4. **When:** after you have answered the two mandate briefs
   (recommended), or now in parallel.

## Test plan and evidence

- The acting report on the baselines (numeric, saved as JSON).
- One pipeline check: a directed take on two cast members through upload
  and render.
- The six-second test's critic answers and the owner's verdict.
- Proof video under ignored `output/`.

## Physical-device limits

None for slices 0 and 1. Slice 2 inherits the phone brief's pending device
checks. Quick Look playback of a two-avatar authored piece on an iPhone is
pending the owner.
