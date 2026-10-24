# Conversation Coverage And Provenance

**Reconciled:** 2026-10-18.
**Scope:** The user and assistant messages available in this task's inherited
conversation, plus product Markdown already in this worktree. This is a
coverage map, not a verbatim transcript or a new implementation queue.

## Source Limits

Some early user messages refer to prior assistant explanations whose full
text is absent here, including the explanation preceding "go for it" and the
original proposal for organizing Markdown. Do not reconstruct or quote that
missing content. Existing IDEA-001 through IDEA-044, the anchored-notes draft,
and the IDEA-031 design exploration are retained as repository material; their
presence does not prove the exact language of an unavailable chat message.

The design note links external direction boards and visual prototypes. Those
links are preserved, but their contents were not retrieved or archived in this
task. Research traditions are leads, not verified citations. No external
browsing was used for this reconciliation.

Earlier code audits and test claims are historical observations. No current
runtime audit is implied. The old separate-project paths, old CI/port issue,
claims of absent controls, and references to then-in-flight work must not be
treated as today's state; use current source, feature briefs, and trackers.

## Integration With Newer Repository Decisions

During integration, main gained an agreed event/meaning/view lens, portal view
as IDEA-045, and a Parked decision for PRD-001. These are preserved as current
authority. The earlier visible conversation called the PRD a draft and suggested
an object explanation; those statements are historical, not a rollback of the
newer decision. See [what a hologram is](../concepts/what-a-hologram-is.md).
New unpublished ideas were assigned IDEA-046 through IDEA-069 to avoid
colliding with portal IDEA-045. Existing IDs 001-045 keep their current meanings.
The moodboard and its references from the newer task are retained.

## Coverage Map

