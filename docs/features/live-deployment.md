# Feature brief: Live deployment (Fly + R2 + async USDZ)

**Lead:** Muse (lead agent)
**Status:** Verifying — PR #1 merged (529aeb3, CI Gate green); API live on Fly since 2026-10-19; Pages deploy awaits operator `wrangler login`; physical-device checks remain (see docs/DEPLOYMENT.md)

## User outcome

A shareable HTTPS URL where a hologram can be captured, uploaded, browsed in
the feed, viewed in WebXR, and opened as an iPhone Quick Look preview — without
running anything on the developer's machine. The same stack must be cheap at
beta scale (~$5–15/month), fast for agents to iterate on, and portable
(Postgres + S3-compatible storage, no BaaS lock-in).

## Host decision (Fly vs Railway)

| Attribute | Fly.io | Railway |
| --- | --- | --- |
| Always-on API (~512 MB–1 GB) | ~$6–9/mo (per-second machines + $0.15/GB volume) | ~$5–8/mo ($5 Hobby incl. $5 usage; RAM $10/GB-mo) |
| Sporadic heavy converter (2 GB, minutes/upload) | Machines run per-second, then stop — pennies/upload | Worker service idles always-on unless hand-rolled |
| Agent workflow | `fly.toml` in repo; CLI does deploy/secrets/logs/volumes | Dashboard state can drift from repo; CLI good |
| Egress | $0.02/GB (moot once media is on R2) | $0.05/GB (same) |
| Bundled Postgres | Managed Postgres ~$38/mo (skip; use Neon later) | Cheap in-project Postgres |
| Previews | Manual review apps | Automatic PR environments |

**Decision: Fly.io** for API + converter, **Cloudflare Pages** for the static
viewer, **R2** for media. Prices tie at beta scale; Fly wins on per-second
converter billing and repo-declared infrastructure that agents can drive
entirely from the CLI. Postgres arrives later as an external Neon/Supabase
URL — no host change. No Fly/Railway/wrangler CLI or account exists on this
machine yet, so this pass delivers deploy-ready code and config; the first
`fly deploy` / Pages publish is an operator step (see `docs/DEPLOYMENT.md`).

## Scope

**Included (stepwise, each phase verified before the next):**

1. **Phase 1 — live URL.** Production Dockerfile for `apps/viewer-api`
   (Node 22, Prisma migrate on boot, `/healthz`), `fly.toml` with a
   persistent volume for SQLite + local uploads, configurable uploads root
   and web origins, Cloudflare Pages config for `apps/viewer-web`
   (`VITE_API_ORIGIN`), and a deployment runbook.
2. **Phase 2 — R2 media.** A storage driver abstraction (`local` default,
   `s3` for R2/S3) in the API. Presigned direct-to-R2 upload flow
   (initiate → PUT to R2 → complete) alongside the existing multipart flow,
   which stays the local/test path. DTO media URLs become absolute CDN URLs
   when a public media base is configured. Deletes remove stored objects.
3. **Phase 3 — async USDZ.** `usdzStatus` on the hologram record
   (`none|pending|processing|ready|failed`) plus claim fields (B4 below).
   Upload completion enqueues conversion (status only; no in-memory
   queue). The worker is **embedded in the single API process** for the
   SQLite phase (B1): started from `server.ts` only, never from
   `buildApp`, with an injectable converter for tests; a `worker:usdz`
   entrypoint runs the same loop standalone for local use. A separate
   Fly converter app is explicitly deferred until Postgres replaces
   SQLite, because a second Fly app cannot read the API machine's
   volume. The API machine is sized for the converter (2 GB) and runs
   one conversion at a time in production. `GET /holograms/:id/usdz`
   returns the redirect when ready, `202` with a contracts-defined
   status body + `Retry-After` while pending/processing, and
   conditionally re-enqueues + `202` when failed/none (B6). The web
   Quick Look control is disabled with a "Preparing…" label until the
   DTO reports `ready`, then links directly to the CDN `usdzUrl`.

**Excluded:** accounts/auth (deferred; `submittedBy` stays a display string
this pass), Postgres migration (Prisma provider swap when auth lands),
USDZ size reduction (separate investigation), live multiplayer/realtime,
custom domain purchase/TLS beyond platform defaults.

