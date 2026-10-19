# Hologram Authoring

**Layers:** event (repair), meaning (confirm and add). Not the view.

## Hypothesis

Creators shape a message by performing it, then repairing the event and
confirming or adding meaning. The authoring model should preserve the
spontaneity of embodied performance while allowing repair, clarity, and
composition. Authors never set the camera: they express where attention should
go, and each viewer's device decides how to show it.

## Seeds in Scope

- IDEA-020 Multi-take ghost overlay
- IDEA-021 Segment retakes
- IDEA-022 Message-first editor
- IDEA-023 Clarity co-director
- IDEA-028 Embodied rhetoric
- IDEA-035 "Stand here" viewpoint markers

## Authoring Lanes

| Lane | Layer | Holds |
| --- | --- | --- |
| Performance | Event | Body, face, hands, gaze |
| Voice | Event | Live voice, narration, silence |
| Environment | Event | Scene bubble, physical context, props |
| Marks | Meaning | Links read from the body, symbols, notes, anchors |
| Attention | Meaning | Emphasis, suggested viewpoints, recap moments, checkpoints |

There is no camera lane. Pacing, framing, and shots are decided per device at
playback from the attention lane.

Text, images, video, charts, animation, sound, and simulations can become
message content rather than app chrome (IDEA-061). Bind a layer to a useful
place and time, with attribution and a deliberate reveal. The editor model
(IDEA-022) is about manipulating those layers; mixed-media composition is a
separate capability that may begin during the take.

## Product Directions

- Retake only a selected segment and blend it into the surrounding performance.
- Make body, voice, objects, and marks independently editable.
- Right after a take, show what was read from the body (pointing links,
  ribbons, measurements) as suggestions to keep or dismiss.
- Let creators convert a gesture into a clean editable spatial primitive.
- Offer clarity suggestions only where the body did not resolve a reference.
- Show ghosted prior takes to support repeatable demonstrations and choreography.
- Every edit is recorded as provenance, so viewers can tell recorded, inferred,
  and added apart.

## Create While Communicating

IDEA-062 preserves the user's emphasis on doing much of the shaping while
creating: spawn an object, animate or transform it, draw a path, invent a
symbol, or emphasize a relationship without stopping speech. Voice, gesture,
controller actions, and presets are candidates. Avoid accidental commands
being recorded as content or turning natural gestures into unintended marks.
The [IDEA-031 exploration](design-language.md) suggests held modes and a radial
menu; these remain alternatives, not requirements for all authoring.

## How Much Editing Is Needed?

Start by observing real takes. Preview and discard/re-record are the proposed
baseline; trimming is a candidate next step (IDEA-069). If a small mistake
repeatedly ruins a useful message, investigate segment retakes (IDEA-021).
If ambiguous references are the main failure, notes or highlights may help
more than timeline tools. Ghost overlays, overdubs, sequencing/cuts, independent
layers, and motion continuity are possibilities, not a commitment to a full
animation suite. Editing should preserve meaning and make material changes
understandable to recipients.

The recommended [object-explanation experiment](../APPROACH.md) needs prop
motion to survive recording and playback. Static environment capture and
recorded object transformations are different capabilities; inspect the
current exporter before scoping this change.

## Design Tension

The editor must be more expressive than a timeline editor but less demanding
than a full 3D animation suite. The intended user is communicating, not
becoming a technical artist. Reading meaning from the body is what keeps
authoring light.

## Open Questions

- Which edits are valuable enough to justify complex interpolation tools?
- Where should AI make a suggestion versus automatically modify a recording?
- What is the fastest way to give text, images, video, and charts a place in a
  hologram?
