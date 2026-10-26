# Feature brief: Snappy feed first load

**Lead:** Claude Code (session started from the perf lead)  
**Status:** Implementing
**Layer:** view; see `docs/product/concepts/what-a-hologram-is.md`

## User outcome

Opening the feed shows the newest hologram as soon as its file can arrive,
not after every card's file and not after the API wakes from scale-to-zero.

## Scope

**Included:**

1. Load order: the focused card downloads its GLB first and alone; the cards
   next to it (two below, one above) follow one at a time; the rest wait
   until the feed scrolls near them.
2. Edge-served first page: the newest ten holograms reach the browser from
   Cloudflare's edge in `index.html`, with a preload for the newest GLB,
   so a cold visit never waits on the Fly cold start (about 14 s).

**Excluded:** smaller GLB files (export-side animation compression), the JS
bundle split (parallel `js-bundle` session), cursor pages after the first.

## Acceptance criteria

- [x] Feed order: the second GLB request starts only after the first has
      downloaded; a card more than two below the focused one is not fetched
      until the feed scrolls near it.
- [x] Live: in a fresh browser at ~1 MB/s the first GLB finishes noticeably
      sooner than with all downloads in parallel.
- [ ] A cold first visit renders the newest hologram without waiting on the
      Fly API.
- [ ] A new upload, or a delete, shows in the edge list on the next page load
      (see Design decision for the bound).
- [ ] When the snapshot is missing or old, the feed still works from the
      live API exactly as today.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| A stuck or slow download blocks every later card | The focused card never waits behind a background download; a card's turn ends when its bytes arrive, its file proves missing, or it fails |
| The next download waits for the previous card to parse and draw (seconds on a weak GPU) | A turn ends at the resource-timing entry for the full GLB, not at render; nearby cards run the small availability probe early |
| Snapshot write fails after an upload or delete | The SPA still fetches the live list and replaces the snapshot's items once the API answers; the next successful write repairs the snapshot |
| Snapshot lists a deleted hologram | Its GLB 404s and the card says the file is missing until the live list removes it |
| Snapshot is per-anonymous, live list is per-viewer (`ownedByViewer`) | The live list always replaces the snapshot, so owner controls appear once the API answers |
| Preloaded GLB downloaded twice (preload/fetch mode mismatch) | Preload uses `as="fetch" crossorigin="anonymous"` to match GLTFLoader's fetch; checked by wire bytes on the preview deploy |
| The Pages Function errors or R2 is unreachable | The function serves the unmodified `index.html` |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead / implementer | Claude Code | `apps/viewer-web/src/features/feed/*`, `apps/viewer-web/functions/`, `apps/viewer-api/src/services/feed-snapshot.ts`, hologram routes |
| Independent verifier | Codex (`-p standard`) | Read-only review of the diff and evidence |

## Design decision

**Load order** (`modelLoadOrder.ts`): `FeedPage` keeps the started and
settled card ids and asks `nextModelLoads` which to start next. Cards get a
`loadTurn` of `load`, `check` (run the small HEAD + range probe now) or
`wait`.

**Edge list.** Chosen: a write-through snapshot. After every upload, delete,
and at API boot, the API writes the anonymous first page to R2 as
`feed/latest.json`. A Pages Function on `/` of `holoim-viewer` reads it
through an R2 binding and, with HTMLRewriter, inlines it as
`window.__HOLOIM_FEED__` plus a `<link rel="preload">` for the newest GLB.
The SPA renders those items at once, then the live API's answer replaces
them. Freshness comes from the write, not from a TTL, so no purge or
Cloudflare API token is needed.

Alternatives considered: a Pages Function that proxies and edge-caches the
API response (short TTL plus stale-while-revalidate). Simpler on the API
side, but the Cache API is per data centre, so the first visitor in each one
(and after every eviction) still waits on the cold start, and freshness is
bounded only by the TTL unless the API purges with a new token.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Feed order | `e2e/hologram-feed.spec.ts` "feed downloads holograms in feed order, one at a time" | Passes; `glb-downloads.json` attachment |
| Live first GLB sooner | Fresh Chromium, CDP throttle 1 MB/s, 40 ms, against production and a preview deploy (warm API) | Production: 5 GLBs start together, first done 4.3–5.8 s, first card rendered 8.6–8.7 s. Preview: first done 3.8–4.3 s, then one at a time, first card rendered 4.2–4.7 s |
| Cold visit, upload freshness | Preview deploy with the R2 binding, API stopped | pending |

## Physical-device limits

None required: network ordering is device independent. Software GL in
headless Chromium exaggerates parse and first-render time, which is why a
turn ends at download, not render.
