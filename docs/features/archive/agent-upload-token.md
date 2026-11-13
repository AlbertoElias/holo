# Feature brief: Agent upload token

**Lead:** Claude Code (Opus), session started from the showcase session
**Status:** Complete (on `main` d1414798, deployed 2026-11-12; production token set up by the user)
**Layer:** None (publishing infrastructure; no change to what a hologram is or how it is viewed)

## User outcome

An agent session publishes a showcase hologram to production with
`pnpm --filter @holoim/capture run showcase:upload --api https://holoim-api.fly.dev <scene>`
and nothing else: no emailed sign-in link, no token pasted into chat. The
piece is credited to a dedicated agent creator account, **Claude
(agent-authored)**, whose email is a plus-address of the user's (kept out
of the repo, which is public), not to the user.
The user sets this up once with one command and revokes it with another.

## Scope

**Included:**

- An `ApiToken` table in `apps/viewer-api`: a hashed, revocable token tied
  to one account, with a label, `lastUsedAt`, and a nullable `expiresAt`
  (left empty: the user chose no expiry).
- API tokens carry a `holoim_at_` prefix. The API accepts one as
  `Authorization: Bearer` for **uploading** (`POST /holograms`, the
  initiate/complete upload routes) and **`GET /auth/me`**. Public reads
  (`GET /holograms`, `GET /holograms/:id`) see it as its account, which
  only sets `ownedByViewer` on its own pieces. Renaming the account (`PATCH /auth/me`) and deleting holograms answer
  `403` to an API token, so a misled agent can neither change the byline on
  every piece nor delete the agent's work. Sessions keep working unchanged;
  no endpoint changes shape.
- A production CLI, `apps/viewer-api/src/agent-token.ts`, run through
  `fly ssh console` like `claim-uploads.ts`:
  - `register --email --name --hash <64 hex> [--label]` creates the account
    if missing and stores the hash. It refuses anything that is not 64 hex
    characters (so a pasted raw token never reaches Fly), and an
    already-registered hash is a no-op.
  - `list` shows tokens (label, account, created, last used), never hashes.
  - `revoke --hash <64 hex>` or `--id` deletes the row.
  - `move --from <email> --to <email> [--id ...] [--apply]` lists the
    source account's holograms (dry run), then moves the chosen ones to the
    agent account and sets their byline to its display name. This covers
    "The way down" and "The way down II".
- `scripts/agent-upload-token.sh` for the user, with `setup <api origin>`
  and `revoke <api origin>`. Setup wakes the Fly machine, generates the
  token on the Mac, registers only its SHA-256 hash, and stores the token in
  the Keychain only after registration succeeds. The token reaches
  `security` through stdin (`security -i`), never argv. Revoke deletes the
  production row and the Keychain entry. The raw value never leaves the
  Mac, never prints, and never passes through chat, Fly, or a log.
- `apps/capture/scripts/showcase/upload.mjs`: when `HOLOIM_SESSION` is unset
  it reads the Keychain entry for the `--api` host (service
  `holoim-agent-upload`, account = lowercased host). Before reading any GLB
  it calls `GET /auth/me` and prints the account it uploads as. It refuses
  to send a token over plain `http` to a non-loopback host and sends with
  `redirect: "error"`. It never prints the token. `HOLOIM_SESSION` keeps
  working as today.
- Setup, revocation and the move documented in `AGENT_CONTRACT.md` and the
  showcase concept doc.

**Excluded:**

- Test uploads. The `TODOS.md` item "Tests should not have to sign in" is
  already delivered (`TEST_OPEN_UPLOADS`, off in production); this work does
  not touch it.
- A web UI for tokens, tokens for ordinary creators, and finer scopes.
- Anonymous deletion of unowned holograms (`holograms.ts:499`). The review
  flagged it as a gap, but it is the documented legacy rule in
  `creator-accounts.md` ("unowned + anyone → 200"), so it is not a
  bug; whether it still makes sense now that uploads need an account is a
  question for the user, outside this brief.

## Undo

None: no capture authoring action changes.

## Acceptance criteria

- [x] With a Keychain entry and no `HOLOIM_SESSION`, `showcase:upload` to
      production prints "uploading as Claude (agent-authored)", and the
      piece is owned by the agent account with that byline. The output never
      contains the token.
- [x] A revoked or unknown token gets `401`. The script says the token was
      refused and names the setup command, and it uploads nothing.
- [x] A Keychain entry is only sent to the host it was registered for.
      Uploading to a local API does not send the production token.
- [x] An API token gets `403` on `PATCH /auth/me` and on delete.
      `POST /auth/logout` with it leaves the token valid.
- [x] Magic-link sign-in, sessions, logout and anonymous reads behave as
      before (existing auth and hologram route tests stay green).
- [x] No HTTP route creates a token, and the database holds only hashes.
      The setup script's hash equals the API's `hashToken`.
- [x] ~~"The way down" and "The way down II" show the agent byline and sit on
      the agent's creator page after the move.~~ Dropped by the user: the
      `move` dry run listed "The way down" and the user chose to keep it;
      "The way down II" was not on production and is uploaded as the agent.
- [x] `pnpm run verify:pr` passes. The migration deploys and production
      health checks are green.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Token leaks (log, transcript, `ps`, shell history) | Generated on the Mac; stdin to `security`; read with `security -w` into memory; never echoed; prod holds a hash |
