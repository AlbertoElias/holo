# Feature brief: Your look, on a phone (slice 2e, phone part)

**Lead:** Claude (Opus)  
**Status:** Phone slice verified (emulation), with the picture picker; slice 2, the headset, is next  
**Layer:** event (who performs the take). See
`docs/product/concepts/what-a-hologram-is.md`.

Source: the owner, 2026-11-20: "we should also start looking into the
embodied flow on phone and nailing that. it will also benefit from the rest
of the work." This lifts the hold on phone slices 2e and 2g. This brief is
the phone part of 2e in [directed-performance.md](directed-performance.md)
("How a creator sets it", the 2e row). It builds on the phone journey in
[phone-capture.md](phone-capture.md).

## User outcome

A creator opens capture on a phone. They pick a look for the house avatar:
finish, build, skin, hair, hair colour, eyes, glasses and clothes. They see
the avatar change at once, in the selfie mirror, with their face driving it.
They record, post, and the hologram in the feed and the viewer wears that
look. The next take starts with the same look.

## Measured before the change (2026-11-20, `main` at `2fac220785e0`)

The phone journey works end to end with the stock avatar. No look step
exists. See "Baseline" under Test plan.

## Scope

**Included:**

- A "Look" control in the capture dock, and a look panel at the bottom of
  the screen, when the loaded avatar is the house base.
- Every trait of the look card (`@holoim/avatar-look`) and the three
  finishes. Each change shows on the live avatar in about a second, with no
  page reload (a reload would drop the post grant, which lives only in
  memory).
- The look is kept on the device and starts the next take. `?look=` and
  `?finish=` in the capture link set it (the same card on another device).
- In the selfie journey, the panel opens by itself the first time, before
  the first Record.
- The take carries the look: the meshes and colours are baked in, as today,
  and the recorded avatar node carries the card and finish in its extras.
- Height and eye placement no longer change with the hairstyle.
- Desktop gets the same panel (it is page chrome); the view turns to face
  the avatar while the panel is open.
