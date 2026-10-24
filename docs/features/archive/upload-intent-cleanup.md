# Feature brief: Expired upload-intent cleanup

**Lead:** Muse Code
**Status:** Complete
**Layer:** view (storage lifecycle; no capture, export, or rendering change)

## User outcome

Direct (presigned) uploads that are abandoned or expire no longer leak
storage objects and database rows forever. The API periodically removes
expired, uncompleted upload intents together with their `incoming/*.glb`
objects, and prunes completed intent rows after a retention window, without
ever touching a live upload or a published hologram file.

## Scope

**Included:** a periodic cleanup sweep in `apps/viewer-api` (expired
uncompleted intents past a grace period + their storage objects; completed
intent rows older than a retention window, rows only); env configuration
with safe defaults; wiring in `server.ts` next to the USDZ worker; tests.
**Excluded:** accounts/auth, Postgres migration, hologram-file lifecycle
(published GLB/USDZ deletion already exists), multipart (non-presigned)
upload staging, any capture/3D/viewer change.

## Acceptance criteria

- [x] An uncompleted intent whose `expiresAt` is older than the grace
  period is removed, and its `incoming/*.glb` object is deleted first.
- [x] A live (unexpired) intent and its object are never touched.
- [x] An expired intent still inside the grace period is kept, so an
  in-flight `complete` racing expiry is not undercut.
- [x] If the storage delete throws, the intent row is kept for the next
  sweep and the failure is logged; other intents still clean up.
- [x] If the object was never uploaded, the row is still removed.
- [x] Completed intent rows older than the retention window are pruned
  (rows only; the published hologram file is a different key and is kept).
- [x] The sweep is bounded per run and safe to run concurrently from
  multiple API instances (idempotent deletes, conditional row removal).
- [x] Cleanup can be disabled by env; defaults run it hourly.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| `complete` in flight exactly at expiry | Grace period (default 15 min past expiry) before sweeping |
| Storage delete fails (R2 outage) | Row kept, error logged, retried next sweep; sweep continues |
| Object never uploaded (abandoned before PUT) | Row removed even when delete reports no object |
| Completed intent pruned too early breaks idempotent `complete` retry | 24 h retention, far beyond the 10 min upload window |
| Two API instances sweep at once | Storage delete is idempotent; row delete is conditional on still-uncompleted / still-old |
| Unbounded sweep on a large backlog | Batch limit per sweep (default 100) |
| Cleanup deletes a published hologram file | Only `storageKey` (`incoming/…`) is deleted; completed pruning deletes no objects |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Muse Code | Brief, integration, final handoff |
| Design reviewer | Muse Code (self-review against brief) | Read-only review before implementation |
| Implementer | Muse Code | `apps/viewer-api/src/services/upload-intent-cleanup.ts`, `hologram-repo.ts`, `lib/env.ts`, `server.ts`, `test/upload-intent-cleanup.test.ts` |
| Independent verifier | Separate verifier pass | Read-only verification; test artifacts only |

## Design decision

Mirror the existing USDZ worker shape (`startUsdzWorker`): a
`cleanupExpiredUploadIntents()` single-sweep function plus a
`startUploadIntentCleanup()` interval wrapper with an immediate first tick,
`unref`ed timer, and `stop()`. The object is deleted before its row; a
failed delete keeps the row. Completed-intent pruning deletes rows only.
Alternatives considered: R2 lifecycle rules alone (cannot delete DB rows,
and bucket config is operator-owned) and cleaning up lazily inside
`complete` (only runs when someone completes an upload).

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| All criteria above | `pnpm --filter @holoim/api run test -- test/upload-intent-cleanup.test.ts` (real SQLite + local storage in a temp dir) | 6/6 passed; independent verifier PASS on all 8 criteria |
| No regression in upload routes | `pnpm --filter @holoim/api run verify:fast` | 24/24 tests passed, lint + typecheck green |
| Repo gate | `pnpm run verify:agent`, `pnpm run verify:pr` | Both exit 0 (`verify:pr` incl. 9 viewer e2e) |

## Physical-device limits

None. This is server-side storage lifecycle only; no XR, capture, export,
or rendering behavior changes.
