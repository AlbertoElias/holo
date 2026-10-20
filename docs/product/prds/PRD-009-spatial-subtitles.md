# PRD: Spatial subtitles bound to referents

**Status:** Draft  
**Source ideas:** IDEA-014  
**Layer:** Meaning (read)  
**Depends on:** IDEA-032 (resolved referents), speech transcription  
**Owner:** Unassigned  
**Last updated:** 2026-10-20

## User Outcome

Before: a viewer who cannot hear the audio, or misses a word, reads a caption
at the bottom of the screen that says "this one" without saying which one.
After: the words appear near the speaker, and words like "this" and "that" are
linked to the thing the author pointed at, so a viewer reading without sound
still knows what was meant.

## Problem

Captions solve hearing but not reference. In holograms the referent is
usually known from the body (IDEA-032), so the caption can carry it. This also
serves viewers in public places with sound off.

## Primary User And Moment

A recipient on a phone, sound off, watching an explanation full of "this" and
"over here". Live AR use is the long-term case; the async hologram comes first
because the pipeline already exists.

## Proposed Interaction

- Speech is transcribed after recording, with word timings.
- Subtitles float near the speaker's head, facing the viewer.
- Deictic words ("this", "that", "here") that coincide with a resolved pointing
  link are underlined and linked to the referent's highlight.

## Why Holograms

A video caption cannot link "this" to anything. Here the link is read from the
body, so the author does nothing. Fair comparison: the same hologram with
ordinary bottom-of-screen captions.

- **Anchored to the event:** near the speaker's head; links to referents.
- **Read from the body:** words from speech, links from pointing.
- **Intent, not a view:** each device places text for legibility.
- **Works on a flat phone:** text stays in a readable band near the speaker.
- **Lost as a video:** the word-to-referent link.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Text near the speaker; linked words glow with the referent | Subtitles toggle |
| Phone portal | Text in a band near the speaker, clamped on screen | Same toggle |
| Desktop | Same as phone | Same |
| Still image or Quick Look | Dropped | None |

## In Scope

- [ ] Transcription with word timings for uploaded holograms.
- [ ] Speaker-anchored subtitles on phone and desktop.
- [ ] Linking deictic words to IDEA-032 referents.

## Out Of Scope

- [ ] Live AR subtitles; translation.

## Success Signals

- [ ] **Technical:** subtitles stay within 200 ms of speech and on screen at phone width.
- [ ] **Communication:** see the trial below.

## Risks And Open Questions

- [ ] Transcription cost and where it runs.
- [ ] Visual overload: subtitles plus highlights on a small card.

## Comparison And Learning

Task: identify the referent of three "this" phrases with sound off. At least
five recipients, spatial subtitles versus ordinary captions. Measures: correct
referents and time. Continue if linked subtitles improve accuracy; park if
ordinary captions plus pointing highlights alone perform the same.

## Decision

Pending until explicitly decided. Drafting this document is not approval to
build. Recommended sequencing: after IDEA-032.

## Links

- Concept: [live VR and AR dialogue](../concepts/live-vr-ar-dialogue.md)
- Research: [open questions](../research/open-questions.md) (question 7)
- Related PRDs: [PRD-022 self-resolving pointing](PRD-022-self-resolving-pointing.md)
- Mockups: none
- Feature brief: none
- Implementation issue: none