| Hash mismatch at setup (trailing newline, missing prefix) | `printf %s` of the full prefixed token; `register` validates 64 hex; a test checks the shell hash against `hashToken` |
| Keychain holds a token prod never registered | Keychain write happens only after `register` succeeds |
| Fly machine stopped (`min_machines_running = 0`) | Setup wakes it with `/healthz` before `fly ssh console`; absolute `dist` path; fails loudly without `DATABASE_URL` |
| Setup run before the migration deployed | Setup is documented as after deploy; `register` reports a missing table plainly |
| Token sent to the wrong host or downgraded | Keychain account is the `--api` host; no token over non-loopback `http`; `redirect: "error"` |
| Misled agent renames the account or deletes pieces | API tokens get `403` on `PATCH /auth/me` and delete |
| Revocation does not take effect | Revoke deletes the row; every request looks up by hash, no cache |
| Unknown `holoim_at_` token falls through to session lookup | Prefix routes to the token table only; a miss returns null |
| `lastUsedAt` writes contend with uploads on SQLite | Written at most once an hour per token (`updateMany where lastUsedAt < now - 1h`) |
| Migration breaks the running API or a rollback | Additive table only; an older image ignores it |
| Move hits the wrong holograms | Dry run lists them first; only listed ids owned by `--from` move; a rerun changes nothing |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | This session | Brief, integration, handoff |
| Design reviewer | `design-reviewer` subagent (Opus), done | Read-only |
| Implementer | This session | `apps/viewer-api/{prisma,src/services/auth.ts,src/routes/auth.ts,src/routes/holograms.ts,src/agent-token.ts,test}`, `apps/capture/scripts/showcase/upload.mjs`, `scripts/agent-upload-token.sh`, `AGENT_CONTRACT.md`, `docs/product/concepts/agent-authored-holograms.md` |
| Independent verifier | Claude Sonnet subagent, fresh context (Codex was over its usage limit and Muse failed on billing, so same vendor) | Read-only; found the `security -i` echo risk and unquoted args (fixed) and the read-route wording (brief corrected) |

## Design decision

A separate `ApiToken` table rather than a `Session` row with a far-off
expiry: sessions are per-device sign-ins that logout deletes and the 30-day
TTL governs; a standing agent credential has a label, a last-used time and
its own revocation, and must not be swept up by future session cleanup.

One resolver in `services/auth.ts` returns `{ user, via: "session" |
"apiToken" }`. `optionalAuthUser` and `requireUser` both use it (today
`requireUser` calls `getSessionUser` directly, `routes/auth.ts:30`). The
routes that must not take an API token check `via`.

Generating the token on the Mac and registering only its hash means the
secret exists in exactly one place, the Keychain. Minting on the server and
piping the value back would put it in a Fly SSH stream and the terminal.

Review changes adopted: the credential kind and the `403`s, hourly
`lastUsedAt`, the hash validation and test, waking Fly, Keychain ordering
and stdin, script `revoke`, host binding with `redirect: "error"`, `/auth/me`
before upload, and nullable `expiresAt`. Not adopted: filing the
unowned-delete rule as a bug, since it is a documented decision.

Found while building: the repository is public, so the agent account's email
stays out of every committed file; setup takes it as `--email`.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Upload as agent with Keychain token | Real `agent-upload-token.sh setup` + `showcase:upload door` against a fresh local API (Keychain service `holoim-agent-upload-e2e`), then production | Local, 2026-11-12: "uploading as Claude (agent-authored)"; DTO `submittedBy` "Claude (agent-authored)", `submittedByVerified: true`, owner = agent; the setup script's hash matched (`register` then `/auth/me` 200). Proof video `output/agent-token-proof/proof.mp4` (ignored). Production, 2026-11-12: the user's `setup https://holoim-api.fly.dev` registered the hash and its check printed "uploading as Claude (agent-authored)"; an agent session's `showcase:upload --whoami` with no env var printed the same |
| Revoked token refused | `agent-token revoke --hash`, then `showcase:upload` locally | Local: "The API refused the agent token ... Nothing was uploaded", exit 1 |
| Host binding | Upload to `http://localhost:3901` with only a `127.0.0.1:3901` entry | Local: "no token for localhost:3901: uploading anonymously", then 401 |
| No leak | `grep -c holoim_at_` over the API log and upload output | Local: 0 and 0 |
| Route rules | Vitest (`test/agent-token.test.ts`, real migrations, real CLI): upload and `/auth/me` accepted; `PATCH /auth/me`, delete `403`; unknown, revoked, expired `401`; prefix keeps tokens and sessions apart; logout leaves token; `register` refuses a raw token, is idempotent, will not rebind; `move` dry run, refuses ids it does not own, sets the byline | 6/6 pass (with `auth-routes.test.ts` 9/9), 2026-11-12 |
| No regression | `pnpm --filter @holoim/api test`, `pnpm run verify:pr` | 2026-11-12: every step passed; bubble-capture failed once under another session's concurrent pipeline load and passed alone, with portal and capture XR. Hosted CI on `main` green, Fly deploy green, `/healthz` ok, a made-up token 401 |
| Move | `agent-token move` dry run on production | Listed only "The way down" (owned by alberto); not applied, by the user's choice |

## Physical-device limits

None apply: no client rendering or XR change.
