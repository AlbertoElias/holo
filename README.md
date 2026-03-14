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
pnpm run verify:full
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
| viewer-web | 3174 | `http://127.0.0.1:3174` |
| capture dev | 5173 | `http://localhost:5173` |
| capture mock VR | 5174 | `http://127.0.0.1:5174` |

## Documentation

- Agent quick context: `AGENTS.md`
- Agent command contract: `AGENT_CONTRACT.md`
- Cross-project context: `CLAUDE.md`
