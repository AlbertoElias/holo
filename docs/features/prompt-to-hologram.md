# Feature brief: AI prompt to hologram on mobile

**Lead:** Devin  
**Status:** Implementing  
**Layer:** event (the directed performance — body, face, voice, props, and captions over time), plus the mobile creation path that turns a text prompt into a private preview and a published hologram. See `docs/product/concepts/what-a-hologram-is.md`.

## User outcome

Someone on a phone opens HoloIM, types a short prompt (e.g. "A tired chef smells soup, smiles warmly, and says 'Finally ready!'"), optionally picks a finish (`clay`, `ink`, `light`) or enters their own LLM API key, watches the generated 3D hologram with voice and captions in a private interactive portal preview, optionally sends a one-line revision note, and taps **Post** to publish and share it on the feed.

## Scope

**Included (Slice 1):**
- **Prompt → BeatSheet → GLB pipeline in `apps/viewer-api`:**
  - New `PromptJob` Prisma model + SQLite migration tracking private generation jobs (`queued` → `directing` → `building` → `ready` | `failed`) owned by the signed-in user.
  - Pluggable, ultra-cheap LLM director supporting:
    - **BYOK (Bring Your Own Key)** via per-request headers (`x-llm-provider`, `x-llm-api-key`, optional `x-llm-model`) — **never persisted to the database, disk, or logs** — supporting `anthropic` (default `claude-haiku-4-5`), `openai` (default `gpt-4o-mini`), `openrouter` (any cheap model), and `workers-ai`.
    - **Server-configured cheap default** (when `PROMPT_LLM_PROVIDER` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `WORKERS_AI_*` is set on the server), plus a deterministic `mock` provider for zero-cost local dev and automated tests.
  - Automatic beat-sheet validation (`validateSheet`) with one structured LLM self-repair retry if the first sheet has schema/timing/grammar errors.
  - Subprocess execution of the existing pure-Node `apps/capture/scripts/authoring/direct.ts` solver (reusing the exact house avatar, expressions, gestures, props, captions, synth SFX, and local Kokoro ONNX TTS voice at $0/run, with clean OS memory reclamation on the 2 GB Fly machine).
  - Private preview storage (`prompts/<jobId>.glb`) served only to the owning user via `GET /api/prompts/:id/preview.glb` until they explicitly publish.
  - One-line revision (`POST /api/prompts/:id/revise`) that feeds the previous `BeatSheet` + user's note back to the director to produce a new job.
  - Publish (`POST /api/prompts/:id/publish`) that promotes the preview GLB into a normal `Hologram` record (triggering existing processing + USDZ Quick Look conversion) and redirects to `/h/<id>?posted=1`.
- **Mobile-first Create UI in `apps/viewer-web`:**
  - Entry control in the feed dock alongside Record and Upload, routing to `/create`.
  - Prompt textarea with starter prompt chips, finish selector (`clay` / `ink` / `light`), collapsible **API key (BYOK)** drawer (saved only in browser `localStorage`, never on the server), live step status, interactive 3D preview reusing `HologramCardCanvas`, one-line **Revise** input, and **Post** action.
- **Shared contracts in `packages/contracts`:** Zod schemas and DTOs for prompt creation, status, revision, and publishing.

**Excluded (deferred to later slices):**
- Custom look-card trait editor inside `/create` (Slice 1 lets the LLM pick traits or defaults to the house avatar; full trait picker can plug into `@holoim/avatar-look` later).
- Poly Haven external prop downloads inside prompt jobs (Slice 1 keeps prompts fast and offline-safe using procedural primitives/built-in props; Poly Haven integration is Slice 2).
- Multi-performer crowd choreography beyond 2 performers.
- Server-side billing/credits system (BYOK + cheap server model covers beta cost control).

## Undo

None. This feature lives in `viewer-web` and `viewer-api` and adds no capture-session authoring action. Revisions create a new `PromptJob` linked via `parentJobId`, preserving the previous job's beat sheet and preview.

## Acceptance criteria

