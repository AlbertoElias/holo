# PRD: Find an object by asking

**Status:** Draft  
**Source ideas:** IDEA-079  
**Layer:** Event  
**Depends on:** PRD-043 (explain with an object, delivered), PRD-045 (summon and place, delivered)  
**Owner:** Unassigned  
**Last updated:** 2026-10-27 (Q1 and Q3 decided by the user)

## User Outcome

Before: to explain something with an object, the author first finds a
suitable GLB somewhere, downloads it, checks that it fits the tray's rules,
and passes it as a file or a `?tray=<url>` parameter. Most authors stop before
they get as far as recording.
After: the author types or says "a bicycle chain" in capture, picks one of a
few candidates they can see, and it is in the tray, sized for true scale and
with its credit attached, ready to summon during the take.

## Problem

Today the tray ([summon and place](../../features/archive/summon-and-place.md),
"Prepare the tray") fills only from repeated `?tray=<url>` parameters or a
multi-file picker. Each item must be a GLB without Draco, meshopt, KTX2 or
skins, at most 8 MB, or a PNG or JPEG of at most 8 MB and 4096 px. The tray
holds at most five items and 16 MB in total, so a take stays under the 25 MB
upload. Those rules are right, but they leave the author with the hardest part:
finding a model that exists, is allowed to be shared, and passes them. The
PRD-043 experiment shows that objects make explanations work. Finding the
object should be the easy part.

There is also a constraint that a hand-supplied file hides: a recorded take
**re-exports the object's geometry and textures inside its own GLB**. The
viewer serves that GLB, and the API converts it to USDZ for Quick Look, so
anyone who can view the hologram can also download the model. Every object the
search adds is therefore redistributed, unchanged, to every viewer. Its
licence has to allow that, and its credit has to travel with the take.

## Primary User And Moment

An author, in a Quest or at the desktop capture page, **just before a take**,
who knows what they want to show ("a bike chain", "a human heart", "a
four-stroke engine") but not where to get a model of it. The recipient is
whoever later watches the take on a phone.

## Proposed Interaction

The smallest version prepares the tray before the take. It does not search
during a take. "First Slice" below cuts this further for the first build.

1. **Ask.** In capture's overlay, a "Find" field sits next to the existing
   "Tray" picker. The author types a phrase or holds a button to say it.
   Speech is transcribed to text before anything is searched, and the text is
   shown so the author can correct it.
2. **See candidates.** Up to six results, each with a turntable thumbnail,
   its source and licence, the author's name, and its real size if known.
   Only results that pass the tray rules (format, size, licence) are shown,
   so the author never picks something that will be refused.
3. **Pick.** Choosing a result downloads it once, checks it against the PRD-043
   rules, scales it to the source's stated real size (or asks for one when the
   source gives none), and adds it to the tray as an ordinary item. A sixth
   item or a tray over 16 MB is refused, as today.
4. **Credit travels.** The tray item carries its source URL, title, author and
   licence. When the item is summoned in a take, that credit is written into
   the take's GLB (in the object node's `extras`, alongside `asset.copyright`)
   and shown by the viewer next to the hologram whenever the object appears.

**Spoken search during a take** (say "bring a wrench" mid-explanation) is
recorded as a later step, not this PRD. Its open problems: the author's voice
is part of the event, so a spoken command would be recorded as content, which
breaks PRD-045's "commands are never recorded" rule unless the audio span is
cut. Choosing among candidates is a menu. A network wait sits in the middle of
the performance. The evidence from step one decides whether it is worth it.

## First Slice

**Provisional — pending user approval.** The lead (2026-10-27) asked for a
small first slice that needs no paid or secret credentials, built on the
recommended answers to Q1–Q7 below:

1. **Desktop text search before the take.** A "Find" field on the desktop
   capture page's overlay, next to "Tray". No voice yet, no XR keyboard, no
   search during a take.
2. **Poly Haven only, through a `viewer-api` search endpoint.** It needs no key
   and is CC0 throughout. The endpoint filters by licence (CC0 and CC-BY,
   ready for Poly Pizza), and by size at 1k textures, then returns up to six
   candidates with thumbnail, title, author, licence, source URL and
   dimensions.
