# PRD: Durable jobs for every derived artifact

**Status:** Draft  
**Source ideas:** IDEA-050  
**Layer:** All layers  
**Depends on:** the async USDZ job (delivered by live deployment); a second artifact that needs it (PRD-034, PRD-035)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## What Already Exists

The [live deployment](../../features/live-deployment.md) brief delivered the
USDZ case of this idea: `usdzStatus` (none, pending, processing, ready,
failed), claim fields with stale-claim recovery, an attempt counter, persisted
errors, a 120 s conversion timeout, and a worker embedded in the API process.
This PRD covers only what remains: the same guarantees for the next derived
artifacts, without one hand-written state machine per artifact.

## User Outcome

Before: when a preview image or metadata job is added, it would need its own
status fields and recovery logic, and a failure in one could leave an author
unsure whether their hologram is usable.
After: every derived artifact (Quick Look, preview image, metadata, and later
transcripts) is processed by one job mechanism with the same retry, timeout,
and failure reporting, and a failure in one never hides the others.

## Problem

Several draft PRDs add derived artifacts: metadata (PRD-034), preview images
(PRD-035), and transcripts (PRD-009, PRD-017). Copying the USDZ fields for each
multiplies schema and failure paths.

## Primary User And Moment

The author, at the moment they check whether a hologram is ready (PRD-033);
the operator when a job fails (PRD-040).

## Proposed Interaction

- One job record per hologram and artifact kind: status, attempts, claim,
  error, timestamps.
- The USDZ job moves onto it with its API contract unchanged
  (`GET /holograms/:id/usdz` keeps its redirect, `202`, and `Retry-After` behavior).
- Partial success is explicit: a playable GLB is ready even when an optional
  artifact failed.

## Why Holograms

Pipeline work. How it serves the test: derived artifacts are lower steps of the
same hologram (a still, a flattened preview). The lens says these never stand
in for the hologram, so their failures must never block it.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Not visible | None |
| Phone portal | Not visible; plays as soon as the GLB is ready | None |
| Desktop | Per-artifact status for the author (PRD-033) | Retry |
| Still image or Quick Look | These are the artifacts the jobs produce | None |

## In Scope

- [ ] A generic job record; USDZ migrated onto it; a second artifact kind using it.
- [ ] Backward-compatible API responses.

## Out Of Scope

- [ ] A separate worker service (deferred until Postgres replaces SQLite, per the brief).

## Success Signals

- [ ] **Technical:** a fault matrix (timeout, crash mid-job, stale claim,
  converter error) gives the same recovery for USDZ and the second kind, and
  existing USDZ API tests pass unchanged.

## Risks And Open Questions

- [ ] How can partial artifact failure remain visible and recoverable?
- [ ] Do not generalize before the second artifact kind is approved.

## Comparison And Learning

Technical outcome; evidence is the fault matrix and unchanged API tests.
Approve together with the first of PRD-034 or PRD-035.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [creator pipeline](../concepts/creator-pipeline.md)
- Feature brief (delivered part): [live deployment](../../features/live-deployment.md)
- Related PRDs: [PRD-033 processing lifecycle](PRD-033-processing-lifecycle.md),
  [PRD-035 preview images](PRD-035-preview-images.md)
- Mockups: none
- Implementation issue: none