- The headset gets the look step too (the owner's goal: "2 capturing flows
  … that will work on all devices", "mobile first but greatly enhanced if
  done from a headset"). It lands as a second slice on this brief, after
  the phone slice is merged: a look panel beside the mirror, in IWSDK UI,
  using the same `setLook` call. Checked with the IWER harness; a real Quest
  stays an owner check.

**Excluded:**
- Making the house base the default avatar (2g, another session).
- Outside avatars, and a look from a photo (slice 5).
- New traits or finishes, and any change to the house base files.

## Undo

None. The look is set before a take starts, like the input mode. It is not
in a take's undo history. Changing the look again is its undo. The panel is
not reachable while a take runs.

## Acceptance criteria

- [ ] On a phone viewport, with the house avatar, the look panel opens
  before the first Record in the selfie journey, and each trait change shows
  on the live avatar (the right hair mesh, the right colours) without a page
  reload.
- [ ] The posted take's GLB carries the chosen look: the chosen hair and
  glasses meshes only, the card's colours on the skin, iris, hair, top and
  trousers materials, and the card and finish in the avatar's extras.
- [ ] The feed card and the viewer show that look (screenshot of the feed
  card).
- [ ] A reload, or the next take, starts with the saved look; `?look=` and
  `?finish=` override it; a bad value is ignored with a console warning, not
  a failure.
- [ ] Changing the hairstyle does not change the avatar's fitted height or
  eye height.
- [ ] The phone journey keeps its time: capture load with a saved look is
  no more than 1.5 s slower than without one in the e2e.
- [ ] The stock avatar and `?avatar=` outside avatars show no Look control
  and behave as before.
- [ ] Desktop (a 1280 × 800 viewport) sets a look, records and posts it in
  the same journey.
- [ ] Slice 2: in the IWER headset harness, the look panel beside the mirror
  changes the look, and the take carries it.
- [ ] A live change from clay to ink, then a take: the posted GLB has face
  morph tracks, one skeleton (every skin names the same joint nodes, and
  no bone is there twice), and no leftover meshes.
- [ ] After a live build change, the skinned vertices are within 3 mm of a
  fresh load of the same look.
- [ ] Twelve look changes do not grow `renderer.info.memory`.
- [ ] Feed card screenshots in the clay, ink and light finishes; an ink take
  stays under the upload cap.
- [ ] Quick Look conversion passes on posted ink and light takes, and on a
  take recorded after a live build change.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| A hidden hair mesh is exported (the export clones the avatar and forces every mesh visible) | Every mesh is removed and added, never hidden; the e2e reads the posted GLB's nodes and skins |
| The face stops moving after a change (the face rig holds the old meshes) | Meshes with the same name keep their object; only geometry and material change; the face rig is bound again after each change; the e2e reads the jaw on the meshes in the live tree after twelve changes, and the posted take's morph weights must move |
| The recorder keeps morph bindings to removed meshes (`FrameCaptureStore` caches them per avatar object, and the object does not change) | Each take clears them at its start; the kept last take is dropped on a change; the e2e reads face tracks in the posted take |
| A new mesh (hair, glasses, ink line) is not driven by the skeleton | New meshes bind to the live skeleton by joint name; the three builds share joints within 2.2 mm (measured); the fit check reads each live mesh's own skeleton and binds after the change, and a missing bone fails it |
| A build change leaves the arm clearance measured for the old torso | The clearance is measured from the freshly loaded scene at rest, not from the posed live avatar, and only after the bone check passes |
| Two quick taps race, and an older look lands last | Each change has a number; only the latest is applied; Record waits while a dressing runs |
| The export names the old look (the export copies `userData.holoimAvatar`) | It is set again on each change; the e2e reads the posted extras |
| Old geometries and materials stay in GPU memory | Disposed on removal; the e2e reads `renderer.info.memory` after twelve changes |
| A change lands during a take, or between Stop and export | The control is hidden and the bridge refuses changes unless the take is idle |
| The look sets the eye or height from the hair's top | The house base takes its height from the head-top bone, once, at load |
| A bad `?look=` or stored value breaks the load | Parsed with `parseLook`; on error the default look loads and a warning is logged |
| The panel hides the face it is meant to show | The view shifts up by half the panel's height while it is open |
| Dressing in the browser is slow on a phone | Measured in the e2e; the wardrobe is fetched once; the dressing code loads only when the house avatar is in use |
| The capture bundle grows for everyone | glTF-Transform and the wardrobes load lazily, only for the house avatar |
| Quick Look loses a finish's material | Quick Look conversion run on posted ink and light takes |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead and implementer | Claude (Opus), this session | `apps/capture/src/avatar/houseLook.ts` (new), `src/ui/LookPanel.tsx` (new), small edits to `CaptureOverlay.tsx`, `createCaptureRuntime.ts`, `captureUiBridge.ts`, `UIStateStore.ts`, `CameraController.ts`, `AvatarRig.ts` (height box, a parts refresh), `ArmClearance.ts` (measure again); `packages/avatar-look` (`parseLookKey`); the phone e2e |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only |
| Independent verifier | `verifier` subagent (Opus) and a code review | Read-only |

## Design decision

Reviewed 2026-11-20 by the `design-reviewer` subagent (Opus): approve with
changes. The changes are folded in below.

1. **Dress in the browser with the same code as the AI flow.** The runtime
   fetches `wardrobe-<build>.glb` once per build (served from `assets/` as
   a Vite asset URL), keeps the bytes, and for each change reads them again,
   runs `dressAvatar` and `applyFinish` (glTF-Transform's `WebIO`), and
   loads the result. One dressing function for both flows. The dressing
   code and the wardrobes load lazily, only for the house base.
2. **Change the live avatar in place: keep the bones, replace every mesh.**
   GLTFLoader loads a mesh with more than one primitive as a group and
   makes names unique by load order, and ink adds a primitive to most
   meshes, so meshes cannot be matched by name. On each change: remove
   every mesh object (and dispose of its geometry and materials), add every
   mesh object of the new scene under the live object with its parent's
   name, keep its own local transform and `bindMatrix`, and bind all of
   them to one new `Skeleton` made from the live bones in the new file's
   joint order, with the new file's inverse binds. One skeleton, so the
   export and the Quick Look converter still see one set of bones. (The
   exporter writes a skin per skinned mesh, as it does for every take; each
   skin names the same joint nodes.)
3. **After each change, refresh what holds meshes:** the face rig
   (`face.attach`), the first-person head list, the material list (with the
   first-person state applied again), frustum culling,
   `avatar.userData.holoimAvatar` (the export copies it into the take), and
   the recorder's kept last take (its morph paths are child indices).
4. **Height:** for the house base only, the fit takes the height from the
   head-top bone at load, not from the model's box, so hair and the ink
   outline do not change it. It is measured once; a look change does not
   fit again (the fit multiplies the scale, and sets the scene scale). The
   stock avatar keeps today's fit. Motion owner: this session, with the
   change kept to the house base branch of `applyAvatarScaleAndMetrics`.
5. **Arm clearance** is measured from the freshly loaded scene at its rest
   pose (the widths are shares of the hip spacing, so they do not depend on
   scale), and the live humanoid takes them. The live avatar is posed by
   the face and idle motion, so it is not measured.
6. **Build change:** the live bones keep the first build's rest pose, up to
   2.2 mm off the new build. This is accepted. The e2e checks that after a
   live build change the skinned vertices are within 3 mm of a fresh load
   of the same look.
7. **Idle gate at both ends:** a change is refused unless the take is
   idle, and Record waits while a dressing runs; a result that arrives
   when the take is no longer idle is dropped. Each change has a number;
   only the latest is applied.
8. **At load**, a saved or linked look loads the dressed avatar directly.
   The house base is detected by `userData.holoimAvatar.name`, not by URL.
   `?look=` without `?avatar=` loads the house base (agent choice, for the
   owner to review).
9. **The UI** is a look sheet on the chip above the dock, in the slot the
   Find sheet and the Post panel already use (`aboveDock`), exclusive with
   them and with the tray. The styleguide gains this surface. Styles are
   word choices (`ChoiceGroup`, ring and gold dot). Colours are discs of the
   colour inside the same ring; the chosen disc holds the gold dot on a
   small deep-sea lens, and the row's title names the chosen colour in
   words, so the state is never colour alone (agent choice, for the owner).
   Keyboard focus keeps its own gold ring. The dock control is the word
   "Look" until a glyph is drawn. Touch targets are 44 apx.
   Superseded on 2026-11-20 by the picture picker (next section).

Alternatives: reload the page per change (drops the grant, 4 to 6 s per
tap); hide unused meshes (the export forces them visible); match meshes by
name (breaks between finishes); colour three.js materials directly (a second
dressing path that drifts from the AI flow and Quick Look). Dressing in a
Worker is a later option if the ink outline stalls the face on a phone.

## Picture picker and the open-mouth fix (2026-11-20)

Source: the owner, 2026-11-20, on a screenshot of the house avatar smiling
with the mouth open: "theres a bug in this facial expression. and lets make
this more into an avatar picker with images so its easier to use and
imagine what each option is like. each element can be a row of options with
images".

**The picker.** Each row of the look sheet (finish, build, skin, hair, hair
colour, eyes, glasses, clothes) is a strip of pictures that scrolls
sideways, one picture per value, with the value's word under it. A picture
shows the house avatar in its default look (`defaultLook` in base.json,
clay finish) with only that row changed. Each row has its own framing:
upper body for finish and clothes, head to knees for build, the head for
skin, hair, hair colour and glasses, and the eyes for eye colour. The chosen
picture holds the gold ring and the gold dot on a small deep-sea lens, and
its word turns to full text colour; the strip scrolls the chosen picture
into view when the sheet opens. Each picture is a radio named by its word,
so assistive technology and the look e2e read the same names as before.

- **Pictures are made, not drawn live.** `scripts/authoring/house-look-pictures.ts`
  renders them with the viewer's own renderer and lights (one still take
  per row, a close view per value) into `apps/capture/public/look-pictures/`
  (216 px square JPEG, three device pixels per CSS pixel of the 72 px
  picture). They load lazily, so the sheet costs nothing until it opens.
  Re-run the script after a change to the house base, the dressing or the
  finishes.
- **Agent choice, for the owner:** the pictures show the default look, not
  the creator's current look. Live pictures (each value on the current
  look) need a render per value on the phone, about 40 dressings each time
  the sheet opens.

