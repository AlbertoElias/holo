# Idea Registry

This is the canonical inbox for uncommitted product ideas. An entry becomes a
PRD only after it describes one bounded user outcome and has a reason to exist.

Each idea names its layer from [what a hologram is](concepts/what-a-hologram-is.md):

- **Event:** what is recorded (body, voice, scene, time, true scale).
- **Meaning (read):** what the system makes explicit from the body.
- **Meaning (added):** what the author or a participant adds on purpose.
- **View:** how a viewer and their device move through and show the hologram.
- **Conversation:** events placed inside or beside other events (replies,
  live sessions, threads).
- **All layers:** shared systems that serve every layer.

| ID | Idea | Layer | Theme | State | Next question |
| --- | --- | --- | --- | --- | --- |
| IDEA-001 | HoloGrammar: the schema of the meaning layer; each utterance has intent, a referent in the event, an action in space, a time scope, confidence, an expected reply, and provenance | Meaning (added) | Communication protocols | Idea | What is the smallest grammar that marks read from the body already fill? |
| IDEA-002 | Notes the author adds, anchored to a person, object, or place for a moment, for what the body could not say | Meaning (added) | Async holograms | Parked PRD ([PRD-001](prds/PRD-001-anchored-notes.md)) | Which notes can only the author add, after pointing (IDEA-032) is read from the body? |
| IDEA-003 | Symbol Forge for team-created, interactive 3D symbols placed on referents | Meaning (added) | Spatial language | Idea | What eight symbols are universally useful, and how does each look on a flat phone? |
| IDEA-004 | Gesture Compiler that turns hand motions made during the performance into arrows, paths, boundaries, and diagrams | Meaning (added) | Spatial language | Idea | Which gestures can be recognized reliably enough? |
| IDEA-005 | Claim Capsules that hold a statement, evidence, confidence, and status, anchored to a referent | Meaning (added) | Communication protocols | Idea | Does this help discussions or make them feel bureaucratic? |
| IDEA-006 | Understanding Mirror where the listener reconstructs the speaker's model in the same space | Conversation | Communication protocols | Idea | How should mismatch be shown without shaming users? |
| IDEA-007 | Grounding signals for understood, confused, disagree, and need-example, attached to a moment | Conversation | Live collaboration | Idea | Which signals are faster than speech and socially comfortable? |
| IDEA-008 | Reference Lock: in a live session, invite every participant's view to the same person, object, region, or moment (live twin of IDEA-036) | View | Live collaboration | Idea | How does it stay an invitation (Follow) rather than taking over someone's view? |
| IDEA-009 | Counterfactual Theater with spatial A/B alternatives and simulated consequences | Event | Spatial language | Idea | Which decisions justify the cost of simulation? |
| IDEA-010 | Role Lenses: view filters that show operators, designers, reviewers, or executives different parts of the meaning layer | View | Collaboration | Idea | How can role-specific views preserve common ground? |
| IDEA-011 | Co-presence Portal: remote participant at human scale with shared eye line and depth-aware placement | Event | AR presence | Idea | What fidelity is needed before it feels meaningfully present? |
| IDEA-012 | Hybrid embodiment: real face and expressive avatar body | Event | Expressive presence | Idea | Which blend feels authentic rather than uncanny? |
| IDEA-013 | Shared Attention Cone that shows what a remote participant is examining (live twin of IDEA-039) | Meaning (read) | AR presence | Idea | How can it help without becoming surveillance? |
| IDEA-014 | Spatial subtitles that bind spoken words to the person and object being referenced, using IDEA-032 links | Meaning (read) | AR presence | Idea | Can subtitles disambiguate references without visual overload? |
| IDEA-015 | Reality-anchored notes left on physical locations or equipment in the viewer's own space | Meaning (added) | AR presence | Idea | What ownership and expiry model is needed? |
| IDEA-016 | Branching holograms that adapt an explanation to audience or choice | Meaning (added) | Async holograms | Idea | What authoring model is simpler than a full game editor? |
| IDEA-017 | Interactive checkpoints that ask the viewer to inspect a referent, answer, or act | Meaning (added) | Async holograms | Idea | Which checkpoints increase comprehension rather than friction? |
| IDEA-018 | Holo Replies: a reply is a new event placed at a moment and place inside the original | Conversation | Async holograms | Idea | What is the reply UX through a phone portal? |
| IDEA-019 | Semantic diff between hologram versions, across the event and meaning layers | Event | Async holograms | Idea | Which changes should count as semantic: words, pose, objects, marks, or intent? |
| IDEA-020 | Multi-take ghost overlay for recording consistency | Event | Recording and authoring | Idea | Does it improve creator quality enough to justify complexity? |
| IDEA-021 | Segment retakes with motion continuity instead of full rerecording | Event | Recording and authoring | Idea | How much automatic blending is necessary? |
| IDEA-022 | Message-first editor with lanes for the event (performance, voice, scene), meaning (marks, symbols), and attention intent; no camera lane | All layers | Recording and authoring | Idea | Which lane operations are indispensable for a first prototype? |
| IDEA-023 | Clarity co-director that finds references the body did not resolve and suggests anchors or recap moments | Meaning (read) | Recording and authoring | Idea | What signals make a useful suggestion without over-directing authors? |
| IDEA-024 | Provenance on every mark and edit (recorded, inferred, added) plus a presence authenticity watermark | All layers | Expressive presence | Idea | Which provenance must be visible to viewers, and which only on inspection? |
| IDEA-025 | Meaning heatmap: where viewers stood, looked, replayed, and paused | View | Viewer and analytics | Idea | What can be measured without compromising viewer privacy? |
| IDEA-026 | Spatial inbox and collections for hologram threads, reviews, and handoffs | Conversation | Viewer and collaboration | Idea | Is the primary unit a person, a project, a place, or a conversation? |
| IDEA-027 | Decision stamps and task tokens placed in a scene | Meaning (added) | Communication protocols | Idea | What workflows should be allowed to create commitments? |
| IDEA-028 | Embodied rhetoric: emphasis, urgency, uncertainty, and recap read from delivery first, adjustable by the author | Meaning (read) | Expressive presence | Idea | Which expressive signals can be read reliably, and which must be explicit? |
| IDEA-029 | Conversational memory palace: a navigable graph of claims, artifacts, and decisions | Conversation | Viewer and collaboration | Idea | How can a graph remain legible at scale? |
| IDEA-030 | Audience simulation with novice, expert, and skeptical perspectives | Meaning (read) | Communication protocols | Idea | Is AI simulation accurate enough to be trusted as feedback? |
| IDEA-031 | Shared design language and interaction model for 2D and 3D, all devices and inputs ([concept](concepts/design-language.md)) | All layers | Design system | Idea | Which look, and is the held-mode, two-handed grammar natural on every device? |
| IDEA-032 | Self-resolving pointing: when the author points or looks at something, the thing the finger or gaze ray hits is linked and lights up | Meaning (read) | Hologram-native annotation | Idea | Which pointing and gaze signals are reliable enough to fire without false highlights? |
| IDEA-033 | Hand-path ribbons that leave a demonstrated motion in the air at true size and speed | Meaning (read) | Hologram-native annotation | Idea | When does a trace clarify a motion rather than clutter the scene? |
| IDEA-034 | True-scale measurements from gestures ("about this big", "at this height") shown as real distances | Meaning (read) | Hologram-native annotation | Idea | Which gestures signal a measurement rather than ordinary emphasis? |
| IDEA-035 | "Stand here" viewpoint markers: the author marks where the viewer should stand; Follow mode carries it out on each device | Meaning (added) | Hologram-native annotation | Idea | Do viewers follow suggested viewpoints in a headset, and is the 2D camera move welcome? |
| IDEA-036 | Look-here cues: directional sound, or playback that waits, when a key moment happens outside the viewer's view | View | Hologram-native annotation | Idea | Which cue redirects attention without feeling like a nag? |
| IDEA-037 | Proximity notes that play when the viewer comes close to a place, in a headset or through a phone portal | Meaning (added) | Hologram-native annotation | Idea | How do proximity notes coexist with the author's timeline? |
| IDEA-038 | Ghost frames: copies of the avatar at key poses along its path, walkable like stop-motion | Meaning (read) | Hologram-native annotation | Idea | How are key poses chosen without authoring effort? |
| IDEA-039 | Author's-eye view: briefly see through the author's eyes, or a cone showing what they looked at | View | Hologram-native annotation | Idea | Does a borrowed first-person view orient or disorient on each device? |
| IDEA-040 | Follow-along check: the viewer copies a movement and drift from the author's hands is highlighted | Conversation | Hologram-native annotation | Idea | Is comparison feedback useful outside training contexts? |
| IDEA-041 | Attention-following camera: the Follow mode of the portal; the view moves to what the author points at, sizes, or walks toward, and re-frames for any aspect ratio | View | 2D hologram viewing | Idea | How much automatic camera motion feels guided rather than seasick? |
| IDEA-042 | Tilt to look around: phone orientation moves the portal camera (part of IDEA-045) | View | 2D hologram viewing | Idea | Is the effect worth iOS's motion-permission prompt? |
| IDEA-043 | Freeze to orbit: pausing stops time and dragging moves around the frozen moment (part of IDEA-045) | View | 2D hologram viewing | Idea | Do viewers discover dragging without a hint? |
| IDEA-044 | Object-indexed timeline: tap a thing in the scene to jump to every moment the author pointed at it | View | 2D hologram viewing | Idea | What happens when pointing data is sparse or ambiguous? |
| IDEA-045 | Portal view: on a flat screen the hologram is a window into its 3D world. Moving the phone moves the camera; the mouse rotates; zoom runs from inside the world to third person. Includes IDEA-042 and IDEA-043 ([concept](concepts/what-a-hologram-is.md)) | View | 2D hologram viewing | Idea | How far can iPhone web go with orientation only, before needing WebXR or ARKit? |

## Promotion Rule

Promote an idea into `prds/` when it has a named user, a concrete before/after
workflow, a smallest viable interaction, a measurable communication benefit,
and passes the test in [what a hologram is](concepts/what-a-hologram-is.md):
anchored to the event, read from the body where possible, expressing intent
rather than a view, working on a flat phone, and losing its meaning as a video.
