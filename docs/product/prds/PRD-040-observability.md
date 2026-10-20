# PRD: Know about failures before creators report them

**Status:** Draft  
**Source ideas:** IDEA-056  
**Layer:** All layers  
**Depends on:** live deployment (in verification)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: when uploads or conversions fail on the live service, the operator only
finds out if an author complains.
After: the operator sees upload and conversion failures and slow processing on
one dashboard and gets an alert when they cross a threshold, usually before any
author notices.

## Problem

Fastify's request logger is on; there are no metrics, error tracking, or
service objectives. The converter is a single in-process worker, so a stuck job
can delay every Quick Look artifact.

## Primary User And Moment

The operator, any day the live service is in use.

## Proposed Interaction

- Structured logs with request and hologram IDs.
- Metrics: uploads started, completed, failed; conversion duration and failures; queue depth.
- Two objectives to start: upload success rate and time to Quick Look ready.
- One alert channel.

## Why Holograms

Operations work with no meaning-layer element. How it serves the test: it
protects the export -> upload -> render path that every hologram depends on.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Not visible | None |
| Phone portal | Not visible | None |
| Desktop | Operator dashboard | None |
| Still image or Quick Look | Conversion metrics cover the USDZ path | None |

## In Scope

- [ ] Structured logs, a small metric set, two objectives, one alert.

## Out Of Scope

- [ ] Viewer analytics (IDEA-025); tracing across services.

## Success Signals

- [ ] **Technical:** an injected conversion failure raises an alert within minutes.

## Risks And Open Questions

- [ ] Which failures should operators detect before creators report them?
- [ ] Cost of a hosted metrics service at beta scale.

## Comparison And Learning

Evidence is a fault-injection run showing each failure on the dashboard.
Approve when the live service has regular outside users.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [creator pipeline](../concepts/creator-pipeline.md)
- Feature brief (related): [live deployment](../../features/live-deployment.md)
- Mockups: none
- Implementation issue: none
