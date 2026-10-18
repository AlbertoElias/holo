# Feature brief: Migrate workspace typechecking to tsgo / TypeScript 7

**Lead:** Muse (quartz-orbit)
**Status:** Verifying

## User outcome

Every workspace package typechecks with the native TypeScript compiler
(`tsgo` today, `typescript@7` when the ecosystem allows) from one shared
config chain, so strict settings cannot drift between capture and the rest
of the monorepo and typechecking is materially faster.

## Scope

**Included:** Remove `baseUrl` from `tsconfig.base.json`; point
`apps/capture` at `@holoim/config-ts/web.json`; migrate every `typecheck`
script to the native compiler; bump the catalog to `typescript@^7.0.2`
with `typescript-eslint` updated and bridged on the TS6 sidecar; update
`TODOS.md` items for contract tests and the XR check-script port per the
agreed rescoping.
**Excluded:** The UI/interaction redesign itself (its own brief); porting
the `.mjs` XR check scripts (folded into the redesign); bumping Vite or
ESLint majors beyond what the compiler migration requires.

## Acceptance criteria

- [x] `pnpm run verify:agent` passes in the worktree (exit 0, approved
  unsandboxed run with `XDG_CACHE_HOME=/tmp/prisma-cache`, 2026-10-18;
  the sandboxed invocation cannot start because the sandbox blocks the
  `tsx` IPC pipe). Supplementary gates `doctor`, `check:all`,
  `test:unit:all`, and `build:all` also exit 0.
- [x] Every package's `typecheck` runs the native compiler; no package
  keeps a hand-synced duplicate of the strict settings.
- [x] Capture resolves the shared chain with no `TS5090`/`TS5102` errors.
- [x] `TODOS.md` reflects: contract tests scoped to `xr-ui-core` +
  capture orchestration; UI-package tests deferred to the redesign brief;
  XR script port folded into the redesign; `tsgo` wait item closed by
  this work.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| `baseUrl` removal breaks `@holoim/contracts` path resolution | `paths` resolves relative to the config file in TS ≥4.1; capture does not import `@holoim/contracts`; verified by full typecheck run |
| TS7 removes the JS compiler API that `typescript-eslint` needs | Keep `typescript` 5.7 for lint tooling if lint breaks; native compiler only owns `typecheck` scripts; decide from an actual lint run |
| Native compiler rejects `composite`/`declaration` emit in shared base | Capture and UI packages already set `composite: false, noEmit: true`; viewer-api build (`tsc` emit) stays on the classic compiler until separately proven |
| Peer worktrees (avatar-locomotion, xr-height) also touch `apps/capture/tsconfig.json` and `TODOS.md` | This work is isolated in its own worktree/branch; lead resolves overlap at merge |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Muse (quartz-orbit) | Brief, integration, final handoff |
| Design reviewer | Muse (quartz-orbit, pre-implementation pass) | Read-only review before implementation |
| Implementer | Muse (quartz-orbit) | `tsconfig.base.json`, `packages/config-ts/**`, `apps/capture/tsconfig.json`, `package.json` typecheck scripts, `TODOS.md`, this brief |
| Independent verifier | Muse (quartz-orbit, fresh pass) | Read-only verification; test artifacts only |

## Design decision

Two-step migration, both steps delivered. Step 1: remove `baseUrl`,
adopt the shared chain everywhere, and run all `typecheck` scripts on
`@typescript/native-preview` (`tsgo` `7.0.0-dev.20260707.2`). Step 2:
bump the catalog `typescript` to `^7.0.2` — the stable native release
shipped 2026-07-08, whose binary is again named `tsc` — delete the
preview package, and update `typescript-eslint` to `^8.71.2`.

Findings from the implementation passes:

- Yes, there is a stable native TypeScript: `typescript@7.0.2` (GA
  2026-07-08) *is* the Go compiler, binary named `tsc`. The compiler was
  never the blocker; the lint toolchain was. Even the latest
  `typescript-eslint` (8.71.2) declares peer `typescript >=4.8.4 <6.1.0`
  because TypeScript 7 does not yet expose a stable programmatic API.
  The supported bridge is Microsoft's sidecar: `packages/config-eslint`
  now depends on `typescript: npm:@typescript/typescript6@^6.0.2`, so
  pnpm resolves `typescript-eslint`'s peer to TypeScript 6.0.2 (verified
  in the lockfile) while every compiler invocation runs 7.0.2. Capture's
  redundant direct `typescript-eslint` dependency was removed for the
  same reason — it uses `@holoim/config-eslint`'s instance. When
  `typescript-eslint` supports TypeScript 7 natively, delete the alias.
- TS7 requires an explicit `rootDir` when the common source directory
  escapes it (`TS5011`): `viewer-api`'s emitting config now sets
  `rootDir: ../..`. Its `dist` output layout is therefore
  workspace-relative; no script, Dockerfile, or workflow consumes that
  `dist` (the API runs via `tsx` from source), so nothing else changes.
- The original `TODOS.md` diagnosis was half-stale: `tsgo` resolves
  package `extends` fine. The real blockers were (a) `baseUrl`, removed in
  TS7 (`TS5102`), fixed by dropping it and making `paths` targets
  explicitly relative (`./packages/...`, `TS5090` otherwise), and
  (b) capture never declared `@holoim/config-ts` as a dependency, so
  `tsgo` silently ignored its `extends` — fixed by adding the workspace
  dependency to match every sibling package.
- `tsgo` infers `rootDir` from `outDir` more strictly than classic `tsc`
  (`TS6059` when `@holoim/contracts` source falls outside it).
  `viewer-web`'s config is now typecheck-only (`noEmit`, no `outDir`;
  Vite owns emit), and `viewer-api` gained a separate
  `tsconfig.typecheck.json` so its emitting `tsconfig.json` is untouched.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Shared chain resolves, no drift | `pnpm run verify:agent` | Exit 0 (unsandboxed, `XDG_CACHE_HOME=/tmp/prisma-cache`); `doctor` + `check:all` also exit 0 |
| Native typecheck everywhere | `pnpm run check:all` scoped per package | All 9 `typecheck` scripts report `tsc ... Done` on TypeScript 7.0.2; lint passes on `typescript-eslint` 8.71.2 with the TS6 sidecar |
| No behavior regression | Existing unit tests via `verify:agent` | `verify:agent` and `test:unit:all` exit 0; `build:all` exit 0 |

## Physical-device limits

None. This is tooling-only; no XR behavior changes, so no headset
validation applies. IWER suites are not re-run for a config-only change
beyond what `verify:agent` selects.
