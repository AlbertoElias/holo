# PRD: What changed between two versions

**Status:** Draft  
**Source ideas:** IDEA-019  
**Layer:** Event  
**Depends on:** versioned holograms (none today), IDEA-021 or IDEA-069 producing revisions  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: when an author re-records or edits a hologram, a recipient who saw the
first version must rewatch the whole thing to find what changed.
After: the recipient opens the new version and is taken to each changed moment,
with a short summary such as "step 3: different grip; the bracket is now
mentioned".

## Problem

Revisions are common in instruction and review. Video diffs are pixel
differences, which say nothing about meaning. Holograms store body, speech, and
marks as data, so a meaningful diff is possible.

## Primary User And Moment

A reviewer who commented on version one and now receives version two.

## Proposed Interaction

- Compare two versions on three tracks: speech (transcript diff), pose (large
  differences in hand and body motion at aligned times), and marks.
- The viewer gets a list of changed moments; selecting one plays both versions
  side by side as ghosts.

## Why Holograms

A video diff can only show pixels. Here differences in motion and reference are
measurable. Fair comparison: the author's own written change notes.

- **Anchored to the event:** changes are moments and body parts.
- **Read from the body:** pose differences come straight from the event data.
- **Intent, not a view:** lists what changed; the device shows it.
- **Works on a flat phone:** a list of moments plus a ghost overlay in the portal.
- **Lost as a video:** motion-level comparison independent of camera.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Old version as a ghost beside the new | Step through changes |
| Phone portal | Same ghost overlay in the portal | Change list |
| Desktop | Same | Same |
| Still image or Quick Look | Side-by-side stills of each change | None |

## In Scope

- [ ] Version link between two uploads; speech and pose diff; change list.

## Out Of Scope

- [ ] Intent-level diff, merge, or version trees.

## Success Signals

- [ ] **Technical:** a deliberate change to one step is detected and nothing else is flagged.
- [ ] **Communication:** see the trial below.

## Risks And Open Questions

- [ ] Which changes count as semantic: words, pose, objects, marks, or intent?
- [ ] Time alignment between takes of different length.

## Comparison And Learning

Task: a reviewer checks whether their requested change was made. Compare the
diff view with author-written change notes. Measures: time to verify and
missed changes. Park until versioned holograms exist.

## Decision

Pending until explicitly decided. Drafting this document is not approval to
build. Readiness: low until holograms have versions.

## Links

- Concept: [async holograms](../concepts/async-holograms.md)
- Research: [open questions](../research/open-questions.md) (question 5)
- Mockups: none
- Feature brief: none
- Implementation issue: none
