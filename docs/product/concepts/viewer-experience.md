# Recipient Experience

**Layers:** View; related meaning and conversation capabilities are identified separately.

**Status:** Supporting ideas and design questions; no implementation commitment.

The recipient needs to understand what the author means, orient themselves,
inspect a moment, and recover after exploring. A feed is one way to discover
messages; it is not the whole communication experience.

The current [agreed lens](what-a-hologram-is.md) makes portal viewing
(IDEA-045) and Follow/Free the organizing model. Controls below are related
possibilities within that model, not a competing fixed-camera player.

## Core Controls And Delivery

IDEA-060 covers synchronized pause/resume of speech, performance, objects, and
marks, with viewpoint inspection and a return to a useful view. Scrubbing is
an option to validate, especially when authors refer to a particular moment.
IDEA-043 is its narrower flat-screen interaction: freeze to orbit. IDEA-058
adds a dedicated detail/share URL with an opening view that makes an unfamiliar
message understandable. Neither requires choosing a public social feed.

Recipient interaction should preserve the distinction between exploring a
recorded scene and modifying the author's message. Branching (IDEA-016),
checkpoints (IDEA-017), anchored replies (IDEA-018), semantic version comparison
(IDEA-019), inbox/collections (IDEA-026), and memory palaces (IDEA-029) extend
that experience; see [async holograms](async-holograms.md).

## Hologram-Native Annotation And Guidance

The existing IDEA-032 through IDEA-044 remain separate explorations:

| Ideas | Possibility | Question to preserve |
| --- | --- | --- |
| IDEA-032 | Highlight the thing a pointing or gaze ray hits | How do we prevent false references? |
| IDEA-033 | Leave hand-path ribbons at real scale and speed | When does a trace become clutter? |
| IDEA-034 | Show real distances from size/height gestures | Is a gesture measurement or ordinary emphasis? |
| IDEA-035 | Mark where the recipient should stand | How does a suggested viewpoint translate to a phone? |
| IDEA-036 | Directional sound or a playback wait for missed action | How do we cue attention without coercing it? |
| IDEA-037 | Play a place-based note on approach | How does proximity relate to recorded time? |
| IDEA-038 | Leave ghost copies at meaningful poses | Which poses are worth preserving? |
| IDEA-039 | Offer an author's-eye view or attention cone | Is a viewpoint change useful and comfortable? |
| IDEA-040 | Compare a recipient's movement with the demonstration | What evidence is reliable enough for feedback? |
| IDEA-041 | Frame flat-screen playback around the author's attention | How much automatic motion can people tolerate? |
| IDEA-042 | Use phone tilt as a window into the scene | Does parallax justify permissions and device friction? |
| IDEA-043 | Freeze time and orbit | Is the interaction discoverable? |
| IDEA-044 | Navigate moments by selecting an object | What if pointing data is absent or ambiguous? |

These expand [contextual annotation](async-holograms.md) beyond text labels.
They are not requirements for [parked PRD-001](../prds/PRD-001-anchored-notes.md).
The [design exploration](design-language.md) proposes cross-device idioms;
its precise controls and appearance still need selection and validation.

## Configurable Bubble Size And Device Fit

IDEA-070. Today the bubble is one fixed sphere (6 m radius at capture;
see [bubble rendering](../../BUBBLE_RENDERING.md)). Different messages want
different bubbles: a person explaining a coat is tall and narrow, a painter
filling a wall is wide, a product demo is tabletop-sized. The author picks a
preset (portrait, tabletop, room, wide stage) or adjusts extents, and the
choice is stored with the hologram so every viewer reads the same boundary.
Mockups: [portrait](../mockups/bubble-shape-portrait-dana.webp),
[landscape](../mockups/bubble-shape-landscape-sketchbook.webp).

True scale never changes (see [what a hologram is](what-a-hologram-is.md)); the
bubble sets what is recorded and what the viewer can see, and each device
chooses a framing, not a different size:

| Device | Fit behavior to validate |
| --- | --- |
| Phone portal | Opening camera distance is computed from the bubble extents, field of view, and screen aspect, so a tall bubble fills a portrait phone and a wide one a landscape phone. A mismatch (wide bubble, portrait phone) pulls the camera back or relies on Follow rather than cropping the subject. Tilt and orbit stay inside the bubble's outer edge. |
| Desktop feed | The card takes the bubble's silhouette and aspect (as in the mockups) within a bounded height; opening it frames the whole bubble first. |
| Headset | Room-scale bubbles are walked into at life size; the viewer needs enough free space, so show the footprint before placement and offer a smaller option if the guardian is too small. |
| Phone AR | Placement checks free floor against the footprint. When it does not fit, offer a clearly labelled tabletop miniature, never a silent rescale, since a rescaled body breaks the recorded event. |
| iOS Quick Look | Sphere clipping may be the only supported shape; document the approximation for other shapes rather than assume parity. |

Open design questions:

- Does the clipping contract extend from a sphere to capsule or box shapes?
  Nonuniform scale currently produces ellipsoids that are not covered.
- Capture side: the sampled scene volume sets file size and polygon cost, so
  larger bubbles need a budget, and the author's play space limits what can be
  recorded at all.
- Can the bubble size be changed after recording (crop smaller, never larger),
  and does the editor ([IDEA-022](../IDEAS.md)) own that?

## Access And Evaluation

Keep a capable desktop/phone path so a recipient can understand a message
without an XR headset. Evaluate AR scale, placement, legibility, attention,
audio, and orientation separately from flat-screen use. WebXR and iOS Quick
Look may support different interactions; show limitations honestly rather
than assuming every layer survives format conversion.

Observe comprehension and task performance as well as control use. Replaying,
pausing, or looking at an object can indicate interest or confusion; IDEA-025
meaning heatmaps are an inference to investigate, not a comprehension score.
