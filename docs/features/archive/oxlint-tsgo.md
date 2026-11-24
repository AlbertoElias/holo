# Feature brief: lint with Oxlint, typecheck with the native compiler

**Lead:** Claude (session `infra/oxlint-tsgo`)
**Status:** Delivered 2026-11-24
**Layer:** None. Developer tooling; no product behavior changes.

## User outcome

The owner asked for a faster `verify:pr` and edit loop with the same
confidence, and approved this step on 2026-11-24: "approve moving to 0xlint
and tsgo".

Today every package lints with ESLint (`typescript-eslint` on the
TypeScript 6 sidecar) and typechecks with `tsc`. After this change, every
package and the root tooling lint with Oxlint, with the same rules on the
same files, and typecheck with the native TypeScript compiler.

### The typecheck half was mostly done already

`tsc` in this workspace is TypeScript 7.0.2 (catalog `typescript: ^7.0.2`).
TypeScript 7 is the Go compiler: its `tsc` runs the native binary that
`@typescript/native-preview` shipped as `tsgo`
(`docs/features/archive/tsgo-typescript7-migration.md`, 2026-10-18). Only
`apps/knowledge` still calls `tsgo`, from the preview build
`7.0.0-dev.20260707.2`, which is older than 7.0.2. So this change does not
replace `tsc` with `tsgo`. It moves `apps/knowledge` to the stable `tsc` and
removes the preview package, so every package runs one compiler. The proof
compares the old preview `tsgo`, the stable native `tsc` and the
TypeScript 6 JavaScript compiler on the same planted errors.

### Times before (2026-11-24, 10 cores, other sessions running)

| Command | Run 1 | Run 2 |
|---|---|---|
| `pnpm run lint:all` | 16.9 s | 19.0 s |
| `pnpm run typecheck:all` | 8.6 s | 8.0 s |
| pre-push, one file in `apps/viewer-web` (2 checks) | 5.4 s (lint 5.3 s, typecheck 2.8 s) | |
| pre-push, one file in `packages/xr-ui-core` (8 checks) | 4.5 s (lint 3.3 s) | |

Load average was 12 to 16 during these runs (another `verify:pr`).

### Times after (2026-11-24, same machine)

Other sessions kept the load high, so each new run ran right after an old
run (a detached worktree at `main` 28f22dcc4685), under the same load.

| Command | Old (`main`) | New (this branch) | Load average |
|---|---|---|---|
| `pnpm run lint:all`, pair 1 | 34.1 s | 5.4 s | 85 |
| `pnpm run lint:all`, pair 2 | 37.7 s | 4.8 s | 93 |
| `pnpm run typecheck:all`, pair 1 | 18.1 s | 6.5 s | 185 to 198 |
| `pnpm run typecheck:all`, pair 2 | 7.8 s | 6.3 s | 205 to 216 |
| pre-push, one file in `apps/viewer-web` (2 checks) | 5.2 s (lint 5.0 s) | 3.1 s (lint 1.0 s) | 62 to 66 |
| pre-push, one file in `packages/xr-ui-core` (8 checks) | 3.5 s (lint 3.1 s) | 3.5 s (lint 1.5 s) | 58 to 61 |

Lint is 6 to 8 times faster. Typecheck runs the same compiler in all
packages but knowledge, so its difference is load noise; the result is "no
slower". The pre-push hook runs its checks in parallel, so the slowest
typecheck now sets its time. A third lint pair is not in the table: the load went to 200 during
it, and Oxlint used 5.6 s of CPU in 994 s of wall time.

## Scope

**Included:**

- An Oxlint config in `@holoim/config-eslint` (`oxlint/base.json`,
  `oxlint/react-src.json`) and one `.oxlintrc.json` per linted package and at
  the root.
- The custom rule `holoim/no-token-colour-literal` runs unchanged through an
  Oxlint JS plugin (`src/oxlint-plugin.mjs`).
- Every `lint` script runs `oxlint`; `check-css-literals.mjs` stays as it is.
- `apps/knowledge` typechecks and builds with `tsc` (TypeScript 7.0.2).
- ESLint, `typescript-eslint`, `@eslint/js`, `eslint-plugin-react-hooks`,
  `globals`, the TypeScript 6 sidecar and the `@typescript/native-preview`
  package leave the workspace. The rule's unit test runs Oxlint instead of
  ESLint's `Linter`.
- Callers and docs that name the tools: `apps/capture/scripts/verify-changed.mjs`,
  `.vscode/settings.json`, `scripts/ci-changed-areas.sh` (root
  `.oxlintrc.json` selects quality), `AGENTS.md`, `AGENT_CONTRACT.md`,
  `TODOS.md` (the sidecar note).

