# Feature brief: Sound, voice and captions in a piece

**Lead:** Claude (Opus), session "Slice 4: a person's take as input", for the
directed-performance lead (2026-11-18)
**Status:** Slice 1a built in the authoring tool (2026-11-18,
`feature/sound-1a`); slice 3 (captions) built 2026-11-19
(`feature/sound-captions`); slices 1b, 4 to 6 not started. Written and built while the
owner was away on 2026-11-18. On 2026-11-19 the owner heard the slice 1a clip
and accepted all eight recommended decisions ("Owner decisions" at the end),
and with them the agent's slice 1a choices (the local Kokoro voice and the
house base as the lip-sync avatar).
**Layer:** Event for voice and effects: a sound has a time and a place in the
recorded event, like a gesture (`docs/product/concepts/what-a-hologram-is.md`).
Meaning (read) for captions of speech: a reading of the event offered to a
viewer, never part of it, and a viewer can turn them off. A music bed (no
place in the event) and titles (the card already has one) fit no layer
cleanly; decision 7 (2026-11-19) keeps them out until a piece needs one.

## User outcome

A piece made with the authoring tool can speak. A creator writes a spoken
line into a beat ("open: *There you are.*"), and the performer says it on
that beat, from their head, with a mouth that moves with the words on any
avatar that passes the audition. A cup set down makes a sound where it lands,
a step sounds where the foot lands, and a quiet bed of music can sit under
the whole piece. A viewer scrolling the feed with the sound off reads what is
said on the card, and in AR reads it near the speaker. The same works for a
person's own recorded take: what they said becomes captions, and an imported
take (slice 4a of `directed-performance.md`) keeps its voice.

This closes the gap `directed-performance.md` leaves open: "Not exercised by
the piece, still open: **voice and sound** (speech, effects, music) and
**titles and captions**."

## What exists today

Facts checked on `main` at `39b08018` and re-checked at `65f92be` for the design review (2026-11-18).

