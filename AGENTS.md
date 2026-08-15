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
pnpm run verify:agent
pnpm run verify:pr
pnpm run verify:nightly
pnpm run verify:fast
pnpm run verify:xr
pnpm run verify:full
pnpm run test:xr:all
```

## Where to implement changes

- Viewer UX / feed / AR rendering: `apps/viewer-web/**`
- Upload API / storage / DB schema: `apps/viewer-api/**`
- XR capture / locomotion / export: `apps/capture/src/**`
- Test runners and shared automation scripts: `scripts/**`, `packages/tooling-*/*`
- Shared DTO/contracts: `packages/contracts/**`

## Ports

- `apps/viewer-api`: `http://localhost:3001`
- `apps/viewer-web`: `https://localhost:3174`
- `apps/capture` dev: `https://localhost:5173`
- `apps/capture` mock VR: `https://localhost:5174`

## Operating rules

- Prefer app-scoped checks first, then workspace-wide checks.
- Keep changes localized; cross-app refactors should move shared logic to `packages/*`.
- Avoid parent-relative imports for shared tooling; use workspace packages.
- Use `https://localhost:*` for desktop/local XR emulation and a non-localhost secure origin for native mobile/headset WebXR.
- Browser XR automation is IWER-only at the workspace level; treat jsdom shims as unit-test internals.
- If GLTF contract changes, validate export -> upload -> view with smoke pipeline.

## gstack

- `gstack` is vendored at `.claude/skills/gstack` for Claude Code and mirrored into the user skill dirs for local Codex/Claude sessions.
- For browser-driven QA or site exploration, prefer the gstack `browse` skill/binary over generic browser tooling when the task is about interacting with a running app.
- Available gstack modes: `plan-ceo-review`, `plan-eng-review`, `review`, `ship`, `browse`, `qa`, `setup-browser-cookies`, `retro`.
- In Codex, if the user names one of those modes or asks for that style of workflow, open the matching `SKILL.md` under `.claude/skills/gstack/<mode>/` and follow it.
- If project-local gstack skills stop working, run `cd .claude/skills/gstack && PATH="$HOME/.bun/bin:$PATH" ./setup`.

## Validation checklist before handoff

1. Run `pnpm run verify:agent` during the edit loop.
2. Run `pnpm run verify:pr` before a pull request or merge.
3. For exhaustive XR or live-API changes, also run `pnpm run verify:nightly`.
