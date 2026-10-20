# PRD: Find a known explanation

**Status:** Draft  
**Source ideas:** IDEA-051  
**Layer:** View  
**Depends on:** IDEA-048 metadata; transcription (shared with IDEA-014) for spoken-word search  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: a recipient who remembers "that hologram where Ana showed how to fit
the bracket" can only scroll the latest-first feed until they find it.
After: they type "bracket" or pick Ana's name and find it in seconds.

## Problem

The API has stable cursor pagination by newest first, and nothing else. The
registry's question is whether finding a known explanation matters more than
browsing; for communication, finding is likely the job.

## Primary User And Moment

A recipient returning to an explanation they received last week.

## Proposed Interaction

- Search across title, creator name, and (later) transcript text.
- Filter by creator; sort newest first.
- Results keep the existing cursor pagination contract.

## Why Holograms

Pipeline work. How it serves the test: searching by spoken words and, later,
by referent (IDEA-044) indexes the event itself rather than a video's title.
Fair comparison: scrolling the feed.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Search field in the viewer | Voice or keyboard |
| Phone portal | Search above the feed | Keyboard |
| Desktop | Same | Same |
| Still image or Quick Look | Not applicable | None |

## In Scope

- [ ] Title and creator search; creator filter; backward-compatible API parameters.

## Out Of Scope

- [ ] Tags, profiles, engagement ranking, recommendation.

## Success Signals

- [ ] **Technical:** existing feed clients keep working; search returns within 300 ms at beta scale.
- [ ] **Recipient:** see below.

## Risks And Open Questions

- [ ] Is finding a known explanation more valuable than feed browsing?
- [ ] SQLite full-text search limits until Postgres arrives.

## Comparison And Learning

Task: find three named holograms among fifty. Compare search with scrolling.
Measures: time and failures. Continue if search is used without prompting.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [creator pipeline](../concepts/creator-pipeline.md)
- Research: [open questions](../research/open-questions.md) (question 15)
- Mockups: none
- Feature brief: none
- Implementation issue: none
