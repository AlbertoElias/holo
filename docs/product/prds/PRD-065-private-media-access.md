# PRD: Private media access

**Status:** Draft  
**Source ideas:** IDEA-054  
**Layer:** All layers  
**Depends on:** R2 storage (delivered by live deployment); identity (PRD-037); a workflow that needs private holograms (PRD-048)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## What Already Exists

The [live deployment](../../features/live-deployment.md) brief delivered the
durability and distribution part of this idea: a storage driver (local, or
S3-compatible R2), presigned direct-to-R2 uploads, absolute CDN media URLs, and
object deletion. Reads use public URLs with long immutable caching. What
remains is the signed-access part: holograms only some people may open.

## User Outcome

Before: anyone who has, or guesses, a hologram's media URL can download it,
so a team cannot use HoloIM for anything private.
After: a hologram can be private; its GLB and Quick Look files open only
through short-lived signed links given to people allowed to see it, and
public holograms work as they do today.

## Problem

Embodied recordings of people and workplaces are sensitive. Public immutable
URLs cannot be revoked once shared.

## Primary User And Moment

A team recording internal procedures (PRD-048); a person sending a personal
message (PRD-046) only to one recipient.

## Proposed Interaction

- A visibility setting per hologram: public (today's behavior) or private.
- Private media is served through signed URLs that expire, issued by the API
  to allowed viewers.
- Deleting or making private revokes future access.

## Why Holograms

Operations work. How it serves the test: a hologram holds a person's body,
voice, and place at true scale, which is more personal than most video, so
private access matters for consent (IDEA-024's provenance and consent concerns).

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Private holograms open for allowed viewers | Sign in |
| Phone portal | Same | Sign in |
| Desktop | Same; owner sets visibility | Visibility setting |
| Still image or Quick Look | Quick Look gets a signed USDZ link | None |

## In Scope

- [ ] Visibility field; signed GLB and USDZ URLs for private holograms; revocation.

## Out Of Scope

- [ ] Workspaces and roles (IDEA-065); end-to-end encryption.

## Success Signals

- [ ] **Technical:** a private hologram's media is unreachable without a valid
  signed URL; public holograms and existing clients are unchanged.

## Risks And Open Questions

- [ ] Which reliability or access need justifies changing the read path?
- [ ] Quick Look on iOS following signed redirects.

## Comparison And Learning

Technical outcome; evidence is an access matrix (owner, allowed, stranger,
expired link). Approve only with the workflow that needs private holograms.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [creator pipeline](../concepts/creator-pipeline.md)
- Feature brief (delivered part): [live deployment](../../features/live-deployment.md)
- Related PRDs: [PRD-037 creator identity](PRD-037-creator-identity.md),
  [PRD-048 team review trial](PRD-048-team-review-trial.md)
- Mockups: none
- Implementation issue: none
