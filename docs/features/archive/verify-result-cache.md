# Feature brief: verify:pr skips checks whose inputs already passed

**Lead:** Claude (session `infra/verify-input-cache`)
**Status:** Complete (2026-11-24)
**Layer:** None. Developer tooling; no product behavior changes.

## User outcome

The owner and the agents wait much less for `pnpm run verify:pr`, with the
same certainty about the change.

Measured on 2026-11-23 (logs under `output/`): a full run takes 30 minutes on
a quiet machine. The browser suites take 27 of them (pipeline 15 to 16, viewer
XR 8, portal 3, capture XR 2.4). With other sessions running, the pipeline
step took 23 to 31 minutes and failed in 4 of the last 5 logged runs. A rerun
after a failure repeats every step. 14 of the last 40 merges changed only
`apps/capture/scripts/authoring` plus docs and skills, and each still ran
about 22 minutes of browser suites that cannot load that folder.

After this change:

- A check does not run when the same inputs already passed it, in any worktree.
- A rerun after a failure runs only the spec files that did not pass.
- A change to the authoring scripts alone runs the quality checks only, locally
  and on hosted CI.

## Scope

**Included:**

- A result cache in `verify:pr`, keyed by a hash of each step's inputs.
- Spec-file granularity for the three viewer Playwright steps (pipeline,
  portal, viewer XR).
- `apps/capture/scripts/authoring/**` maps to `quality` only in
  `scripts/ci-changed-areas.sh`, with a guard that nothing outside reads it.
- Three gaps in the area selector that the design review found (a separate
  commit, see "Selector gaps").

**Excluded (later steps of the plan):**

- A hosted run on a branch as the gate. It changes the rule "never dispatch CI
  to find out whether something works", so the owner decides it.
- Port leases and a slot limit in place of the machine-wide lock.
- Keys from the bytes of the built bundle (needs a determinism measurement).
- Per-check granularity for the capture XR runner (2.4 minutes in total).
- A cache for `usdz-tools`. It passes with `SKIPPED` when Python packages are
  missing, and it reads tools outside the repository.

## Undo

None. The feature adds no authoring action.

## Design decision

### One rule

The cache only removes work. `verify:pr` selects steps from the diff against
`origin/main` as before. The cache then skips a selected step only when
everything the step can read is the same as in a run that passed. When the
cache cannot decide, it is off and the step runs.

### Step inputs

| Inputs | Steps | Files |
|---|---|---|
| None (always run) | doctor, ci-areas, usdz-tools | Not cached |
| Tree | lint+typecheck, unit, build, e2e-shards, knowledge | Every tracked or untracked file that git does not ignore |
| Code | xr-capture | The tree without Markdown, `docs/` and the authoring folder |
| Code, by spec file | pipeline, portal, xr-viewer | As Code, but each `apps/viewer-web/e2e/**/*.spec.ts` counts only for its own result |

- **The key does not use the area selector.** The selector decides which
  steps a diff needs. The first design also took each step's input files from
  the selector's mapping, and the design review showed that the mapping has
  gaps (a suite reads files that do not select it). In a key, such a gap is a
  stale pass. So a Code key holds every file a browser suite can read. The
  cost: an API-only edit also reruns capture XR when the selector selects it,
  which the selector does not do.
- **What Code leaves out.** `*.md` and `docs/` (a search found no read of
  either in the specs, the capture XR checks, the Vite configs or the test
  API; `docs/product/design/tokens.json` counts as code), and the folders in
  `NOT_SUITE_INPUTS` (`apps/capture/scripts/authoring/`), which a guard keeps
  true (see "Authoring scripts").
- **Tree steps hash everything**, because lint, typecheck, `build:all` and
  Knowledge read Markdown and scripts everywhere. They take under 2 minutes
  together, so a hit only on an exact rerun is enough.
- **`build` makes files that later steps load** (`dist`). When its key hits it
  is skipped, but it runs before the first later step that runs. So a rerun
  with nothing to do runs nothing, and a rerun that runs one suite builds
  first.

### Key

`sha256` of: a cache version, the step label, the step command, OS, CPU
architecture, Node version and Python tools (below), the environment
(below), and the sorted list of `(path, mode, content id)` of the input
files.

