# PRD: Report and hide

**Status:** Draft  
**Source ideas:** IDEA-053  
**Layer:** All layers  
**Depends on:** public or shared distribution beyond a known group  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: a viewer who sees an offensive or unwanted hologram in the feed has no
way to remove it from their view or tell anyone.
After: the viewer can hide it for themselves at once and report it; an operator
reviews reports and can remove it for everyone.

## Problem

A public feed without moderation is a liability, and the feed becomes public as
soon as the live viewer URL is shared. The registry asks what each action
should do and when.

## Primary User And Moment

A viewer encountering unwanted content; the operator handling a report.

## Proposed Interaction

- Hide: removes the hologram from this viewer's feed (local, no account).
- Report: a reason from a short list; stored for review.
- Admin review: a simple protected list to remove or dismiss.
- Removed holograms stop resolving at their links and in Quick Look.

## Why Holograms

Pipeline work. How it serves the test: embodied, life-size content can feel
more intrusive than video, which raises the bar for removal. Fair comparison:
none; this is a safety baseline.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Hide and report in the viewer menu | Point and pinch |
| Phone portal | Same on cards | Tap |
| Desktop | Same | Click |
| Still image or Quick Look | Removed content returns not found | None |

## In Scope

- [ ] Hide, report, admin review, removal across all artifacts.

## Out Of Scope

- [ ] Automated moderation, appeals, account bans (needs IDEA-052).

## Success Signals

- [ ] **Technical:** a removed hologram is unreachable via feed, link, GLB, and USDZ URLs.
- [ ] **Operations:** a report reaches the operator within a set time.

## Risks And Open Questions

- [ ] What response and visibility should each report or hide action have?
- [ ] Is the feed staying public? If distribution moves to private links, scope shrinks.

## Comparison And Learning

Safety baseline; evidence is technical (every artifact path removed). Approve
before any wider public sharing of the live URL.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [creator pipeline](../concepts/creator-pipeline.md)
- Research: [open questions](../research/open-questions.md) (question 15)
- Mockups: none
- Feature brief: none
- Implementation issue: none
