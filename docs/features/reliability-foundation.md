# Feature brief: Development reliability foundation

**Lead:** primary agent  
**Status:** Complete

## User outcome

Developers and agents can add HoloIM features through a repeatable workflow that
defines observable behavior, assigns non-overlapping ownership, detects regressions,
and reports what automated and physical-device checks actually establish.

## Scope

**Included:** reliable XR runner completion and cleanup, inexpensive tests in the
fast gate, API route coverage, distinct PR and nightly CI responsibilities, and a
feature delivery contract with independent verification, plus generated local database
hygiene.  
**Excluded:** production persistence/authentication and physical-headset automation.

## Acceptance criteria

- [x] The capture locomotion wrapper always prints a final PASS or FAIL result and
      terminates descendant server/browser processes.
- [x] Fast verification runs lint, type checks, and inexpensive tests for capture,
      viewer API, and viewer web.
- [x] Viewer API route tests cover upload, pagination, deletion, and failed USDZ
      conversion without modifying the tracked development database.
- [x] Pull requests run one fast quality gate and one pipeline build/smoke gate;
      scheduled/manual CI runs the heavier XR and live integration flows and keeps
      failure artifacts.
- [x] Future feature work has a brief, explicit file ownership, design challenge for
      consequential changes, and independent verification against the original criteria.
- [x] Generated SQLite databases are ignored and reproducible from committed migrations;
      tests use temporary fixture state.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| A wrapper exits while a browser or Vite descendant remains alive | Process-group cleanup integration test |
| An XR child hangs without producing a final result | Bounded flow timeout and timeout cleanup integration test |
| A failed child command appears successful | Non-zero propagation test and final FAIL banner |
| API tests mutate `prisma/dev.db` or real uploads | Temporary database and uploads directory |
| Local API use continually dirties tracked SQLite files | Ignore generated databases and recreate them from migrations |
| Invalid cursor behavior or filesystem cleanup regresses | Route-level pagination and deletion checks |
| USDZ tooling is absent or fails | Route-level 503 behavior check |
| PR CI duplicates expensive XR work | Separate PR and nightly workflow definitions |
| An implementer validates only their own interpretation | Independent verification from this brief |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | primary agent | integration, final verification, handoff |
| Design reviewers | workflow and test agents | read-only repository analysis before implementation |
| XR implementer | XR runner agent | capture wrapper and shared process helper |
| API implementer | API test agent | viewer API testability and route tests |
| Workflow implementer | CI/workflow agent | CI, package verification scripts, workflow docs/templates |
| Independent verifier | primary agent | acceptance criteria and combined repository checks |

## Design decision

Use the existing app-scoped verification commands as the local interface. Keep PR
checks deterministic and reasonably fast; move browser-heavy XR coverage to nightly
or explicit runs. Use process groups for test-runner cleanup, isolated filesystem and
database state for API routes, and repository instructions/templates to preserve the
same delivery shape for future features.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Runner completion and cleanup | tooling integration test, `test:xr:flows`, and original `test:all` reproduction | 4/4 process-helper tests passed, including timeout and descendant cleanup; XR runner printed PASS; port 5174 was immediately reusable; subsequent viewer tests ran |
| Fast app checks | `pnpm run verify:fast` | Passed with tooling 4, capture 11, API 10, and viewer 38 tests plus lint/type checks |
| API route behavior | API Vitest suite | 10/10 passed using a temporary SQLite database and uploads directory |
| CI responsibilities | YAML parse and workflow inspection | Both workflow files parsed; duplicate workspace workflow removed; `git diff --check` passed |
| Feature workflow | brief/template/PR checklist inspection | Repository contract, template, example brief, and PR evidence checklist agree on roles and gates |
| Database hygiene | `prisma:setup`, ignore rules, and Git index inspection | Local files preserved; both generated databases removed from version control; temporary route fixtures passed |

Additional combined evidence: `pnpm run verify:xr` passed on an unrestricted host
(capture mock XR plus 5/5 viewer IWER/SEM cases), `pnpm run build:all` passed, and
`pnpm run test:smoke:pipeline` completed export, upload, fetch, and cleanup.

## Physical-device limits

This change does not alter user-facing XR behavior. Existing capture embodiment and
viewer AR behavior still require the physical-headset checks recorded in `TODOs.md`.