- **Content id.** A clean tracked file takes its blob id from
  `git ls-files -s`. A modified or untracked file is hashed with
  `git hash-object`, so the same content has the same id before and after a
  commit. A file missing from disk is recorded as deleted. An unmerged index
  or a file that is not a regular file or a symlink turns the cache off.
- **Files that git is told not to look at.** `git update-index
  --assume-unchanged` and `--skip-worktree` hide an edit from `git ls-files
  -m`. Those files (`git ls-files -v`) are always hashed from disk.
- **Git-ignored inputs.** `.env` and `.env.*` in the root and in each app and
  package, and every file under `apps/viewer-web/public/local-places/` (a
  place-capture test runs only when a downloaded scan is there). A symbolic
  link there counts as the file or folder it points to, because the suites
  read through it. A link to its own parent turns the cache off.
- **Python tools.** The unit tests, the pipeline specs and the test API start
  `USDZ_PYTHON` (or `python3`) with packages from outside the repository. The
  key holds a hash of that interpreter's version and of the version of each
  installed package (one 0.05 s call for each run).
- **Environment.** The value of every set variable that the repository's code
  reads (a scan for `env.NAME` in `apps/`, `packages/`, `scripts/` and the
  root), and of the tools' variables (`CI`, `DEBUG`, `NODE_ENV`, and the
  `VITE_`, `PLAYWRIGHT_`, `XR_`, `E2E_`, `HOLOIM_`, `CAPTURE_` prefixes). Port
  variables and `VERIFY_PR_*` are left out, and a local URL counts without its
  port, so a run on moved ports shares its results. A normal session sets none
  of them. A run with `XR_REPLAY_ONLY` set has its own keys and cannot pass
  for a standard run.
- **Servers that the run did not start.** `REUSE_DEV_SERVER` lets the capture
  checks use a dev server that is already up, with code that the key does not
  describe. The cache is off when it is set. The Knowledge suite reuses a
  server on its port (`KNOWLEDGE_E2E_PORT`, 4176) when one answers there, so
  verify:pr stores no pass for a Knowledge run that found one.
- **Machine state.** The cache is off when `node_modules/.pnpm/lock.yaml`
  differs from `pnpm-lock.yaml` (packages not installed from this lockfile).
  The lockfile is in every key, so the Playwright and Chromium versions are
  too.
- The cache is off when a run starts with `E2E_PASSED_SPECS` set (verify:pr
  sets it itself for one step).

One snapshot of the whole tree takes about 0.25 s. Each step takes a fresh
one, so an edit between two steps of a run is seen.

### Spec files

For pipeline, portal and viewer XR the base key leaves out the content of
every spec file under `apps/viewer-web/e2e/` and holds only their names. A
spec key is `sha256(base key, spec path, mode, content id)`. Helpers and
fixtures in `e2e/` stay in the base key, so a helper edit reruns every spec,
and a new, removed or renamed spec makes a full run. When a code file in a
folder that holds spec files imports a spec file (a named import, an import
for its effect, a dynamic import, a `require`), the step falls back to one
key (none does today).

- After a run, the Playwright JSON report gives each test's verdict. A spec
  file passed when the report has no top-level error and every test in the
  file has status `expected` or `flaky`, or is a declared skip (status and
  expected status both `skipped`). A test that never ran or was interrupted
  has expected status `passed` and status `skipped`, so it does not count
  (measured with Playwright 1.5x in a throwaway project).
- The report must be from this run: verify:pr deletes it before the step and
  checks its start time after.
- A step that fails while every spec file in its report passed failed outside
  the tests. Nothing is stored.
- The list of the step's spec files is stored under the base key, and only by
  a full run. A partial run adds passes and never changes the list.
- A record of a file with a skipped test is used only in the worktree that
  made it. A skip can depend on something that is not in the key.
- On the next run with the same base key: when every file of the list has a
  usable record, the step is skipped. Otherwise the step runs with
  `E2E_PASSED_SPECS` naming the passed files, and `playwright.config.ts` puts
  them in `testIgnore`. A report in which one of those files ran stores
  nothing.
- Keys are computed before the step and again after it. Records are written
  only for keys that did not change, so an edit during a run stores nothing
  for what it touched.

