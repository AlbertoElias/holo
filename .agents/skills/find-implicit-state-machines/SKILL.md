---
name: find-implicit-state-machines
description: "Find the implicit state machines in the app (status and phase unions, boolean flag combinations, async lifecycles), choose the ones where a bad transition costs the most, draw each with /statechart, and decide the best change for user experience, developer experience, and agent experience without breaking anything. Use for /find-implicit-state-machines, \"find all of the implicit state machines in my app\", or before touching a flow that has many flags."
disable-model-invocation: true
---

# Find implicit state machines

Many bugs here are illegal states. A flow is a state machine whether or not the code says so: a `status` union, two booleans that combine into a mode, a ref that async callbacks flip, an XR session that starts, pauses, and ends. This skill finds those, makes each one visible, and picks the change that helps the user, the next developer, and the next agent, without breaking behavior.

The prompt this encodes, from the Vox post and poteto's follow-up: *find all of the implicit state machines in my app, and make the best decision that elevates user experience (UX), developer experience (DX), and agent experience (AX) always, without breaking anything.* The "always" and "without breaking anything" are constraints, not hopes: every change must pass the checks below.

It builds on three skills copied from pstack (`cursor/plugins`, MIT): [`/statechart`](../statechart/SKILL.md), [`/create-formal-verification-skill`](../create-formal-verification-skill/SKILL.md), and [`/maintain-formal-verification-skill`](../maintain-formal-verification-skill/SKILL.md). Refer to them by name; do not copy their commands here.

## 1. Find

Search `apps/` and `packages/`, skipping `node_modules`, `dist`, and fixtures. Send the sweep to a `searcher` subagent so only the table comes back. Look for:

- unions named `*State`, `*Phase`, `*Status`, `*Mode`, `*Step`, and the code that assigns them;
- two or more booleans, refs, or nullable fields that together act as a mode (`isRecording && !isPaused`, `uploading && !error`) and allow combinations nobody intended;
- async lifecycles with several actors: XR session start and end, permission prompts, upload and retry, audio and recording, avatar placement and portal transitions;
- `useEffect` or event handlers that set state from a callback that can fire late or twice.

For each candidate, record: the file and line of the state, the files that change it, its values, its events, and every combination the code can reach that the product would call illegal.

## 2. Choose

Rank by two things: how many actors can change the state at once, and what the user loses on a bad transition (a lost recording, a stuck upload, a dead XR session). Take the top three to five. Say why each was chosen and why the rest were not.

## 3. Make it visible

For each chosen machine, follow `/statechart`: write a small TLA+ model in a scratch folder outside the repo, use the code's real names, write each product rule as an INVARIANT, and draw the chart in the user's words. A step in the model must be one indivisible step in the code. When `/statechart` reports a rule that breaks, treat it as a finding and replay the path against the real code before believing it. Do not weaken a rule or the model to make it pass.

For a machine worth guarding over time (a recording or upload pipeline, say), use `/create-formal-verification-skill` to leave a project-local verify skill for it, one skill per subsystem. Later, `/maintain-formal-verification-skill` brings it back in line after merges.

## 4. Decide the change

For each machine, pick the smallest change that improves all three, and name what each gets:

- **UX**: no illegal state reachable by the user; every state has a way out and a visible explanation (error, retry, cancel).
- **DX**: one named state value replaces the flag combination, transitions live in one function, and a type makes an illegal state unrepresentable (a discriminated union instead of booleans).
- **AX**: an agent can read the states, events, and rules from one place, and a check or e2e test fails when a rule breaks.

If no change improves all three, pick the one that improves two and loses nothing, and say what you gave up. If a change cannot keep behavior identical, stop and ask the user. "Without breaking anything" means: a changed machine keeps its public events and outputs, its e2e check passes before and after, and the GLTF export, upload, and render path is untouched.

Changing product code is a separate step from finding. Report findings first. Make the change only when the user asks, or when a finding is a bug inside the task they gave you. Follow `docs/FEATURE_WORKFLOW.md` for any behavior change. Per `CLAUDE.md`, verify with an end-to-end check, not new unit tests written to ratify code.

## 5. Report

Give the user, for each machine: the chart (Mermaid text, plus the rendered SVG if asked), the rules, each bug as a short path in the code's words, the harm in one sentence, the proposed change with its UX, DX, and AX effects, and what the model leaves out. Say which bug paths you replayed against the real code and which you did not. Record a defect in `BUGS.md` only after a replay or a read of the code that shows every step can happen, and put any follow-up in `TODOS.md`, nowhere else.