## Acceptance criteria

- [ ] `docker build` of the API image succeeds and the container serves
      `/healthz`, upload → list → download, with data surviving restart on
      the mounted volume path.
- [ ] Existing local workflow is unchanged by default: `pnpm run dev`,
      API route tests, and the capture → viewer pipeline smoke pass with
      no cloud credentials present.
- [ ] With `STORAGE_DRIVER=s3` against an S3-compatible endpoint, the web
      upload flow PUTs GLB bytes directly to storage (not through the API)
      and the feed serves GLB/USDZ from the configured public media base.
- [ ] After upload, `usdzStatus` transitions pending → ready without any
      request to the USDZ endpoint; the endpoint then redirects (302) to
      the USDZ. A failed conversion lands in `failed`, preserves the GLB,
      and a later USDZ request re-enqueues it.
- [ ] Deleting a hologram removes its GLB and USDZ objects under both
      storage drivers.
- [ ] `docs/DEPLOYMENT.md` lets an operator go from a fresh Fly + Cloudflare
      account to a live URL (env vars, secrets, volume, Pages, CORS origins).
- [ ] `pnpm run verify:agent` passes; pipeline smoke passes per phase.

## Failure cases considered

| Failure case | Prevention or evidence |
| --- | --- |
| Converter crashes/times out mid-job | Status lease via `processing` + stale-claim reclaim; failure sets `failed`, GLB preserved, USDZ request re-enqueues |
| Worker and DELETE race on one hologram | Worker re-checks record existence before publishing; delete removes both objects; existing per-hologram lock retained in API |
| Presigned upload never completed (abandoned) | Intent expires; no hologram row is created until complete; orphaned objects are unreferenced keys (lifecycle rule documented) |
| Complete called twice / replayed | Completion is idempotent per storage key + record id |
| R2/S3 outage during upload or conversion | Upload complete fails without creating a row; conversion failure → `failed` + retry on demand |
| Fly volume loss / single-machine SQLite | Beta-accepted risk, documented; Postgres swap is the exit |
| Preview origins (Pages `*.pages.dev`) blocked by CORS | Configurable additional web origins; local/LAN allowances unchanged |
| Secrets leaking into repo | Only `.env.example` + `fly.toml` (no secret values) committed; runbook uses `fly secrets set` |
| Complete before PUT lands / R2 read lag | HEAD miss → 409 retryable; no row created |
| Presigned POST replayed after complete | Complete copies to a final key never presigned, then deletes the incoming object |
| Worker crashes after USDZ PUT, before DB update | Deterministic USDZ key: next claim sees the object exists and only updates the DB |
| Deterministically unconvertible GLB | Attempts recorded with `usdzError`; re-enqueue on demand only, never in a hot loop |
| Abandoned direct uploads orphan objects | Incoming keys share the `uploads/*.incoming.glb` shape; runbook documents the sweeper query + manual cleanup until intents get a scheduled sweeper |
| Worker is dead while API is up | Oldest-`pending` age logged each poll cycle; stale claims reclaimed after 10 min |
| Volume loss orphans R2 media | SQLite rows are the index; runbook names Fly volume snapshots as the restore story |

## Ownership

| Role | Owner | Files or modules |
| --- | --- | --- |
| Lead | Lead agent | Brief, integration, `docs/DEPLOYMENT.md`, tracker updates |
| Design reviewer | Independent subagent | Read-only review before implementation |
| Implementer — contracts + API | Subagent | `packages/contracts`, `apps/viewer-api` |
| Implementer — web | Subagent | `apps/viewer-web` upload/feed/Quick Look |
| Implementer — infra | Lead | Dockerfiles, `fly.toml`, Pages config |
| Independent verifier | Subagent | Read-only verification against criteria |

## Design decision

Keep Fastify + Prisma + SQLite and the existing contracts; add seams, not a
rewrite. Storage and conversion become driver/job abstractions defaulting to
today's local behavior so every existing test and the local dev loop keep
working with zero cloud setup. Alternatives rejected: Convex/Appwrite/
Firebase (full data-layer rewrite, lock-in, agents know them less well);
Railway (ties Fly on price, loses on repo-declared infra); Cloudflare
Workers (cannot run Fastify or the Python converter). USDZ endpoint contract
changes from sync-convert to status-aware — an intentional, documented
compatibility break for the preview endpoint only; GLB upload/download
contracts are preserved, and direct-upload is additive.