**The assumption: spec files are independent of each other.** The spec
files of one run share one test API, one database and the dev servers. So an
edit to spec file A can change what A leaves there, and spec file B, which
ran after A, keeps its pass without a rerun. The independent verifier named
this as the largest remaining gap. It stays, for two reasons. First, hosted
CI already has it: the mocked suite runs as 4 shards and the pipeline suite
as 6, each on its own runner with its own database, so a spec file there
already runs without most of the others. Second, no dependency was found:
the test API makes a new database for each run, `profiles` uses a unique
token, and the walk take is recorded again when a spec runs alone. A spec
that depends on another file's earlier run fails when it reruns alone, which
is the safe direction. `--no-cache` or `verify:full` runs every spec file
together when a change is about shared state.

### Store

`$(git rev-parse --git-common-dir)/holoim-verify-cache/v1/`, shared by every
worktree, one small JSON file per record (written to a temporary name, then
renamed). `VERIFY_PR_CACHE_DIR` moves it. A record holds the time, branch,
worktree, commit and duration, so a skip can say where the pass came from.
Records older than 14 days are removed at the start of a run.

`verify:pr -- --no-cache` (or `VERIFY_PR_NO_CACHE=1`) and `verify:full` do
not read the cache. They still store passes. `--dry-run` prints which steps
the cache would skip.

### Lock

The first measured rerun did 11 s of work after it waited 140 s for another
session's lock. The lock protects ports and CPU, and a skipped step uses
neither. So a run now takes the lock before the first step that runs, not at
the start. Doctor and `check:ci-areas` are marked `free` (seconds, no server)
and run without it. After a wait, the run reads the cache again for that step:
another session can store the pass during the wait.

### Authoring scripts

`apps/capture/scripts/authoring/*` maps to `quality` only (no capture XR,
pipeline, portal or capture deploy), and the folder is not in a Code key. The
test build already leaves all of `apps/capture/scripts` out of the capture
bundle's fingerprint, and no file outside the folder imports it.
`scripts/check-ci-areas.ts` gains a guard: it fails when a line of code
outside the folder (apps, packages, scripts, workflows, root files) names an
`authoring/` path, or has `"authoring"` as one item of a list (as in
`path.join(here, "authoring", "make.ts")`). It reads files that are not
committed yet too. A comment counts as one only when it starts its line; code
after the end of a comment on the same line is read. The `test:authoring:*`
script in `apps/capture/package.json` may name the folder, and then no other
file may run that script.

One exception came from `main` during this work: the `solver-regression` step
of `verify:pr` runs `test:authoring:solver`, which builds pieces with the
authoring tools. The step is not cached, because its inputs are not listed
yet. The guard permits a `verify:pr` step to run a script of the folder only
when the step has no Code key. A step with a Code key that runs such a script
fails `check:ci-areas`.

### Selector gaps

The design review found files that a suite reads but that do not select it.
They exist on `main` today: such a change merges without the suite, locally
and on hosted CI. Fixed in this branch, as a separate commit:

| Change | Read by | Selected before | Fix |
|---|---|---|---|
| `packages/meaning`, `objects`, `avatar-look`, `tooling-scripts`, `config-ts` | viewer-web, capture and the API (dependencies) | `quality` only | Every package but `config-eslint` selects all browser areas and deploys |
| `apps/capture/public/gltf/*` | 6 mocked viewer specs (`avatar.glb`) | no `web` | Also selects `web` |
| `apps/viewer-api/*` | the portal step (it starts the test API) | no `portal` | Also selects `portal` |
| `scripts/test-api.ts` | the pipeline and portal steps (it is the test API they start) | `quality` only | Selects `pipeline` and `portal`; `check:ci-areas` fails when a suite starts a root script that does not select it |

### Alternatives considered

- **Keys from the selector's areas** (the first design). Rejected in design
  review: a gap in the mapping becomes a stale pass.
- **Hash the built bundle bytes.** Finer (a comment edit would not rerun the
  suites), but it needs a build before the plan is known and a proof that the
  build is deterministic. Deferred.
- **Trace the files each suite opens.** Automatic, but a new file can change
  behavior without being in the old read set, and Chromium, Python and ffmpeg
  need a system tracer.
- **Playwright `--last-failed`.** It does not list tests that never ran after
  an interruption, and it is not keyed by inputs.

