# PRD: Portal view

**Status:** Approved  
**Source ideas:** IDEA-045 (includes IDEA-042, IDEA-043), IDEA-060  
**Owner:** Alberto Elias  
**Last updated:** 2026-10-19

## Decision

Approved 2026-10-19 by Alberto Elias, as its own experiment ahead of the UI
redesign: evidence from it decides how flat-screen viewing moves, and the
redesign styles it afterwards. It is first because every other flat-screen idea
(pointing highlights, the Follow camera, ghost frames, the object timeline) is
shown through it, and because it is the cheapest direct test of the claim in
[what a hologram is](../concepts/what-a-hologram-is.md): a hologram can be
moved through in time *and in space*.

Default variant, 2026-10-20: after trying the portal, Alberto chose looking
around while the hologram plays (`drag`) as the default. `freeze` and `tilt`
remain available with `?portal=` for the trial. On desktop the plain mouse
wheel still scrolls the feed while playing; trackpad pinch and +/- zoom.

## User Outcome

Before: on a phone or computer, a hologram is a looping clip seen from one
fixed, automatic camera. The viewer cannot stop it or look from another side,
so it behaves like a video.
After: the viewer can freeze any moment and look around it, move in close
enough to stand inside the scene or back out until the hologram is an object,
and return to the author's framing with one action.

## Problem

Spatial explanations fail when the one view hides what matters: the thing the
author points at is behind them, two candidates line up from this angle, or a
distance cannot be judged from the front. Today the viewer has no recovery
except rewatching the same view. The feed also gives no sense that there is a
world behind the screen, which is why typed notes on it read as captions on a
video (see the [PRD-001 decision](PRD-001-anchored-notes.md)).

## Primary User And Moment

A recipient on a phone, or at a computer, opens a hologram someone recorded
in VR. It is the moment the explanation refers to something spatial ("this
one", "from here", "about this far") and the recipient wants to check it.

## Proposed Interaction

The screen is a portal into the hologram's world.

- **Follow (default):** today's automatic framing, while the hologram plays.
- **Free:** any look-around gesture switches to Free. The camera orbits a
  focus point on the author; zoom runs on one continuum from inside the scene
  (eye height, near the author, the world fills the card) out to third person
  (the bubble seen as an object). True scale never changes; only the camera
  moves.
- **Pause opens the space:** paused, time stops and the moment stays fully
  explorable.
- **Return:** one control goes back to Follow at the current moment.

Three interaction variants, compared before one becomes the default:

| Variant | Phone | Computer | Why try it |
| --- | --- | --- | --- |
| **Freeze to orbit** | Tap pauses; while paused one finger orbits and two fingers zoom; vertical swipes scroll the feed only while playing | Click pauses; drag orbits; wheel or pinch zooms | Clean split between browsing and exploring; matches "pausing opens up the space" |
| **Drag while playing** | Sideways drag orbits at any time, vertical swipes still scroll; pinch zooms | Drag orbits; ctrl+wheel or pinch zooms | Fastest to discover; tests whether exploration needs pausing |
| **Tilt** | Turning the phone turns the camera (after the iOS motion prompt); pinch zooms | Same as drag | Tests whether moving the device feels like a window, the closest flat-screen idiom to a headset |

## Why Holograms

A video stores one camera's view; every other angle is gone. A hologram stores
the event, so the view can be made at playback. If viewers do not use that
freedom, or it does not help them, the medium's core claim is weaker than we
think, and that must be known before investing in the meaning layer.

## In Scope

- [ ] Free and Follow modes on feed cards, phone and desktop.
- [ ] Freeze, orbit, the zoom continuum, and Return.
- [ ] The three variants above, chosen by a URL parameter and a dev control.
- [ ] Phone orientation as a trigger, including the iOS permission flow.
- [ ] Feed browsing keeps working: no gesture trap, inactive cards reset.
- [ ] An end-to-end check on a real capture export, with screenshots.
- [ ] A small recipient trial (below), recorded in this PRD.

## Out Of Scope

- [ ] Moving the phone through space with WebXR tracking (needs an AR session;
  the existing AR view stays as is).
- [ ] An intelligent Follow camera that reacts to pointing (IDEA-041; needs
  IDEA-032).
- [ ] Scrubbing and a timeline (IDEA-060 beyond pause and resume).
- [ ] Headset viewing, the meaning layer, and the visual redesign.
- [ ] Quick Look on iPhone, which stays a flattened preview.

## Success Signals

Written before testing, per the [approach](../APPROACH.md):

- [ ] **Technical:** on a real capture export, pause stops time, orbit keeps
  the camera's distance from the focus, zoom reaches inside the bubble and back
  out, Return restores the Follow framing, and vertical feed scrolling still
  works on a phone viewport.
- [ ] **Trial (at least 5 recipients, one real spatial explanation):** each
  recipient watches on their own phone, either through the portal or as a
  screen recording of the same hologram, then does an observable task (which
  object, where to stand, how far). Continue if portal recipients answer more
  correctly or explore without prompting; revise if they never discover the
  look-around gesture; park if there is no difference.
- [ ] **Variant pick:** the default is the variant recipients discover and
  use without a hint, with the fewest accidental feed scrolls.

## Risks And Open Questions

- [ ] **Gesture conflict with the vertical feed.** The variants exist to
  answer this.
- [ ] **iPhone motion permission** may cost more than tilt is worth (IDEA-042's
  question).
- [ ] **Seeing outside the recorded bubble.** The world fades at the bubble's
  edge; looking outward from inside may show emptiness. Zoom limits must keep
  the view meaningful.
- [ ] **Test content** needs a real recording where space matters, made on
  the headset by the author (shared with the hand-tracking recording session).

## Links

- Concept: [what a hologram is](../concepts/what-a-hologram-is.md),
  [viewer experience](../concepts/viewer-experience.md)
- Research: [`../research/open-questions.md`](../research/open-questions.md) (question 9)
- Mockups: working prototype screenshots, 2026-10-19:
  [`portal-view.jpg`](../../features/evidence/portal-view.jpg) (desktop Follow,
  orbit, and inside; phone Follow, pinched in, drag variant, tilt variant), from
  a real capture export
- Feature brief: [`../../features/portal-view.md`](../../features/portal-view.md)
- Implementation issue: none
