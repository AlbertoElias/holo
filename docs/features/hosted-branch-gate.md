# Feature brief: hosted branch gate

**Lead:** Claude Code session `hosted-branch-gate` (Opus 5.5)  
**Status:** Reviewed  
**Layer:** None (developer tooling; no product behavior changes)

## User outcome

An agent passes the pre-merge gate with one command, `pnpm run verify:hosted`.
The command runs the fast local checks, then runs the hosted test jobs on the
branch merged with the current `origin/main`, waits, and prints pass or fail
with the failed job and test names. The hosted jobs run in parallel on about
20 runners, so the gate takes minutes, and it does not wait for the
machine-wide `verify:pr` lock. Many sessions can use it at the same time.

When the gated tree lands on `main` unchanged, the push to `main` does not run
again the suites that the gate run passed. The deploy still runs.

A full local `pnpm run verify:pr` stays valid as the other way to pass the
gate (owner decision, 2026-11-24).

## Scope

**Included:**

- `scripts/verify-hosted.ts` and the `verify:hosted` script in `package.json`.
- `.github/workflows/ci.yml`: a push trigger for `gate/**` refs, the gate's
  area selection, the reuse of a gate run's results on `main`, main-only
  bundle uploads.
- `scripts/ci-gate-reuse.sh` (new): finds a green gate run for a tree.
- `.github/workflows/deploy.yml`: a main-only condition.
- `environment: production` on `api-image` and every deploy job, in both
  workflows. The `production` environment (owner's yes, 2026-11-24) has the
  deployment-branch policy "main only" and holds the three deploy secrets.
- The one-time rerun of failed browser-suite jobs ("Rerun rule").
- `ci.yml` deploy concurrency groups: the shared group name only on `main`.
- Instruction files: `AGENTS.md`, `AGENT_CONTRACT.md`, `docs/FEATURE_WORKFLOW.md`,
  the header of `scripts/ci-changed-areas.sh`.

**Excluded:**

- `scripts/verify-lock.ts`, the lock and port code in `scripts/verify-pr.ts`,
  the Playwright configs, and the `lint` and `typecheck` scripts (other
  sessions own them). `verify-hosted.ts` only imports `parseAreas`, `selectSteps`
  and `touchesSolver` from `verify-pr.ts`.
- `.claude/settings.json` keeps its deny rule for `gh workflow run`. The gate
  does not dispatch; it pushes a `gate/**` ref.
- Branch protection and other repository settings. The owner's yes covers
  only the `production` environment and its three secrets: the owner enters
  the values and, after the first green deploy from `main`, deletes the
  repository-level copies.
- Pull-request triggers. No fork or outside contributor can start a gate run:
  only a user with write access can push a `gate/**` ref.

## Undo

None: the change adds no capture authoring action.

## First-attempt failures on `main` (step 1)

Source: `gh run list --workflow CI --branch main --limit 40` on 2026-11-24.
38 runs completed; 2 were cancelled by a newer push (45342250666,
44876678236) and are not counted. 31 passed on attempt 1. 7 failed on
attempt 1 (18 %): 4 passed on attempt 2 and 3 stayed red.

| Run (commit) | Job | Test | Class | Record |
|---|---|---|---|---|
| 44869917236 (b8b70baf) | Quick Look tool check | `exercise_usdz.py`: "Source needs two embedded base color materials for alpha challenges" | Real defect, every run. The house base has flat-colour materials; the challenge needed images. Fixed in 94384e67. | Commit message |
| 44880742510 a1 (a0ad1998) | Portal view end-to-end | `portal.spec.ts:246` tilt permission: "feed scroll did not settle: 845, …" | Real defect, intermittent: the product's 1 px load-more sentinel gave a short feed 1 px of extra scroll. | B-089 (closed) |
| 45183739635 a1 (9cc877c5) | Portal view end-to-end | `portal.spec.ts:214` tilt: `locator.click` on Return timed out | Flake (test defect: the click scrolled the feed on a loaded runner) | B-090 (closed, fixed in 80afb248) |
| 45195106971 (22199d76) | Portal view end-to-end | `deep-zoom.spec.ts:241`: mode "follow", expected "free" | Flake, cause not known | B-085 (open) |
| 45269930460 (79475539) | Portal view end-to-end | `portal.spec.ts:214` tilt: `locator.click` on Return timed out | Flake (same test defect) | B-090 (closed) |
| 45330508669 a1 (af3e48fa) | Viewer and Knowledge browser checks (shard 2/4) | none: the job was cancelled at its 10-minute limit | Flake (infrastructure): the Playwright Chromium cache missed, and the apt install took 7 minutes on a slow mirror | B-111 (open, new) |
| 45340950168 a1 (8107f752) | Portal view end-to-end | `portal.pipeline.spec.ts:120`: two wheel steps did not zoom in (distance stayed 7.14) | Flake, probably the cause of B-085 | B-085 (open) |

Result: 2 real defects, 5 flakes (13 % of the runs). 4 of the 5 flakes are in
the portal job. B-090 is fixed, so the open flake causes are B-085 (2 runs)
and the slow Playwright install (1 run): about 3 in 38 runs (8 %).
`BUGS.md` B-085 said that the run on 79475539 failed at `deep-zoom.spec.ts:241`;
the log shows `portal.spec.ts:214` (B-090). This change corrects that line.

### Rerun rule (owner's decision)

Proposal sent to the owner on 2026-11-24: the command reruns the failed jobs
once, only when every failed job is a browser-suite job (a quality job failure:
lint, typecheck, unit tests or build, never reruns). If the rerun passes, the
gate is green and the command prints each test that failed in attempt 1; the
agent adds a `BUGS.md` record for it (new, or "observed again") before the
merge. If a job fails again, the gate is red: reproduce with
`scripts/ci-emulate.sh`. **Decision (owner, 2026-11-24):** approved. Only the
failed jobs rerun (`gh run rerun --failed`), one time. A job counts as a
browser-suite job when its name starts with "Capture XR checks", "Viewer and
Knowledge browser checks", "Viewer VR gallery", "Capture to viewer pipeline"
or "Portal view end-to-end", and its conclusion is failure, timed out or
cancelled. GitHub reports a job past its `timeout-minutes` as cancelled (run
45330508669, B-111), and nothing else cancels a gate run's jobs. The
aggregate "CI Gate" job reruns with them and does not count. A failure of the
area selection, the quality job or the Quick Look tool check never reruns. On
a green rerun the command prints "FLAKY" with the tests of attempt 1, and
`output/verify-hosted.json` holds them in `flaky`. It then prints no land
command: the agent commits the `BUGS.md` record on the branch and merges the
branch. That commit changes the tree, so `main` runs the suites again.

The owner approved "the failed browser-suite jobs". The count of a cancelled
job as a failed one is this session's reading of that approval, added after
it (B-111 showed that a timeout reports as cancelled). The owner can reverse
it: remove "cancelled" from `onlyBrowserSuitesFailed` in
`scripts/verify-hosted.ts`.

Three rules keep a gate run's result honest. The branch and the gate ref go
up in one atomic push, so a refused branch push makes no gate ref. A red run
of the same commit does not count again: the next `verify:hosted` starts a
new run, and a running or green run is reused. A status read from GitHub
is tried 3 times, 10 s apart, before the command stops with exit 2; the gate
ref is deleted on every exit after the push, a stop by SIGINT or SIGTERM
included.

## Acceptance criteria

- [ ] `pnpm run verify:hosted` on a branch with a small change in
  `apps/viewer-web` passes. The brief records its wall time beside the local
  `verify:pr` time for the same change.
- [ ] On a branch with a planted failing test, the command fails and prints
  the job name and the test name.
- [ ] The gate tests the branch merged with the current `origin/main`. The
  command stops before it pushes when the merge has a conflict.
- [ ] The gate run selects the same suites that the push to `main` would
  select (`scripts/ci-changed-areas.sh`, base from `scripts/ci-push-base.sh`).
- [ ] After a green gate run, the merge into `main` deploys, and the run on
  `main` shows the suites that the gate passed as skipped, with the gate run's
  number in its summary. When `main` moved after the gate run, the tree is
  different and the suites run.
- [ ] A branch run cannot deploy: the workflow conditions show it, and a gate
  run shows every deploy job skipped. `deploy.yml` deploys only from `main`.
  Every job that reads a deploy secret runs in the environment `production`,
  whose branch policy is main only. A skipped deploy job of a gate run is in
  no shared deploy group.
- [ ] No job of a gate run reads a secret (only the test jobs run, and they
  use none).
- [ ] Two gate runs at the same time do not cancel each other.
- [ ] `pnpm run doctor` and `pnpm run verify:pr` pass.
- [ ] A proof video (H.264 MP4, under ignored `output/`) shows the command
  from its start to the green result.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| The gate tests the branch alone, and `main` breaks after the merge | The command makes the merge commit (`git merge-tree --write-tree`, `git commit-tree` with `origin/main` as the first parent and the branch as the second) and gates that commit. |
| The merge has a conflict | `git merge-tree` exits 1; the command stops before it pushes and tells the agent to merge `origin/main` and resolve. Another exit code is reported as a `merge-tree` error, not as a conflict. |
| Uncommitted edits are not in the gate | The command refuses a dirty working tree (tracked changes or untracked files that are not ignored). |
| The gate selects fewer suites than `main` would | The gate's base is the last green `main` run that is an ancestor (`ci-push-base.sh`), the same base `main` uses. The merge commit has `origin/main` as a parent. |
| `main` skips a suite that the gate did not pass | A suite is skipped on `main` only when the gate run's conclusion is success and every job of that suite in the gate run concluded success (at least one job). A suite that the gate skipped, or a renamed job that the reuse script does not know, runs on `main`. |
| `main` reuses a gate run for a different tree | The gate ref is `gate/<tree>`. The gate's changes job fails when the ref is not `gate/<HEAD^{tree}>`, on a push and on a dispatch. `main` lists only green push runs on the exact ref `gate/<its own HEAD^{tree}>` and reads the tree of each run's commit before it uses the run. The same tree includes the same `ci.yml`, so the gate ran the jobs that `main` would run. |
| The runner image, an `@v4` action tag or a cached tool changed after the gate run | These are not in the tree. `main` reuses only a run that finished in the last 24 hours. |
| `main` moved after the gate run | The merge commit on `main` has a different tree, no gate run matches, and the suites run as today. |
| Skipping quality on `main` removes the bundles that the deploys use | When quality is reused and a deploy needs a bundle, the quality job still runs the build and the bundle checks; only lint, typecheck, unit tests and the shard check are skipped. |
| Reused suites make the CI Gate's "no area selected" check fail | The changes job outputs `reused_suites`; the check accepts a reused suite as a selected one. The reuse script rewrites the areas file before the step writes it to `GITHUB_OUTPUT`, so each key is written once. |
| A gate run deploys | Every deploy job and `api-image` keep `github.ref == 'refs/heads/main'`. `deploy.yml` gets a main-only condition on its `changes` job, which every deploy job needs. A rollback is a revert on `main`, then a deploy. |
| A skipped deploy job of a gate run cancels a pending deploy on `main` | The deploy groups have `cancel-in-progress: false`, so a newer pending job replaces an older pending one in the same group. On a ref that is not `main`, each deploy job's group is `gate-deploy-<app>-<run id>`, so it never shares a group with `main` or `deploy.yml`. |
| An edited workflow on a gate ref reads a deploy secret | The in-file conditions do not stop an edited workflow, and an agent can make that edit by mistake. Only a GitHub environment with a main-only branch policy stops it. The environment `production` holds the three deploy secrets, and every job that reads one names it; GitHub refuses that job on any ref but `main`. The repository-level copies go after the first green deploy from `main`. Only users with write access can push a gate ref. |
| Two gate runs cancel each other | Each job's cancel group is `ci-<job>-${{ github.ref }}` and each gate ref is different (the tree is in the name). Two branches with the same tree hold the same content. |
| The same tree is gated twice | The merge commit is deterministic (the configured git identity, the message "Merge branch '<branch>'", dates from the newer parent), so the second push is a no-op. Before it pushes, the command looks for a run of that commit and waits for it or reports its result. When the ref holds another commit of the same tree, the command stops and says so. |
| Gate runs push `main`'s Actions caches out (the 10 GB limit) | A cache missed on a gate ref is saved in that ref's scope. After the run, the command deletes the caches of the gate ref (`gh cache delete --all --ref`). |
| A gate push runs the branch's own pushes in CI | `on.push.branches` is `[main, 'gate/**']`; a push of `feature/*` still starts nothing. |
| Deleting a gate ref starts a run | `on.push` starts no run for a deleted branch. Checked: after the command deleted both gate refs, `gh run list` showed no new run. |
| The command polls in the agent's context | The command waits by itself and prints one line per finished job. The agent runs it in the background and is told when it exits. |
| A gate passes but the local-only solver regression would fail | The command runs the solver regression locally when `verify:pr` would (`touchesSolver`). |
| The usdz-tools check is SKIPPED locally (no Python packages) | Hosted runs it with its packages, so the gate is stronger here than `verify:pr`. |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead and implementer | this session | Brief, `scripts/verify-hosted.ts`, `scripts/ci-gate-reuse.sh`, `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `package.json` (one script line), instruction files |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only review before implementation |
| Independent verifier | `verifier` subagent (Opus) and `/code-review high` | Read-only verification |

## Design decision

**Trigger: a push to `gate/<tree>`, not a dispatch.** A dispatch
needs `gh workflow run`, which `.claude/settings.json` denies to agents, and
the run's tree would come from an input that the run must check. A push to a
ref whose name holds the tree lets the run check its own name, gives `main` an
exact lookup (`gh run list --branch gate/<tree>`), and keeps the deny rule
for ad-hoc dispatches. The branch name is in the merge commit's message.

**The tested commit.** `git fetch origin main`; when `origin/main` is an
ancestor of `HEAD`, the gate tests `HEAD`. Otherwise
`git merge-tree --write-tree origin/main HEAD` gives the merged tree, and
`git commit-tree` makes a merge commit with the parents `origin/main` (first)
and `HEAD`, the message "Merge branch '<branch>'", the configured git identity
and dates from the newer parent, so the same inputs always give the same
commit. It is the commit that `git merge <branch>` on `main` would make, so
the command tells the agent to land that exact commit with
`git merge --ff-only <commit>` in the main checkout. A normal merge also
works when it gives the same tree.

**Selection on a gate ref.** The changes job runs
`ci-push-base.sh ci.yml HEAD ""` and `ci-changed-areas.sh <base> HEAD`,
as on `main`.

**Reuse on `main`.** After the selection, `scripts/ci-gate-reuse.sh` looks
for the newest green push run of `ci.yml` on the ref `gate/<HEAD^{tree}>`
that finished in the last 24 hours. For
each suite (quality; capture_xr; e2e, which is the viewer shards and the VR
shards; pipeline; portal; usdz_tools) whose jobs all passed there, it sets the
suite's area to false. For quality, `quality_checks=false` turns off lint,
typecheck, unit tests and the shard check, and the job still runs the build
when `web` or `capture_app` is true. The summary names the gate run and the
reused suites. A lookup error reuses nothing.

**Local phase.** The command runs these `verify:pr` steps for the selected
areas, with the result cache: doctor, ci-areas, lint and typecheck, unit
tests, and the solver regression. It does not take the machine-wide lock:
these steps start no server and use no fixed port. The task names these
checks; the design reviewer noted that lint, typecheck and unit tests also run
in the hosted quality job and add CPU load beside another session's browser
suites. `verify:agent` already runs them without the lock in every session,
so the load is not new; the local run gives a fast failure before the push.

**Waiting and the report.** The command pushes the branch and the gate ref in
one `git push --no-verify` (its local phase already ran more than the
pre-push hook), finds the run, and checks it every 20 s. It prints one line
per finished job. At the end it prints PASSED or FAILED, the run URL, the
failed jobs and, from each failed job's log, the failed test lines
(Playwright `✘`, node test `not ok`, `FAIL`, and the `##[error]` line). It
writes `output/verify-hosted.json` and `output/verify-hosted.exit`. It then
deletes the gate ref and its Actions caches; the run and its results stay.

**Runner queue.** A gate run that selects every suite has about 22 jobs; a
public repository has 20 concurrent runners. Two gate runs and a push to
`main` at the same time wait for runners, and the deploys on `main` wait
with them. The test plan records the queue time of the gate run.

**Alternatives considered.** A `workflow_dispatch` with a tree input (blocked
by the deny rule, and the input needs checking). Reusing the gate run's
bundles for the deploy (cross-run artifacts with a 3-day life; the build on
`main` costs about 1 minute and keeps the deploy independent). Skipping by
commit SHA (the merge on `main` is a new commit; the tree is what is the same).

## Design review (2026-11-24)

The `design-reviewer` subagent (Opus) reviewed the draft. It confirmed the
skip rule: `main` skips a suite only when that suite ran green in a run whose
conclusion is success. Findings and what changed:

| Finding | Change |
|---|---|
| Repository secrets reach push runs on every ref; an edited deploy condition on a gate ref deploys | The `production` environment is a precondition for the merge (open decision 2). |
| A skipped gate deploy job can take the shared deploy group and cancel a pending deploy on `main` | Deploy groups on refs other than `main` are `gate-deploy-<app>-<run id>`. |
| A dispatch on a gate ref skipped the tree check | The check runs for every run on a `gate/` ref, before the dispatch branch. |
| The merge commit had the branch as its first parent | `origin/main` is the first parent; the message is "Merge branch '<branch>'"; the command prints the fast-forward to land it. |
| `gh run list --branch` matches exactly, and a list window can miss a run | The ref is `gate/<tree>`, and the lookup uses `--branch gate/<tree>`. |
| Duplicate keys in `GITHUB_OUTPUT` | Not a problem here: the reuse script rewrites the areas file, and the step writes each key once. |
| The quality job split | Already as proposed: the job runs when quality is reused but a bundle is needed; the lint, unit and shard steps check `quality_checks`. |
| Drift outside the tree | Reuse only a run that finished in the last 24 hours. |
| Cache pressure from gate refs | The command deletes the gate ref's caches after the run. |
| Runner queue | Recorded above; the test plan records the queue time. |
| `merge-tree` errors, commit identity, an existing run, deleting the ref | Exit codes split; the configured identity; the command looks for a run of the commit before it pushes; the ref is deleted after the run ends. |
| Lint, typecheck and unit tests locally without the lock | Kept, because the task names them (see "Local phase"). |
| `deploy.yml` main-only blocks a rollback dispatched on a tag | First the condition allowed a tag. The `production` environment allows only `main`, so a tag deploy fails there anyway: the condition is main only, and a rollback is a revert on `main`. |
| The gate never builds the API image | Not changed: the image builds on `main` before its deploy, as today. A Dockerfile defect still shows only on `main`. |

## Decisions (owner, 2026-11-24)

1. The rerun rule (above): approved.
2. Secret scoping: approved. The sequence:
   1. This session creates the environment `production` with the
      deployment-branch policy "main only". Done: environment id
      28387246589, one branch policy, `main`.
   2. The owner enters `FLY_API_TOKEN`, `CLOUDFLARE_API_TOKEN` and
      `CLOUDFLARE_ACCOUNT_ID` in that environment.
   3. Only then does the change with `environment: production` merge.
   4. After the next green deploy from `main`, the owner deletes the three
      repository-level copies. This session does not delete them.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Small viewer change passes; wall time vs `verify:pr` | `pnpm run verify:hosted`; `pnpm run verify:pr -- --no-cache` on the same commit | pending |
| Planted failing test | throwaway branch with a failing Playwright test, `pnpm run verify:hosted` | Run 45404331213 (tree 047d8b55), 11m28s: FAILED, exit 1. The command printed `failed job: Viewer and Knowledge browser checks (shard 4/4)` and `✘ 12 e2e/atlas.spec.ts:593:1 › planted gate failure: the atlas title is wrong on purpose`. |
| Rerun rule: a second failure is red | the new command on the failed planted run | Run 45404331213: the command reran the failed shard once (attempt 2, 4m35s); the planted test failed again; FAILED, exit 1; `output/verify-hosted.json` holds `firstAttemptFailures` and `failures`. Green-rerun path: gate run 45847778751 (tree a7cd7367, 2026-11-26), 10m50s. Attempt 1 failed `portal.pipeline.spec.ts:120` (B-085); the command reran that job once, attempt 2 passed, and it printed PASSED, FLAKY with that test, and no land command; exit 0. The BUGS.md record came next, on the branch. |
| Merge conflict stops the command | a branch that conflicts with `origin/main`, `--dry-run` | A throwaway branch that edits a line of `docs/features/your-look.md` that `main` also changed: "FAILED: the branch conflicts with origin/main (docs/features/your-look.md)", exit 2, nothing pushed. |
| Same selection as `main` | the gate run's "Changed areas" summary against `ci-changed-areas.sh` run locally | pending |
| `main` skips the gated suites | the run on `main` after the merge: skipped jobs and its summary | pending |
| A branch run cannot deploy | the conditions in `ci.yml` and `deploy.yml`; deploy jobs skipped in a gate run | Run 45404255068: "Build API image", "Deploy API (Fly)", "Deploy viewer (Pages)" and "Deploy capture (Pages)" skipped. `api-image` and the deploy jobs name the environment `production` (branch policy `main`). |
| Two gate runs do not cancel each other | two gate runs on two refs at the same time | Runs 45404255068 (13:31:09–13:37:08 UTC) and 45404331213 (from 13:31:36) overlapped; neither job was cancelled. Their test jobs started 2–3 s after the changes job (no runner queue at that time). |
| doctor and verify:pr | `pnpm run doctor`, `pnpm run verify:pr` | pending |
| Proof video | screen recording of the command | `output/hosted-gate-proof/verify-hosted-green.mp4` (H.264, 9m12s, real time, the green run 45404255068); not committed |

## Physical-device limits

None: no product behavior changes.