### Design review (2026-11-23, `design-reviewer`, Opus)

Six findings, each checked in the code and accepted:

1. Area keys left out files that steps read (the selector gaps above). Keys
   no longer use the selector.
2. A partial run could shrink the stored list of spec files. Only a full run
   writes it.
3. The list of variables that turned the cache off was too small. Variable
   values are now in the key.
4. Machine state: packages that do not match the lockfile, ignored `.env`
   files, the usdz tools. Lockfile check; ignored inputs in the key;
   usdz-tools not cached.
5. A skip can depend on the environment or the disk. Skips are counted in the
   record, and such a record holds only in its worktree.
6. "Matches the hosted shards" was wrong: the shards split inside spec files
   too. The claim is now the measured one under "Spec files".

### Independent verification (2026-11-23)

Two fresh contexts got the brief and the diff: a code review (Sonnet) and the
`verifier` subagent (Opus). Each finding was reproduced before it was
accepted.

| Finding | Result |
|---|---|
| An edit to a file under `--assume-unchanged` or `--skip-worktree` kept the key | Fixed: those files are hashed from disk; test A |
| `REUSE_DEV_SERVER` runs the capture checks on a server with unknown code | Fixed: the cache is off |
| The Knowledge suite reuses a server that already answers on its port | Fixed: no pass is stored for such a run |
| `scripts/test-api.ts` did not select the suites that start it | Fixed in the selector, with a check; added to B-109 |
| A scan or `.env` that is a symbolic link was not in the key | Fixed: links are followed; test A |
| The Python interpreter and its packages were not in the key | Fixed: a hash of both is in the key; test C |
| The authoring guard missed a path in parts, code after a comment on the same line, a code line that starts with `*`, and uncommitted files | Fixed: test B and `check:ci-areas` |
| The spec-import check missed an import for its effect and a helper that imports a spec | Fixed: test E |
| An error that was not a cache decision stopped verify:pr, or lost the final status line after a passed step | Fixed: any error from a read turns the cache off for the run, and any error from a write prints `no pass stored` |
| A spec file keeps its pass when another spec file of the same run changes | Kept, and written down as the assumption under "Spec files" |

## Acceptance criteria

- [x] A second `verify:pr` on an unchanged tree runs only doctor and ci-areas
      (and usdz-tools when selected), names the earlier pass for each skipped
      step, and ends in under 1 minute.
- [x] After an edit to one viewer spec file, the viewer step that has the file
      runs only that file.
- [x] After a run in which one spec file fails, the next run executes only
      that file's step with only that file.
- [x] Each of these changes the key of every step that reads the file: an
      edit, a staged-only edit, a new untracked file, a deletion, a mode
      change.
- [x] A pass stored from one worktree is used in another worktree with the
      same inputs, and is not used when one input differs.
- [x] A never-run test, an interrupted test and a report with a top-level
      error store no pass for their file.
- [x] A change to `apps/capture/scripts/authoring/**` alone selects only
      `quality` (local plan and `ci-changed-areas.sh` output), and the guard
      fails on a new reference to the folder from outside.
- [x] `--no-cache` and `verify:full` run every selected step and store passes.
- [x] A run whose steps are all skipped ends while another process holds the
      machine-wide lock. A run with one step to execute waits for the lock.