**Excluded:**

- New rules. Oxlint's default `correctness` category is off; only the 88
  rules that are active today are on. Turning on more rules is a separate
  decision.
- Renaming `@holoim/config-eslint` (the change selectors key on its path).
- `scripts/verify-lock.ts`, the lock and port code in `scripts/verify-pr.ts`,
  and the Playwright configs (another session owns them).
- `scripts/hooks/pre-push-checks.mjs` and `.github/workflows/ci.yml` need no
  edit: they run the packages' `lint` and `typecheck` scripts and
  `check:all`, which change under them.

## Undo

None. Developer tooling; no capture authoring action.

## Rule map (step 2)

The resolved ESLint config was printed for one file of each config shape:
root `scripts/*.ts`, capture `.ts` and `.mjs`, knowledge, viewer-web,
viewer-api, `xr-ui-core`, `avatar-face`, `contracts`, `design-tokens`
scripts, and the `.mjs` files outside each `files` pattern. The union is 88
active rules. 87 are `error`; `react-hooks/exhaustive-deps` is `warn`. No
rule needs type information (`tseslint.configs.recommended` is the
non-type-checked set).

| ESLint rules | Where active | Oxlint rule |
|---|---|---|
| 41 `eslint:recommended` rules that TS keeps (`for-direction` … `valid-typeof`, options copied) | all files | same name, same options |
| 19 `@typescript-eslint/*` recommended rules (`ban-ts-comment` … `triple-slash-reference`) | all files | `typescript/<same name>` on TypeScript files. Oxlint runs `typescript/*` rules only on TypeScript sources, so 3 of them have a port for JavaScript files (next row). Oxlint runs `no-array-constructor`, `no-require-imports` and `no-unused-expressions` on `.mjs` too (a probe in capture, `xr-runtime` and viewer-api found the same lines as ESLint). The other 13 check type syntax only. |
| `@typescript-eslint/ban-ts-comment`, `no-this-alias`, `triple-slash-reference` on `.mjs` | `.js`, `.mjs`, `.cjs` | `holoim/js-ban-ts-comment`, `holoim/js-no-this-alias`, `holoim/js-triple-slash-reference`: ports of the typescript-eslint 8.71 rules with the recommended options and the same messages (`packages/config-eslint/src/rules/js-typescript-rules.mjs`), loaded by the JS plugin |
| `@typescript-eslint/no-unused-vars` with `^_` ignore patterns | all files | `no-unused-vars`, same options |
| `@typescript-eslint/consistent-type-imports` | all but capture | `typescript/consistent-type-imports` (off in capture) |
| `no-var`, `prefer-const`, `prefer-rest-params`, `prefer-spread` | `.ts`, `.tsx`, `.mts`, `.cts` | same names, TS override |
| 17 JS-only rules that `typescript-eslint` turns off for TS (`constructor-super`, `getter-return`, `no-class-assign`, `no-const-assign`, `no-dupe-class-members`, `no-dupe-keys`, `no-func-assign`, `no-import-assign`, `no-new-native-nonconstructor`, `no-obj-calls`, `no-redeclare`, `no-setter-return`, `no-this-before-super`, `no-undef`, `no-unreachable`, `no-unsafe-negation`, `no-with`) | `.js`, `.mjs`, `.cjs` | same names, JS override |
| `no-dupe-args` | `.mjs` | **No Oxlint rule.** A duplicate parameter is a syntax error in a module. In `.mjs`, ESLint reports it as `no-dupe-args` and `no-redeclare`; Oxlint's parser reports a syntax error and exits 1. Both fail the lint. |
| `no-octal` | all files | **No Oxlint rule.** A `071` literal is a syntax error in a module; ESLint and Oxlint both report a parse error and exit 1. |
| `react-hooks/rules-of-hooks` (error), `react-hooks/exhaustive-deps` (warn) | all of viewer-web; `src/**` of knowledge, place, ui-dom, `xr-ui-core`, `xr-ui-iwsdk`, `xr-ui-r3f`, `xr-ui-three` | `react/rules-of-hooks`, `react/exhaustive-deps`, same severities and globs |
| `holoim/no-token-colour-literal` | all files | the same rule module, loaded as an Oxlint JS plugin (JS plugins are alpha in Oxlint 1.95; the planted defect and the unit test prove it runs) |

Sloppy-mode limit of the two parse-error rows: Oxlint parses a `.ts` file
with no `import` or `export` as a script, where a duplicate parameter and
`071` are legal, so Oxlint reports nothing there. One such file is in scope,
`packages/xr-ui-r3f/src/testSetup.ts`. `tsc` still rejects both (TS2300 for a
duplicate parameter, TS1121 for an octal literal), and typecheck runs on the
same files.

