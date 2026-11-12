# Feature brief: Creator pages, shareable holograms, search

**Lead:** Claude Code (Sonnet 5.5)
**Status:** Implementing
**Layer:** View (how a hologram is found, shared and attributed on flat screens)

## User outcome

A visitor can follow a creator's name to a page with everything that creator
has uploaded, open and share a link to one specific hologram, and search the
feed by title or creator. A card shows only what the viewer needs: title and
byline. The creator's own controls (copy link, delete) stay out of sight until
the card is reached for. The owner's old "alberto" uploads belong to their
account.

## Scope

**Included:**

- Remove the "Verified creator" badge from cards and Settings. The API field
  `submittedByVerified` stays (additive contract, old clients parse).
- `ownerId` on the hologram DTO (additive, nullable). A byline name links to
  `/u/:userId` when the hologram has an owner; legacy unowned names are plain text.
- `GET /api/users/:id` (public profile: id, displayName, hologramCount; no email) and
  `GET /api/holograms?ownerId=` to list one creator's holograms (same cursor paging).
- `GET /api/holograms?q=` searches hologram title and creator name
  (case-insensitive substring), paged the same way.
- Viewer routes: `/u/:userId` (creator page: the feed layout, filtered),
  `/h/:id` (one hologram, the card at full screen, shareable). `/?q=` is the
  search result view. All reuse `HologramCard` and the feed layout. A
  narrowed feed (creator or search) shows its name or words in a chip at the
  top left; its close glyph returns to the whole feed. Entering VR/AR from a
  narrowed feed carries the filter and returns to the same page.
- Card controls: title links to `/h/:id`. "Copy link" (anyone; the phone's
  share sheet on touch, else the clipboard) and "Delete" (owner only, with a
  confirmation) are glyphs (`copyLink`, `remove`, drawn from `tokens.json`) in
  the card's reach row: out of sight at rest, shown when the card is reached
  (hover, touch, focus). No standing button, no pill. A card whose model cannot
  draw shows the owner's controls in its foot so a broken hologram can still
  be removed.
- Search: a lantern glyph (`search`) beside Upload in the dock, because the
  top-right corner is Settings and the top centre is not for controls. It
  opens a sheet with one field; submit navigates to `/?q=`.
- A one-off, idempotent claim script that sets `ownerId` on unowned holograms
  whose `submittedBy` is "alberto" (case-insensitive) to the named account;
  dry-run by default.

**Deferred:** link previews (Open Graph title and image) for `/h/:id` need an
edge function and a thumbnail the product does not render yet; a shared link
shows the site's generic preview until then.

**Excluded:** public handles/slugs (the user id is the URL), follow/likes,
profile editing beyond the existing display name, full-text ranking,
search over object credits, immersive (`/vr`, `/ar`) search, running the claim
on production without the owner's go-ahead.

## Undo

None: viewer-only; no capture authoring action.

## Acceptance criteria

- [ ] Cards and Settings no longer show "Verified creator".
- [ ] Clicking a byline name on an owned hologram opens `/u/:userId`, which
  shows that creator's name and exactly their holograms, newest first, and
  nobody else's.
- [ ] Each card's title opens `/h/:id`; that page shows the hologram and
  loads directly from a cold URL; an unknown id shows a "not found" notice.
- [ ] "Copy link" puts the absolute `/h/:id` URL on the clipboard and confirms.
- [ ] Searching "foo" returns only holograms whose title or creator contains
  "foo"; an empty result says so; clearing returns the normal feed.
- [ ] Delete and Copy link are invisible at rest and appear on hover, touch
  or keyboard focus; Delete is offered only to the owner and needs a second
  confirming press.
- [ ] After the claim script runs for the account, every hologram with
  `submittedBy` "alberto" has that account's `ownerId`; a second run changes nothing.
- [ ] Old clients: DTO additions are optional-with-default; the existing API
  suite stays green.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| `q` with `%`, `_`, quotes or accents matches everything, errors or misses | Matching is a case- and accent-folded substring test in code, not SQL LIKE; API test covers `%`, `_`, accents, blank, paging |
| Creator page leaks other creators' holograms or test artifacts | `ownerId` filter AND the existing test-artifact exclusion; e2e asserts the exact set |
| Cursor paging breaks under a filter | Filters join the same `AND` as the cursor; e2e pages a filtered list |
| Edge snapshot (`__HOLOIM_FEED__`) shown for a filtered view | The hook uses it only for the plain feed; the edge function skips it when `q` is set |
| `/h/:id` for a deleted or unknown hologram | 404 from API becomes a visible notice, not a blank page |
| Delete hit by accident (no longer a standing button) | Owner-only, revealed on reach, `window.confirm` naming the hologram; e2e dismisses once and accepts once |
| Hidden controls unreachable by touch or keyboard | Reveal on pointerdown and focusin as `useReach` already does; verified with a touch-emulated pass |
| Claim script reassigns someone else's uploads | Only rows with `ownerId` null; target account by exact email; dry-run default; prints the rows it will change |
| Clipboard refused or share sheet dismissed | Dismissal is silent; a refused clipboard shows the link itself in the notice to copy by hand |
| A new upload appears on a page it does not belong to | Upload joins the list only on the plain feed or its creator's own page |
| Pages SPA routing for new paths in production | `/auth/verify` already relies on the Pages fallback; same for `/u` and `/h` |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude Code | Brief, integration, handoff |
| Design reviewer | `design-reviewer` subagent | Read-only, before implementation |
| Implementer | Claude Code | `packages/contracts`, `apps/viewer-api/src/{routes,services}`, `apps/viewer-api/tools`, `apps/viewer-web/src/{app,features/feed,features/auth,styles}` |
| Independent verifier | A subagent on a different vendor/tier from the implementer | Read-only; e2e artifacts only |

## Design decision

User ids are the creator URL, because display names are not unique and there
are no handles yet; a readable slug can be layered on later without breaking
`/u/:id`. Filtering is a query parameter on the existing list endpoint, not a
new endpoint, so cursor paging, DTO shaping and the snapshot path stay single.
The creator page, search result view and `/h/:id` reuse the feed page with a
source argument, so cards, load ordering and portal behaviour stay identical.
Standing delete is replaced by two glyphs in the card's reach row, `copyLink`
and `remove` (owner only, behind a confirmation), drawn as SVG from
`tokens.json` and hidden until the card is reached for (styleguide principle
5). Search is a glyph in the dock, beside making.
Paging a creator page or a search keeps the feed's id cursor; the client moves
the cursor up when the card it points at is deleted, so the list is not cut
short. Search matches title and creator name in the API (in code, so case and accents
fold and a typed `%` is literal). It reads the table newest first in batches
of 200 from the cursor and stops once the page is full, so memory is bounded
and a common word costs a batch or two; a word that matches nothing reads
every row once. The API has no rate limiting yet, which is the open guard
against abusing that scan.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Creator page, search, `/h/:id`, copy link, delete reveal | `apps/viewer-web/e2e/profiles.pipeline.spec.ts` against the real API (two creators) | 6 pass; screenshots under `output/profiles-and-share/` |
| Claim script | Run against a seeded temp DB: dry-run, apply, re-apply, unknown email | Done; output in the session |
| API filters and paging | `apps/viewer-api/test/auth-routes.test.ts` through the real HTTP layer | API tests pass (82 in the package) |
| Visual | Screenshots under `output/profiles-and-share/`; proof video | pending until run |

## Physical-device limits

Touch reveal is checked with emulated touch only; a physical phone check
(reach-then-tap on the byline row) is left to the owner.