**The open-mouth fix (B-073).** A smile with the jaw open showed the skin
inside the mouth at both sides (and a blob in the middle at a laugh). Each
face shape puts the mouth back on the skin by itself, but a glTF mix only
adds the shapes' offsets: on the face's curve the sum lies behind the skin,
and the face's own skin round MPFB's lip slit lies close behind the mouth
everywhere. `build.py` now samples the mixes in base.json `face.mouthMixes`
over a weight grid, at the mouth's points and at points inside each of its
faces, and pushes each shape's mouth forward, one column at a time, just
enough that every sampled mix keeps the mouth 0.4 mm in front of the skin.
A column moves as one piece, so no tooth edge comes in front of the lips.
The largest push is 3.0 mm (jawOpen at full weight); the side profile of a
smile or an open jaw alone does not change to the eye.

**The glasses fix (B-074).** The pictures showed that no dressed avatar
wore its glasses: the two glasses kinds share one index list, and dressing
disposed it with the kind it removed. Dressing now keeps any accessor that
another mesh still uses, and the look e2e checks the posted hair and
glasses for their index lists.

## Slice 2: the look step in a headset (design, 2026-11-20)

The scope says "a look panel beside the mirror", but VR capture has no
mirror: the author is inside the avatar, and the head meshes are hidden in
first person (`AvatarRig.setFirstPersonVisualState`). Without a mirror the
author sees only hands, arms and the top. So the slice adds one.

