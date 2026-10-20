# PRD: Upload progress and recovery

**Status:** Draft  
**Source ideas:** IDEA-057  
**Layer:** All layers  
**Depends on:** presigned upload flow (delivered); pairs with IDEA-046 publish  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: an author uploading a large hologram on a weak connection sees no
progress, and if it fails they must start over and retype the title.
After: the author sees progress, and a failed upload can be retried with the
file and details kept, so a bad connection never costs them the message.

## Problem

The upload panel has no progress or retry. The presigned flow already records
upload intents with expiry, which a retry can reuse.

## Primary User And Moment

An author uploading from a headset or laptop on hotel or mobile Wi-Fi.

## Proposed Interaction

- Progress bar for the PUT to storage.
- On failure: the form keeps the file and fields; Retry reuses the upload
  intent if unexpired, else creates a new one.
- "Resumable" here means retry within the same session; across reloads or
  devices is out of scope until needed.

## Why Holograms

Pipeline work. How it serves the test: embodied takes cannot be re-performed
identically, so losing one is worse than losing a video file you still have.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Progress and Retry in Publish (IDEA-046) | Retry |
| Phone portal | Not affected | None |
| Desktop | Progress and Retry in the upload panel | Retry |
| Still image or Quick Look | Not affected | None |

## In Scope

- [ ] Progress, retry with kept fields, intent reuse.

## Out Of Scope

- [ ] Multipart resumable uploads across reloads.

## Success Signals

- [ ] **Technical:** a connection dropped mid-upload recovers on Retry without re-entry.

## Risks And Open Questions

- [ ] Can a failed attempt be retried without losing the recording or metadata?

## Comparison And Learning

Evidence is technical (network-throttled and dropped uploads in an end-to-end
run). Approve together with PRD-032.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [creator pipeline](../concepts/creator-pipeline.md)
- Related PRDs: [PRD-032 publish from capture](PRD-032-direct-publish.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