- [x] Each selector gap in the table above selects its suite.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| A step reads a file that is not in its key (a stale pass) | Code keys hold every non-ignored file but Markdown, `docs/` and the guarded authoring folder; Tree keys hold every file; ignored `.env` files and `local-places` are added |
| Uncommitted, staged or untracked changes are missed | Content ids from the working tree (`git ls-files -m`, `-o`, `hash-object`); test A |
| Something outside starts to read the authoring folder | Guard in `check:ci-areas`; test B |
| A pass from another environment is used | Variable values in the key; cache off on a lockfile mismatch; test C |
| A partial Playwright run counts as a pass (interrupt, global timeout, `beforeAll` failure, failed server) | Per-test rule on status and expected status; no record on a top-level error, an old report, or a failure with no failed spec; test D |
| `E2E_PASSED_SPECS` does not reach Playwright, and a rerun looks complete | A report in which a left-out file ran stores nothing; test D |
| The list of spec files is wrong (partial run, new spec) | Only a full run writes it; spec names are in the base key; test E |
| A spec depends on another spec's code | One key for the step when a spec imports a spec; test E |
| A spec passes alone but depends on another file's earlier run | It fails when rerun alone (fails closed); none found |
| A skip hides a test that would run elsewhere | Records with skips hold only in their worktree; test F |
| The tree changes while a step runs | Keys recomputed after the step; test G |
| A flaky pass is stored | Same acceptance as today: one pass merges. `--no-cache` forces a fresh run |
| `dist` missing or stale in a worktree that skipped `build` | `build` runs before the first later step that runs |
| Two runs write the store at once | One file per record, temporary name then rename |
| The store grows without limit | 14-day prune |
| Tool or runtime change (Node, Playwright, OS, Python) | Node version, OS, architecture, the lockfile and a hash of the Python tools are in the key; a cache version constant for recipe changes; test C |
| An input that git or the directory walk does not show (a file git is told not to look at, a symbolic link) | Both are read from disk; test A |
| A suite uses a server that the run did not start | Cache off with `REUSE_DEV_SERVER`; no pass for a Knowledge run on a foreign server |
| The cache code itself fails (a full disk, a file that goes away) | The step runs and its own result stands; nothing is stored |
| usdz-tools passes as SKIPPED and is then skipped for good | Not cached |
| A test proves the cache only on paper | Ten deliberate breaks of `verify-cache.ts` (one per rule above) each fail a test, and each test added after the reviews fails on the code before its fix |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude (this session) | Brief, integration, final handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only review before implementation |
| Implementer | Claude (this session) | `scripts/verify-pr.ts`, `scripts/verify-cache.ts`, `scripts/verify-cache.test.ts`, `scripts/ci-changed-areas.sh`, `scripts/check-ci-areas.ts`, `apps/viewer-web/playwright.config.ts`, `AGENT_CONTRACT.md`, `AGENTS.md` |
| Independent verifier | `verifier` subagent (Opus) and a code review of the diff | Read-only verification; test artifacts only |

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Unchanged tree reruns in under 1 minute | Two real `pnpm run verify:pr` runs in this worktree | 2026-11-23, commit `b97dbab0571f`. First run: `PASSED in 1702s` (125 s of it a wait for another session's lock). Second run with no change: every cached step `skipped`, `PASSED in 12s` |
| One edited spec reruns alone | Edit one spec, real `verify:pr` | Same sequence: after an edit to one portal spec file, `portal: pnpm run test:portal (1 of 3 spec files; the others passed with the same inputs)`, `passed in 24s`. Pipeline (13 spec files) and viewer XR (9 spec files) `skipped`. Run: `PASSED in 174s` |
| A failed spec reruns alone | Force one spec to fail, run, repair, run | Same sequence. Run with the failing test: `FAILED (exit 1) in 24s`, `stored a pass for 0 of 1 spec files`. Run again with no change: portal runs the 1 file again and fails again (`FAILED in 114s` for the run). After the repair: the 1 file passes, `PASSED in 174s`. Then no change: `PASSED in 12s` |
| Key changes; shared store; partial reports; skips; environment | `scripts/verify-cache.test.ts` on temporary git repositories and the measured Playwright report shapes (tests A to G) | `pnpm run test:tooling`: 34 tests pass (25 of them in `scripts/verify-cache.test.ts`) |
| Authoring-only selection and guard; selector gaps | `pnpm run check:ci-areas` | `check-ci-areas: 4782 assertions passed (975 source files, 367 docs, 851 other files)` on the tree merged with `main`. A `solver-regression` step with a Code key makes it fail |
| `--no-cache`, `verify:full` | `pnpm run verify:pr -- --no-cache --dry-run` and the test "a failed step stores nothing; --no-cache does not read but stores" | The plan prints `result cache: not read in this run; passes are stored` and `would run` for each selected step. No full 26-minute run was made with `--no-cache`: the first full run of each code state did the same work |
| No wait for the lock when all steps are skipped | Hold the lock in a second process, real `verify:pr` | 2026-11-23: the run with no change printed `no step needed the machine-wide lock` and `PASSED in 12s`. The run with one spec file to execute waited 1171 s for another session's lock, then ran |

## Physical-device limits

None. No product behavior changes.