| Available discussion group | Durable home / stable IDs | Interpretation preserved |
| --- | --- | --- |
| Understand the project, usefulness, missing features, directions | [Vision](../VISION.md), [portfolio](../concepts/product-directions.md), IDEA-064 through IDEA-067 | Questions and possible audiences, not a selected market |
| Earlier pasted POC-to-product plan, baseline, architecture, gaps, 90-day phases | [Historical proposal](historical-productization-plan.md), [creator pipeline](../concepts/creator-pipeline.md) | Historical proposal; later explicit brainstorming redirect supersedes the implementation request |
| Record/export/upload/view; rapid creator iteration; AR/VR team demos; browser/Android/iOS playback; deterministic XR regression | [Historical proposal](historical-productization-plan.md), [portfolio](../concepts/product-directions.md) | Proposed uses and earlier technical baseline, not proof of adoption or present support |
| Direct publish and title/creator/tags; share/detail route | [Creator pipeline](../concepts/creator-pipeline.md), [viewer](../concepts/viewer-experience.md), IDEA-046, IDEA-058 | Separate creation/distribution ideas |
| Metadata, thumbnails, durable conversion jobs | [Creator pipeline](../concepts/creator-pipeline.md), IDEA-048 through IDEA-050 | Proposed asset lifecycle, distinct from product knowledge states |
| Text search, tags, filters, profiles, engagement, stable pagination | [Creator pipeline](../concepts/creator-pipeline.md), IDEA-051 | Discovery options; engagement has no established priority |
| Auth/ownership, moderation/report/hide/admin review, abuse controls and quotas | [Creator pipeline](../concepts/creator-pipeline.md), IDEA-052, IDEA-053, IDEA-055 | Trust capabilities to scope to a real workflow |
| Local storage/SQLite concerns; object storage/CDN/signed URLs; logs, metrics, dashboards, SLIs/SLOs | [Creator pipeline](../concepts/creator-pipeline.md), IDEA-054, IDEA-056; [historical proposal](historical-productization-plan.md) | Hardening suggestions, not a migration commitment |
| DTO additions, upload 202, status/list/report endpoints, USDZ compatibility; upload/process/pagination/load/timeout/E2E tests | [Historical proposal](historical-productization-plan.md) | Exact suggested surface retained as historical; no API authorization inferred |
| Ports/env/docs drift, doctor, deterministic CI ports, tsgo strategy, shared ESLint | [Historical proposal](historical-productization-plan.md); canonical [agent contract](../../../AGENT_CONTRACT.md) | Earlier tooling recommendations; current policy remains elsewhere |
| Explicit shift away from implementation to communication brainstorming; ask whether editing/viewer features are needed | [Approach](../APPROACH.md), [authoring](../concepts/hologram-authoring.md), [viewer](../concepts/viewer-experience.md) | Explore usefulness before committing feature scope |
| What contextual annotation means | [Async concepts](../concepts/async-holograms.md), IDEA-002, [original draft, now Parked PRD-001](../prds/PRD-001-anchored-notes.md) | Referent + context/time, not merely flat captions; unavailable original response not invented |
| Avatars discussing in VR, spawning/animating objects, inventing unique 3D symbols | [Spatial language](../concepts/spatial-language.md), [live dialogue](../concepts/live-vr-ar-dialogue.md), IDEA-003, IDEA-004, IDEA-009, IDEA-061, IDEA-062 | Shared construction of meaning; no realtime platform commitment |
| AR people seeing one another while using virtual worlds; remote portals, scale, eye line, shared attention | [Live dialogue](../concepts/live-vr-ar-dialogue.md), [embodiment](../concepts/embodied-communication.md), IDEA-007, IDEA-008, IDEA-010, IDEA-011, IDEA-013 through IDEA-015 | Co-located AR and remote co-presence remain distinct cases |
| Holograms as async live communication, inspectable replay, questions/replies, branches, checkpoints | [Async](../concepts/async-holograms.md), IDEA-016 through IDEA-019, IDEA-026, IDEA-029 | Vision for continuity, not claim of implemented semantic recording |
| Lifelike avatars or captured real people in AR, expression, felt presence, emotional power | [Embodiment](../concepts/embodied-communication.md), IDEA-011, IDEA-012, IDEA-024, IDEA-028, IDEA-063 | Fidelity, authenticity, and benefit remain questions |
| Improve the message during creation and with editing afterwards | [Authoring](../concepts/hologram-authoring.md), IDEA-020 through IDEA-023, IDEA-062, IDEA-069 | Ghost overlays, segment retakes, cuts/sequencing, overdubs/layers, clarity suggestions, minimal review/trim |
| Text, images, video, animation and other media inside holograms | [Authoring](../concepts/hologram-authoring.md), IDEA-061 | Mixed-media content distinguished from editor operations (IDEA-022) |
| Old papers, communication theory, bicycle for the mind, cross-disciplinary combinations | [Research leads](research-leads.md), [open questions](open-questions.md), [Approach](../APPROACH.md) | Research agenda and inspiration, not verified literature or claims |
| Existing deeper communication proposals | [Protocols](../concepts/communication-protocols.md), IDEA-001, IDEA-005 through IDEA-008, IDEA-027, IDEA-030 | HoloGrammar, Claim Capsules, Understanding Mirror, grounding, Reference Lock, decision/task tokens, audience simulation retained without invented chat provenance |
| Analytics, role overlays, provenance, semantic versions, spatial collections and memory | [Async](../concepts/async-holograms.md), [live dialogue](../concepts/live-vr-ar-dialogue.md), [embodiment](../concepts/embodied-communication.md), IDEA-010, IDEA-019, IDEA-024, IDEA-025, IDEA-026, IDEA-029 | Supporting hypotheses; analytics do not prove understanding |
| Keep every seed, deepen selected ideas in PRD-like documents, use Markdown, commit the original knowledge setup | [Knowledge-system README](../README.md), [registry](../IDEAS.md), [PRD template](../prds/PRD-TEMPLATE.md) | Repo knowledge remains authoritative; that prior commit request does not create a product approval |
| Founder review: vision, brainstorm, selection, building with agents; challenge feature-platform framing | [Approach](../APPROACH.md), [Vision](../VISION.md) | Build a learning process around actual communication tasks |
| Founder review: existing pipeline as experiment instrument; avoid premature universal grammar/full editor/realtime/photo-real platform | [Approach](../APPROACH.md), [protocols](../concepts/communication-protocols.md) | Architectural caution, not a permanent ban on these directions |
| Founder review: twelve-month ambition, hypotheses/outcomes, first-hour user/job/control and later integration/evaluation questions | [Vision](../VISION.md), [Approach](../APPROACH.md) | Long-term aspiration and sequencing guidance, not dated delivery estimates |
| Founder review suggested Scope Expansion, with Hold Scope or Scope Reduction alternatives | [Review posture](#review-posture) below | No visible selection or approval of a scope mode |
| Later restart recommendation: spatial understanding, presence, shared thinking; async first | [Vision](../VISION.md), [Approach](../APPROACH.md) | Three promises retained; spatial understanding is a recommended starting point |
| Explain with an object; assembly/mechanism/room tasks; capture motion, inspect viewpoint, send a message | [Approach](../APPROACH.md), [spatial language](../concepts/spatial-language.md), IDEA-059, IDEA-060, IDEA-058 | Recommended first experiment, not a decision or a replacement of PRD-001 |
| Lightweight edit first; add retakes when real mistakes justify them; share URL then direct publish when needed | [Authoring](../concepts/hologram-authoring.md), [Approach](../APPROACH.md), IDEA-069, IDEA-021, IDEA-058, IDEA-046 | Sequence based on observed friction, not a queued feature list |
| Selection questions rather than false numerical precision; fair video comparison; concrete follow-up task | [Approach](../APPROACH.md), [open questions](open-questions.md) | Task errors, clarification, time, author effort, connection and repeat use; small trials have limits |
| Human judgment, lead, implementer, independent verifier, exclusive ownership, original acceptance criteria and artifacts | [Approach](../APPROACH.md); canonical [feature workflow](../../FEATURE_WORKFLOW.md) | Technical acceptance separate from product evidence; no duplicate agent process authority |
| Resume/checkpoint existing work before first feature | [Approach](../APPROACH.md); [feature index](../../features/README.md) | Inspect current owning files; old uncommitted-work/CI status assertions are not refreshed by this archive |
| Existing cross-device design exploration and additional annotation/viewer ideas | [IDEA-031 design](../concepts/design-language.md), [viewer](../concepts/viewer-experience.md), IDEA-032 through IDEA-044 | Preserved repository content; visual direction, parity rules, held modes and first slice remain explorations |
| Requested mini app: main thinking page, idea list with detail/PRDs, separate wiki, open bugs, read only | [Atlas concept](../concepts/knowledge-atlas.md), IDEA-068, [README authority](../README.md) | Current user-authorized app task; delivery authority belongs to its feature brief, not a fabricated PRD decision |
| Failure handling in learning: no recipient, broken workflow, ambiguous result | [Approach](../APPROACH.md), [open question 19](open-questions.md) | Record blocked/inconclusive observations with source links; do not claim the idea failed |

## Review Posture

The visible founder-review response recommended Scope Expansion of the learning
process. Hold Scope would operationalize the existing idea-to-PRD process;
Scope Reduction would choose one task and minimal experiment. The conversation
contains no visible answer selecting a mode. All are planning alternatives,
not approval gates to re-impose on already authorized work.

## Reconciliation Decisions

- Preserve every existing identifier, the current Parked PRD-001 decision, and the IDEA-031 design
  exploration. Add IDEA-046 through IDEA-069 for distinct missing capabilities
  and directions. Related ideas link to each other without renumbering.
- Preserve the historical 90-day proposal rather than deleting it or treating
  all of its gaps as current. Later brainstorming changes the framing; the
  object-explanation recommendation is also not an approved roadmap.
- Use only the current three-state lifecycle: Idea -> PRD -> Decision. Earlier
  descriptions with Concept, Research, or Experiment as extra stages do not
  override the current source of truth.
- Keep open defects in [BUGS.md](../../../BUGS.md), committed queue in
  [TODOS.md](../../../TODOS.md), and in-flight work in its feature brief. Product
  knowledge and the atlas link to those owners rather than duplicating status.

This document covers available material; it cannot certify the contents of
messages, artifacts, or research sources that were not accessible in the task.
