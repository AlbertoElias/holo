# HoloIM Workspace

Monorepo for creating, uploading, and viewing holographic 3D content.

## Apps

- `apps/capture` (`@holoim/capture`): WebXR capture runtime for avatar recording and GLTF export.
- `apps/viewer-api` (`@holoim/api`): Fastify + Prisma API for upload/storage/metadata.
- `apps/viewer-web` (`@holoim/web`): React + R3F viewer frontend.
- `apps/knowledge` (`@holoim/knowledge`): read-only atlas of ideas, concepts, PRDs, and open bugs.

## Packages

- `packages/contracts`: shared DTO and schema contracts.
- `packages/config-eslint`: shared ESLint config.
- `packages/config-ts`: shared TS config.
- `packages/tooling-testing`: reusable test/dev-server helpers.
- `packages/tooling-scripts`: reusable script helpers.

## Quick Start

```bash
pnpm install

# configure API env (first time)
cp apps/viewer-api/.env.example apps/viewer-api/.env
pnpm --filter @holoim/api prisma:setup

# start all runtimes
pnpm run dev

# or start capture with IWSDK's shared AI/browser session
pnpm run dev:capture:ai
```

The local SQLite database is generated from committed Prisma migrations and is
ignored by Git. Route tests create their own temporary database and upload fixtures;
the pipeline smoke test creates and removes its own API record.

## Knowledge Atlas

Run `pnpm run dev:knowledge`, then open <http://127.0.0.1:4176>.
It reads the product knowledge base and open bug tracker directly from Markdown.
Changes anywhere under `docs/` refresh the running site automatically, including
new and renamed files. The wiki's "All repository documents" collection exposes
every included source. No database, editing UI, or capture/viewer servers are needed.
See [the app guide](apps/knowledge/README.md) for operation and verification.

## Verification

```bash
pnpm run doctor
pnpm run verify:fast
pnpm run verify:xr
pnpm run verify:full
pnpm run test:xr:all
pnpm run verify:changed
pnpm run test:smoke:pipeline   # capture export → upload → viewer render
```

## Workflow

1. Record and export GLTF in `apps/capture`.
2. Upload GLTF to `apps/viewer-api`.
3. Browse and render content in `apps/viewer-web`.

For feature work, start with the lightweight
[`docs/templates/FEATURE_BRIEF.md`](docs/templates/FEATURE_BRIEF.md) and follow
[`docs/FEATURE_WORKFLOW.md`](docs/FEATURE_WORKFLOW.md). It defines lead, design
review, implementation, and independent verification responsibilities.

## Port Map

| Service | Port | URL |
|---|---:|---|
| viewer-api | 3001 | `http://localhost:3001` |
| viewer-web | 3174 | `https://localhost:3174` |
| capture dev | 5173 | `https://localhost:5173` |
| capture mock VR | 5174 | `https://localhost:5174` |
| knowledge atlas | 4176 | `http://127.0.0.1:4176` |
| knowledge atlas E2E | 4177 | `http://127.0.0.1:4177` |

Desktop/local XR emulation for `apps/viewer-web` now uses `https://localhost:3174`.
Use a non-localhost secure origin for native mobile/headset AR so the localhost-only IWER activation does not override real WebXR.

## XR And CI

- Browser XR automation is standardized on IWSDK 0.5.3 and IWER 2.3 across the workspace.
- `pnpm run dev:capture:ai` opens a visible collaborative runtime;
  `pnpm run dev:capture:agent` runs the managed browser headlessly.
- Public `XR_TEST_MODE` values are `iwer` and `off`. The jsdom-only shim stays internal to unit tests.
- Every push, pull request, manual run, and weekly dependency-drift run uses the
  same CI tier: quality checks, production builds, Knowledge Atlas browser
  checks, IWER surfaces, and the real capture-to-viewer pipeline. Browser jobs
  install Chromium and upload failure diagnostics.
- Local `ktx` is optional. If you install it, capture builds use the same higher-quality compression path as CI.

## Documentation

- Agent quick context: `AGENTS.md`
- Agent command contract: `AGENT_CONTRACT.md`
- `CLAUDE.md` files are symlinks to the adjacent `AGENTS.md`
- Current handoff: `HANDOFF.md`
- Verified defects: `BUGS.md`
- Planned work: `TODOS.md`
- Feature delivery workflow: `docs/FEATURE_WORKFLOW.md`
- Feature brief template: `docs/templates/FEATURE_BRIEF.md`
- IWSDK AI workflow and architecture boundary: `docs/IWSDK_AI_WORKFLOW.md`
