# PRD: Hand traces (hand-path ribbons)

**Status:** Approved  
**Source ideas:** IDEA-033  
**Layer:** Meaning (read)  
**Depends on:** hand-tracking fidelity (verifying), IDEA-045 portal (implementing), PRD-022 meaning record (approved)  
**Owner:** Alberto Elias  
**Last updated:** 2026-10-28

**Name.** The idea was called "hand-path ribbons", but the
[design language](../concepts/design-language.md) already calls the timeline
strip the Ribbon. In the product and code this mark is a **hand trace**.

## User Outcome

Before: when the author demonstrates a motion (a twist, a sweep, an arc, "this
big, this way round"), a recipient sees it once from one angle. They cannot
read its depth, size or direction, so they replay it and still copy it wrong.
After: the recipient pauses, and the path each hand just took hangs in the air
at true size. They orbit it in the phone or desktop portal, see the shape from
the side and how far it reached, then copy the motion correctly. The author
does nothing extra.

## Problem

Showing how to move is one of the main things people will use holograms for
("swing like this", "turn it this way"). In video, motion blurs, depth is
lost, and the camera angle hides one axis. A hologram already stores the hand's
path in 3D at true scale, but playback shows only one instant of it at a time.

## Primary User And Moment

- **Author:** someone in a headset demonstrating a movement with tracked
  hands. They do nothing extra.
- **Recipient:** someone watching through the feed portal on a phone or
  desktop, who will repeat the movement. The moment: they pause right after
  the movement to look at it again.

## Proposed Interaction (v0)

v0 is a deliberately simple experiment. It shows the hands' own recorded path
around the paused moment, with no detection of what counts as a
demonstration. That answers the first open question, whether a trace
clarifies a motion or clutters the scene, before we build detection.

- **Paused:** each hand that moved shows a trace of where it went in the
  **3 s before** the paused moment. The trace is thin and tapers in width and
  opacity toward the oldest end, so direction reads without arrows. The
  paused moment is the solid end, at the hand.
- **Orbit:** the trace is real geometry in the hologram's world, so the
  portal's freeze-and-orbit shows it from any side, at true scale.
- **Playing:** nothing by default. A **Traces** toggle in the card's controls
  also draws a short fading tail (the last 1 s) behind each moving hand during
  playback. It is off by default, to keep the playing feed calm.
- **Which point:** the index fingertip, using the rig's tip bone if it has
  one, otherwise the index distal bone. One trace per hand.
- **What is suppressed:** still hands (path under 5 cm in the window), and
  spans where the body itself is travelling (hips faster than 0.3 m/s),
  so walking does not leave metres of trace.
- **Which takes:** headset takes with tracked hands only. Desktop takes move
  the arms by IK and procedural swing, which is not a demonstration, so they
  show no traces in v0.

### Where the data comes from

The trace is the hand's motion itself, so v0 stores nothing new. The viewer
samples the fingertip node's world position from the exported animation
(`RecordedMotion`, sampled every capture frame) over the window, and draws
that. Older exports get traces as soon as the viewer ships, if they are
headset takes.

A take has to say whether its hands were tracked. If no existing field records
this, capture adds a single take-level input-source flag to the `HOLOIM_meaning`
record (PRD-022's extension) or `HOLOIM_humanoid`. Older takes that lack the
flag show no traces. Which of the two belongs in the brief.

### Provenance and look

A trace is read from the body, so it uses the inferred style of the Ink
material (styleguide 1.1 and 4): the same hue as pointing highlights until
identity hues land, and lighter than recorded marks. It is never gold and
never hollow. The path itself is recorded data; only the choice to show it is
inferred, and v0 has no confidence to show.

### Slice 2, not part of this approval

Stored, detected demonstration spans: a `trace` mark kind in `HOLOIM_meaning`
with a span, a hand anchor and inferred provenance with confidence. Detection
would use deliberate motion relative to the body and, later, speech that
refers to motion. Traces would then show during playback at those spans
without a toggle. Whether to build slice 2 depends on the v0 trial.

## Why Holograms

A video can draw a motion trail from one angle only, and its depth is a
guess. A hologram holds the hand's 3D path at true scale, so the trace can be
seen from the side and measured against the body. Fair comparison: the same
hologram in the same portal without traces, and a video of the take.

- **Anchored to the event:** the path of a body part over a span of time.
- **Read from the body:** the trace is the recorded motion. No authoring.
- **Intent, not a view:** it shows the motion; each device frames it.
- **Works on a flat phone:** a paused trace gives depth when orbited, and the
  taper shows direction even without orbiting.
- **Lost as a video:** the 3D path at true scale.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Phone portal | Trace of the last 3 s while paused; optional 1 s tail while playing | Traces toggle; orbit while paused |
| Desktop | Same | Same |
| Headset (VR or AR) | Later: the same trace at true scale, walkable (v0 plays the event without traces) | Later |
| Still image or Quick Look | Later: baked into a still; dropped in Quick Look | None |

## In Scope

- [ ] Sampling each hand's fingertip path from the exported animation in the
  viewer, with the stillness and travelling suppression above.
- [ ] Trace rendering in the feed portal on phone and desktop, in the Ink
  inferred style, while paused, with a Traces toggle that adds the playing
  tail.
- [ ] A take-level "hands were tracked" signal, if none exists, so desktop and
  older unknown takes show nothing.
- [ ] An end-to-end check: an IWER-scripted headset take that draws a known
  shape (a 30 cm circle and a figure-eight at chest height), exported and
  uploaded through the real pipeline, then paused and orbited in the feed
  portal, with screenshots and a numeric report.
- [ ] The same run on the real headset fixture
  (`headset-open-fist-pinch-point-wave-reach.json`), to see what ordinary
  gesturing looks like.

## Out Of Scope

- [ ] Detection of demonstration spans and a stored `trace` mark (slice 2).
- [ ] Traces in the headset viewer, immersive AR, stills and Quick Look.
- [ ] Desktop-take traces; controller traces.
- [ ] Cleaned or simplified shapes (IDEA-004); comparing the viewer's own
  motion (IDEA-040, parked).
- [ ] Speed encoding along the trace (for example spacing or ticks for
  timing). The tail during playback carries speed; a paused trace does not.

## Success Signals

- [ ] **Technical, fidelity:** every drawn trace point is within 2 mm of the
  fingertip node's world position at the same recording time (the trace is
  the recorded data, so the only error is sampling). On the scripted take,
  the drawn circle's fitted radius is 30 cm ± 1 cm at the hologram's true
  scale.
- [ ] **Technical, suppression:** the walking replay fixture shows no traces
  while the author travels. The scripted take shows exactly the two scripted
  shapes and no trace while the hands are still.
- [ ] **Technical, cost:** pausing a phone-sized portal card with two traces
  adds under 1 ms of frame time on the desktop e2e run.
- [ ] **Communication:** in the trial below, recipients copy a demonstrated
  motion more accurately with traces than without.
- [ ] **Clutter (the open question):** in the same trial, ask after each task
  whether a trace got in the way. If traces from ordinary gesturing confuse
  people, build slice 2 detection before anything else. If nobody minds, keep
  the simple window.

## Risks And Open Questions

- [ ] When does a trace clarify a motion, and when is it clutter? v0 answers
  this before we invest in detection.
- [ ] Is a fixed 3 s window right? A slow demonstration may be longer, and a
  quick one gets mixed with the gesture before it.
- [ ] Fingertip or wrist: fingertip shows sweeps but picks up finger curl. If
  the real fixture's traces look noisy, compare against the hand (wrist) bone.
- [ ] Hand-tracking quality on a physical headset sets the ceiling. Jitter
  shows up directly as a wobbly trace; emulation cannot answer this.
- [ ] Only one real headset recording exists, and it is not a demonstration.
  The trial needs new headset takes of real demonstrations.

## Comparison And Learning

Task: three real headset takes, each demonstrating one motion (for example a
figure-eight, a twist of a held object, and an arc of a given size and
height). At least five recipients on their own phones each see portal with
traces, portal without, and a video, in rotated order. They copy the motion
on camera. Measures: shape, size and direction, judged from the recording
against the original, plus the clutter question above. Continue (to slice 2
or the headset) if traces clearly improve accuracy. Park if clutter outweighs
the gain.

## Decision

Approved 2026-10-28 by Alberto Elias, as drafted: the name "hand trace";
v0 shows traces while paused, with an opt-in playing tail behind the Traces
toggle; a 3 s window; the index fingertip; headset takes only; and no stored
mark until slice 2, which needs its own decision after the v0 trial.

## Links

- Concept: [viewer experience](../concepts/viewer-experience.md),
  [design language](../concepts/design-language.md),
  [what a hologram is](../concepts/what-a-hologram-is.md)
- Research: [open questions](../research/open-questions.md) (question 4)
- Related PRDs: [PRD-022 self-resolving pointing](PRD-022-self-resolving-pointing.md),
  [PRD-002 portal view](PRD-002-portal-view.md),
  [PRD-028 ghost frames](PRD-028-ghost-frames.md)
- Mockups: none
- Feature brief: [hand traces](../../features/hand-traces.md)
- Implementation issue: none