| Area | What is there | Where |
|---|---|---|
| Voice in a recorded take | Capture opens the microphone (mono) and records one Opus-in-WebM blob from start to stop, browser-default bitrate and rate | `apps/capture/src/recording/AudioRecorder.ts:1-2`, `:24`, `:73-99` |
| Time alignment | None stored: the audio recorder starts after the motion recorder, with no timestamp linking the two | `apps/capture/src/recording/RecordingSession.ts:175`, `:208` |
| In the GLB | Draft `KHR_audio`: the blob as a bufferView, one source (`autoPlay: false`, `loop: true`), a positional `voice` emitter (inverse distance, 2 m reference) on the head node, or a global emitter when there is no head | `apps/capture/src/recording/GLTFAudioPlugin.ts:73-126`; called from `GltfExportComposer.ts:260`, `:397` |
| Several placed sounds | The format and viewer already take many sources and positional emitters on any node, with gains and distance settings | `docs/features/archive/positional-audio.md` (Complete, 2026-11-11) |
| Feed and portal playback | Decoded once, scheduled against the take's clock: every source starts at the clip's time 0, and a looping source restarts every time its own length passes (`offset = time % buffer.duration`), HRTF panners (up to 64); the feed starts muted and unmuting resumes the audio context | `apps/viewer-web/src/features/hologram/gltfAudio.ts:87`, `:345`, `:428-436`; `useGltfAudio.ts:22-30`; `features/feed/FeedPage.tsx:213-241`; `HologramCardCanvas.tsx:307` |
| Headset and AR playback | The same scheduler, re-synced on drift | `apps/viewer-web/src/features/xr/hologramPlayback.ts:17-61` |
| Quick Look | The converter reads `KHR_audio`, transcodes every source to AAC 128 kb/s stereo 48 kHz and writes `UsdMedia.SpatialAudio` prims: a positional emitter on a drawn node is placed under that node's prim (`auralMode` spatial), a global one or one on a node that is not drawn plays unplaced. Every prim starts at time 0 and loops from the stage, or plays once. Takes cap at 600 s. It also carries blend-shape animation, and it refuses unknown *required* extensions but only warns on unknown used ones (the archived `positional-audio.md` still says positional sound is unplaced there; the code has moved on) | `apps/viewer-api/tools/glb_to_usdz.py:1228-1275`, `:1238-1242`, `:1556-1558`; checked by `tools/check_usdz_tools.sh` (not in `verify:pr`) |
| Mouth from sound | Only liveness: in capture the mic level opens the jaw. No phonemes, no visemes from audio | `apps/capture/src/face/VoiceLevel.ts`, `FaceDriver.ts:192-194` |
| Mouth shapes on avatars | The canonical face carries the 15 Oculus visemes; on an avatar without them, fallbacks map each to `jawOpen` and mouth shapes; the audition grades how far the lip-shape channels move (`lipMm` 4) and the mouth corners, but neither visemes nor whether the lips close (`viseme_PP` falls back to `mouthPress` at 0.5, which may not close lips while the jaw is open) | `packages/avatar-face/src/canonical.ts:58-64`, `fallbacks.ts:12-26`; `fallbacks.ts:26`; `apps/capture/scripts/authoring/lib/audition-bar.ts:27`, `:45-50` |
| Authoring tool | The beat sheet has no sound, voice or caption field; the GLB writer writes no `KHR_audio`; `publish.ts` checks size and the Quick Look load, not audio | `apps/capture/scripts/authoring/lib/beats.ts:30-44`, `:114-125`; `publish.ts:67` |
| Speech to text | Voice search sends up to 10 s / 1 MB to `POST /api/objects/transcribe`, which calls Cloudflare Workers AI Whisper (`whisper-large-v3-turbo`) with the API's token; a used-up free daily allocation is handled as an error | `apps/viewer-api/src/services/transcribe.ts:11-20`; `packages/contracts/src/index.ts:190-191` |
| Text to speech | None, in code or docs | |
| Text in the views | uikit chips in WebXR (`packages/xr-ui-core/src/headsetText.ts`); the styleguide sets Fraunces for titles, Figtree for captions (its "caption" is the card's description, not speech), every text over a hologram on the chip, and **no text inside AR Quick Look** | `docs/product/design/styleguide.md:439`, `:618-619`, `:635-636` |
| Captions as a product idea | PRD-009 (Draft): subtitles near the speaker, "this" and "that" linked to what the body points at | `docs/product/prds/PRD-009-spatial-subtitles.md` |
| Size | Upload cap 100 MB (`MAX_HOLOGRAM_BYTES`); no audio share; the budgets brief calls Opus "already small" | `packages/contracts/src/index.ts:10`; `docs/features/hologram-budgets.md:171-175` |

So the file format, the viewer and Quick Look already carry several placed
sounds. What is missing is all on the making side (a voice, lips, effects
and music in the authoring tool), plus captions everywhere.

## What each kind of take needs

| Need | Agent-directed take (beat sheet) | Embodied take (a person recorded it) |
|---|---|---|
| A spoken line on a beat | A `say` on the beat: text, optionally a voice file; the solver places the audio at the beat's time on the performer's head emitter | Already recorded; needs a known offset between audio and motion (capture stores none today) |
| The mouth follows it | Visemes from the line, written as face weights in the take | Visemes from the recorded audio, added at import or upload; the face recording keeps only some channels today (slice 4a) |
| Effects tied to events | `sound` cues on events the solver already knows: a put lands, a grip closes, a pour starts, a foot touches down (contacts from `motion-quality.ts`) | The same events, found by the import (foot contacts, object events in the recording) |
| Music | One global source with gain and a fade, from a file | The same, added in an edit file (slice 4a's `edit-take.ts`) |
| Captions | From the `say` text, with the timing from the audio | From a transcript of the recorded voice |
| Titles | An opening or closing title cue in the sheet | The same, in an edit file |

## Design decision (proposed)

### 0. Placing a sound in time (a constraint, not a choice)

`KHR_audio` sources carry no start time. The viewer starts every source at
the clip's time 0 and loops each by its own length; the Quick Look converter
starts every prim at 0 and loops it from the stage. So a 1 s put sound set to
loop would repeat every second, and one set not to loop would play once, at
the start, and in Quick Look only on the first pass. **Every source the
authoring tool writes is therefore padded with silence to exactly the clip's
length, `loop: true`, with its onset as leading silence**, and a check fails
any source whose decoded length differs from the clip by more than a frame.
Silence costs little in Opus, but in Quick Look every padded source costs
its full length (5 below). Encoding is `audio/webm;codecs=opus`, as capture
writes, using the ffmpeg `review.ts` already uses; never WAV (size) or Ogg
(Safari decoding risk).

Five choices are open. Each lists options, cost, a recommendation and the
check that would prove it. **Paid or keyed options are the owner's call and
are marked so.**

### 1. Where a voice comes from

| Option | Cost | Notes |
|---|---|---|
| A. The creator's own recorded voice: a sound file named in the sheet (or the take's own recording) | None | Real performance, the best fit for "a recorded event". Needs a person for every line; consent is implicit (it is theirs) |
| B. A local open text-to-speech model run by the authoring tool, for example Kokoro-82M (Apache-2.0 weights, runs in Node through ONNX) | Free; a few hundred MB of weights in the ignored cache; seconds per line on this machine | No key, no network after download. Each voice carries its own licence, which must be checked and recorded beside it, as `house-base.ts` does for its parts. Quality is good for narration, flatter for acting |
| C. A paid service (ElevenLabs, OpenAI speech, or Workers AI speech models on the API's existing Cloudflare account) | **Spend and a key: the owner's call** | Best acting range and emotion controls. Workers AI would reuse the account the transcriber already uses, but past the free allocation it is spend too. Voice cloning of a real person is out of scope whatever the service |

**Recommendation:** A for anything a person performs, B as the default for
agent-directed pieces, and C only if the owner asks for it after hearing B.
The sheet names a voice by spec (`file:…`, `local:kokoro/<voice>`,
`service:<name>/<voice>`), like avatars, so a later swap changes one line.
**Proof:** a round trip that needs no ears. Synthesise the line, transcribe
it locally with whisper.cpp (MIT, local), and require a word error rate under
10 % on five test lines. Timing is measured where it is heard: decode the
embedded bufferView with ffmpeg (Opus pre-skip and the WebM container can
shift the onset) and read the viewer's scheduled offsets in the local feed;
the onset lies within one frame of its beat in both. Whether it *sounds* right is the owner's to judge: subagent
readers cannot hear. A listening clip of each candidate voice goes to the
owner (decision 1: the local voice, accepted 2026-11-19).

### 2. How the mouth follows the voice, on any avatar that passes the audition

| Option | Cost | Notes |
|---|---|---|
| A. Loudness opens the jaw (what capture does live today) | None; already in `VoiceLevel.ts` | Reads as "talking", never as words; lips never close on *p*, *b*, *m* |
| B. Phonemes with timings to visemes: from the TTS (unconfirmed that kokoro-js exposes phoneme timings; it phonemises with espeak-ng, GPL, as WASM) or from forced alignment of a recorded voice to its transcript | Free, local; alignment needs a phonemiser (espeak-ng, GPL, run as a separate tool, not linked) | Most exact; separate paths for synthetic and recorded voices |
| C. Audio to mouth shapes with Rhubarb Lip Sync (MIT, offline command line; optional transcript; nine mouth shapes) mapped onto the 15 Oculus visemes | Free, local; one binary in the ignored cache. English only (its recogniser is PocketSphinx; a phonetic mode is language-free but coarser); an arm64 macOS build must be confirmed before slice 1a starts | One path for every voice (recorded, local or paid). Coarser than B, but proven in animation pipelines; the text, when we have it, improves it |

All three write face weights into the take, so the lips are baked into the
GLB and play everywhere a face plays: feed, headset, AR and Quick Look (the
converter carries blend-shape animation). Avatars without viseme shapes get
them through the fallbacks onto `jawOpen` and the lip shapes, but nothing
yet proves the lips close on such an avatar: the claim is limited to the
avatars tested (the stock avatar and the house base) until the audition
gains a closure row (proposed to its owner, additive: `viseme_PP` at full
weight brings the lips within a written threshold, measured with
`lib/face-geometry.ts`). Life's mouth
(slice 1d) must yield to speech while a line plays.

**Recommendation:** C first (one path, no spend), and B later only if the
proof shows C missing closures. **Proof:** (1) numbers against ground truth
that is fine enough: the TTS's own phone durations where it exposes them,
otherwise a hand-labelled fixture of five lines with *p*, *b* or *m* at word
starts (whisper.cpp's word timings are too coarse for ±80 ms and do not
place phones). Every viseme onset lies within ±80 ms of its labelled phone,
and the upper-to-lower lip distance, measured with `lib/face-geometry.ts`,
falls under a threshold written before the run on at least 90 % of *p*, *b*
and *m*, on the stock avatar and the house base;
(2) readers: three fresh Sonnet readers, frames only (close sheets every
0.1 s), asked what the face does. Pass when at least two say the figure is
speaking and point to where the mouth closes between phrases, against a bar
written first.

### 3. Caption and title format

| Option | Cost | Notes |
|---|---|---|
| A. A `HOLOIM_captions` extension in the GLB: cues `{ from, to, text, kind: speech \| title \| sound, speaker?: node }` | Small: authoring writer, viewer reader, contract type | Travels with the file; additive, so older viewers ignore it and uploads stay backward compatible; the converter can skip it |
| B. A WebVTT sidecar stored by the API next to the GLB | An API field and storage path (versioned endpoint) | Standard format and tooling; does not travel with the file; a second upload to keep in step |
| C. Text as geometry in the GLB (the words modelled as meshes) | Heavy per cue; no accessibility; against the styleguide | Only option that would show inside Quick Look |

**Recommendation:** A, listed in `extensionsUsed` only, never
`extensionsRequired` (the converter refuses unknown required extensions and
only warns on used ones), with a `language` per track so a second language
can come later, and PRD-009's referent links added later as an optional
field on a cue. A cue names its `speaker` by the performer's wrapper node name
(`RecordedAvatar` for the first, `Performer_<id>` for others), not a node
index, which `edit-take.ts` and `recast-take.ts` rewrite. (`HOLOIM_humanoid`
declares only the first performer's bones and no names, so it cannot name a
speaker; corrected at the slice 3 design review.) **Proof:** an extension round trip in the authoring writer's check
(the cues read back equal), and a viewer e2e (below).

### 4. Where captions render

| Option | Notes |
|---|---|
| A. On the card (the flat-screen portal, zoomed out or inside): one line on the chip above the control row while the card is muted, or always if the viewer turns captions on | Feed starts muted (`FeedPage.tsx:213`), so this is where most people meet it. Figtree, on the chip, as the styleguide requires for text over a hologram |
| B. Near the speaker (PRD-009): a chip by the head that faces the viewer | Right for AR and the headset, where the card's foot does not exist; on a phone it can cover the face |
| C. Inside Quick Look | Not possible without breaking the styleguide's "no text in Quick Look" (option 3C); Quick Look keeps the voice and lips only |

**Recommendation:** A on the card (the card is the portal), B in WebXR AR and the
headset, none in Quick Look. This differs from PRD-009, which makes the
phone the primary moment and puts words near the speaker there too; which
wins on the phone was decision 8: the card's foot (2026-11-19). No titles (decision 7). **Proof:** a
viewer-web e2e on a captioned fixture: the cue's text is on the card during
its span and gone after, contrast at least 4.5:1 on the chip, captions
follow mute; in AR, an IWER screenshot of the chip by the head, with a
design-reviewer pass against `styleguide.md`.

### 5. Size budget

Opus voice at 32 kb/s mono is about 4 KB/s; music at 96 kb/s stereo about
12 KB/s; visemes are 15 morph weights a frame (about 1.8 KB/s per mesh at
30 fps as float32); captions are bytes. A 60 s piece with a voice, a music
bed and a dozen short effects is about 1.2 MB of audio in the GLB, about 1 %
of the 100 MB cap. Quick Look grows more: the converter writes every source
as 128 kb/s stereo AAC (16 KB/s), and every source is padded to the clip's
length (0 above), so each costs 16 KB/s × the take's length, silence
included: ten sources over 60 s are about 9.6 MB, eight over 600 s about
77 MB.

**Recommendation:** cap **source-seconds** (sources × take length), not
Opus bytes: at most 480 source-seconds per piece (eight sources over 60 s,
about 7.7 MB in the USDZ), checked by `publish.ts` as a refusal with a hint
(like the Quick Look load row), with the USDZ's audio size reported per
take, and effects mixed into one source per object rather than one per hit.
A later converter change (mono, 64 kb/s for voice sources) belongs to the
Quick Look tool's owner. **Proof:** `publish.ts` refusing an over-budget
fixture, and the USDZ inspected (below) for its audio size.

### Sound sources for effects and music

Effects and music come from files under a licence the repo records:
**CC0 only** (recommended; for example Kenney's audio packs or CC0 items on
Freesound), each with its source and licence in a manifest beside it, as the
house base records its parts. Files the creator supplies are theirs.
Generated audio (for example Stable Audio Open, whose licence is the
Stability community licence, not open) and royalty-free libraries with
attribution are owner decisions.

## Scope

**Included (this brief):** the design above, the slice plan, and the open
decisions. **Excluded:** building anything; voice cloning of a real person;
live voice translation; changing capture's recording format or anything in
`apps/capture/src/` (the embodied-take items that need it go to the
recording owners in slice 5 below); a converter change for Quick Look.

## Undo

None for slices 1 and 3: they add authoring-tool inputs (a sheet or an edit
file, edited as text), not capture actions. Captions in the viewer are a
viewing setting. If a later slice lets a creator add a caption or title in
capture, it is a meaning edit (undone out of the take), to be specified there.

## Slice plan

1. **1a. A supplied voice file, lips and one effect, in the authoring tool
   (no spend, no secret).** Additive beat-sheet fields: `say: { text, voice }`
   on a beat (voice `file:` only) and
   `sound: { file, at: beat | event, on: performer-head | object, gain }`.
   Rhubarb (2C) is fetched at pinned sha256 into an ignored cache, like
   `house-base.ts` does. `writeTake` writes `KHR_audio` with every source
   padded to the clip (0 above): the voice on the head emitter, the effect on
   the object. Rhubarb's shapes become visemes in the take, and life's mouth
   yields while a line plays. One CC0 effect (a put) with its manifest; the
   five test lines are recorded once (by the owner or a CC0 speech sample)
   and hand-labelled. Evidence:
   - a review pack with sound (H.264 plus AAC);
   - the decoded-onset and padded-length report;
   - the viseme timing and lip-distance numbers on the stock avatar and the house base;
   - three frame-only readers against a bar written first;
   - the USDZ inspected with `apps/viewer-api/tools/inspect_usdz.py`: a SpatialAudio prim under the head (spatial) and one under the object, and non-zero mouth blend-shape weights during the lines;
   - the GLB uploaded to a **local** API only, playing in the feed.
   No viewer or API change.
2. **1b. A local voice.** `local:` voices through the local TTS (1B), the
   whisper.cpp round trip, and a listening clip for the owner (decision 1).
   Its licences (weights, voices, the GPL phonemiser run as a separate
   process) recorded beside the cache.
3. **Captions (titles out: decision 7).** The `HOLOIM_captions` contract type in
   `packages/contracts`, written by the authoring tool from `say` lines,
   read by viewer-web on the card (chip, follows mute) and in
   WebXR (chip by the head). Design review against the styleguide and a
   viewer e2e. Codex screenshot validation when it has quota.
4. **Effects from events (no music bed: decision 7).** Sounds attached to solver events
   (put, grip, pour, foot contacts), one mixed source per object, a global
   music source with a fade, and the budget row in `publish.ts`.
5. **Embodied takes (needs the recording owners).** The audio-to-motion
   offset stored in the recording (a capture change), visemes and captions
   for an imported or uploaded take from its own voice (local whisper.cpp in
   the authoring tool; the server's Workers AI path is the owner's call), and
   an `edit-take.ts` edit that adds music or a title.
6. **A paid voice (owner's call).** Only if the owner asks after hearing
   slice 1's local voice.

## Slice 1a: built (2026-11-18)

How to use it: `apps/capture/scripts/authoring/README.md`, "Sound". The
example sheet is `sheets/spoken-line.json`: `tallest-bar` with a line on its
turn and a clink on its put.

**Decided by the agent in the owner's absence on 2026-11-18 (each reversible;
none spends or needs a key). The owner accepted them on 2026-11-19 with the
eight decisions:**

1. **The voice is local Kokoro, not a supplied file** (the parent session's
   instruction, ahead of slice 1b): `local:af_heart`, Kokoro-82M through
   kokoro-js 1.2.1, model `onnx-community/Kokoro-82M-v1.0-ONNX` q8, its
   file checked by sha256 against revision `1939ad2a` on every build that
   speaks (kokoro-js cannot request a revision, so a changed upstream model
   fails the build rather than being pinned away; the transitive packages
   float within kokoro-js's ranges, in the ignored cache). Licences:
   kokoro-js, the weights and voices, `@huggingface/transformers` and
   phonemizer Apache-2.0; onnxruntime-node MIT; the phonemiser runs eSpeak
   NG, **GPL-3.0**, as WASM in a separate process from the ignored cache
   (`output/authoring/tools/kokoro/`), so nothing GPL is committed or
   shipped, only audio it helped make. `file:` voices work too and need a
   credit. This is decision 1 (local), accepted 2026-11-19;
   the owner can swap the voice per line.
2. **Lips come from an in-repo driver, not Rhubarb.** The pinned Rhubarb
   1.14.0 macOS build crashed on this machine (segfault), and running a
   downloaded binary was then refused by the session's safety policy. So
   `lib/lips.ts` lays the phonemiser's phones over the voiced time of the
   line's own audio (RMS envelope) and maps them onto the 15 Oculus visemes,
   which the avatar-face routing already sends to any avatar that passes the
   audition. It works for every voice that has text, in any language eSpeak
   speaks; a line without text (a person's take) still needs an
   audio-only path (Rhubarb or whisper.cpp) in slice 5. Reverting to Rhubarb
   is a swap of one function.
3. **The effect is `synth:cup-clink`**, made procedurally by the tool (this
   project's own, CC0), instead of a fetched CC0 recording: nothing to
   fetch, credit or pin. It is decision 4 (CC0 only), accepted 2026-11-19.
4. **No hand-labelled phones, no lip-distance on p/b/m.** There are no
   recorded lines to label (the voice is synthesised). The written bars were
   replaced, before measuring, by ones read from the GLB alone
   (`speech-report.ts`): each phrase's mouth onset within ±80 ms of its
   sound, the mouth in pauses of 0.25 s or more below 15 % of its speaking
   level, correlation with loudness at least 0.4, every source within a
   frame of the clip. Bilabial closure is not measured; the frame readers
   judge closing between phrases.

**Evidence (all local; no upload anywhere but a local API):**

| Check | Stock avatar | House base |
|---|---|---|
| Sources decoded (`speech-report.ts`) | voice and clink each 10.500 s = clip; the line's first sound at 4.600 s, its beat's cue (+0 ms; placed by its first voiced sound, past Kokoro's 0.3 s lead-in), clink at 8.40 s (the put) | same |
| Mouth onset vs. sound, per phrase | mouth leads 33 ms, 33 ms | leads 33 ms, 67 ms |
| Mouth in the pause, share of speaking | 0 to 3 % | 0 to 2 % |
| Mouth follows loudness (Pearson r) | 0.52 | 0.54 |
| Mouth opening p90 while speaking | 5.5 mm | 18.3 mm |

- Feed card, local API (`viewer-check.ts --audio`): after unmute, the card's
  sound heard at 4.67 to 5.65 s, 6.08 to 7.26 s and 8.47 to 8.63 s take time;
  each sound 68 ms after its place in the file (the recorder's start, the
  same for both).
- Quick Look (`glb_to_usdz.py`, `inspect_usdz.py`, `check_usdz_tools.sh`:
  passed): `audio_0` under `…/Neck/Head`, `audio_1` under the recorded
  object, both spatial, 10.508 s, looping from the stage; facial weights
  carried within 3e-6 of the GLB; both avatars pass, rerun on the final take.
- The eight existing sheets build byte-identical to `214e3b0a`; a take with
  sound builds byte-identical twice (bit-exact WebM).
- Frame readers: three fresh Sonnet readers per avatar, each given only four
  face sheets (2.0 to 9.8 s, a 720 px face view `review.ts` now renders for
  takes with sound) and asked, per still, whether the lips are parted; no
  times or sound spans given. Scored against the voiced spans (bar set
  beforehand: two of three see the mouth open in most voiced stills and
  closed in most silent ones):

  | Avatar | Voiced stills open | Silent stills closed | Bar |
  |---|---|---|---|
  | House base | 11/12, 11/12, 11/12 | 23/28, 23/28, 23/28 | passes |
  | Stock | 1/12, 1/12, 1/12 (2 to 4 unsure) | 28/28 each | fails |

  On the house base the five open silent stills (5.80, 7.20 to 7.80 s) are
  the beat's `smile`, which parts this face's lips over its teeth; the lips
  channel itself measures 0 mm in the pause and after the line
  (`speech-report.ts`). On the stock avatar the mouth moves (5.5 mm p90,
  r 0.52) but too little to read: it has no viseme shapes, and the shared
  fallback in `packages/avatar-face/src/fallbacks.ts` (also used by the
  runtime, so not retuned here) opens only `jawOpen` at 0.1 to 0.7. Decided
  by the agent in the owner's absence (2026-11-18): the house base is the
  slice's lip-sync avatar; a stronger no-viseme fallback is a follow-up.

**Review findings folded in** (independent verifier and code review, fresh
contexts): the line was 0.3 s late by the voice's lead-in silence, and
nothing checked it (now placed by its first voiced sound, and
`speech-report.ts` checks each line within a frame of its beat); the
revision pin was silently ignored by kokoro-js (now described as it is:
a sha256 check); temporary files leaked from `speech-report.ts`; the line
cache ignored the model revision; the lips' phonemiser used American
English for every voice; a negative `delay` desynchronised voice and
lips (now refused). Kept as limits: one sound per place, so one line per
performer per take (README); an unknown Kokoro voice fails at synthesis,
not validation.

**Follow-ups:** the house base misses `tallest-bar`'s aim and put (88.5°)
with or without sound, a pre-existing house-base solve issue; captions
(slice 3); an audio-only lip path for takes without text (slice 5); a
stronger lip fallback for avatars without viseme shapes (`mouthLowerDown`,
`mouthUpperUp` with `jawOpen`, in `packages/avatar-face`), since the stock
avatar's lips read as closed; an unknown Kokoro voice to fail at validation,
and a sound past the clip end to fail rather than warn.

## Slice 3: design review (2026-11-19)

Design reviewer: `design-reviewer` subagent (Opus), fresh context, read-only,
before any code. Folded into the plan:

- **Contract** in `packages/contracts/src/captions.ts`: root extension
  `HOLOIM_captions` `{ version: 1, tracks: [{ language, cues: [{ from, to,
  text, kind, speaker? }] }] }`, in `extensionsUsed` only. `language` is a
  BCP-47 tag (`en-US` for Kokoro's `a` voices, `en-GB` for `b`; a `file:`
  voice says its own). `kind` is any string so a later kind does not void a
  file; viewers show `speech` only (decision 7). `speaker` is optional (the
  first performer when absent). The reader drops a bad cue, not the track,
  and ignores an invalid extension with a warning, as `findStoredPlace` does.
- **No API change.** Captions are JSON only; `hologram-process.ts` keeps root
  extensions, and `HOLOIM_meaning` has no upload check either. The Quick Look
  converter warns on an unknown used extension; `check_usdz_tools.sh` runs
  once on a captioned file.
- **Cue times** from the line's voiced sound, not its file: from `at` plus
  the first voiced group's start to `at` plus the last group's end, clamped
  to the clip. A line splits into cues at its sentence ends only when its
  phonemiser phrases match its voiced groups one to one; otherwise it is one
  cue.
- **Captions share audio's lifecycle.** `direct.ts` adds them with the audio
  after `writeTake`, so `edit-take.ts` and `recast-take.ts` drop both alike
  (a limit, as for sound today).
- **The card:** the chip is drawn outside `.feed-card-foot` (whose layout
  hooks watch its subtree and would move Play), absolutely over the bottom of
  the viewing box, so the cloche and camera never reframe when a cue starts
  or ends. Only the focused card shows captions: the others are paused and
  drawn on demand ("the others hold", styleguide 9.3). The text follows the
  primary action's time, the clock unmuting starts the audio from and the
  lips follow, set only when the cue changes; paused, it shows the cue at the
  paused time. One polite live region, on the focused card only.

### Slice 3: choices the eight decisions left open

Decided by the agent in the owner's absence on 2026-11-19, for the owner to
review (the lead's picks; each is one constant or option, so reversible):

1. **WebXR:** captions show by the head only on a hologram that is not heard
   (in the gallery, every placed hologram but the focused one); the heard one
   shows none. (`XR_CAPTIONS_WHEN` in `apps/viewer-web/src/features/xr/captionChip.ts`.)
2. **No captions toggle in this slice:** on the card, captions follow mute
   only. A toggle (PRD-009, the Settings sheet) is a follow-up.
3. **The headset's 1 m fade applies:** speech captions fade within 1 m of
   the hologram like its other text (styleguide 7.3, `headsetTextVisible`
   with kind `caption`).
4. **The card's reach controls lift the caption:** when they open (stacked
   above Play on a phone), the caption chip rises above them rather than
   hiding.
5. **One line:** a line longer than one chip line is split at sentence and
   clause ends into timed pieces, each its share of the voiced time;
   `CAPTION_LINE_CHARS` in `packages/contracts/src/captions.ts` caps a piece.
6. **Type:** speech captions use `captionOnHologram` (Figtree 400,
   `clamp(.8rem, 1.3vw, 1rem)`; 40 apx in a headset).

## Slice 3: built (2026-11-19)

Branch `feature/sound-captions`. What landed:

- **Contract:** `packages/contracts/src/captions.ts` (`HOLOIM_captions` v1,
  `parseCaptions`, `activeCue`, `primaryTrack`, `splitCaptionText`).
- **Writer:** `apps/capture/scripts/authoring/lib/captions.ts`, called by
  `direct.ts` after the audio; it reads the file back with the viewer's
  parser and fails on a dropped cue.
- **Card:** `HologramCardCanvas.tsx` reads the cue at the primary action's
  time in the frame loop and commits it in that frame (`flushSync`), so the
  chip paints with the pose it belongs to. `HologramCard.tsx` shows it in one
  polite live region, on the focused card only, while muted.
- **WebXR:** `apps/viewer-web/src/features/xr/captionChip.ts`, a UIKit chip
  0.3 m above the speaker's head bone, turned to the viewer, fading by the
  chrome timings.

Evidence (all local):

| Check | Command | Result |
|---|---|---|
| Sheet to card, in time with the clock and the voice | `direct.ts` on `spoken-line`, then `viewer-check.ts --captions --audio --video` (publishes to its own local API) | 2 cues (4.60–6.00 "That one is the tallest.", 6.00–7.19 "Almost twice the first."); 110 frames of a muted pass, 0 wrong; every edge on the first frame drawn past it (0 ms late); voice heard 81 ms after each cue's start (bar 100 ms) |
| Card sync, mute, contrast, type, no-caption file, phone reach row | `e2e/captions.spec.ts` (mocked feed, in `test:e2e:mocked` shard 2) | 0 wrong frames and every edge on the first frame drawn past it, over 9 runs (`--repeat-each=3`) at load averages of 60 to 97, 46 frames a pass at the slowest (8 inside every cue; bar 3); a `title` cue never shows; chip contrast 6.67:1 worst (fill `rgba(8,26,30,0.72)` over white and black, bar 4.5); unmuted, none shown; a GLB with no captions, none shown; phone, paused in Free mode with the row stacked: caption bottom 503 px, controls top 527 px |
| WebXR, heard and not heard, head, fade, focus | `e2e/xr-viewer.spec.ts` "VR captions:" (IWER, `office_small`) | focused hologram shows none, the other shows its cue at opacity 1; chip foot 1.847 m against a head top of 1.769 m; 40 stepped reads, 19 of cue 1 and 21 of cue 2, none wrong; opacity 0 with the head 0.72 m from the hologram, back at 1 beyond 1 m; focus swap moves the chip |
| Quick Look carries no text (decision 3) | `check_usdz_tools.sh` on `spoken-line.glb`; `glb_to_usdz.py` | 7/7 cases pass; the converter warns on `HOLOIM_captions` and the 4.9 MB USDZ holds no caption text |
| Older viewers and the API | no API change; `extensionsUsed` only, never `extensionsRequired` | an older viewer ignores the extension |

Found and fixed while building: the XR chip's fade stuck at 0.875 (it faded
out when already at its target); the card's caption painted one frame after
its pose (about 200 ms at the 8 fps a loaded machine draws), now committed in
the frame; the checks count lag from the first frame drawn past an edge, so a
slow frame rate is not read as lag. Limits: `edit-take.ts` and `recast-take.ts` drop captions with the
audio, as planned; no captions toggle yet (choice 2).

## Acceptance criteria (slice 1a)

- [x] A beat sheet with a `say` line (a supplied file) and a `sound` on a
      put produces a GLB whose sources are each as long as the clip, whose
      voice, decoded with ffmpeg and as the viewer schedules it, starts
      within one frame of its beat on the head emitter, and whose effect
      plays on the object at the put, once. (+0 ms; clink at 8.40 s.)
- [ ] Viseme onsets within ±80 ms of the hand-labelled phones; the lip
      distance under the written threshold on at least 90 % of *p*, *b* and
      *m*, on the stock avatar and the house base. (Not met as written:
      no hand labels, by the agent's decision above; onsets lead the sound
      by 33 to 67 ms on both avatars, closure not measured.)
- [ ] Two of three frame-only readers say the figure speaks and the mouth
      closes between phrases. (House base: 3/3 see it speak, but the beat's
      smile keeps the lips parted through the 0.3 s pause; stock: 0/3. See
      "Frame readers".)
- [x] The USDZ holds the voice prim placed under the head, the effect under
      the object, and non-zero mouth blend-shape weights during the lines.
- [ ] Every fetched tool and asset is pinned by sha256, with its licence
      recorded; nothing paid, no key, no production upload. (Partly: the
      model file is checked by sha256; kokoro-js is pinned by version,
      and its npm dependencies, eSpeak NG's WASM among them, float within
      its ranges.)

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| The voice drifts from the beat over a long take | Audio placed by the solver's clock; the viewer already re-syncs on drift; the onset check is per line, not only the first |
| The mouth moves while silent, or life's mouth fights speech | Life's mouth yields during a line; the closure check covers pauses between phrases |
| An avatar lacks viseme shapes | The fallbacks map visemes onto `jawOpen` and lip shapes; the check runs on the house base as well as the stock avatar |
| A TTS voice or effect has a licence we cannot ship | CC0 only by default; every file's licence is in a manifest, and a check fails on a file without one |
| A fetched model or binary changes upstream | Pinned sha256, as `house-base.ts` does |
| Quick Look grows past its budget from many sources | Source cap and audio budget in `publish.ts`; the USDZ size is reported per take |
| Old viewers or Quick Look break on captions | Captions are in `extensionsUsed` only, so unknown readers ignore them and the converter warns rather than refuses |
| A short sound repeats every loop, or plays only once at the start | Every source is padded to the clip's length and loops with the clip; a check fails a source of any other length |
| A caption's speaker points at the wrong performer after an edit or recast | Speakers are named by performer, not by node index |
| Quick Look plays a music bed aloud, with no mute and no captions | Music stays out (decision 7); if a piece later needs one, its gain is set for a phone speaker and Quick Look is listed in the review pack |
| The feed autoplays sound | It does not: the feed starts muted; captions carry the line while muted |
| Captions cover the face on a phone | On the card they sit on the chip at the foot, not by the head; by-the-head only in XR |
| A person's recorded take has no known audio offset | Slice 5, with the recording owners; until then imported takes keep their audio as recorded and get no visemes |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Directed-performance lead | This brief, integration |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only, before slice 1 |
| Implementer (slice 1) | One authoring session | `apps/capture/scripts/authoring/` only |
| Implementer (slice 3) | A viewer session | `packages/contracts`, `apps/viewer-web` caption rendering |
| Recording owners (slice 5) | Capture recording and phone-journey sessions | `apps/capture/src/recording/`, `src/face/` |
| Independent verifier | A different vendor when one has quota, else `verifier` | Read-only |

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Voice and effect timing | `direct.ts` on a test sheet, then a timing report from the GLB | slice 1a: `speech-report.ts`, line +0 ms on its beat, clink on the put |
| Intelligibility | the whisper.cpp round trip on five lines | not in slice 1a (one line; slice 1b) |
| Lips | a viseme report (onsets, closures) on two avatars; frame readers | slice 1a: onsets, pauses and r on both avatars; readers (see "Frame readers") |
| Quick Look | `apps/viewer-api/tools/check_usdz_tools.sh` | slice 1a: passed, convert and inspect on both takes |
| Feed playback | `review.ts` on the take against a local API | slice 1a: `viewer-check.ts --audio`, heard 68 ms after the file |
| Captions | `viewer-check.ts --captions --audio`, `e2e/captions.spec.ts`, the VR captions test | slice 3: see "Slice 3: built" |

## Physical-device limits

Speaker and headphone listening, Quick Look playback of voice and lips on an
iPhone, and Quest playback are physical checks, none run. The phone brief's
pending device checks apply. Emulated playback proves timing, not how it
sounds.

## Owner decisions (2026-11-19)

The owner heard the slice 1a clip on 2026-11-19 and, asked "Accept the eight
recommended sound decisions?", answered "Accept all eight". Each is decided as
the recommended option:

1. **Voice for agent-directed pieces:** a local open model (free; Kokoro
   `local:af_heart` today). No paid service.
2. **Captions by default:** shown whenever the card is muted.
3. **Text in Quick Look:** none, as the styleguide says.
4. **Licences:** CC0 only for effects and music.
5. **Transcribing a person's take:** local whisper.cpp in the authoring tool.
6. **Size:** 480 source-seconds per piece (about 7.7 MB of audio in the USDZ).
7. **Music beds and in-piece titles:** kept out until a piece needs one.
8. **Captions on the phone:** at the card's foot on the chip, never over the
   face.
