# PRD: A hologram's own page and share link

**Status:** Draft  
**Source ideas:** IDEA-058  
**Layer:** View  
**Depends on:** IDEA-045 portal (approved)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: to send someone a hologram, an author can only share the feed (where it
is one of many) or an AR link; the recipient lands somewhere that does not
explain what they are looking at.
After: every hologram has its own link that opens it alone, full screen,
playing in Follow, with a one-line hint that they can look around, so a
first-time recipient understands it is a place, not a video.

## Problem

The viewer has two routes: the feed and `/ar/:id`. Messages are sent to a
person, so they need a destination of their own. The registry asks what
opening state helps an unfamiliar recipient.

## Primary User And Moment

A first-time recipient opening a link from a chat app on their phone.

## Proposed Interaction

- `/h/:id` opens a single hologram in the portal, Follow, with title and creator.
- First-open hint: "Drag to look around" (or the chosen PRD-002 variant's idiom),
  dismissed on first gesture.
- Buttons: view in AR (where supported), Quick Look (iOS, opt-in), back to feed.
- Open Graph tags with the preview image (IDEA-049).

## Why Holograms

A video link opens a player; this link must open a portal. Fair comparison:
sharing the feed URL.

- **Anchored to the event:** opens at the start of the event, in Follow.
- **Read from the body:** not applicable; this is viewing.
- **Intent, not a view:** Follow carries the author's intent from the first frame.
- **Works on a flat phone:** this is the phone's front door.
- **Lost as a video:** a first impression that invites moving, not just playing.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Opens with an enter-VR or AR option | Enter |
| Phone portal | Full-screen portal with hint | Portal gestures |
| Desktop | Large portal | Mouse |
| Still image or Quick Look | Link preview image; Quick Look button on iOS | Tap |

## In Scope

- [ ] Detail route, opening state, hint, Open Graph tags, share button.

## Out Of Scope

- [ ] Private or expiring links (needs IDEA-052).

## Success Signals

- [ ] **Technical:** links open the right hologram on iOS Safari, Android Chrome, desktop, and Quest browser.
- [ ] **Recipient:** see below.

## Risks And Open Questions

- [ ] What opening state helps a recipient understand an unfamiliar message?

## Comparison And Learning

Task: first-time recipients open a link and are asked what the message showed.
Compare detail link with feed link. Measures: whether they find the message,
whether they explore, and correct answers. Continue if they explore unprompted.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [viewer experience](../concepts/viewer-experience.md)
- Research: [open questions](../research/open-questions.md) (question 2)
- Related PRDs: [PRD-002 portal view](PRD-002-portal-view.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
