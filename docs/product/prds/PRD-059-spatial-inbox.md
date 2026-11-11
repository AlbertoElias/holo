# PRD: Spatial inbox and collections

**Status:** Parked  
**Source ideas:** IDEA-026  
**Layer:** Conversation  
**Depends on:** identity (PRD-037), replies (PRD-012), share links (PRD-042)  
**Owner:** Alberto Elias  
**Last updated:** 2026-10-20

## Decision

Parked 2026-10-18 by the agreed lens in [what a hologram is](../concepts/what-a-hologram-is.md).
Rationale: an inbox organizes conversations that do not exist yet (no
identity, no replies), and its key question, whether the unit is a person, a
project, a place, or a conversation, can only be answered by watching real
threads. Revisit once Holo Replies (PRD-012) and identity (PRD-037) are in use
and people have more than a handful of threads.

## User Outcome

Before: holograms someone received are scattered across chat apps as links,
with replies elsewhere.
After: they open one place that holds the holograms sent to them and their
reply threads, grouped in the way they think about the work, and pick up where
they left off.

## Problem

Async communication needs a home for threads; a public feed is not that home.

## Primary User And Moment

Someone with several ongoing hologram conversations, opening the app to catch up.

## Proposed Interaction

- A list of threads (a hologram and its replies), newest activity first.
- Collections by person or project, chosen by observation.
- A spatial view (threads as places in a room) is an option to test, not the default.

## Why Holograms

Fair comparison: a chat app with links.

- **Anchored to the event:** threads keep each reply at its moment and referent.
- **Read from the body:** not applicable.
- **Intent, not a view:** organizes conversations, not cameras.
- **Works on a flat phone:** a list first.
- **Lost as a video:** replies placed inside the original hologram.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | List, optionally a room of threads | Point |
| Phone portal | List of threads | Tap |
| Desktop | Same | Click |
| Still image or Quick Look | Preview images in the list | None |

## In Scope

- [ ] Thread list, unread state, one kind of collection.

## Out Of Scope

- [ ] Search across threads (PRD-036), notifications.

## Success Signals

- [ ] **Use:** people return to threads through the inbox rather than chat links.

## Risks And Open Questions

- [ ] Is the primary unit a person, a project, a place, or a conversation?

## Comparison And Learning

If reopened: after two weeks of replies, compare inbox with chat links for
finding a thread. Measures: time and preference.

## Links

- Concept: [async holograms](../concepts/async-holograms.md)
- Research: [open questions](../research/open-questions.md) (question 1)
- Mockups: none
- Feature brief: none
- Implementation issue: none
