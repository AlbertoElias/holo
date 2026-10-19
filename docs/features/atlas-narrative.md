# Feature brief: Atlas visual narrative

**Lead:** Codex
**Status:** Verifying

## User outcome

Understand the HoloIM backbone and where an idea belongs without reading a manual. Navigate from a visual model to a concrete example, related ideas, experiments, and source detail when needed.

## Scope

Included: concise Markdown-backed reading guide; Event/Meaning/View interactive flow; illustrative storyboard/wireframe with Follow/Free; grouped idea navigation and compact results; dependency/reasoning map; visual learning loop; concise wiki navigation; progressive disclosure in idea/document detail; responsive navigation and source freshness.
Excluded: changing HoloIM product decisions, implementing actual XR authoring/playback features, replacing canonical docs, editing or persistence, external sharing.

## Acceptance criteria

- [ ] Home explains Event/Meaning/View visually, with a single selectable layer and concise explanation; no full APPROACH.md dump.
- [ ] One illustrative communication example connects a recorded event, meaning and recipient view; Follow/Free wireframe changes are labeled conceptual rather than shipped capabilities.
- [ ] Ideas open as grouped territories rather than 69 expanded prose cards. All ideas remain searchable/discoverable; new IDs fall back to canonical text.
- [ ] A relationship map explains specific canonical links (e.g. pointing enables attention/subtitles), without presenting speculative dependencies as approved work.
- [ ] A separate visual process explains problem -> hypothesis -> smallest trial -> evidence -> decision, with details on demand and source links.
- [ ] Wiki/PRDs/bugs/full Markdown stay accessible with statuses, source links, deep links, history, safety and live updates intact.
- [ ] The guide and any concise editorial summaries live in Markdown and update through the existing watcher.
- [ ] Keyboard, desktop and 390px mobile workflows have repeatable browser evidence.

## Design review

The current home displays a long approach document after a decorative hero. The garden requires scanning many similarly weighted cards. Wiki cards repeat document structure rather than explaining relationships. The existing warm paper/teal visual language is retained; the change is hierarchy, narrative and interaction. Source documents remain reference views, not default reading surfaces.

The new narrative is: understand the medium -> see one example -> find an idea's place -> follow a reasoning link -> choose a useful trial. Diagram connections describe conceptual relationships, not implementation sequencing. Parked notes and current portal/body-first priorities remain explicit.

## Failure cases considered

| Failure | Prevention / evidence |
| --- | --- |
| Concise copy diverges from canonical decisions | Editorial guide links authority; no statuses inferred from presentation |
| Source guide or summary missing | Canonical registry fallback; visible source links |
| New ideas disappear from curated map | Group dynamically by layer; all/search always includes every record |
| Diagram cannot be read on phones or by keyboard | Semantic buttons/links and stacked mobile flows; browser tests |
| Links or PRD decisions lost during redesign | Preserve hash routes and source reader; test parked PRD and history |
| Illustrative wireframe mistaken for a real product demo | Explicit conceptual example label and source explanation |
| Markdown updates overwrite user exploration or remain stale | Existing polling reload; URL stores selected route/collection/layer where useful |

## Ownership

Lead: app, source guide, feature brief and browser coverage. Independent design review: read-only reviewer if available. Verification: real browser workflows; preserve ongoing work in other worktrees and shared ports.

## Validation

Scoped lint/tsgo/build/Markdown integrity and browser E2E; verify:agent in the edit loop; verify:pr before integration. Screenshot/trace evidence under output/atlas-narrative. No physical XR claims.

## Verification In Progress

- Scoped Markdown integrity, shared ESLint and tsgo pass.
- Browser E2E: 11 passed, including new IDs, parked PRD/history, all-doc freshness/renames, unsafe Markdown, sourced Mermaid/wireframe copy, local-image deletion, reading-state preservation and missing-guide exits.
- Independent reviewer found and rechecked fixes for competing wireframe copy, inferred/event boundary, missing-guide fallback and refresh state. Relationship selection is now also persisted.
- Awaiting latest-main integration and full repository gate.
