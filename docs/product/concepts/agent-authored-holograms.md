# Agent-Authored Holograms

**Layers:** Event (a synthetic performance), Meaning (added, with exact
referents), View (unchanged: viewers watch it like any hologram).

**Source idea:** IDEA-076.
**Provenance:** User request, 2026-10-22: explore how agents can create
holograms from a prompt. Exploration only; no PRD or architecture is approved.

## The idea

A person, or another program, gives an agent a prompt such as "explain how to
reset this valve, at the valve" or "walk the new hire through the dashboard".
The agent returns a published hologram: a synthetic presenter with a voice,
placed in a scene, moving, pointing at and walking toward the things it names.
The agent is the author; the output is a normal hologram that plays in the
portal and the headset like a recorded one.

This is a different route to the same medium, not a video generator. The test
is whether the result is still an event with a body, a place, and referents.

## Why agents are good authors of the meaning layer

A human performance leaves pointing to be inferred from a finger or gaze ray
(IDEA-032). An agent that composes the scene already knows what "this" refers
to, so every reference is exact, with no false highlights. Exact referents are
what Follow (IDEA-041), spatial subtitles (IDEA-014), and the object-indexed
timeline (IDEA-044) need. The harder part for an agent is the Event layer:
movement and voice that look and sound like a person meaning it.

## Shape of the flow

1. **Prompt.** Intent, audience, and optional inputs: a model or scene (the
   IDEA-059 supplied object), a script, a place, a creator profile.
2. **Plan.** The agent writes a beat sheet: who stands where, what they point
   at, when. The prompter can read and correct it before anything renders.
3. **Compose.** A performer is driven through the plan: a stock or the
   prompter's own avatar, synthesized voice, gestures and pointing resolved
   against known objects, walking between viewpoints.
4. **Publish.** Through the same upload path as a captured hologram, so it
   shows in the feed and the portal with no special case.
5. **Revise.** "Slower", "point at the left valve first", "shorter" produce a
   new version, not a re-record (relates to IDEA-019 and IDEA-022).

## Interface

The hologram compositor is the product surface; prompting is one way in. An
agent-callable tool (a CLI command or MCP tool) that accepts a plan and
returns a published hologram lets any agent author, including coding agents
documenting their own work and agents in other products (IDEA-067). A person
typing a prompt in the app uses the same tool.

## Tensions

- **Authenticity.** A viewer must always see that nobody performed this.
  Provenance (IDEA-024) is mandatory from the first version: every body
  channel is marked synthesized, and the presenter is never shown as a real
  person's capture. Prompting as a real, named creator needs explicit
  consent and is out of scope until identity (IDEA-052) exists.
- **Uncanny motion.** Synthesized gestures that miss the words are worse than
  a plain avatar. A restrained performer (fewer, clearer gestures; pointing
  and walking only) may beat lifelike (IDEA-063) at first.
- **Accuracy.** An agent can confidently point at the wrong thing. The plan
  step and the preview are the review gates.
- **Hologram or slideshow.** If nothing in it depends on a place, a body, or
  a moment, it is a video and should not be built this way.

## Passes the hologram test?

1. Tied to the event: the beats are tied to a performer, objects, and places.
2. Read from the performance: references are exact by construction, and
   marked as synthesized rather than inferred.
3. Expresses intent, not a view: the plan says what matters and where; the
   viewer's device chooses the view.
4. Works on a flat phone: it is a normal hologram, so the portal applies.
5. Loses meaning as a video: only if the walkable, point-resolved scene is
   what carries the explanation. That is the first thing to test.

## Open questions

- Which prompt produces something a viewer prefers to a short video or a
  checklist? Start with one narrow case, such as a place-bound how-to.
- Is a synthetic presenter needed at all, or are voice, pointing marks, and
  moving viewpoints in the scene enough?
- Should the agent output a plan the author performs over (a script that
  guides a human recording, relating to IDEA-020) instead of a finished
  performance?
- What is the smallest plan format an agent can reliably write and a person
  can edit?

## First authored pieces (2026-11-09)

Four showcase holograms now exist as scene scripts in
`apps/capture/scripts/showcase/`. An agent wrote each scene by hand; this is
not the prompt, plan, compose flow above, and nobody speaks in them. They
were chosen to fail test 5 as hard as possible: each loses its point as a
video.