Globals: browser and node on every file, except the JavaScript files of the
packages that ESLint linted with the root config (`apps/viewer-api`,
`apps/viewer-web`, `packages/contracts`). The root config matched only
TypeScript files, so ESLint linted their `.mjs` files with no globals, the
default `no-unused-vars` options and no token rule. Their override keeps
that.

Scope outside the old `files` patterns: some packages' ESLint configs
applied the workspace rules (globals, the `^_` patterns,
`consistent-type-imports`, the token rule) only inside a `files` pattern
(`src/**/*.{mjs,ts}` in avatar-face, avatar-look, meaning, objects and
`xr-runtime`; `src/**/*.ts` and `scripts/**/*.ts` in design-tokens). Oxlint
applies them to every linted file of the package. No tracked file is
outside those patterns today (the file lists match), so no result changes.
A new file there gets the full rule set. This is an accepted
simplification: the full set is the intended one.

Ignores: each `.oxlintrc.json` lists `**/*.d.ts`, `**/dist/**`,
`**/coverage/**`, `**/node_modules/**`, `**/.turbo/**` and its own
(`output/`, `.wrangler/`, `uploads/`, `test-results/`, `playwright-report/`).
Oxlint also reads `.gitignore`, but the lists do not depend on it.

Disable directives: ESLint 9 warns on an unused `eslint-disable` comment.
`options.reportUnusedDisableDirectives: "warn"` in `base.json` does the
same in Oxlint. The tree has 9 directives; all are used, and Oxlint honours
them.

So no rule needs an ESLint pass (step 3): the remaining ESLint pass is empty
and takes 0 s.

### Differences that the proof found

- Oxlint found 3 unsafe optional chains that ESLint missed, because Oxlint
  also looks inside a cast: `(a?.b as T)[k]`. This change fixes them with a
  non-null assertion, where the value is always present:
  `apps/capture/scripts/ci-bodycam-playwright.ts:238` and
  `apps/viewer-api/test/hologram-budgets.test.ts:324-325`.
- Oxlint's `typescript/ban-ts-comment` reports a `@ts-nocheck` that comes
  after the first statement, where `tsc` ignores it. ESLint does not. The
  tree has no such comment, so the stricter rule changes no result.
- TypeScript 6 (the old sidecar) reports 7 implicit-any errors in
  `apps/capture/src/body/BodyTracking.ts` that TypeScript 7 infers. This is a
  TypeScript 6 against 7 difference, not `tsgo` against `tsc`, and the sidecar
  only fed `typescript-eslint`, so no check ran it as a typecheck.

## Acceptance criteria

- [ ] On one clean tree, ESLint and Oxlint both report zero errors and zero
  warnings, and lint the same file set in every package.
- [ ] For every row of the rule map, a planted violation in a scratch copy
  fails the new lint (exit 1) with the expected rule; the `warn` rule warns.
- [ ] No less than 10 planted type errors (wrong argument type, missing
  property, null access under `strict`, wrong generic, bad type import, an
  error across a package boundary, a `.tsx` error, an e2e spec error, a
  `scripts/` error, an unused `@ts-expect-error`) are each reported by the
  new typecheck, and the old commands report the same set.
- [ ] `apps/knowledge` gives the same result with the preview `tsgo` and
  with `tsc` 7.0.2, on the clean tree and on its planted errors.
- [ ] `pnpm run check:all`, `pnpm run doctor` and `pnpm run verify:pr` pass.
- [ ] Times after are recorded beside the times before.
- [ ] A proof video shows the old and new times and the planted defects found.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Oxlint lints fewer files than ESLint (a glob or ignore differs) | Per-package file-list comparison (a probe JS plugin that reports each file) |
| An option or severity is lost in translation | Planted defect per rule group, including option edges (`^_` names pass, other unused names fail) |
| `env` or `ignorePatterns` in the shared file is dropped by `extends` (seen in the prototype) | Globals are set in a `**/*` override, ignores in each package file; a planted `process` use in `.mjs` passes, and an undefined name fails |
| The JS plugin stops loading after an Oxlint update (alpha API), or a port goes silent | `packages/config-eslint/src/token-literals.test.mjs` runs the real Oxlint binary on fixtures and fails when the token rule or any of the 3 ports does not report (checked by breaking one port) |
| An `eslint-disable` comment stops working, so a hidden finding appears or a disabled one is not honoured | Clean-tree run is zero; unused-directive reporting stays as it was (ESLint 9 warns; Oxlint warns) |
| A package without `.oxlintrc.json` falls back to a parent config or Oxlint's default rules | `pnpm run doctor` fails for a package whose `lint` script runs Oxlint and that has no `.oxlintrc.json` (checked by removing one) |
| The two compilers differ on a planted error | Stop and report to the owner; no config change hides it |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead and implementer | Claude, this session | All files in this change |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only |
| Independent verifier | `verifier` subagent (Opus) and `/code-review` | Read-only; test artifacts only |

