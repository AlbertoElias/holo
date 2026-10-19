# Feature brief: Knowledge Atlas

**Lead:** Codex
**Status:** Complete

## User outcome

Browse HoloIM's product approach, every conversation idea, related concept notes and PRDs, and verified open bugs in a read-only local app whose content comes directly from repository Markdown.

## Scope

Included: conversation-to-repository reconciliation, approach page, searchable/filterable idea index and detail links, concept wiki, Markdown reader, open-bug view, source links, local dev and production build, responsive UI.
Excluded: editing, accounts, a second content database, XR product changes, external artifact imports, deployment.

## Acceptance criteria

- [x] Every distinct idea and planning recommendation visible in this conversation is captured, distinguishing proposals from approved work and historical plans from current direction.
- [x] Home explains vision, brainstorming, selection, evaluation, and building with agents from Markdown.
- [x] Ideas can be searched/filtered and open associated concept notes/PRDs, with direct links and browser-history support.
- [x] Wiki and bugs read their canonical files; templates and closed bugs are not reported as open bugs.
- [x] Relative Markdown links resolve inside the app; external links stay external; unknown documents show a recovery view.
- [x] No content-writing API, user-content HTML execution, or generated content committed as another authority. Development updates reflect source changes; production snapshots require rebuilding.
- [x] Desktop and mobile workflows have repeatable browser evidence.

## Failure cases considered

| Failure | Prevention / evidence |
| --- | --- |
| Registry grows or PRDs are added | Derive records and cross-references from Markdown, test source additions |
| Missing/invalid document or link | Visible not-found/recovery state and source path |
| Script or unsafe link in Markdown | React Markdown renderer with raw HTML disabled and safe link protocols |
| Templates counted as real bugs/PRDs | Explicit heading/filename boundaries |
| Filters yield no results | Clear filters action and empty state |
| App becomes separate content authority | Vite loads repository Markdown; no persistence or write routes |
| Source accidentally bundled from secrets | Explicit allowlist of public knowledge documents |
| Other agent work overwritten | Isolated worktree, scoped ownership |

## Ownership

| Role | Owner | Files |
| --- | --- | --- |
| Lead / implementer | Codex | apps/knowledge, manifests, brief, feature index |
| Knowledge reconciliation | Documentation agent | docs/product only |
| Design reviewer | Newton | Independent read-only architecture review |
| Runtime verifier | Lead (fallback) | Browser workflows and inspectable artifacts; second-agent runtime review was unavailable due to service quota |

## Design decision

Integration preserves the newer agreed event/meaning/view lens, portal IDEA-045, and Parked PRD-001. New unpublished additions use IDEA-046 through IDEA-069. The registry parser reads column headings (including Layer) rather than fixed positions.

Standalone Vite/React/TypeScript mini app on port 4176. A build-time Vite module reads an explicit repository Markdown allowlist; the browser derives ideas, related documents, and bugs from that content. Hash routes keep static hosting and deep links simple. Repository-relative source paths remain visible. The interface is a warm editorial atlas with deep teal navigation and a readable paper-like document view. No changes to the hologram runtime.

Independent design review required symlink-safe filesystem boundaries, development invalidation for edits/additions/deletions, syntax-tree parsing instead of line splitting, one fragment-aware link resolver, disabled HTML/images, and PRD ownership from explicit Source ideas metadata. These are included. The existing shared React Hooks lint configuration and CI browser gate also cover the app.

## Test plan and evidence

- Knowledge integrity: 69 unique ideas and 24 product documents; local links and referenced idea IDs pass. Conversation coverage is mapped in `docs/product/research/conversation-coverage.md`; unavailable earlier assistant messages and external boards are explicitly excluded from certification.
- `pnpm --filter @holoim/knowledge verify:fast` and production build pass (shared ESLint, tsgo, Markdown integrity).
- `pnpm run verify:agent` passes workspace quality and existing tests.
- `pnpm run verify:pr` passes workspace quality, tests, all builds, seven Atlas browser scenarios, real capture/export/upload/view/Quick Look conversion, capture XR flows, and viewer AR checks. Ports 3474/3301/5574/5575 isolated this run from other agents.
- Final Atlas browser suite passes 7/7 after search/source-link refinements. It checks navigation/history/deep links, PRD source ownership, canonical bug and empty states, safe rendering, phone overflow, and source additions/edits/deletions/atomic saves/renames anywhere under docs.
- Screenshots and browser report: `output/knowledge-atlas/` (local generated evidence, not source content).
- Native filesystem events were unreliable in the sandboxed long-running server. A small 300 ms polling watcher now covers app/docs roots; source-update scenarios pass against that persistent server.
- No login service was installed. The app guide recommends a user LaunchAgent rooted in the main checkout for always-on local use; production snapshots need a rebuild.

## Physical-device limits

No XR behavior changes. Mobile browser responsiveness is tested through viewport emulation.
