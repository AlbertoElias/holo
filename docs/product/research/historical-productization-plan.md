# Historical POC-To-Product Proposal

**Status:** Historical proposal, not an approved or current roadmap.
**Provenance:** The user pasted a 90-day "Creator Pipeline First" plan earlier
in the available conversation, then explicitly redirected the work to
brainstorming communication functionality. The later recommended first
experiment is recorded in [APPROACH.md](../APPROACH.md).

This preserves the proposal's useful detail without implying its schedule,
market recommendation, API choices, or implementation request remains active.
The newer [agreed lens](../concepts/what-a-hologram-is.md), portal priority,
and Parked PRD-001 decision remain current authority. Some foundation work may since have landed; this is not a current gap audit.

## Original Framing And Baseline

The proposal described an end-to-end pipeline: record embodied motion in
WebXR, export GLB, upload to an API, consume in a vertical feed, and enter AR.
It proposed rapid creator iteration, team demos, cross-device playback, and
deterministic XR regression testing as early uses.

At that time it reported passing lint/typechecks in two separate projects,
passing viewer tests, and capture E2E blocked by port allocation across
5174-5193. Paths referenced `webxr-capture` and `holoim-viewer`; those historical
paths are not current instructions for the pnpm monorepo. The present command
and port authority is [AGENT_CONTRACT.md](../../../AGENT_CONTRACT.md).

## Proposed Phases

| Historical phase | Proposed scope | Related ideas |
| --- | --- | --- |
| Weeks 1-2: foundation | Align ports, env names, docs, E2E server config; workspace doctor; shared ESLint source; decide tsgo rollout | Supporting engineering proposals, not product ideas; current policies live outside this directory |
| Weeks 3-5: processing | Uploaded -> processing -> ready/failed; duration/audio/poly-count metadata; thumbnails; durable USDZ jobs; persisted retry/error and stale-lock handling | IDEA-047, IDEA-048, IDEA-049, IDEA-050 |
| Weeks 6-8: creator workflow | Direct capture publishing; title/creator/tags; progress and recoverable uploads; detail/share URL | IDEA-046, IDEA-057, IDEA-058 |
| Weeks 9-10: discovery/trust | Latest/creator/tag filters, text search, stable pagination; session/token identity; hide/report/admin review | IDEA-051, IDEA-052, IDEA-053 |
| Weeks 11-12: hardening | Object storage/CDN/signed URLs; request limits, quotas, rate limits; structured logs, metrics, dashboards; upload and processing SLOs | IDEA-054, IDEA-055, IDEA-056 |

## Proposed Contract (Not Adopted By This Note)

Keep GLB canonical and existing DTO fields (`id`, `url`, `usdzUrl`, etc.) intact.
Proposed additions to `HologramDTO` were:

```ts
status: "uploaded" | "processing" | "ready" | "failed";
previewImageUrl: string | null;
durationSec: number | null;
hasAudio: boolean;
processingError: string | null;
```

The suggested upload response was HTTP 202 with `{ id, status }`. Proposed API:

- `POST /api/holograms`: accept an upload for asynchronous processing.
- `GET /api/holograms/:id/status`: status and failure details.
- `GET /api/holograms`: `q`, `submittedBy`, `tag`, `status`, `cursor`, `limit`.
- `POST /api/holograms/:id/report`: a moderation signal.
- Preserve `GET /api/holograms/:id/usdz` as a processed-artifact redirect/lookup
  shim, moving conversion out of the request path.

Any future adoption must review compatibility explicitly. The old POST response
proposal is not authority to change the existing API contract.

## Proposed Validation

- Upload cases: valid GLB, wrong extension, invalid MIME, oversized files, and
  missing required form fields.
- Processing: legal transitions, retries, conversion failure, timeouts, and
  stale-lock cleanup.
- Listing: cursor stability while new content is inserted.
- Capture-to-viewer: mock VR recording, export/upload, feed animation, AR entry.
- Frontend: upload success/failure, recovery, infinite scroll, detail routing,
  search and filters.
- Concurrent upload load and long-running conversion timeout checks.
- Deterministic CI ports rather than ambiguous dynamic allocation.

This preserves test intentions, not a second validation policy. Current
repository doctrine prefers workflow-level evidence where practical.

## Portfolio And Defaults

The earlier recommendation favored a consumer creator-to-feed product first,
with private teams possible later. Other options were enterprise training/review,
commerce AR, and an API/SDK platform. They remain unselected
[portfolio directions](../concepts/product-directions.md), IDEA-064 through
IDEA-067.

Other proposed defaults: TypeScript-first development, tsgo where compatible,
additive contracts, browser/Android WebXR AR plus iOS Quick Look fallback, and
creator pipeline reliability ahead of engagement features. Current engineering
policy must be read from the actual repository guides; this historical note
does not freeze old tooling, device support, or implementation status.

## Later Reframing

The user asked to explore what holograms enable compared with text, image, and
video: embodied live discussion, real and virtual shared worlds, lifelike
presence, async equivalents, and authoring during communication. Later assistant
recommendations favored spatial understanding and an "explain with an object"
experiment. Neither that recommendation nor the earlier creator-to-feed choice
is a recorded product approval. No dated 90-day commitment is inferred.
