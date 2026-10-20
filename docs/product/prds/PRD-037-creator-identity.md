# PRD: Creator identity and ownership

**Status:** Draft  
**Source ideas:** IDEA-052  
**Layer:** All layers  
**Depends on:** a chosen workflow that needs ownership (replies, deletion, private sharing)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: anyone can upload under any name, and an author cannot delete or edit
their own hologram, or be sure a reply came from the person it claims.
After: an author signs in once, their holograms are theirs to delete or
re-share, and recipients see a verified creator name.

## Problem

`submittedBy` is a free-text field today. Several PRDs (replies, moderation,
private team use) need real ownership. The registry asks which workflow needs
it first; identity should follow that workflow, not precede it.

## Primary User And Moment

An author who wants to remove a hologram they sent by mistake, or a recipient
who wants to know a reply is genuine.

## Proposed Interaction

- Passwordless sign-in (email link or passkey) on viewer and capture.
- Holograms link to an owner; owners can delete their own.
- Anonymous viewing stays possible for shared links.

## Why Holograms

Pipeline work. How it serves the test: provenance (IDEA-024) answers who
recorded a hologram; identity makes that answer trustworthy. Fair comparison:
the current free-text name.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Signed-in state in capture | Device-code sign-in |
| Phone portal | Verified creator name on cards | Sign in to delete own |
| Desktop | Same | Same |
| Still image or Quick Look | Creator name in link previews | None |

## In Scope

- [ ] Sign-in, ownership, owner delete, verified names; migration of existing records.

## Out Of Scope

- [ ] Workspaces, roles, private libraries (IDEA-065), profiles.

## Success Signals

- [ ] **Technical:** an owner can delete; nobody else can; existing API clients keep working.
- [ ] **Need:** the first workflow that needs ownership is named before approval.

## Risks And Open Questions

- [ ] Which chosen workflow first needs verified ownership?
- [ ] Headset sign-in friction.

## Comparison And Learning

This is an enabling decision. Approve only alongside the PRD that needs it
(likely PRD-012 Holo Replies or PRD-048 team review); park until then.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [creator pipeline](../concepts/creator-pipeline.md)
- Research: [open questions](../research/open-questions.md) (question 15)
- Related PRDs: [PRD-012 Holo Replies](PRD-012-holo-replies.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
