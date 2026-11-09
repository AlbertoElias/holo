# PRD: Hand traces (hand-path ribbons)

**Status:** Approved (v1, author-marked traces, 2026-11-09); v0 approved 2026-10-28 and shipped 2026-10-29  
**Source ideas:** IDEA-033  
**Layer:** Meaning (added: the author marks the span, the body draws the path)  
**Depends on:** v0 hand traces (shipped), hand-tracking fidelity (verifying), PRD-022 meaning record (approved), the Halo (styleguide 6.2)  
**Owner:** Alberto Elias  
**Last updated:** 2026-11-09

**Name.** The idea was called "hand-path ribbons", but the
[design language](../concepts/design-language.md) already calls the timeline
strip the Ribbon. In the product and code this mark is a **hand trace**.

## Why this amendment

v0 put the decision in the wrong place. A viewer control chose whether to show
the hands' last 3 s, so the viewer had to guess which motion was the
demonstration, and every card with tracked hands carried one more control.
Which motion matters is meaning, and the lens gives meaning to the author:
the viewer's controls change how they see the event, never what matters in
it. v1 lets the author mark a trace while recording, stores it in the
hologram, and replays it with the message. It also removes v0's hardest open
problem: telling a demonstration from ordinary gesturing no longer has to be
guessed.

## User Outcome

