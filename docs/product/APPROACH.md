# How We Think And Build

This is a recommended working method derived from the conversation. It does
not approve a market, first feature, architecture, or dated roadmap. The current
product lifecycle is [Idea -> PRD -> Decision](README.md), and delivery follows
the [canonical owning-file workflow](../FEATURE_WORKFLOW.md).

## Current Agreed Lens

Read [what a hologram is](concepts/what-a-hologram-is.md) first. The current
working philosophy separates event, meaning, and view; preserves true scale
and recorded/inferred/added provenance; and prioritizes faithful events, portal
viewing (IDEA-045), and meaning read from the body (IDEA-032). PRD-001 is
[Parked](prds/PRD-001-anchored-notes.md). Those newer recorded decisions take
precedence over earlier candidate sequences retained below.

## Start With A Communication Problem

HoloIM explores communication through people, objects, space, and time. The
recording and viewing pipeline is an instrument for learning when that helps.
Choose a real speaker, recipient, and task before defining a feature.

Describe an actual failure: the recipient could not tell which part was meant,
could not reproduce a movement, missed a relationship, needed repeated
clarification, or did not feel the speaker's presence. Name the current
alternative: text, an image, video, slides, a screen recording, or a call.
Some tasks will remain easier in those media.

## Develop The Vision

Keep the [vision](VISION.md) ambitious enough to include live VR, live AR, and
asynchronous holograms. Distinguish three promises: spatial understanding,
human presence, and shared thinking. For each, keep examples, assumptions,
observable outcomes, and evidence that would change our minds.

Revisit the thesis after experiments. Do not equate uploads, realism, visual
complexity, or feature count with successful communication. Better outcomes
could mean fewer clarification exchanges, improved recall, faster handoffs,
better task performance, stronger connection, or more expressive discussion.

## Brainstorm Broadly

Capture seeds in [IDEAS.md](IDEAS.md) with stable IDs; develop related language
in the [concept wiki](concepts/README.md). Contradictory proposals can coexist.
Separate generating possibilities from selecting the next experiment.

Useful combinations to explore:

- Communication act: explain, demonstrate, persuade, express, question,
  compare, repair misunderstanding, coordinate, decide, or hand off.
- Medium property: embodiment, real scale, manipulable objects, viewpoint,
  spatial reference, time, shared attention, or presence.
- Situation: live VR, live AR beside real people, remote co-presence, async
  message, or a desktop/phone participant without a headset.
- Inspiration: conversation research, gesture, theater, comics, animation,
  music, diagrams, games, simulation, programming, and tools for thinking.

For example, combine a repair question with an object and time anchor; combine
an abstract disagreement with two spatial alternatives; combine a movement
demonstration with persistent hand paths. Text, images, video, charts, sound,
and animation can be layers inside a holographic message.

Research traditions are [leads to investigate](research/research-leads.md), not
evidence that our designs work. Do not attribute an invented proposal to a paper.

## Select What To Try

Compare a small shortlist using the same questions rather than assigning
precise scores to guesses:

| Question | What a promising answer contains |
| --- | --- |
| Who has this problem repeatedly? | A reachable speaker and recipient with a real task |
| Why this medium? | A concrete role for embodiment, space, interaction, or presence |
| What is the smallest believable experience? | One observable interaction and outcome |
| What can we reuse or simulate? | The existing record -> export -> upload -> view loop, manual setup, or a disposable prototype |
| What do we learn? | A result that distinguishes competing explanations |
| What does it cost? | Author effort, recipient friction, device access, and engineering uncertainty |
| What changes the decision? | Continue, revise, or park criteria written before the trial |

Keep the wider portfolio visible. A feature with learning value and reusable
primitives can be worthwhile before a market is settled. Avoid committing to
realtime multiplayer, a full editor, universal grammar/schema, photoreal capture,
or platform infrastructure merely because those appear in the long-term vision.
If one is necessary for the chosen task, state why in its PRD.

## Earlier Candidate Experiment: Explain With An Object

This is a recommendation from the later discussion (IDEA-059), not an approved
replacement for current priorities. [PRD-001](prds/PRD-001-anchored-notes.md)
is now Parked under the agreed lens. An object explanation remains a candidate
experiment, evaluated through that lens and alongside portal/body-first work;
this historical recommendation does not reopen notes or select a new feature.

