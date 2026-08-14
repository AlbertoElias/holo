# HoloIM Workspace

Monorepo for creating, uploading, and viewing holographic 3D content.

## Apps

- `apps/capture` (`@holoim/capture`): WebXR capture runtime for avatar recording and GLTF export.
- `apps/viewer-api` (`@holoim/api`): Fastify + Prisma API for upload/storage/metadata.
- `apps/viewer-web` (`@holoim/web`): React + R3F viewer frontend.

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
pnpm --filter @holoim/api prisma:generate
pnpm --filter @holoim/api prisma:migrate

# start all runtimes
pnpm run dev
```

## Verification

```bash
pnpm run doctor
pnpm run verify:fast
pnpm run verify:xr
pnpm run verify:full
pnpm run test:xr:all
pnpm run verify:changed
pnpm run test:smoke:pipeline
```

## Workflow

1. Record and export GLTF in `apps/capture`.
2. Upload GLTF to `apps/viewer-api`.
3. Browse and render content in `apps/viewer-web`.

## Port Map

| Service | Port | URL |
|---|---:|---|
| viewer-api | 3001 | `http://localhost:3001` |
| viewer-web | 3174 | `https://localhost:3174` |
| capture dev | 5173 | `https://localhost:5173` |
| capture mock VR | 5174 | `https://localhost:5174` |

Desktop/local XR emulation for `apps/viewer-web` now uses `https://localhost:3174`.
Use a non-localhost secure origin for native mobile/headset AR so the localhost-only IWER activation does not override real WebXR.

## XR And CI

- Browser XR automation is standardized on IWSDK/IWER across the workspace.
- Public `XR_TEST_MODE` values are `iwer` and `off`. The jsdom-only shim stays internal to unit tests.
- CI installs a pinned `ktx` binary so capture builds use the full IWSDK texture compression path.
- Local `ktx` is optional. If you install it, capture builds use the same higher-quality compression path as CI.

## Documentation

- Agent quick context: `AGENTS.md`
- Agent command contract: `AGENT_CONTRACT.md`
- Cross-project context: `CLAUDE.md`
- Current handoff: `HANDOFF.md`
- Verified defects: `BUGS.md`
- Planned work: `TODOs.md`