### Review resolutions (B1–B9)

- **B1 topology.** One Fly app, one machine (`min_machines_running = 1`,
  auto-stop off in `fly.toml` — two machines would mean two SQLite files).
  Worker embedded in the API process (see Phase 3). Separate converter
  app waits for Postgres.
- **B2/B3 races.** The in-process lock is valid only because worker and
  API share one process; this is stated, not assumed. Publication is
  atomic: conditional `updateMany({ id, usdzStatus: "processing",
  usdzClaimToken })`; on count 0 the worker deletes the USDZ object it
  uploaded. DELETE removes objects by deterministic keys (GLB
  `storagePath`, USDZ derived via `usdzFilenameFor`), not only by the
  `usdzPath` value it read.
- **B4 claim schema.** New columns: `usdzStatus TEXT NOT NULL DEFAULT
  'none'`, `usdzClaimedAt DATETIME`, `usdzClaimToken TEXT`,
  `usdzAttempts INTEGER NOT NULL DEFAULT 0`, `usdzError TEXT`, plus
  `@@index([usdzStatus])`. Migration backfills `ready` where
  `usdzPath IS NOT NULL`. Claim = one conditional `updateMany` (pending,
  or processing with claim older than 10 min — above the 120 s converter
  timeout plus transfer time); proceed only on count 1; claim one row
  at a time, oldest first. SQLite runs in WAL mode with a busy timeout.
- **B5 upload intent.** `UploadIntent` table (`id`, unique `storageKey`,
  metadata fields, `expiresAt`, `completedHologramId`). Server picks the
  key at initiate (`uploads/<intentId>.incoming.glb`). Direct upload uses
  a presigned **POST** policy (content-length-range 1–25 MB, exact
  content type, 10 min expiry). Complete HEADs the object (missing →
  409 retryable), checks size and `glTF` magic bytes, then server-side
  copies to the final immutable key (`uploads/<cuid>.glb`), deletes the
  incoming object, creates the row, and marks the intent completed —
  replayed completes return the original DTO. Endpoints:
  `POST /holograms/uploads/initiate` and `POST /holograms/uploads/complete`,
  schemas in `packages/contracts`. Local driver returns
  `{ mode: "multipart" }` from initiate and the web falls back to the
  existing multipart POST. Unauthenticated intent minting is a
  beta-accepted abuse risk (25 MB cap per intent), stated here.
- **B6 Quick Look.** Contracts export `usdzStatusSchema` and
  `usdzStatusResponseSchema` (`{ id, usdzStatus, usdzUrl }`); the 202
  carries `Retry-After: 5`. DTO `usdzUrl` is non-null exactly when
  status is `ready` (stale-version or missing-object repair: on the
  ready path the API HEADs the object; missing or version-stale →
  re-enqueue + 202). Web: `ARQuickLookLink` takes the DTO, renders a
  disabled "Preparing…" button until ready (polling `fetchHologram`
  every 5 s, max ~2 min, then "Preview unavailable"), then an anchor
  directly to `usdzUrl`.
- **B7 test contract updates.** Route tests: raw-SQL DDL gains the new
  columns; USDZ tests assert status transitions and poll-until-302 with
  a bounded timeout instead of immediate 302; delete test no longer
  assumes delete waits for an in-flight conversion (it asserts objects
  + row are gone and a late worker publish does not resurrect them).
  Pipeline smoke polls the status endpoint until ready before fetching
  bytes. Contracts: `usdzStatus` is required in the DTO schema with
  zod `.default("none")` parsing tolerance for older fixtures/mocks.
- **B8 URLs + R2.** `resolveMediaUrl` passes absolute URLs through
  untouched; the storage driver (not the route) mints DTO URLs. Worker
  USDZ PUT sets `Content-Type: model/vnd.usdz+zip`,
  `Content-Disposition: inline`, immutable `Cache-Control`; GLB objects
  get `model/gltf-binary`. The runbook includes the R2 bucket CORS
  policy (web origins for PUT/GET) — bucket CORS is separate from API
  CORS. `WEB_ORIGINS` is a comma-separated allowlist plus one optional
  preview pattern restricted to this project's Pages subdomain.
