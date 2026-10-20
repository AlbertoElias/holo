# PRD: Clarity co-director for unresolved references

**Status:** Draft  
**Source ideas:** IDEA-023  
**Layer:** Meaning (read)  
**Depends on:** IDEA-032 (resolved pointing), speech transcription  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: an author sends a hologram that says "this one" twice with no pointing,
and only learns it was ambiguous when the recipient asks.
After: right after the take, the author sees a short list of moments where a
reference was spoken but not resolved by the body, and can fix each with a
point, a note, or a short retake before sending.

## Problem

Authors cannot see their own ambiguity; they knew what they meant. The system
knows which deictic words had no resolved pointing link.

## Primary User And Moment

An author in capture, at the review step before export or publishing.

## Proposed Interaction

- Combine transcript deictics ("this", "that", "here", "there") with IDEA-032
  pointing links.
- List moments where a deictic had no link or more than one candidate.
- For each, offer: jump there, pick the referent from candidates, or ignore.

## Why Holograms

Video has no structured referents, so ambiguity cannot be detected. Fair
comparison: authors reviewing their own take without suggestions.

- **Anchored to the event:** suggestions point at moments and candidate referents.
- **Read from the body:** only flags what the body did not resolve.
- **Intent, not a view:** suggests meaning, never camera moves.
- **Works on a flat phone:** recipients only see the resolved result.
- **Lost as a video:** detection of unresolved spatial references.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Review list in capture; candidates highlighted in the scene | Pick, jump, ignore |
| Phone portal | Not shown to recipients | None |
| Desktop | Same list if review moves to desktop | Same |
| Still image or Quick Look | Not applicable | None |

## In Scope

- [ ] Detection of unresolved deictics; review list; pick-a-candidate fix.

## Out Of Scope

- [ ] Automatic fixes; style or pacing suggestions; AI audience simulation (IDEA-030, parked).

## Success Signals

- [ ] **Technical:** on a test set, flags at least 80 percent of unresolved references with few false flags.
- [ ] **Communication:** see the trial below.

## Risks And Open Questions

- [ ] Over-directing authors; keep suggestions few and ignorable.
- [ ] Transcription quality in noisy rooms.

## Comparison And Learning

Task: authors record an explanation with natural ambiguity. Compare holograms
sent after co-director review with those sent after unaided review. Measures:
recipients' referent errors and clarification questions. Continue if errors
drop; park if authors ignore suggestions.

## Decision

Pending until explicitly decided. Drafting this document is not approval to
build. Recommended sequencing: after IDEA-032.

## Links

- Concept: [hologram authoring](../concepts/hologram-authoring.md)
- Research: [open questions](../research/open-questions.md) (question 7)
- Related PRDs: [PRD-022 self-resolving pointing](PRD-022-self-resolving-pointing.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