**What the author does.** The wrist dock gets a third glyph, Look, beside
Record and Find. It shows only while the house avatar is loaded and no take
runs. Selecting it opens two things 1.5 m ahead, in the styleguide's world
panel place (1.2, 9.1): a standing mirror on the left, and the look panel on
the right. Each one turns to face the head. A pick on the panel changes the
avatar at once, and the author sees it in the mirror with their own head
and hands moving it. Close on the panel, Record, or Find closes both. One
world panel at a time: Look closes Find and the settings panel.

**The mirror.** A planar reflector (three's `Reflector`), 0.7 m × 1.9 m,
standing on the floor, with the chip's radius at its corners and a plain
deep-sea back: no rim and no gold (2.3, 10). The mirror and the panel stand
on one arc 1.5 m from the head, the mirror to the left and the panel to the
right, each turned to face the head, so neither covers the other. The
mirror renders only while Look is open, and its pass draws only the avatar
and the lights (a layer of its own): no world, no chrome, no wrist dock.
Against no world (passthrough) its ground is deep sea. Its overlay colour
is linear 0.5, the identity of its blend, so skin and clothes keep their
colour (three's default grey darkens them). Its target is 512 × 1024 with
no multisampling. The avatar's first-person hidden meshes (the head) show
for the mirror's own render and hide again before the eye's render.

**The panel.** The phone sheet's pictures (`lookPictures.ts`), in IWSDK UI
as the Find panel is built (`VrFindPanel.ts`), on three tabs: Body
(finish, build, clothes), Face (skin, eyes, glasses) and Hair (hair, hair
colour). Each row is the row's word, then its pictures at 64 apx × 2.5
(about 9 cm at 1.5 m; the phone's 72 px, smaller so that the widest row
of eight fits in 0.87 m), each with the value's word under it. The chosen
picture holds the gold ring and dot, and its word is full text colour; the
others are muted. The chosen tab has the gold rule under its word. Rays
only, as Find at 1.5 m; every hit area is at least 56 apx. The panel is
about 0.9 m × 0.65 m at most, so it needs no scroll.

**The glyph.** A provisional Look glyph (a head and shoulders, lines on the
16 × 16 viewBox) in `packages/xr-ui-core/src/provisionalGlyphs.ts`, as
Find's lens was, until the styleguide's glyph table carries it. The wrist
carries no words (7.3), so the glyph is needed.

**What does not change.** `setLook` is the phone's call, so the take, the
export and the saved look behave as on the phone. Record already waits
while a dressing runs. The mirror hangs under the chrome root and the
panel is one of the chrome's IWSDK roots, so recording, export and
pointing skip them.

**Decided by the agent with the owner away (2026-11-20); the owner agreed
to all three the same day:**

- D10. A mirror is added in VR, because the brief's mirror does not exist
  there. Other options: no mirror (the author sees only hands and torso), or
  a small turning copy of the avatar on the panel (cheaper, but it is not
  "you"). Undo: remove the mirror; the panel stands alone.
- D11. Three tabs of rows (Body, Face, Hair), not all eight rows on one
  panel: eight rows at 1.5 m would be 0.87 m × 1.2 m or more, past a
  comfortable look up and down (design review, Neon, 2026-11-20). Other
  options: all rows with smaller pictures, or one tab per row (one more
  step per change). Undo: one panel of all rows. The owner kept the three
  tabs.
- D12. The Look glyph is provisional, as Find's was. The owner kept it for
  now.
- D13. Under Quest multiview the mirror stays as shipped (flat: three draws
  it once for both eyes). The owner chose this over a per-eye mirror render
  now; the physical Quest check stays open, and a fail there brings the
  per-eye render.

**Failure cases for slice 2:**

| Failure case | Prevention or evidence |
|---|---|
| The mirror is recorded or exported | It hangs under the chrome root; the XR check reads the posted GLB's nodes |
| The head shows to the eye, or not in the mirror | The hidden meshes show only inside the mirror's render; the check reads the mirror's head-shown render count, and the head's visibility after the frame, after a live change too |
| The mirror costs frame time when closed | It renders only while Look is open; the probe counts mirror renders after Close |
| The mirror darkens the look | Overlay colour linear 0.5; the check saves a headset frame with the reflection |
| A take starts with Look open (Record, or Halo's S) | Look closes when the recording state leaves idle, whatever started it; the glyph hides during a take |
| Look shows for an avatar that is not the house base | The glyph shows only when the house look is set; `headset-find` (the default avatar) checks it is absent |
| A pick lands while the dressing of the last one runs | `setLook` numbers each change and Record waits (phone slice) |
| The panel or the mirror is under a ray, or pokes miss the Look glyph | The panel is one of the chrome's IWSDK roots; the rays and the poke shade know Look |
| The panel's words are within 1 m | It opens at 1.5 m; the chrome label report checks every label |
| Multiview on a Quest (IWSDK turns it on) | three calls the mirror once for both eyes there, from the centre camera, so the reflection is flat; not checked in IWER (no multiview). A Quest check is open |

**Check.** A new `headset-look` scenario in the IWER harness, through the
real input paths: a controller ray on the dock's Look glyph opens the
mirror and panel at 1.5 m, apart, with every hit at least 56 apx; a ray on
the Hair tab, a hair picture, the Face tab and a glasses picture changes
the live look (`__sampleHouseLook`); the mirror rendered with the head
shown, and the head stays hidden to the eye after the change; Record
closes Look; the exported take carries the chosen hair and glasses nodes
and the card in its extras, and no mirror or panel node; after Close the
mirror renders no more. A headset frame of the open mirror is saved.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Look step, post, feed | The look e2e (`apps/viewer-web/e2e/phone-look.pipeline.spec.ts`): phone ink, phone light and desktop clay journeys | 2026-11-20, IWER and SwiftShader: 5 of 5 pass in 4.1 min. Each journey posts and its feed card renders. Screenshots: `output/test-results/your-look/*-panel.png`, `*-dressed.png`, `*-card.png` (not committed) |
| GLB carries the look | The same e2e reads the posted GLB | Only the chosen hair and glasses; one skeleton; each mesh node once; card and finish in the extras; face weights peak above 0.3. Ink take 10.85 MB, light 6.10 MB, clay 6.18 MB (cap 100 MB) |
| Height unchanged by hair | The same e2e loads four hairstyles and reads the fitted height (the eye is a bone, so it moves only with the fit; on a phone no eye height is fitted) | 1.7109 m for sweptCrop, highBun, tightCoils and wavyBob (spread 0). Load 0.41 s without a saved look, 0.56 s with one (bar: +1.5 s). A bad `?look` and `?finish` give two warnings and load the default |
| Memory, face after a change | The same e2e: twelve changes, then `renderer.info.memory` and the jaw on the live meshes | Memory at load g67/t8; ink g73/t10; back in clay g67/t8, the same on each lap. Live jaw 0.6 on every jaw mesh. Fit after a build change: 2.76 mm broad, 2.60 mm slight (bar 3 mm). A change takes 61 to 144 ms in emulation |
| Quick Look | Phone posts have Quick Look off (`quickLookEnabled` false, so `/usdz` answers 404), so the e2e saves each posted GLB to `output/test-results/your-look/takes/` and `apps/viewer-api/tools/glb_to_usdz.py` and `inspect_usdz.py` run on each by hand (`check_usdz_tools.sh` needs a source with two textured materials, and the house base has none) | All three takes convert, and `inspect_usdz.py` reports no failures: ink 4.53 MB, light 4.33 MB, clay 4.11 MB |
| Picture picker | The same e2e: each row's choices are pictures; every picture is served as a JPEG, and a tapped choice shows its picture | 2026-11-20, IWER and SwiftShader: 5 of 5 pass in 6.2 min. 40 pictures, 352 KB in all (`apps/capture/public/look-pictures/`, made by `scripts/authoring/house-look-pictures.ts`) |
| Open-mouth smile (B-073) | Clearance check of the built base over base.json `face.mouthMixes` (scratch script, Blender) | 910 sample points in 284 mixes: no lips, teeth or mouth point behind the skin (before: up to 3.68 mm) |
| Glasses drawn (B-074) | The same e2e reads the posted GLB | The posted hair and glasses keep an index list longer than their point list |
| The whole flow | Proof video, real time, phone viewport | Sent to the owner; not committed |
| Headset look (slice 2) | `SUMMON_ONLY=headset-look pnpm --filter @holoim/capture run test:xr:summon` (`apps/capture/scripts/lib/look-take.mjs`), IWER controllers on the house base | 2026-11-20: pass. Mirror and panel at 1.5 m, 0.21 rad apart; panel 0.87 × 0.64 m; nearest text 1.5 m; smallest hit at the ray minimum. Hair tab → High bun, Face tab → Round: the live avatar wears each. Mirror: 12 passes, the head shown in each; the head hidden to the eye. Close: no mirror pass after it, settings back. Record closes Look and takes it off the wrist. The take exports `Hair_highBun`, `Glasses_round`, the card, and no mirror or panel node. Shots: `apps/capture/output/ci-summon/headset-look-*.png` |
| Look only for the house base | `SUMMON_ONLY=headset-find …` (the default avatar) | 2026-11-20: pass; no Look glyph on the wrist |
| Mirror under multiview | Not testable in IWER (no multiview); a Quest check | Not verified: under multiview the reflection may render once for both eyes (flat) |
| The headset flow | Proof video, real time, IWER headset view | Sent to the owner; not committed |

### Baseline

`main` at `2fac220785e0`, Pixel 7 viewport, IWER: the phone journey e2e
passes in 34.9 s (sign-in, capture link, countdown, a take, post, the
`/h/<id>` page). It loads the stock avatar. There is no look step: the
house base loads only with `?avatar=`, in its default look, and nothing on
the page can change it.

## Physical-device limits

Not run on a real phone in this slice: the dressing time on a phone CPU,
the swatch colours on a phone screen, and the feel of the panel. The face
from a real camera stays a device check, as in phone-capture.md.
