# Feature brief: Creator accounts (IDEA-052)

**Lead:** Muse Code
**Status:** Complete
**Layer:** All layers (supporting trust)

## User outcome

An author signs in once with a passwordless email link, uploads under a
verified name, and can delete their own holograms. Nobody else can delete
them. Anonymous viewing of shared links and the feed stays open, and
existing unauthenticated uploads keep working unchanged.

Implements [IDEA-052](../product/IDEAS.md) / [PRD-037](../product/prds/PRD-037-creator-identity.md).
User decisions (2026-10-24): implement now; email magic link; owner delete
plus verified name; existing records stay unclaimed.

## Scope

**Included:**

- API: `User`, `MagicLinkToken`, and `Session` records; only token hashes
  are stored. Endpoints under `/api/auth`: request magic link, verify,
  `me` (read/update display name), logout. Bearer session tokens.
- Email delivery behind a mailer seam: no provider is configured in this
  repo and no paid service is used. With `AUTH_DEV_EXPOSE_MAGIC_LINK=true`
  (local development and tests only) the link is returned in the request
  response and logged; otherwise it is never logged or returned. A real
  provider plugs into that seam later without contract changes.
- Ownership: `Hologram.ownerId` and `UploadIntent.ownerId` (both nullable).
  An authenticated upload is owned, and its `submittedBy` is the account
  display name, whatever the client sent. Unauthenticated uploads keep
  today's free-text `submittedBy` and no owner.
- Delete: an owned hologram can be deleted only by its owner. Matrix
  (checked inside `withHologramLock`, before any storage delete):
  owned + owner → 200; owned + anonymous → 401; owned + non-owner → 403;
  unowned + anyone → 200 (legacy); missing → 404 regardless of auth.
  Unowned legacy holograms keep today's unauthenticated delete so
  existing clients do not break.
- DTO: additive `submittedByVerified` and `ownedByViewer` booleans with
  schema defaults, so older fixtures and mocks stay parseable.
- Viewer web: sign-in panel (email → check your inbox → verify link route),
  session kept in `localStorage`, verified badge on cards, Delete button
  only on your own holograms, upload name locked to the account name when
  signed in.

**Excluded:** capture/headset sign-in (device code), passkeys, passwords,
workspaces/roles/private libraries (IDEA-065), profiles, claiming existing
uploads, Postgres migration, email provider selection and secrets.

## Acceptance criteria

- [x] Requesting a magic link for a new email creates the account on
  verify; the raw token never appears in the database.
- [x] Verify issues a session; `GET /api/auth/me` returns the user; logout
  revokes the session; expired or reused magic links fail.
- [x] An authenticated upload is owned; its card shows the verified name.
- [x] The owner can delete their hologram; another signed-in user gets
  403; an anonymous caller gets 401; the hologram stays.
- [x] Legacy behaviour is unchanged: anonymous upload, feed, view, and
  delete of unowned holograms work exactly as before, with no session.
- [x] The viewer flow works end to end in a browser: sign in, upload,
  see the verified name, delete your own hologram, sign out.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Magic-link token leaked from logs/DB | Only SHA-256 hashes stored; single use; 15-minute expiry |
| Session fixation or replay after logout | Session row deleted on logout; 30-day expiry checked per request |
| Signed-in user deletes another's hologram | Owner check inside the delete lock; route tests for 401/403/200 |
| Auth change breaks anonymous clients | Owner fields nullable; auth optional everywhere except owned delete; existing API suite must stay green |
| Duplicate accounts for one email | Unique email; verify reuses the existing user |
| Display-name spoofing while signed in | Server overwrites `submittedBy` with the account display name |
| Email enumeration via link requests | Same 202 response whether or not the email already has an account |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Muse Code | Brief, integration, final handoff |
| Design reviewer | Subagent (read-only) | Brief and plan review before implementation |
| Implementer | Muse Code | `packages/contracts`, `apps/viewer-api`, `apps/viewer-web` |
| Independent verifier | Subagent (read-only) | Brief acceptance against the finished tree |

## Design decision

Bearer session tokens, not cookies: the viewer (Pages) and API (Fly) are
different origins, and local development is cross-origin too; cookies would
need `SameSite=None` plus credentialed CORS before any local flow works.
Tokens are random, hashed at rest, and revocable per session. Magic links
point at the viewer (`/auth/verify?token=…`), which exchanges the token for
a session at the API, so the emailed link never carries a session.

Alternatives considered: email+password (rejected by the user; adds reset
and credential-storage burden) and passkeys (headset flow unsolved).

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Magic-link lifecycle, ownership, legacy compat | New API route tests in `apps/viewer-api/test/auth-routes.test.ts`; full API suite | `pnpm --filter @holoim/api run verify:fast` passes, 28/28 tests (2026-10-25) |
| Contracts stay backward compatible | Contracts build + existing API/viewer suites | Contracts, API, and web `verify:fast` pass; root `pnpm run verify:agent` passes (2026-10-25) |
| Browser sign-in → upload → verified name → owner delete | Playwright against local API + viewer, dev-exposed magic link | All five steps pass; screenshot `output/creator-accounts/e2e-signed-in.png` (local evidence, not committed). The hologram 3D view itself fails to load in headless Chromium (no WebGL), which does not affect the account flow |

Independent verification (read-only subagent, 2026-10-25): criteria 1–5
pass on code and test evidence; criterion 6 verified by the lead's browser
run above. Accepted tradeoffs recorded by the verifier: bearer tokens in
`localStorage` (required by the cross-origin viewer/API split) and
anonymous deletion of legacy unowned holograms (backward compatibility,
documented in Scope). The verifier's finding that raw magic-link tokens
were written to server logs was fixed: tokens are logged only when dev
exposure is enabled.

## Physical-device limits

None for this slice: headset sign-in is excluded. Phone-browser behaviour
follows the existing responsive viewer; no device-only claim is made.