Choose an explanation such as assembling two parts, showing a mechanism's
movement, or arranging a room. The author stands beside a supplied model,
moves or rotates it while speaking, and points out a relationship. The recipient
watches, pauses, and changes viewpoint to inspect the explanation.

Suggested progression, to scope only after choosing a task:

1. Make and watch a recording with the existing apps on a headset and an
   ordinary browser. Identify the friction that actually blocks the message.
2. Try one supplied manipulable object; preserve its motion over time through
   export and playback. Do not assume static scene capture already does this.
3. Give the recipient synchronized pause/resume, viewpoint inspection, and a
   useful return view. Add scrubbing if the task requires it.
4. Make the message easy to send through a dedicated URL. Add direct publishing
   when export/upload friction obstructs repeat use.

This progression is not an engineering queue. Inspect the current implementation
before claiming a capability is missing; earlier conversation audits are dated.

## Compare And Evaluate

Use a decent alternative explanation of the same task, such as a video, rather
than a deliberately weak control. Keep content, preparation effort, and task
difficulty comparable. Counterbalance viewing order or use different equivalent
tasks where prior exposure would teach the answer.

Ask recipients to do something observable: assemble the parts, reproduce an
arrangement, identify a spot and moment, or explain the mechanism back. Record
errors, clarification questions, time, author effort, and voluntary repeat use.
For presence-focused work, also ask about connection and authenticity; those
answers do not substitute for comprehension measures.

Write expectations and continue/revise/park criteria before testing. A few
sessions can reveal breakdowns and guide iteration; they cannot establish broad
superiority over video. Replay counts and pauses alone do not prove understanding.
AI audience simulation can suggest problems but cannot stand in for recipients.

Keep the hypothesis, comparison, observations, limits, and resulting decision
with the relevant PRD or linked research note. These are activities within the
three-state lifecycle, not extra states or a parallel delivery tracker.

### When A Trial Cannot Answer The Question

Record an observation as blocked or inconclusive when the recipient is
unavailable, the workflow fails technically, the comparison is unfair, or the
evidence cannot distinguish benefit from noise. State what was attempted,
which source/artifact supports the observation, what remains unknown, and the
next condition needed to retry. These are observation labels, not new idea
states. A broken recording/export/playback path does not establish failure of
the communication idea; an unavailable recipient provides no recipient evidence.
Report a reproducible technical defect through its canonical owning file and
link it rather than duplicating the bug in product notes. A later decision
may still park the idea for cost or access reasons, with that rationale explicit.

## Build With Agents

Use the roles and delivery sequence in [FEATURE_WORKFLOW.md](../FEATURE_WORKFLOW.md),
and commands in [AGENT_CONTRACT.md](../../AGENT_CONTRACT.md). The human supplies
the real communication example, product judgment, and observations of recipients.
The lead owns a bounded brief and integration; a design reviewer challenges the
plan; implementers work within exclusive ownership; an independent verifier
tests the original criteria and produces inspectable evidence.

Give agents a user outcome, exclusions, agreed interfaces, file ownership,
failure cases, acceptance criteria, and evidence expectations. Shared contracts
have one integrator. Parallelize independent work; preserve other agents' edits
and coordinate shared ports and databases. Follow current repository worktree
and Git rules rather than copying them into each product note.

Separate technical acceptance from product evidence. "Object motion survives
export and playback" may pass while "this helped someone understand" remains
unknown. Prefer the real end-to-end flow and reproducible artifacts. Emulation
does not establish physical tracking feel, comfort, or device performance.

## Approval Boundaries

- Capturing an idea, elaborating a concept, recommending an experiment, or
  drafting a PRD does not authorize feature implementation.
- Record a product approval or parking decision, with rationale, in the PRD.
  Draft and Review are PRD statuses within the PRD state; Approved and Parked
  record the Decision state. Approval must come from explicit user direction
  or authorization already present in the task, not an agent's preference.
- Approved queued engineering work belongs in `TODOS.md`. Once in flight, its
  feature brief owns scope, evidence, and progress. Do not mirror either here.
- Within authorized work, agents make routine reversible choices and complete
  validation and fixes without repeatedly asking. Material scope changes go
  to the lead; unresolved product choices remain visible rather than silently
  becoming requirements.
- Publishing to external services, messaging others, and consequential actions
  follow explicit task authorization and repository policy. Permission to
  brainstorm does not grant permission to release a product.
- The knowledge atlas reads Markdown; it cannot approve ideas, change statuses,
  author PRDs, or become a separate source of truth.
