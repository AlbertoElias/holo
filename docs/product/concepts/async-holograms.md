# Async Holograms

**Layers:** view, meaning, conversation.

## Hypothesis

An asynchronous hologram preserves the event of a live explanation, so the
viewer can move through it in time and in space: pause and look around a
moment, follow the author's attention, or explore freely, then respond in
context. It should never behave like a passive clip, including on a phone.

## Seeds in Scope

- IDEA-002 Notes added by the author (PRD-001 parked)
- IDEA-016 Branching holograms
- IDEA-017 Interactive checkpoints
- IDEA-018 Holo Replies
- IDEA-019 Semantic diff
- IDEA-025 Meaning heatmap
- IDEA-029 Conversational memory palace
- IDEA-035 "Stand here" viewpoint markers
- IDEA-037 Proximity notes
- IDEA-038 Ghost frames
- IDEA-044 Object-indexed timeline
- IDEA-045 Portal view

## What Contextual Annotation Means

A contextual annotation binds a message to what it refers to and, when needed,
when it matters. "This wrist rotation is risky" might follow the wrist only
during 00:12-00:15. A note on a machine can stay fixed to a part; a reply can
refer to an event instead of a permanent location. It is more specific than
a caption or an unattached comment thread.

Possible context includes an object, bone, surface point, world region,
recorded event, time span, or physical location. These are alternatives to
evaluate, not an agreed schema. Notes could contain text, speech, media,
symbols, questions, or decisions; [parked PRD-001](../prds/PRD-001-anchored-notes.md)
deliberately proposes only short text notes with space/time anchors.

An annotation can be created while speaking, added in review, or left by a
recipient. The placement workflow and authorship rules differ; the parked PRD
chooses upload-time authoring as a proposal and excludes replies. Automatic
pointing highlights, hand traces, viewpoints, and proximity notes are separate
[viewer explorations](viewer-experience.md), not implicit PRD scope.

## Product Directions

- Viewing is two kinds of navigation: through time (play, pause, scrub) and
  through space (walk, move the phone, orbit, zoom from inside the world to
  third person). Follow carries out the author's attention intent; Free leaves
  the viewer in charge.
- Meaning comes from the body first: references, demonstrated paths, and
  measurements are read from the performance; authored notes fill the gaps.
- Index the hologram by referent as well as by time: tap the rock to find every
  moment it was discussed.
- A reply is a new event placed at a moment and place inside the original,
  recorded in a headset or through a phone portal.
- Represent versions as meaningful changes to speech, motion, marks, and intent.
- Surface aggregate signals (where viewers stood, looked, and replayed) while
  protecting viewer privacy.

## Continuity With Live Communication

Async is the replayable counterpart of a live spatial discussion: preserve
people, references, objects, and changes over time, not just a chosen camera
view. Whether a live session can become an editable, searchable, replyable
artifact without losing meaning is a hypothesis. A current exported file
should not be assumed to contain a semantic conversation graph.

Threaded replies could preserve the original moment and let a recipient show
their own interpretation. Understanding Mirrors and checkpoints could test
that interpretation; they need evaluation beyond whether playback works.

## Example

A field expert records a repair walkthrough. When they point at the loose
bracket and say "this one", the bracket is linked and lights up. On a phone, a
viewer in Follow mode sees the camera ease to the bracket; they pause, switch
to Free, move the phone to look behind it, and record a reply anchored to the
bracket at that moment. The expert answers in context.

## Open Questions

- Which interactions preserve the creator's narrative while empowering viewers?
- How should branches and replies be presented without becoming a maze?
- What is the smallest portal that still feels like looking into a place
  rather than watching a clip?