3. **Pick → packed GLB → tray.** The API downloads the 1k glTF and packs it
   into one GLB without Draco, meshopt or KTX2. Capture loads it through the
   existing tray loader and its PRD-043 checks (8 MB per item, 16 MB per
   tray, five items), scaled from Poly Haven's stated dimensions.
4. **Attribution in the export.** The tray item carries `{source, sourceUrl,
   title, author, licence}`. When it is summoned, the composer writes that
   record into the object node's `extras` and appends it to the GLB's
   `asset.copyright`. The viewer shows it in the hologram's details, and the
   USDZ keeps it.
5. **Acceptance.** An e2e check searches, picks, records a take with the
   summoned object, uploads it, and asserts the credit in the GLB, in the
   viewer, and in the converted USDZ. Plus a proof video of the desktop flow.

Next, in order: voice input on desktop, Poly Pizza (once its key exists), the
headset overlay, then the spoken in-take search PRD.

## Candidate Registries

Checked 2026-10-27 against public documentation and live endpoints. These are
candidates; choosing them is a product decision (Q1).

| Registry | Search API | Auth | GLB? | Licences | Notes |
| --- | --- | --- | --- | --- | --- |
| **Sketchfab** | Data API v3 `GET /v3/search?type=models` with filters `downloadable`, `license` (`cc0`, `by`, `by-sa`, `by-nd`, `by-nc`, `by-nc-sa`, `by-nc-nd`, plus `ed` editorial and `st` store), `archives_max_size`, `archives_max_face_count`, `available_archive_type` | Search is public. Downloads (`GET /v3/models/{uid}/download`) need a **user** OAuth token; the Download API page says apps must let users sign in, and serving downloads without an end-user login means contacting Sketchfab. Returns 429 under rate limits | Yes: glTF, GLB and USDZ archives, via temporary URLs that expire (example: 300 s) | Mixed Creative Commons; most models need attribution, some forbid commercial use or derivatives | Largest catalog (over a million free models). The developer terms of use were not readable from this session and must be reviewed before building (Q1) |
| **Poly Pizza** | REST API (`api.poly.pizza/v1.1/search/<keyword>`) | API key required (the endpoint answers 401 without one) | GLB | CC0 and CC-BY, per model | Low-poly models, small files, a good fit for the 8 MB limit. Terms and rate limits to confirm with a key |
| **Poly Haven** | `api.polyhaven.com/assets?t=models`, `/files/<id>` | None | glTF with separate textures at 1k/2k/4k, not a single GLB; would need packing server-side | CC0 only | Few hundred photoscanned models; gives real-world dimensions, which helps true scale |
| **Smithsonian Open Access** | `api.si.edu/openaccess/api/v1.0` (api.data.gov key; answers 403 without one) and the 3D program at 3d.si.edu | API key | glTF downloads reported; GLB not confirmed | CC0 for open-access 3D | Museum objects and specimens; accurate scale; often large scans that may exceed 8 MB without decimation |

Also possible later: the Khronos glTF sample models (fixed small set), museum
collections that publish to Sketchfab under CC0 (reached through the Sketchfab
row), and image sources such as Wikimedia Commons for tray images (Q6).
Generated models (text-to-3D) are out of scope: they answer a different
question about provenance.

## Licences And Attribution

Because a take re-exports and redistributes the object, the licence decides
whether a model may be offered at all.

| Licence | Redistribution in a take | What we must do |
| --- | --- | --- |
| CC0 | Allowed | Nothing required; still record the source |
| CC-BY | Allowed | Credit title, author, source and licence wherever the object is shown or downloaded |
| CC-BY-SA | Allowed, but the take's object must stay under BY-SA | Credit, and mark the object (not the whole take) as BY-SA; legal reading needed (Q2) |
| CC-BY-ND | Unclear: scaling, re-encoding, and adding recorded motion may count as an adaptation | Exclude until decided (Q2) |
| Any NC licence | Only if HoloIM and every viewer's use are non-commercial | Exclude until decided (Q2) |
| Sketchfab editorial / store | Not redistributable | Always exclude |

Attribution must survive every hop of the pipeline: the tray item, the take's
GLB (`extras` on the object node and `asset.copyright`), the viewer's card and
pause view, the USDZ (`customLayerData` or a credit in the Quick Look
caption), and any download. Recorded, inferred, and added stay
distinguishable (principle 7): the object is visibly *someone else's model*,
handled by the author.

