# Feature brief: Find an object by asking (slice 1)

**Lead:** Claude Code (Opus 5.5)  
**Status:** Verifying (slices 1 and 2 integrated on `feature/object-search` 2026-10-27; started 2026-10-27 on `feature/object-search`; the user asked for it to be built overnight without approvals, so every decision marked provisional in PRD-060 is pending their review)  
**Layer:** Event (see `docs/product/concepts/what-a-hologram-is.md`)  
**PRD:** [PRD-060](../product/prds/PRD-060-find-an-object-by-asking.md) (IDEA-079), "First Slice"

## User outcome

At the desktop capture page, before a take, the author types "chair" into a
Find field, sees up to six models with a thumbnail, author and licence, and
picks one. It goes into the tray as an ordinary item and can be summoned
during the take. The credit travels with it: in the take's GLB, on the viewer,
and in the USDZ.

## Scope

**Included:** text search on the desktop capture overlay; Poly Haven as the
only registry (no key, CC0), behind `viewer-api`; server-side packing of Poly
Haven's 1k glTF into one GLB carrying its credit; the credit on the summoned
object's node `extras` and in `asset.copyright`; a credit line on the viewer
card; the credit in the USDZ's `customLayerData`.  
**Excluded:** voice input, the headset overlay, Poly Pizza and Sketchfab,
CC-BY-SA/ND/NC licences, re-encoding or decimating models, a library of found
objects, image search, search during a take (PRD-060 Q1–Q7).

## Acceptance criteria

- [x] `GET /api/objects/search?q=` returns at most six Poly Haven models,
      each CC0, at most 8 MB packed at 1k, with title, author, source URL,
      thumbnail and real dimensions; an empty or over-long query is a 400.
- [x] `GET /api/objects/polyhaven/:id.glb` returns one GLB that passes
      capture's `checkSuppliedGlb` and carries `asset.copyright` and
      `asset.extras.holoimCredit`; unknown ids are 404, upstream failures 502,
      and only Poly Haven's own hosts are fetched.
- [x] Capture's Find field shows the results; picking one adds it to the tray
      under its title, with the tray's existing limits and messages; the field
      is disabled while recording.
- [x] A take that summons a found object exports `holoimCredit` on that
      `RecordedObject` node and the credit in `asset.copyright`;
      `HOLOIM_objects` stays v0 and valid.
- [x] The viewer card shows "Object: “Title” by Author, Poly Haven, CC0",
      linking to the source; takes without credits show nothing new.
- [x] The converted USDZ keeps the credit in its root layer's
      `customLayerData`.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Poly Haven is down, slow or rate-limits | Server caches the asset list and packed GLBs; upstream errors become 502 with a message capture shows in the tray state; e2e uses a local fixture registry, never the live one |
| A result is shown but the tray refuses it (too big, Draco, skins) | Search filters on summed 1k file sizes; the packer uses no compression extensions; the e2e asserts the picked GLB loads |
| SSRF through a crafted asset id or file URL | Ids match `^[A-Za-z0-9_-]+$`; every download URL must be on the configured Poly Haven hosts |
| Credit lost on summon (the clone drops metadata) | `SceneObjectRegistry.summon` copies `credit`; export check asserts it on the node |
| Old readers or v0 files break | Credit is in `extras` and `asset`, outside `HOLOIM_objects`; viewer treats invalid credit as none |
| A take mixes credited and hand-supplied objects | Only credited objects add to `asset.copyright`; others are unchanged |
| Wrong scale | Poly Haven models are authored in metres; the e2e compares the packed bounds with the stated dimensions |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude Code (Opus) | Brief, `packages/objects/src/credit.ts`, integration |
| Implementer (API) | Claude subagent | `apps/viewer-api/src/routes/objects.ts`, `src/services/polyhaven*`, `tools/glb_to_usdz.py` credit, tests |
| Implementer (capture) | Claude subagent | `apps/capture/src/objects/*`, `src/recording/*`, `src/ui/*`, summon check |
| Implementer (viewer) | Claude subagent | `apps/viewer-web/src/features/feed/*`, `src/features/objects/*` |
| Independent verifier | Codex (`-p standard`) | Read-only verification |

## Design decision