- **B9 images.** One API image (Node + Python + ffmpeg + pinned
  `tools/requirements.txt`, `tools/` copied) serves API and embedded
  worker; `/healthz` is registered in `app.ts` outside the API prefix.
  Migrations run at container start with the Prisma CLI kept in the
  image (beta tradeoff: image size over a split migrate step).
  `STORAGE_DRIVER`, `S3_*`, `PUBLIC_MEDIA_BASE_URL`, `UPLOADS_ROOT`,
  `WEB_ORIGINS`, `USDZ_WORKER_ENABLED`, poll/stale intervals are all
  declared in the zod env schema and `.env.example`.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
| --- | --- | --- |
| Container serves API | `docker build` + `docker run` + curl `/healthz`, upload/list | Docker daemon unreachable in the agent sandbox (socket permission, no escalation per operator rule): image build NOT run. Production Node build passes and the compiled server answered `/healthz`; first `fly deploy` exercises the Dockerfile. |
| Local workflow unchanged | `pnpm run verify:agent`, `pnpm run test:smoke:pipeline` | `verify:agent` cannot run in the sandbox (tsx IPC pipe EPERM); constituent gates run instead: `check:all`, per-package unit suites, `build:all` — all pass. Pipeline smoke needs port binding/browser and is left to CI on the branch. |
| CI browser pipeline (PR) | GitHub Actions `CI Gate` | First runs caught two startup defects invisible locally (contracts dist pre-built on disk): test-API launcher now builds contracts before spawning, and SQLite WAL/busy-timeout pragmas use `$queryRawUnsafe` (P2010: `$executeRawUnsafe` rejects result-returning pragmas). Both fixed and reproduced locally before re-push. |
| Direct-to-R2 upload | API route tests with an in-memory fake implementing the storage interface | Pass: fake-S3 route test covers initiate → 409-before-PUT → complete 201 → idempotent replay, non-GLB rejection + object cleanup |
| Async conversion lifecycle | Route tests with fixture converter + one worker pass per step | Pass: pending → ready → 302 with byte-identical USDZ, failure → `failed` with GLB preserved, missing-object re-enqueue, delete-during-conversion leaves no objects or row |
| Delete removes objects | Route tests (local driver + delete-during-conversion) | Pass locally; S3 delete shares the same driver call and is covered by the fake in the direct-upload test |

## Deploy evidence (2026-10-19)

- PR #1 merged to `main` as `529aeb3` after CI Gate passed on the merge
  commit `0ad033c` (Quality, Production build, Browser end-to-end).
- Fly app `holoim-api` created with a 3 GB `holoim_data` volume in `iad`;
  `WEB_ORIGIN`/`WEB_ORIGINS` secrets staged for the Pages origin.
- `fly deploy -c fly.toml` succeeded (image 436 MB, machine
  `874440da344908`, health check passing). `GET /healthz` returns
  `{"status":"ok"}` and `GET /api/holograms` returns an empty page from the
  fresh SQLite volume at https://holoim-api.fly.dev.
- Live round-trip verified: multipart GLB upload returned a DTO, the file
  downloaded with HTTP 200, delete removed it, and a follow-up GET returned
  404. (List stayed empty by design: the `agent-` submitter prefix is
  excluded as a test artifact.)
- Viewer live on Cloudflare Pages: project `holoim-viewer` created and
  deployed with `VITE_API_ORIGIN=https://holoim-api.fly.dev`;
  https://holoim-viewer.pages.dev returns 200 and the API answers its
  origin with a matching `Access-Control-Allow-Origin`.
- Capture live on Cloudflare Pages as a static deploy (runbook §2b):
  https://holoim-capture.pages.dev returns 200. The dev-only
  input-recording sink is not part of the static deploy.
- Remaining: the physical-device checks below (Quest feed/WebXR, iPhone
  Quick Look against the live URLs).

## Physical-device limits

Headset (Quest) and iPhone Quick Look checks against the live URL remain
operator evidence after the first deploy; IWER/local results do not prove
them. Listed in the runbook as post-deploy checks.
