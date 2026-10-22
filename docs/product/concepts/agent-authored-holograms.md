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
