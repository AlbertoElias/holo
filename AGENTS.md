# HoloIM Workspace Agent Guide

Fast-path context for coding agents working in this workspace.
Canonical command entrypoints and validation policy live in `AGENT_CONTRACT.md`.

## Workspace shape

- This folder is a pnpm monorepo.
- Runtime apps:
  - `apps/capture` - WebXR capture runtime
  - `apps/viewer-api` - upload/storage API
  - `apps/viewer-web` - viewer frontend
- Shared packages:
  - `packages/contracts`
  - `packages/config-eslint`
  - `packages/config-ts`
  - `packages/tooling-testing`
  - `packages/tooling-scripts`

## Product flow

1. Record and export GLTF from `apps/capture`.
2. Upload GLTF to `apps/viewer-api`.
3. Browse and render assets in `apps/viewer-web`.

## Tech stack

- Language: TypeScript (strict)
- 3D: Three.js (all apps), React Three Fiber (`apps/viewer-web`)
- API: Fastify + Prisma (`apps/viewer-api`)
- Build/dev: Vite
- Package manager: pnpm (workspace-wide)

## Quick commands (workspace root)

```bash
pnpm install
pnpm run dev
pnpm run lint:all
pnpm run typecheck:all
pnpm run build:all
pnpm run test:all
pnpm run verify:fast
pnpm run verify:full
```

## Where to implement changes

- Viewer UX / feed / AR rendering: `apps/viewer-web/**`
- Upload API / storage / DB schema: `apps/viewer-api/**`
- XR capture / locomotion / export: `apps/capture/src/**`
- Test runners and shared automation scripts: `scripts/**`, `packages/tooling-*/*`
- Shared DTO/contracts: `packages/contracts/**`

## Ports

- `apps/viewer-api`: `http://localhost:3001`
- `apps/viewer-web`: `http://127.0.0.1:3174`
- `apps/capture` dev: `http://localhost:5173`
- `apps/capture` mock VR: `http://127.0.0.1:5174`

## Operating rules

- Prefer app-scoped checks first, then workspace-wide checks.
- Keep changes localized; cross-app refactors should move shared logic to `packages/*`.
- Avoid parent-relative imports for shared tooling; use workspace packages.
- If GLTF contract changes, validate export -> upload -> view with smoke pipeline.

## Validation checklist before handoff

1. Run lint for touched app/package.
2. Run typecheck for touched app/package.
3. Run relevant tests.
4. For pipeline-affecting changes, run `pnpm run test:smoke:pipeline`.
