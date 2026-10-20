# PRD: One interaction grammar across devices

**Status:** Draft  
**Source ideas:** IDEA-031  
**Layer:** All layers  
**Depends on:** a chosen visual direction from the Direction Board; portal view evidence (PRD-002)  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: capture and the viewer look and behave like two different products;
an action learned in the headset (pointing, "this", a menu) has no equivalent
on the phone, so people relearn the medium on every device.
After: a person who has recorded in a headset opens a hologram on a phone and
uses the same few actions (hold to mark, the same menu directions, "this" and
"here") without instruction.

## Problem

The [design-language concept](../concepts/design-language.md) records why the
current design fails: chrome looks like a 2D app, controls differ per device,
and meaning has no material of its own. Four hologram-first directions are on
the Direction Board; none is chosen.

## Primary User And Moment

Someone moving between devices: they record on a Quest, then open the result
and a reply on their phone.

## Proposed Interaction

Validate one slice of the grammar, not the whole system:

- Three materials: Presence (the event), Ink (meaning), Light (view chrome).
- Held, never toggled, modes.
- One action (mark "this") done through each device idiom.

Pick the visual direction first; then apply it to the record -> view loop only.

## Why Holograms

A design language for holograms must express the event/meaning/view split; a
video app's design language has no meaning layer. Fair comparison: today's UI.

- **Anchored to the event:** Ink always sits on referents; Light never does.
- **Read from the body:** "this" and "here" use pointing before menus.
- **Intent, not a view:** Light chrome is the only screen-anchored layer.
- **Works on a flat phone:** every idiom has a phone form.
- **Lost as a video:** a material for meaning separate from the picture.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Light chrome from the hand; Ink on referents | Held pinch or trigger; Halo menu |
| Phone portal | Light chrome docked; same Ink | Hold dock button, draw with other finger |
| Desktop | Light chrome near cursor | Hold a key, drag |
| Still image or Quick Look | Ink flattened; no chrome | None |

## In Scope

- [ ] Choose a direction from the Direction Board with reactions recorded.
- [ ] Apply materials and one held-mode action across capture and viewer.
- [ ] A cross-device task test.

## Out Of Scope

- [ ] The full roadmap of section 7 of the concept; restyling every screen.

## Success Signals

- [ ] **Technical:** the same action works on Quest hands, controllers, phone, and desktop in end-to-end runs.
- [ ] **Learnability:** see the trial below.

## Risks And Open Questions

- [ ] Which look, and is the held-mode, two-handed grammar natural on every device?
- [ ] Legibility of thin Light chrome on bright AR backgrounds.

## Comparison And Learning

Task: after doing an action once in a headset, participants do it on a phone
without instruction. Compare new grammar with current UI. Measures: unaided
success and time. Continue if transfer works; revise idioms that fail on one device.

## Decision

Pending until explicitly decided. Drafting this document is not approval to
build. The portal view (PRD-002) was approved ahead of this redesign; its
evidence feeds the choice.

## Links

- Concept: [design language](../concepts/design-language.md)
- Research: [moodboard](../research/moodboard.md), [open questions](../research/open-questions.md) (question 17)
- Mockups:
  - [Direction Board](https://claude.ai/artifact/MtoVzHNaaxA3SPd5BuXgdc)
    (2026-10-19): four hologram-first directions, seven triggers for one action,
    reactions per card.
  - [HoloIM Moodboard](https://claude.ai/artifact/6ofHzWfmFmQTiQXBryNfMU)
    (2026-10-19): visual references; plain copy in the moodboard note.
  - [Light & Ink screens](https://claude.ai/artifact/C3h8MbK3YCcVKeiJd771S9)
    (earlier round): 14 screens of the Light direction over capture renders.
  - [Interactive grammar demo](https://claude.ai/artifact/DAjXaAk4QGmXxN1riUu5bp)
    (earlier round): the held-mode grammar.
- Feature brief: none
- Implementation issue: none
