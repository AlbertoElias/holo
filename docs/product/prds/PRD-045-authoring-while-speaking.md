# PRD: Summon and place while speaking

**Status:** Approved  
**Source ideas:** IDEA-062  
**Layer:** Event  
**Depends on:** IDEA-031 (held-mode grammar), IDEA-059 (recorded object motion)  
**Owner:** Unassigned  
**Last updated:** 2026-10-24

## User Outcome

Before: to bring an object or image into an explanation, an author stops
talking, opens a menu, places the thing, and starts again, so the recording
has dead gaps and the author loses their flow.
After: the author says or gestures "bring the bracket" and places it with one
hand while still talking, and the recording flows without a break.

## Problem

Menus break performance. The registry asks whether an author can express an
idea without repeatedly operating menus.

## Primary User And Moment

An author mid-take who needs one of a few prepared objects.

## Proposed Interaction

- Before recording, the author prepares a tray of up to five objects or images.
- During the take, a held gesture (from the design-language grammar) opens the
  tray at the hand; the author picks and places without speech pausing.
- Commands are never recorded as content: the tray and hands-in-menu motion
  are marked as chrome and removed from the event.

## Why Holograms

Video editors insert objects in post; here the insertion is part of the
performance in space. Fair comparison: placing objects through today's menus.

- **Anchored to the event:** placed objects become part of the scene at a moment.
- **Read from the body:** placement is the author's own hand motion.
- **Intent, not a view:** never a camera action.
- **Works on a flat phone:** the recipient just sees the object appear in the author's hand.
- **Lost as a video:** objects introduced into the shared space mid-explanation.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Tray at the hand during a held gesture (author only) | Hold, pick, place |
| Phone portal | Object appears in the author's hand | None |
| Desktop | Same | None |
| Still image or Quick Look | Object visible where placed | None |

## In Scope

- [ ] A prepared tray; held-gesture summon; placement; chrome excluded from recording.

## Out Of Scope

- [ ] Voice commands, transforming or animating summoned objects, spatial primitives.

## Success Signals

- [ ] **Technical:** no tray or menu ever appears in an exported recording.
- [ ] **Authoring:** see below.

## Risks And Open Questions

- [ ] Accidental summons recorded as content.
- [ ] Is a held gesture natural while also gesturing to explain?

## Comparison And Learning

Task: an explanation that introduces three objects. Compare tray-while-speaking
with menus. Measures: speech gaps, total take length, and author preference.
Continue if gaps shrink; park if authors prefer preparing everything in advance.

## Decision

Approved 2026-10-24: the user asked for PRD-045 to be built after PRD-043.

## Links

- Concept: [hologram authoring](../concepts/hologram-authoring.md),
  [design language](../concepts/design-language.md)
- Research: [open questions](../research/open-questions.md) (question 13)
- Mockups: none
- Feature brief: [summon and place](../../features/summon-and-place.md)
- Implementation issue: none