Before: when the author demonstrates a motion (a twist, a sweep, an arc, "this
big, this way round"), a recipient sees it once from one angle. They cannot
read its depth, size or direction, so they replay it and still copy it wrong.
After: while recording, the author turns on Trace, demonstrates, and turns it
off. In playback, the motion draws itself in the air at true size as the hand
moves, and stays there. The recipient sees the whole shape, orbits it in the
portal to read its depth, and copies it correctly, without knowing to pause
or where to look.

## Problem

Showing how to move is one of the main things people will use holograms for
("swing like this", "turn it this way"). In video, motion blurs, depth is
lost, and the camera angle hides one axis. A hologram already stores the hand's
path in 3D at true scale, but playback shows only one instant of it at a time,
and only the author knows which stretch of motion was the lesson.

## Primary User And Moment

- **Author:** someone in a headset with tracked hands, about to demonstrate a
  movement. They spend two quick gestures: Trace on before, Trace off after.
- **Recipient:** someone watching in the feed portal on a phone or desktop,
  who will repeat the movement. The moment: the trace draws in as the author
  moves; they can pause and orbit it afterwards.

## Proposed Interaction (v1)

### Capturing

- **Trace is the Halo's Ink direction (NW).** The Halo's eight directions are
  fixed on every device (styleguide 6.2), and capture leaves Ink empty today.
  Inking with your hand in the air is a trace, so Ink is where it belongs: no
  new control and no new place. While recording, Ink toggles tracing on; Ink
  again, or stopping the take, toggles it off.
- **Both hands, while it is on.** A hand that stays still (under 5 cm of
  spatial extent across the span) draws nothing, so the author does not have
  to say which hand. The span starts and ends with the toggles; the Halo
  gesture that turns it on or off is not itself traced.
- **What the author sees.** The status line says "Tracing" with its time
  while it is on, and the trace draws live behind each moving fingertip, so
  the author can see the shape they are leaving and redo it.
- **Undo.** The Halo's Undo (W) removes the last trace, as it removes the last
  held mark today; Redo (E) restores it.
- **Which takes.** Headset takes with tracked hands. Only frames inside the
  recorded hand spans that v0 already writes (`xr-hand` frames, hands not in a
  menu) are drawn, so a switch to controllers or a tracking dropout leaves a
  gap rather than a made-up path. Desktop takes have no tracked hands and get
  no Ink in v1. A phone-camera take has no hands; tracing the camera's own
  path is a separate idea.

### Stored in the hologram

A trace is a mark in the `HOLOIM_meaning` record:

- **kind:** `trace`.
- **anchor:** the fingertip it follows, per hand, as a humanoid bone, the
  same form as a pointing link's `from`.
- **span:** start and end in recording time.
- **provenance:** `recorded`. The author chose the span; the path is the
  recorded motion.

The path itself is not stored: the viewer reads it from the recorded motion,
as v0 does, so it cannot drift from the avatar and adds no size to the file.
`trace` is a new kind, so a take with a trace writes version 2 of the record;
takes without one keep writing the lowest version that fits (v0 or v1).
Viewers that predate v2 ignore the record and play the event unchanged.

### Viewing

- **Playing:** each trace draws in as the hand moves through its span, with
  its original timing, and stays drawn after the span ends until the take
  loops. The look is v0's ribbon: thin, tapering toward the oldest end,
  never gold, never hollow, in the plain style of a recorded mark (styleguide
  1.1 and 4).
- **Paused:** every trace drawn so far stays. The portal's orbit shows it from
  any side at true scale.
- **No viewer control.** The Traces control from v0 is removed, and so is the
  automatic 3 s window on pause. What is not traced is not drawn.
- **Older takes.** Takes recorded before v1 have no trace marks and show no
  traces. The two test takes on the live feed are exports of this kind and
  will show none; they are replaced by takes recorded with Ink.

## Why Holograms

A video can draw a motion trail from one angle only, and its depth is a
guess. A hologram holds the hand's 3D path at true scale, so the trace can be
seen from the side and measured against the body. Fair comparison: the same
hologram in the same portal without traces, and a video of the take.

- **Anchored to the event:** the path of a body part over a span of time.
- **Read from the body:** the path is the recorded motion; the author only
  says which stretch matters, which the body cannot say on its own.
- **Intent, not a view:** "this motion is the lesson"; each device frames it.
- **Works on a flat phone:** the trace draws in during playback, and the
  taper shows direction without orbiting.
- **Lost as a video:** the 3D path at true scale.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset capture | "Tracing" in the status line; the trace draws live behind the fingertips | Halo Ink (NW) toggles; Undo removes the last trace |
| Desktop capture | No Ink in v1 (no tracked hands) | None |
| Phone portal | Each trace draws in with its original timing and stays; visible from any orbit | None (orbit while paused) |
| Desktop | Same | Same |
| Headset (VR or AR) viewing | Later: the same trace at true scale, walkable | Later |
| Still image or Quick Look | Later: baked into a still; dropped in Quick Look | None |

## In Scope

- [ ] Ink (Halo NW) in headset capture toggles tracing while recording; it
  ends on Ink again or on stop; Undo and Redo apply to traces.
- [ ] "Tracing" in the status line and the live trace while recording.
- [ ] `trace` marks in `HOLOIM_meaning` version 2, written only when a take
  has a trace, with `recorded` provenance.
- [ ] Viewer playback: traces draw in with their original timing and stay
  while paused, inside recorded hand spans only, still hands suppressed.
- [ ] Removing v0's Traces control, its paused 3 s window, and the styleguide
  row for the control.
- [ ] End-to-end checks: an IWER-scripted headset take that turns Ink on,
  draws a 30 cm circle, turns it off, then draws a figure-eight untraced;
  exported, uploaded and played in the feed, with a numeric report and
  screenshots. Replace the two live test takes with this kind of take.

## Out Of Scope

- [ ] Choosing or trimming a trace after the take (review on the time ribbon).
- [ ] Voice as a trigger ("watch this").
- [ ] Detecting demonstrations automatically (v0's slice 2 is dropped).
- [ ] Desktop and controller traces; tracing a phone camera's path.
- [ ] Traces in the headset viewer, immersive AR, stills and Quick Look.
- [ ] Cleaned or simplified shapes (IDEA-004); comparing the viewer's own
  motion (IDEA-040, parked).
- [ ] Speed encoding along a finished trace.

## Success Signals

- [ ] **Technical, marking:** on the scripted take, exactly one trace per
  moving hand is stored, its span within one frame of the Ink toggles; the
  untraced figure-eight leaves no mark and draws nothing.
- [ ] **Technical, fidelity:** every drawn trace point is within 2 mm of the
  fingertip node's world position at the same recording time, and the
  circle's fitted radius matches the avatar fingertip's own circle within
  1 cm.
- [ ] **Technical, timing:** in playback, the trace's drawn end is at the
  fingertip at every frame of its span, and the whole trace stays drawn after
  the span and while paused.
- [ ] **Technical, compatibility:** a take without traces writes the same
  record version as before; a v2 take plays unchanged in a viewer that
  predates v1.
- [ ] **Communication:** in the trial below, recipients copy a demonstrated
  motion more accurately with traces than without.
- [ ] **Authoring:** in the same sessions, authors mark their demonstrations
  with Ink without being reminded after one explanation, and say whether the
  toggle interrupted the demonstration.

## Risks And Open Questions

- [ ] Do authors remember to turn Trace on before demonstrating? If not,
  marking after the take on the time ribbon moves into scope.
- [ ] Does summoning the Halo with the dominant hand right before and after a
  demonstration interrupt it? Watch for it in the trial.
- [ ] Is Ink the right home for a trace, or should Ink stay for drawn marks
  (PRD-005) and Trace take another place? Proposed: Ink is the trace, and a
  later cleaned shape (IDEA-004) is a trace with cleaning applied.
- [ ] The live trace in the headset is the first mark that shows live there
  (slice 5 of the UI redesign said Halo actions only in the status line).
  Check it reads as feedback, not clutter.
- [ ] Fingertip or wrist: fingertip shows sweeps but picks up finger curl.
- [ ] Hand-tracking quality on a physical headset sets the ceiling; jitter
  shows directly as a wobbly trace.

## Comparison And Learning

Task: three real headset takes, each demonstrating one motion (for example a
figure-eight, a twist of a held object, and an arc of a given size and
height), recorded by authors using Ink. At least five recipients on their own
phones each see portal with traces, portal without, and a video, in rotated
order, and copy the motion on camera. Measures: shape, size and direction,
judged from the recording against the original; for authors, whether they
marked the motion and whether the toggle got in the way. Continue (to the
headset viewer and stills) if traces clearly improve accuracy; move marking
into review if authors forget the toggle.

## Decision

v0, approved 2026-10-28 by Alberto Elias and shipped 2026-10-29: the name
"hand trace"; traces of the last 3 s while paused, with an opt-in playing
tail behind a Traces control; the index fingertip; headset takes only; no
stored mark.

v1 amendment, requested 2026-11-09 by Alberto Elias ("if when capturing i
want to generate traces, then they become part of the final hologram"),
approved 2026-11-09 by Alberto Elias as drafted: the author marks traces in
headset capture with the Halo's Ink direction; traces are stored as `recorded`
`trace` marks in `HOLOIM_meaning` v2 and replay with their original timing;
v0's viewer control and paused window are removed; automatic detection
(v0's slice 2) is dropped.

## Links

- Concept: [viewer experience](../concepts/viewer-experience.md),
  [design language](../concepts/design-language.md),
  [what a hologram is](../concepts/what-a-hologram-is.md)
- Design: [styleguide 6.2, the Halo](../design/styleguide.md#62-the-halo)
- Research: [open questions](../research/open-questions.md) (question 4)
- Related PRDs: [PRD-022 self-resolving pointing](PRD-022-self-resolving-pointing.md),
  [PRD-005 gesture-drawn marks](PRD-005-gesture-drawn-marks.md),
  [PRD-002 portal view](PRD-002-portal-view.md),
  [PRD-028 ghost frames](PRD-028-ghost-frames.md)
- Mockups: none
- Feature brief: v0 [hand traces](../../features/archive/hand-traces.md);
  v1 [authored traces](../../features/authored-traces.md)
- Implementation issue: none
