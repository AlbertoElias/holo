# Phone Reality Capture

**Layers:** Event (the recorded place, objects, and people), View (how a
captured world is entered).

**Source idea:** IDEA-077.
**Provenance:** User request, 2026-10-22: capture 3D holograms of the real
world with a phone. Checked against the registry the same day: no existing
idea covers capturing real places or objects with a phone camera. Today's
capture records an avatar and scene authored in a headset; IDEA-046 and
PRD-046 exclude volumetric capture. Exploration only; no technology is chosen.

## The idea

Point a phone at a place, an object, or a person and walk around it. The
result is a hologram of what was really there, at true scale, that others can
enter through the portal, a phone in AR, or a headset. It can stand alone (the
event is the place) or become the scene a performance, or an agent-authored
hologram (IDEA-076), happens in.

## What the recording holds

- **Space and objects:** geometry and appearance of the surroundings, scaled
  to real size.
- **Motion:** a person or moving thing seen over time (much harder than a
  still place; a place or object first).
- **Voice and notes:** speaking while capturing is the narration; pointing at
  things while capturing links them (IDEA-032 applies to the phone camera too).

## Candidate approaches (to compare, not decided)

| Approach | Gives | Cost |
| --- | --- | --- |
| Depth sensor scan (LiDAR, ARKit or ARCore depth) | Fast room and object meshes at true scale | Only some phones; rough texture |
| Photogrammetry from the video | Detailed textured meshes of objects | Heavy processing, needs many views |
| Gaussian splats or neural fields | Photoreal looks from a walk-around | Viewer support, size, true-scale anchoring, no clean mesh |
| Phone AR session placing a performer in the real room | Real room as backdrop, no reconstruction | Not a captured room, only a pass-through |

The export path matters as much as the capture: whatever is captured must flow
through the existing GLTF export, upload, and render path, or extend the
contract on purpose.

## Tensions

- **Capture quality versus effort.** A scan that needs a careful five-minute
  sweep will not be a message; a sloppy one is not worth entering.
- **Event, not a view.** A walk-around reconstruction records the place but
  not the author's attention. The meaning layer (what they pointed at, where
  they stood) must be captured alongside.
- **Privacy.** Rooms, faces, and screens get captured by accident. Needs a
  review step and a rule for people who did not agree to be recorded.
- **Provenance.** A reconstruction is inferred from images; mark it so (IDEA-024).
- **Size.** Photoreal formats are large on a phone portal.

## Passes the hologram test?

1. Tied to the event: the place, objects, and moment are the event.
2. Read from the performance: pointing and walking paths come from the phone.
3. Expresses intent, not a view: the viewer chooses where to look.
4. Works on a flat phone: the portal is its natural home.
5. Loses meaning as a video: yes, if viewers can walk around and measure it.

## Open questions

- Which single case first: an object on a table, a room, or a short outdoor
  spot? What does the viewer do with it that a video or photo cannot?
- Can a depth-only scan on a LiDAR phone be good enough, before photogrammetry
  or splats are considered?
- Does the existing GLTF path carry the result, or does a splat need a
  second format?
