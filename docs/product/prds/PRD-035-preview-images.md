# PRD: Preview images that represent the event fairly

**Status:** Draft  
**Source ideas:** IDEA-049  
**Layer:** All layers  
**Depends on:** a background job (the USDZ job pattern exists); IDEA-058 for link unfurls  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: a shared hologram link shows no image in a chat app, and a list of
holograms has nothing recognizable before they load, so recipients cannot tell
messages apart.
After: each hologram has a preview image of a representative moment, shown in
lists and in link previews, so a recipient recognizes the message before opening it.

## Problem

Recognition and link sharing need stills. A still is a view; the lens says the
author never sets the camera, so the frame must come from intent (a pointed
referent, a viewpoint marker) or a neutral default.

## Primary User And Moment

A recipient who receives a link in a chat app, or browses their messages.

## Proposed Interaction

- A background job renders a still on upload: by default the author at a
  mid-recording moment from a neutral three-quarter view.
- When meaning-layer data exists, choose the moment of the first resolved
  pointing link (IDEA-032) or a viewpoint marker (IDEA-035).
- Use it for cards, the detail page, and Open Graph tags.

## Why Holograms

Pipeline work. How it serves the test: a still is the bottom step of "the
intent stays the same; the presentation adapts to the device". Fair
comparison: no preview.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Preview in lists | None |
| Phone portal | Card placeholder until the portal loads | None |
| Desktop | Same | None |
| Still image or Quick Look | This is the still image | None |

## In Scope

- [ ] Server-side still render; storage; cards and Open Graph tags.

## Out Of Scope

- [ ] Animated previews; author-chosen thumbnails.

## Success Signals

- [ ] **Technical:** every ready hologram has a preview within a set time; failure never blocks ready.
- [ ] **Recipient:** see below.

## Risks And Open Questions

- [ ] Which frame or view represents an embodied message fairly?
- [ ] Headless WebGL rendering on the server.

## Comparison And Learning

Task: recipients pick a described message out of ten. Compare with and without
previews. Measures: time and errors. Continue if recognition improves.

## Decision

Pending until explicitly decided. Drafting this document is not approval to build.

## Links

- Concept: [creator pipeline](../concepts/creator-pipeline.md)
- Research: [open questions](../research/open-questions.md) (question 15)
- Mockups: none
- Feature brief: none
- Implementation issue: none