- [ ] A signed-in user on a mobile viewport opens `/create` from the feed, enters a prompt, selects a finish, and gets a generated 3D hologram preview with animation, captions, and voice (`KHR_audio` when Kokoro is available, or clean silent fallback if `PROMPT_ENABLE_VOICE=false`).
- [ ] A user can supply their own API key (`x-llm-provider` + `x-llm-api-key`) from the `/create` BYOK drawer; the key is stored only in `localStorage` on the client and never written to the database, storage, or logs.
- [ ] Generated previews are private: another user (or an unauthenticated request) receives `401`/`403`/`404` on `GET /api/prompts/:id` and `GET /api/prompts/:id/preview.glb`, and the hologram does not appear on the public feed until `POST /api/prompts/:id/publish` is called.
- [ ] `POST /api/prompts/:id/revise` creates a new job using the previous beat sheet and revision note, and updates the preview once ready.
- [ ] `POST /api/prompts/:id/publish` creates a normal `Hologram` visible on the feed and `/h/<id>?posted=1`, preserving GLB → upload → viewer render compatibility.
- [ ] Invalid LLM beat-sheet output triggers one automatic repair pass; unrecoverable failures transition the job to `failed` with a readable error message (never leaking raw API keys).
- [ ] `pnpm run check:all` and unit/route tests pass, plus an end-to-end verification of the real prompt → preview → revise → publish → feed render workflow.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| User's BYOK API key leaked in DB, error message, or logs | BYOK key lives in-memory only for the active request/job (never written to `PromptJob` table), redacted from any error strings/logs. |
| LLM produces invalid JSON or beat-sheet schema violations | JSON extraction + `validateSheet` check + 1 repair retry with the exact validator error lines; clean `failed` state if still invalid. |
| `direct.ts` solver fails on grip/put/aim tolerance or times out | Subprocess timeout (90 s), bounded retry/fallback, and clean `failed` status without crashing the API process. |
| Memory pressure on 2 GB Fly machine (Three.js + Kokoro ONNX + USDZ) | Subprocess execution releases memory on exit; prompt worker processes one job at a time. |
| Unauthenticated or cross-user access to private preview | Every `/api/prompts/*` route requires `resolveAuth` and checks `job.ownerId === user.id`. |
| Double-tap Publish on mobile | `POST /api/prompts/:id/publish` is idempotent: if `job.publishedHologramId` is already set, returns the existing hologram. |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead & Implementer | Devin | `packages/contracts`, `apps/viewer-api`, `apps/viewer-web`, `docs/features/prompt-to-hologram.md` |

## Design decision

- **Subprocess `direct.ts` instead of extracting `apps/capture/src/`:** `apps/capture/scripts/authoring/lib/` imports directly from `apps/capture/src/` (`HumanoidSkeleton`, `ArmIkSolver`, `FaceRig`, `LivenessFace`). Running `direct.ts` as a bounded child process from `viewer-api` avoids touching `apps/capture/src/` (keeping zero merge conflict with the parallel Option 2 session), guarantees exact parity with `make.ts`, and ensures Three.js + Kokoro ONNX memory is reclaimed by the OS after each build on the 2 GB Fly machine.
- **BYOK in-memory handoff:** Because generation runs asynchronously (LLM call + `direct.ts` build), the user's BYOK key is kept only in an in-process `Map<jobId, LlmConfig>` with automatic deletion as soon as the LLM director step finishes (and never persisted to SQLite). If the machine restarts mid-job, the job fails cleanly with "API key expired — retry".
- **Cheap-first voice:** Uses the existing local Kokoro ONNX (`local:af_heart` / `local:am_adam`, Apache-2.0, $0/run) already wired in `apps/capture/scripts/authoring/lib/sound.ts`, with a configurable `PROMPT_ENABLE_VOICE` flag so fast tests can run without downloading the ONNX weights while real runs include voice + lip-sync + captions.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Contracts & API routes (auth, BYOK non-persistence, preview privacy, revise, idempotent publish, validation retry) | `pnpm --filter @holoim/contracts test && pnpm --filter @holoim/api test` | Pending |
| Real `direct.ts` GLB build from prompt job | API integration test running real `direct.ts` subprocess | Pending |
| Mobile `/create` UI → preview → revise → publish → feed render | Playwright E2E + browser preview verification | Pending |
| Workspace lint & typecheck | `pnpm run check:all` | Pending |

## Physical-device limits

Playwright mobile viewport (Pixel 7) verifies layout, touch targets, 3D portal preview, and end-to-end API flow. Real iOS/Android Safari keyboard/viewport behavior and real-device Quick Look playback of a voice-enabled prompt hologram remain physical-device checks.