| Piece | Feeling | What a video would lose |
| --- | --- | --- |
| Walk beside light | Awe, loneliness | The Earth and Moon at 1 : 100,000,000 are a true 3.84 m apart, and light crosses at its real speed, 3 m/s at that scale. A frame shrinks the gap; here the gap is the room. |
| Two sides of a door | Ache | One person on each side of a closed door. Each side shows one; the viewer's own step finds the other. |
| Murmuration | Wonder | 480 starlings at true size. Outside it is one shape; at the standing spot it passes around your head. |
| Blue hour | Coziness | A miniature house at dusk. Each side hides something: a reader, a cat, a sleeper, lit roots. |

Build one with `pnpm --filter @holoim/capture run showcase:build <scene>`
(`light`, `door`, `murmuration`, `blue-hour`, and the second set's scenes
below); the GLB and a contact sheet
land in the ignored `output/showcase/`. `showcase:upload --api <origin>
<scene>` sends it through the normal upload route.

What building them showed:

- **Provenance has nowhere to show.** Each file says
  `asset.extras.holoim.authored = "synthetic"` and uploads as "Claude
  (agent-authored)", but the byline is the only place a viewer sees it. The
  authenticity rule above needs a visible mark (IDEA-024).
- **The portal cannot lean in.** Its closest view is 1.6 m from the anchor,
  made for a life-size author. A tabletop miniature cannot be inspected on a
  flat screen, so Blue hour is shown at 1:8 instead of its modelled 1:12.
- **True scale can read as empty on a card.** A file with no avatar is framed
  on its whole bounds, so the 12.7 cm Earth in a 3.84 m scene is a few
  pixels until the viewer zooms. The piece is made for a headset or AR.
- **Restraint held up.** The door's two figures are jointed mannequins of
  light with no faces, and the scene still reads; the open question about
  needing a lifelike presenter leans toward "not at first".

## Second set (2026-11-10)

Six more, pushed further from anything a camera could have recorded. Each
is built around one thing only the viewer's own position can do.

| Piece | Scene | Feeling | What the viewer's position does |
| --- | --- | --- | --- |
| From where you stand | `words` | A turn from loneliness to warmth | One sculpture of 895 bricks reads ALONE from the first view and LOVED a quarter turn to the right. |
| Walk around the year | `seasons` | Time passing through one place | One apple tree in all four seasons at once, a quarter each. Walking round it is walking through the year; a red scarf carries the story from the autumn branch to the snowman to the spring melt. |
| Three hearts | `hearts` | Awe, tenderness | A blue whale's heart (1.5 m), a person's and a hummingbird's at true size, beating at 4, 64 and 1,200 a minute. The whale's beat comes twice in the 30 s loop; the waiting is the point. |
| The shape the rain leaves | `rain` | Presence made of absence | Rain on an adult and a child with a red umbrella, neither of them drawn. Water stopping, clinging and running off shows them; from above, the dry ground does. |
| The sea in the bathtub | `bath` | Delight | A true-size clawfoot tub holding a storm: a paper boat, a kraken with the plug, a lighthouse tap, a thundercloud under the shower head. |
| Who holds the strings | `strings` | Vertigo | A puppet theatre from the front. Behind it the puppeteer; above the puppeteer, strings to a giant hand. One gesture passes down four levels, and at 9 s each one looks up at whoever holds it. |

What this set added to the findings above:

- **A piece that depends on the viewpoint must be built for the feed's
  exact first view.** The feed opens at yaw 18°, pitch 16°. The word
  sculpture is turned 18° and each brick is raised by `(u − w) · cell ·
  tan 16°`, so rows at different depths land on the same screen row from
  that tilt. Built for a level view, the letters broke.
- **Nothing can hide underneath.** The portal's pitch stops at −8°, so every
  reveal in this set is behind, above, inside or on the far side.
- **Compact and dense reads on a card.** All six stay within about 3.5 m and
  are filled; none has the empty-frame problem of Walk beside light.
- **An invisible subject needs help at card size.** Rain stopping in mid-air
  was not enough to show two people in a 300 px view; droplets clinging to
  the unseen bodies were added, which is closer to drawing them than the
  idea first intended.
- **The sound is one track for the whole piece.** It cannot follow the
  viewer, so Walk around the year plays one phrase per season in turn
  instead of the season being faced.