- **Credit outside the contract.** `HOLOIM_objects` v0 is strict and versioned;
  a credit is glTF metadata, so it rides in node `extras` (three.js
  `userData`) and `asset.copyright`, validated by `objectCreditSchema` in
  `@holoim/objects`. No version bump.
- **The GLB is self-describing.** The API writes the credit into the packed
  GLB's `asset`, so capture reads it from the file it loads, for search
  results and for any hand-supplied GLB that carries one. No side channel
  between the Find field and the tray.
- **Search on the server.** Poly Haven has about 500 models; the API keeps
  the list for an hour and ranks name, tags and categories locally, then
  checks file sizes for the top candidates only.
- **Capture reaches the API** at `${VITE_API_ORIGIN}/api`, proxied to
  `127.0.0.1:3001` in dev like viewer-web.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Search, pack, errors, host allowlist, unloadable models never shown | `pnpm --filter @holoim/api test` (fixture registry, no network) | `test/object-routes.test.ts`: 12 tests pass |
| Find → tray → summon → export credit | `pnpm --filter @holoim/capture run test:xr:summon` (`find` phase) | pass; `apps/capture/output/ci-summon/report.json` shows node `extras.holoimCredit`, one `asset.copyright` line, `HOLOIM_objects` v0 valid |
| Real API → take → upload → viewer credit → USDZ credit | `e2e/object-search.pipeline.spec.ts` (in `test:smoke:pipeline`) | pass: chair summoned twice beside an uncredited bracket; one credit on the card with an https link, observer `credits` = 1; USDZ `holoim:copyright` and one `holoim:credits` entry; `output/object-search-viewer/report.json`, `card.png` |
| No regressions | `pnpm run verify:pr` | pass 2026-10-27 (all tiers, including `summon.pipeline.spec.ts` and the XR smoke) |
| Live flow | proof video against live Poly Haven (in `output/`, not committed) | see handoff |

## Independent verification

Codex (`-p standard`, read-only) reviewed the slice diff on 2026-10-27 and
asked for changes. All six findings were fixed in `d4ab21d`:

1. Must-fix: a key released while the Find field had focus stuck movement.
   Releases are always processed, and focusing a text field clears held keys.
2. Must-fix: search could show Draco, meshopt, quantized, basisu or skinned
   models that the tray then refused. Each candidate's glTF is now vetted
   with capture's rules before it is shown.
3. The single-object picker dropped a credited GLB's credit; it keeps it.
4. The USDZ listed a twice-summoned model's credit twice; deduped by source.
5. Credit links were below the 44 px touch hit area; an inset hit area fixes it.
6. Find controls lacked the styleguide's hover, pressed and focus states; they
   use `GlyphControl` and its appearance logic.

The automated security review also flagged a `javascript:` link risk in the
credit (now https only) and a download cap applied after buffering (now
enforced while streaming).

## Open for the user

Every PRD-060 decision this slice rests on is provisional (Q1 Poly Haven only,
Q2 CC0 and CC-BY only, Q3 desktop text before the take, Q4 filter without
re-encoding, Q5 no library, Q6 no images, Q7 credit line on the card). The
card credit line answers Q7 provisionally in place of a details view, which
the viewer does not have. A deployed capture needs `VITE_API_ORIGIN` (or an
`/api` route) to reach the API; the dev and e2e setups use a proxy.

The deploy gap is closed in `a834027`: capture's build gets
`VITE_API_ORIGIN=https://holoim-api.fly.dev`, and the two public object
routes answer any origin, so capture's origin stays out of `WEB_ORIGINS`.

## Registries surveyed (2026-10-27)

| Registry | Licences | Access | Fit |
|---|---|---|---|
| Poly Haven | CC0 | Open API, no key | Shipped in this slice; about 520 realistic models |
| Poly Pizza | CC0, CC-BY | Free API key | Next: thousands of light low-poly GLBs, ideal for summoning |
| Smithsonian Open Access | CC0 where marked | Open Access API (key) | Later: a few thousand scanned artefacts, often heavy; would need the 150k variant |
| Sketchfab | Mixed CC (BY, BY-SA, NC, ND) | Download needs each user's Sketchfab login (OAuth), or a contract for app-only | Largest catalogue; only with a Sign in with Sketchfab flow and a licence filter |
| Objaverse (Hugging Face) | Per-object CC | Static dataset, no search API | Only behind our own index |
| Kenney, Quaternius, Khronos samples | CC0 | No API | Could seed a curated starter set we host |

