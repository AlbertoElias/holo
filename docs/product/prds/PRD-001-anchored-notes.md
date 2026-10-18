# PRD: Anchored notes

**Status:** Draft  
**Source ideas:** IDEA-002  
**Owner:** Alberto Elias  
**Last updated:** 2026-10-18

## User Outcome

Before: a viewer watching a hologram has to guess what "this part" or "right
here" refers to, and has to ask the author or rewatch to find out.
After: at the moment the author is referring to something, the viewer sees a
short note pinned to that exact place on the avatar or in the scene, and can
jump straight to each noted moment.

## Problem

Spoken explanations are full of references to things and places ("hold it
here", "this edge", "now watch my wrist"). In today's feed the hologram loops
with no pause, no timeline, and no way for the author to add anything after
recording. A viewer who misses the reference or cannot tell which of two
nearby things was meant has no recovery except rewatching the loop or asking
in another channel.

## Primary User And Moment

- **Author:** someone who just recorded an explanation in capture and is about
  to upload it from a desktop browser. They know which moments were unclear and
  want to add context without re-recording.
- **Viewer:** someone watching that hologram later in the feed on desktop or
  mobile, or placing it in WebXR AR.

## Proposed Interaction

**Author, at upload (desktop viewer-web):**

1. Choose the exported GLB as today. The upload panel now shows a preview of
   the hologram with play/pause and a scrubber.
2. Scrub to a moment, click a point on the avatar or the scene, and type a
   short note (up to 140 characters). The note appears for 3 s from that
   moment by default; the author can drag the end to lengthen or shorten it.
3. Add more notes, edit or delete them, then upload. The notes travel inside
   the uploaded GLB.

**Viewer (feed card and WebXR AR):**

1. The hologram plays as today. Its timeline shows a mark for each note.
2. While a note's time range is playing, a marker sits on the pinned point
   (following it if it is on the moving avatar) with the note text beside it,
   facing the viewer.
3. Tapping a mark jumps to that moment and pauses, so the viewer can look
   around the pinned point.

## Why Holograms

A caption in a video is stuck to a 2D screen position. Once the viewer orbits
the model or walks around it in AR, or the avatar's hand moves, a screen-space
caption stops pointing at the thing it describes. A note pinned to a 3D point
and to a span of time keeps pointing at its referent from every viewpoint and
at every moment, which is the "space is a shared reference system" principle
in [`../VISION.md`](../VISION.md).

## In Scope

- [ ] Preview, play/pause, and scrubbing in the upload panel.
- [ ] Placing a note by clicking a point on the avatar (follows the avatar's
  motion) or on the scene (stays fixed in the scene).
- [ ] Note text up to 140 characters with a start time and a duration.
- [ ] Notes stored in the GLB as an optional glTF extension, so the file
  remains a valid GLB that other viewers render without the notes.
- [ ] Viewer playback controls on feed cards: play/pause, timeline with note
  marks, jump-to-note.
- [ ] Notes shown during their time range in feed cards and in WebXR AR.
- [ ] The real pipeline e2e test extended: record, export, add a note, upload,
  and see the note at its pinned point and time in the feed.

## Out Of Scope

- [ ] Notes written by viewers, replies, or threads (IDEA-018); these need user
  accounts.
- [ ] Editing notes after upload; re-uploading is the edit path for now.
- [ ] Adding notes in VR while recording.
- [ ] Notes in iPhone/iPad Quick Look AR; the USDZ conversion drops them.
- [ ] Images, voice, links, or formatting inside notes.
- [ ] Notes on objects other than the avatar and the recorded scene.

## Success Signals

- [ ] **Comprehension:** in a hallway test with at least 5 viewers, given a
  recording with an ambiguous reference ("hold it here"), more viewers point to
  the correct spot and moment with the note than without it, and they answer
  faster.
- [ ] **Authoring cost:** an author adds 3 notes to a 30 s recording in under
  2 minutes without help.
- [ ] **Legibility:** notes are readable without overlapping the avatar's face
  in feed cards at phone width and at 1–3 m in AR.
- [ ] **Compatibility:** a GLB with notes renders unchanged in a third-party
  glTF viewer, and a GLB without notes renders unchanged in HoloIM.

## Risks And Open Questions

- [ ] **Where authoring happens.** This PRD proposes the upload panel on
  desktop. Alternatives: a review step in capture before export (notes written
  at export time, no GLB rewriting in the browser), or in VR during recording
  (no typing, so notes would need voice or presets). Upload is the simplest
  path that keeps typing easy and needs no accounts, because the uploader is
  the author.
- [ ] **What a pin on the avatar attaches to.** A bone (follows the hand or
  head) or the skinned surface point. A bone is simpler and robust; a surface
  point matches the click more exactly.
- [ ] **Feed autoplay versus pausing.** Feed cards autoplay and loop today.
  Jump-to-note pauses; resuming and loop behavior need a small design pass.
- [ ] **iPhone AR users see no notes.** Quick Look is the iOS AR path. Is that
  acceptable for a first version, or should Quick Look show a notice?
- [ ] **Clutter.** Overlapping notes, or notes behind the avatar, may need a
  limit or occlusion handling.

## Links

- Concept: [`../concepts/async-holograms.md`](../concepts/async-holograms.md)
- Research: [`../research/open-questions.md`](../research/open-questions.md) (question 1)
- Feature brief: none yet; created when this PRD is approved and queued
- Implementation issue: none