## Design decision

Oxlint reads JSON configs with `extends`. The shared rules live in
`packages/config-eslint/oxlint/base.json`; `react-src.json` adds the hook
rules under `src/**`. Each package's `.oxlintrc.json` extends one of them and
adds its ignores and its few differences. Override globs resolve against the
package's config, as ESLint's flat-config `files` did, so `src/**` keeps its
meaning. The package keeps its name and devDependency edges, so the change
selectors still lint every dependent when the shared rules change.

Alternatives: `oxlint.config.ts` (experimental, needs Node to load the
config on each run); keeping ESLint for the custom rule only (the JS plugin
runs the same module, so it is not needed); a text scan for token colours
(would also flag comments).

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Same clean result and file set | A probe JS plugin reports each file it sees; ESLint at `main` (a detached worktree) and Oxlint on the branch, in all 18 lint scopes | Pass. Identical file lists in all 18 scopes (root 11, capture 351, knowledge 21, viewer-api 55, viewer-web 159, avatar-face 9, avatar-look 7, contracts 3, design-tokens 10, meaning 6, objects 3, place 4, ui-dom 27, xr-runtime 2, xr-ui-core 30, xr-ui-iwsdk 15, xr-ui-r3f 17, xr-ui-three 21). 0 errors and 0 warnings with both tools, after the 3 optional-chain fixes. |
| Planted lint defects | 61 plants, one or more per rule row and its option edges (`^_` names, `while (true)`, `(a = b)`, capture's type-import off, hooks outside `src/`, the token rule in `.mjs` and in design-tokens, the root-config `.mjs` with no globals, an unused directive), each in a scratch copy, run with ESLint at `main` and Oxlint on the branch | Pass. 60 of 61 give the same rule and exit code. The one difference is the stricter late `@ts-nocheck` (see "Differences that the proof found"). The ports fire on `.mjs` with the original messages. |
| Planted type errors | 12 edits (wrong argument, missing property, null access under `strict`, wrong generic, bad type import, a package boundary, a `.tsx` prop, an e2e spec, root `scripts/`, an unused `@ts-expect-error`, knowledge `.ts`, knowledge `.tsx`), each run through `tsc` 7.0.2, preview `tsgo` 7.0.0-dev.20260707.2 and TypeScript 6 `tsc` | Pass. All 12 have the same line, column and code on `tsc` and `tsgo`; TypeScript 6 also reports each. On the clean tree `tsc` and `tsgo` give 0 errors in every package. No disagreement to report. |
| Gates | `check:all`, `doctor`, `check:ci-areas` (4750 assertions), `scripts/verify-changed.test.ts` (9), the config-eslint test (4), capture `verify:changed` (a planted `debugger` fails it; a changed file that only the ignores match passes), `verify:pr` | `check:all`, `doctor` and the others pass; `verify:pr`: see Status |
| Times after | same commands as "Times before", each old run beside a new run | "Times after" table |

## Independent verification

The `verifier` subagent (Opus) and a code review (Opus) got only this brief
and the diff, in fresh contexts. No vendor other than Claude was used.

- Verifier: every criterion passes, except `verify:pr` and the video, which
  it could not run. Its own evidence: identical file lists in 18 scopes, the
  88 resolved rules mapped with their options, 24 plant sites with the same
  results with both tools, 12 type plants with the same line, column and
  code. Findings and actions:
  1. Rules now apply outside the old `files` patterns: recorded above as
     an accepted simplification.
  2. The brief named a missing-config check that did not exist: added to
     `pnpm run doctor`.
  3. No test covered the 3 ports: added to the plugin test.
  4. The `TODOS.md` link to the archived brief and the index row: done when
     the brief is archived in the same merge.
  5. Wording in `AGENTS.md` and `AGENT_CONTRACT.md` (per linted package; the
     root `.oxlintrc.json` selects quality only): fixed.
- Both found that `verify:changed` failed when Oxlint ignored every changed
  file ("No files found to lint"). Fixed with
  `--no-error-on-unmatched-pattern`.
- Code review: no defect in the ports (compared with the upstream 8.71.2
  sources), configs, `verify-changed.mjs`, the test or the two code fixes.

## Physical-device limits

None. No runtime code changes.