## Slice 2: Poly Pizza, headset search and voice (decided 2026-10-27)

The user decided PRD-060 Q1 and Q3: add Poly Pizza, drop Smithsonian, and
make search work in the headset's 3D interface (VR and passthrough AR) with
voice, before the take. Slice 1 stays unmerged until Q2 and Q4–Q7 are
approved, so slice 2 builds on `feature/object-search`.

- **Poly Pizza.** `api.poly.pizza/v1/search/{q}` with an `X-Auth-Token`
  header; results carry a GLB `Download` URL, `Creator` and `Licence`
  (CC0 or CC-BY 4.0). Same server-side vetting, size cap, host allowlist
  and credit as Poly Haven; search merges both sources. Develop against a
  fixture; the live key is a Fly secret the user sets
  (`POLYPIZZA_API_KEY`), and search silently uses Poly Haven alone without it.
- **Headset panel.** Capture's VR and AR sessions have no DOM. A Find
  action on the hand dock opens a `WorldPanel` (`@holoim/xr-ui-iwsdk`)
  with category shortcuts (chairs, plants, lamps, food, tools), a query
  line, thumbnail result tiles, and a pick that lands in the tray.
- **Keyboard.** Quest Browser 26.1+ shows the system keyboard for a
  focused DOM input during an immersive session
  (`XRSession.isSystemKeyboardSupported`); the panel mirrors that input's
  value, since there are no key events. Meta reports crashes and frozen
  hands with it on some builds, so an in-world keyboard is the fallback.
- **Voice.** Quest Browser has no Web Speech API, so the mic is recorded
  (push to talk on the panel) and transcribed on the server, then searched.
  Recommended provider: Cloudflare Workers AI `whisper-large-v3-turbo`
  ($0.0005 per audio minute; a free daily allowance covers roughly 200
  minutes). The user approved this provider on 2026-10-27; the account is on
  Workers Free, a hard daily cap with no charges.
- **Toward instant.** Prefetch the top result's GLB as soon as results
  arrive, so a pick loads from cache.

### Slice 2 evidence (integrated 2026-10-27)

Built in two sessions (API: `feature/object-search-api`; capture:
`feature/object-search-headset`) and merged here.

| Check | Result |
|---|---|
| `test/object-routes.test.ts` (Poly Haven, Poly Pizza, transcription, origin allowlist, plural queries; fixtures, no network) | 23 pass |
| `test:xr:summon` (`FIND_VIEWPORT=1920x1080`): iwer-summon, iwer-hands-summon, desktop-summon, desktop-find, headset-find, headset-voice, desktop-voice | 7 of 7 pass |
| `test:smoke:pipeline`, including the Poly Haven and Poly Pizza CC-BY object-search specs | 15 of 15 pass |
| `test:portal` | 9 of 9 pass |
| `test:xr:smoke` | 29 of 30; the VR locomotion test failed once and passed 2 of 2 on rerun (flaky, untouched by this slice) |
| `verify:pr` stages up to the pipeline | pass |
| Live proof: headset Find against live Poly Haven, Chairs → six results with thumbnails → pick → summon | in `output/`, not committed |

Codex (`-p standard`) reviewed the capture half; all 10 findings were fixed
before integration. The live proof found a defect the fixtures hid:
category shortcuts send plurals ("chairs") that matched nothing on Poly
Haven. Fixed in `1d65466` (singular matching, and partial matches only at a
word's start so "tools" no longer returns stools), with a plural-query test.

## Physical-device limits

Slice 1 is desktop-only. Slice 2 still needs a physical Quest for:
the system keyboard (value mirroring, first key replaces, Enter or blur
submits); whether Quest Browser exposes `webkitSpeechRecognition` and how
the mic prompt appears in an immersive session; the `MediaRecorder` audio
format; hand-ray Speak holds ending on release and on real tracking loss;
passthrough AR chrome with real hands. `?debug` shows a capability line.
Poly Pizza results and live transcription were not exercised end to end
locally, because their keys exist only as Fly secrets.

## Follow-ups

- The Find glyph is provisional; add it to `tokens.json` and the styleguide.
- True-scale objects summoned into the hand can be very large (an armchair).
