# PRD: Limits that protect without blocking creation

**Status:** Draft  
**Source ideas:** IDEA-055  
**Layer:** All layers  
**Depends on:** live deployment (in verification); IDEA-052 for per-creator quotas  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: the live service accepts uploads up to a size cap with no rate limit,
so one abusive client could fill storage or stall the converter for everyone.
After: legitimate authors never hit a limit in normal use, and abuse is slowed
or refused with a clear message.

## Problem

`MAX_GLB_BYTES` caps upload size today. There is no request rate limit, no
quota, and the converter runs one job at a time.

## Primary User And Moment

The operator, after the live URL is shared; and an author who records a long
take and must not be refused.

## Proposed Interaction

- Rate limits on upload initiation and completion per client address.
- A daily upload quota per client (per creator once IDEA-052 exists).
- A clear, actionable message when a limit is hit.
- Size and duration limits set from real export sizes, documented.

## Why Holograms

Operations work. How it serves the test: long embodied takes are large;
limits must be set from real recordings so they never truncate an event. Fair
comparison: none; baseline protection.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Clear message on Publish if limited | None |
| Phone portal | Not affected | None |
| Desktop | Clear message in upload panel | None |
| Still image or Quick Look | Not affected | None |

## In Scope

- [ ] Rate limits, quotas, messages, limits set from measured real exports.

## Out Of Scope

- [ ] Paid tiers, per-creator billing.

## Success Signals

- [ ] **Technical:** a scripted burst is throttled; a real long take uploads unaffected.

## Risks And Open Questions

- [ ] What limits protect the chosen workflow without blocking legitimate creation?

## Comparison And Learning

Evidence is technical: a load script and a set of real exports. Approve before
sharing the live URL widely.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [creator pipeline](../concepts/creator-pipeline.md)
- Feature brief (related): [live deployment](../../features/live-deployment.md)
- Mockups: none
- Implementation issue: none
