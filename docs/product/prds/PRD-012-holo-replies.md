# PRD: Holo Replies at a moment and place

**Status:** Draft  
**Source ideas:** IDEA-018  
**Layer:** Conversation  
**Depends on:** IDEA-045 (portal), IDEA-052 (who replied), IDEA-058 (message URL)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: a recipient with a question about a hologram writes a text message
("at the part where you turn it, which way?"), and the author has to guess which
moment and thing they mean.
After: the recipient pauses at the moment, points at the thing, and records a
short reply there; the author opens the reply and lands exactly at that moment
and place, with the recipient's pointing visible.

## Problem

Replies today live in other channels and lose the referent. This is the
repair loop that turns a broadcast into a conversation.

## Primary User And Moment

A recipient on a phone who did not understand one step of a received hologram;
the author who receives the question later.

## Proposed Interaction

- Paused in the portal, the recipient taps "Reply here". A phone reply is a
  voice clip plus a tap on the referent (no headset needed). A headset reply is
  a short embodied recording placed in the scene.
- The reply is stored as a new event linked to the original's time and referent.
- The author sees reply markers on the original's timeline and in the scene.

## Why Holograms

A text reply can quote a timestamp, but not a place in the scene or a gesture.
Fair comparison: replying by text or voice note in a chat, with a timestamp.

- **Anchored to the event:** linked to a moment and referent of the original.
- **Read from the body:** a headset reply's pointing resolves its own referent.
- **Intent, not a view:** the reply says where; the author's device decides how to show it.
- **Works on a flat phone:** voice plus a tap is enough to reply.
- **Lost as a video:** a reply placed inside the original's space.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Reply avatar or marker standing in the original scene | Record reply in place |
| Phone portal | Reply marker in the scene; voice plays with the referent highlighted | Reply here: voice plus tap |
| Desktop | Same as phone | Same with mouse and microphone |
| Still image or Quick Look | Dropped | None |

## In Scope

- [ ] Phone reply (voice plus referent tap) and its playback for the author.
- [ ] Storage of a reply as a linked event.

## Out Of Scope

- [ ] Threads deeper than one reply; notifications; headset reply recording in the first version.

## Success Signals

- [ ] **Technical:** a reply survives upload and opens the original at the right moment and referent.
- [ ] **Communication:** see the trial below.

## Risks And Open Questions

- [ ] Needs identity (IDEA-052) to say who replied.
- [ ] What is the reply UX through a phone portal? This PRD proposes voice plus tap.

## Comparison And Learning

Task: a recipient asks about an ambiguous step; the author answers. Compare a
Holo Reply against a chat message with a timestamp. Measures: author's
correct identification of the question's referent, number of exchanges to
resolution. Continue if fewer exchanges; park if chat with timestamps matches.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [async holograms](../concepts/async-holograms.md)
- Research: [open questions](../research/open-questions.md) (question 1)
- Related PRDs: [PRD-037 creator identity](PRD-037-creator-identity.md),
  [PRD-042 share URL](PRD-042-share-url.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
