# PRD: Reference Lock invitations in live sessions

**Status:** Draft  
**Source ideas:** IDEA-008  
**Layer:** View  
**Depends on:** a live multi-person session (does not exist), IDEA-032  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: in a live discussion, "look at this one" works only if everyone is
already facing the same thing; remote or phone participants lose the reference.
After: when one participant points at something and invites the others, each
participant's device offers to bring that referent into view, and everyone can
confirm they are looking at the same thing within a few seconds.

## Problem

Shared reference is the most common breakdown in spatial conversation. In VR
people stand in different places; a phone participant sees through a small
portal. Video calls solve it by screen sharing, which forces one view on all.

## Primary User And Moment

Three people in a live session (two in headsets, one on a phone) discussing a
part. One points and says "this bracket". The phone participant cannot see it.

## Proposed Interaction

- Pointing resolves the referent (IDEA-032). The speaker can turn that into an
  invitation with one held gesture or a short phrase.
- Each other participant gets the invitation in Follow: a directional sound in
  a headset, an eased camera move on a phone. In Free, it shows as a small cue
  they can accept or ignore.
- No participant's view ever moves without their Follow mode allowing it.

## Why Holograms

A screen share moves pixels; a Reference Lock moves attention to a referent in
the shared event and lets each device show it its own way. The fair comparison
is a video call with screen sharing.

- **Anchored to the event:** the referent is a bone, object, or place.
- **Read from the body:** the invitation starts from a resolved pointing gesture.
- **Intent, not a view:** "look at this", carried out per device.
- **Works on a flat phone:** the portal camera eases to the referent.
- **Lost as a video:** a video call has no referent, only a shared frame.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Directional sound and a brief highlight on the referent | Follow accepts automatically; Free shows an accept cue |
| Phone portal | Eased camera move to frame the referent | Same; a swipe returns to Free |
| Desktop | Same as phone | Same |
| Still image or Quick Look | Not applicable (live only) | None |

## In Scope

- [ ] Invitation from a resolved pointing referent.
- [ ] Per-device Follow behavior and a Free decline path.
- [ ] Recorded into the session so replays show who invited what.

## Out Of Scope

- [ ] Building the live session itself (needs its own PRD and decision).
- [ ] Forcing views, presenter mode, or screen sharing.

## Success Signals

- [ ] **Technical:** an invitation reaches every participant in under 500 ms on
  a local network and never moves a Free view.
- [ ] **Communication:** see the trial below.

## Risks And Open Questions

- [ ] Realtime multiplayer is explicitly not a current commitment (see
  [Approach](../APPROACH.md)); this PRD cannot start before one is approved.
- [ ] How does it stay an invitation rather than a takeover?
- [ ] The async twin (IDEA-036 look-here cues) may answer most of the question first.

## Comparison And Learning

Task: three participants identify which of several similar parts the speaker
means. Compare a live session with Reference Lock against a video call with
screen sharing. Measures: time to confirmed shared reference, wrong-part
errors, and participant comfort. Continue if faster with no comfort cost;
revise if invitations feel intrusive; park if screen sharing matches it.

## Decision

Pending until explicitly decided. Drafting this document is not approval to
build. Readiness: low until live sessions exist; learn from PRD-026 first.

## Links

- Concept: [communication protocols](../concepts/communication-protocols.md),
  [live VR and AR dialogue](../concepts/live-vr-ar-dialogue.md)
- Research: [open questions](../research/open-questions.md) (questions 11, 17)
- Related PRDs: [PRD-026 look-here cues](PRD-026-look-here-cues.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
