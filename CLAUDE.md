# HoloIM Workspace - Cross-Project Context

This workspace is a single monorepo with three runtime apps and shared packages.

## Apps

### 1. `apps/capture`
- Purpose: WebXR recording, locomotion, and GLTF export.
- Stack: Three.js, TypeScript, Rapier, Vite.
- Dev URLs: `http://localhost:5173`, mock VR `http://127.0.0.1:5174`.

### 2. `apps/viewer-api`
- Purpose: upload/storage API and hologram metadata.
- Stack: Fastify, Prisma, TypeScript.
- Dev URL: `http://localhost:3001`.

### 3. `apps/viewer-web`
- Purpose: upload UX, feed browsing, AR viewer.
- Stack: React, React Three Fiber, TypeScript, Vite.
- Dev URL: `http://127.0.0.1:3174`.

## End-to-end flow

1. Capture avatar performance in `apps/capture`.
2. Export GLTF.
3. Upload via `apps/viewer-web` to `apps/viewer-api`.
4. Render uploaded holograms in feed and AR modes.

## Shared packages

- `packages/contracts`: API/request/response contracts.
- `packages/config-eslint`: shared lint config.
- `packages/config-ts`: shared tsconfig baselines.
- `packages/tooling-testing`: XR/dev-server test helpers.
- `packages/tooling-scripts`: doctor/changed-scope script helpers.

## Workspace commands

```bash
pnpm install
pnpm run dev
pnpm run lint:all
pnpm run typecheck:all
pnpm run build:all
pnpm run test:all
pnpm run verify:fast
pnpm run verify:full
pnpm run test:smoke:pipeline
```

## Development guidance

- Keep business logic in app-local modules; move cross-app utilities into `packages/*`.
- Keep API endpoints backward compatible unless versioning is explicit.
- Validate GLTF export -> upload -> render whenever contracts or file processing change.
- Prefer shared script helpers in `packages/tooling-*` over duplicating script logic.

## gstack

- Use the gstack `browse` skill for browser-based testing and page interaction work. Do not use `mcp__claude-in-chrome__*` tools in this repo.
- Available gstack skills: `/plan-ceo-review`, `/plan-eng-review`, `/review`, `/ship`, `/browse`, `/qa`, `/setup-browser-cookies`, `/retro`.
- Project-local gstack files live in `.claude/skills/gstack`.
- If a project-local gstack skill is missing its binary or links, run `cd .claude/skills/gstack && PATH="$HOME/.bun/bin:$PATH" ./setup`.