## Size And Format

- **GLB only into the tray.** Prefer a registry's GLB archive; glTF with
  separate files is packed into one GLB on the server. Archives that use
  Draco, meshopt or KTX2 are filtered out at search time where the API allows
  it, or re-encoded server-side (Q4).
- **8 MB per item, 16 MB per tray.** Ask for the smallest archive that passes
  (Sketchfab `archives_max_size`, Poly Haven 1k textures). Anything larger is
  hidden from results, not offered and then refused.
- **USDZ / Quick Look.** The converter (`glb_to_usdz.py`) already carries the
  object's transforms and visibility. Searched models add textures in more
  varied formats and materials; the acceptance check converts a take with one
  searched object from each chosen registry and opens it in Quick Look.
- **True scale.** Use the registry's stated dimensions when given (Poly Haven,
  Smithsonian). Otherwise scale to the bounding box the author confirms
  ("about 30 cm"), and label the result as estimated (principle 6).

## Why Holograms

This PRD does not change what a hologram is; it makes PRD-043's object
cheaper to supply. The hypothesis is that authors who can find an object in
seconds will use objects more often, and that explanations with an object
work better for recipients (PRD-043's question). The fair comparison is the
current flow: a hand-found GLB passed by URL or picker.

- **Anchored to the event:** the found object is the same tray object as
  today, placed and handled during the take.
- **Read from the body:** its motion comes from the author's hands, unchanged.
- **Intent, not a view:** search happens before the take; nothing in it sets a
  camera.
- **Works on a flat phone:** the recipient sees the object in the author's
  hand, with its credit.
- **Lost as a video:** the object can be looked at from any side; and its
  credit and licence stay attached to it, which a screen recording loses.

## Across Devices

| Device | Appearance | Control |
| --- | --- | --- |
| Headset (VR or AR) | Author: a Find field and a candidate row on the capture overlay before the take; found items appear as tray miniatures | Type with the system keyboard or hold to speak; point to pick |
| Phone portal | Viewer: the object in the author's hand; a credit line when the object is in view or on pause | Tap the credit to open the source |
| Desktop | Author: same Find field on the capture page. Viewer: same as phone | Type or speak; click to pick |
| Still image or Quick Look | Object where placed; credit in the caption or metadata | None |

## In Scope

- [ ] Text search before a take, from capture's overlay, into the existing tray.
- [ ] Voice input transcribed to editable text before searching (same flow).
- [ ] One or two registries chosen by the user (Q1), behind one server-side
      search endpoint in `viewer-api`, so API keys and tokens never reach the
      browser and the registry can be swapped.
- [ ] Results filtered to licences the user allows (Q2), GLB-compatible, and
      within 8 MB.
- [ ] Download, validation against PRD-043 rules, and true-scale sizing on pick.
- [ ] Attribution stored with the tray item, written into the take's GLB, shown
      by the viewer, and carried into USDZ.

## Out Of Scope

- [ ] Spoken search or summoning during a take (a later PRD, after this one's
      evidence).
- [ ] Text-to-3D generation, editing or decimating models beyond what the
      size rules require, uploading models to a registry.
- [ ] A persistent library of found objects across sessions (Q5).
- [ ] Paid or store models.

## Success Signals

- [ ] **Technical:** a found object from each chosen registry goes from search
      to tray to take to viewer to Quick Look, with its credit visible at the
      viewer and present in the GLB and USDZ. No result shown to the author is
      later refused by the tray.
- [ ] **Authoring:** time from "I want an object" to "it is in the tray" falls
      from minutes (hand-found GLB) to under 30 seconds for common objects.
- [ ] **Use:** more takes include at least one object than before search
      existed (counted on uploaded takes).
- [ ] **Fit:** for a fixed list of 20 everyday explanation objects, the first
      six results contain a usable model for at least 15.

## Risks And Open Questions

Product decisions for the user:

- [x] **Q1. Which registries?** Sketchfab has the most models but needs each
      author to sign in to a Sketchfab account (or a partnership with
      Sketchfab), and its developer terms are unreviewed. Poly Pizza and Poly
      Haven are simpler and all CC0/CC-BY but smaller. Smithsonian is CC0 and
      accurate but narrow. Start with one, two, or all?
      **Decided 2026-10-27 (user):** Poly Haven and Poly Pizza (Poly Pizza
      with the user's free API key as a server secret). Smithsonian is out.
      Sketchfab waits. A self-hosted starter set stays a candidate, limited
      by current storage.
- [ ] **Q2. Which licences may a take redistribute?** CC0 and CC-BY only, or
      also BY-SA? Is HoloIM commercial, which rules out every NC licence? Is
      ND acceptable given that a take scales and animates the model? This
      likely needs a legal reading.
      **Provisional — pending user approval:** CC0 and CC-BY only. Everything else is filtered out at
      search time.
- [x] **Q3. Where search lives first:** only before the take (this draft), or
      is a spoken search during the take part of the first version?
      **Decided 2026-10-27 (user):** before the take for now, on desktop and
      in the headset's 3D interface (VR and passthrough AR) alike. The
      headset gets category shortcuts, a keyboard (the Quest system keyboard
      where the browser supports it, an in-world one otherwise) and voice:
      speak, see the transcript and results, pick. Voice is required, not a
      later extra. Direction: during a take, a word plus a gesture or button
      summons the object instantly; each slice should move toward that
      latency (cache, prefetch, streaming transcription).
- [ ] **Q4. Re-encode or filter?** Should the server convert Draco, meshopt,
      KTX2 and oversized models into tray-legal GLBs (more results, a
      conversion service to run), or only show models that already pass?
      **Provisional — pending user approval:** filter only. The server packs a glTF with separate
      textures into one GLB (Poly Haven needs this) at 1k textures, but does
      not decimate or re-encode.
- [ ] **Q5. Keep found objects?** Do found objects stay in a personal library
      across sessions, or does each session start with an empty tray?
      **Provisional — pending user approval:** no library; each session starts with an empty tray.
- [ ] **Q6. Images too?** Should the same search also find images (for
      example Wikimedia Commons) for the tray's image cards?
      **Provisional — pending user approval:** no; models only.
- [ ] **Q7. Credit display:** is a small credit line on the viewer when the
      object is visible acceptable within the styleguide, or should credits
      live only behind an info control?
      **Provisional — pending user approval:** store the credit in the take's GLB and show it in the
      viewer's existing details for the hologram; an on-screen credit line
      waits for a styleguide review.

Risks:

- [ ] A registry changes its terms or removes a model after a take was
      published; the take still contains it. Record the licence as it was at
      download time.
- [ ] Voice transcription of rare object names is poor; the editable text
      field is the mitigation.
- [ ] Wrong scale makes a true-scale explanation misleading; label estimated
      scale.
- [ ] Rate limits on shared server keys during a busy period.

## Comparison And Learning

Task: five authors each prepare a take that explains something with two
objects they did not have beforehand. Half use search, half use the current
URL/picker flow, then swap on a second topic. Measures: time to a full tray,
how many give up, how many objects per take, and author preference. Continue
if search halves the time to a full tray and nobody gives up; revise if
results are too often unusable (the "Fit" signal fails); park if authors
prefer to bring their own models anyway. Technical acceptance (the pipeline
and credit checks) is separate from this communication question.

## Decision

Pending until explicitly decided. Drafting this document is not approval to
build. On approval, follow the [owning-file workflow](../../FEATURE_WORKFLOW.md)
for queue and delivery state.

## Links

- Concept: [what a hologram is](../concepts/what-a-hologram-is.md),
  [hologram authoring](../concepts/hologram-authoring.md)
- Research: Sketchfab [Download API](https://sketchfab.com/developers/download-api)
  and [Data API v3](https://docs.sketchfab.com/data-api/v3/index.html);
  [Poly Pizza](https://poly.pizza); [Poly Haven API](https://api.polyhaven.com/assets?t=models);
  [Smithsonian Open Access](https://www.si.edu/openaccess)
- Mockups: none
- Feature brief: none; today's tray is in
  [summon and place](../../features/archive/summon-and-place.md) and
  [explain with an object](../../features/archive/explain-with-an-object.md)
- Implementation issue: none
