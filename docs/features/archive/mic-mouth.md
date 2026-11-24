# Feature brief: the mouth from the microphone in a headset

**Lead:** Claude (session "mic mouth")
**Status:** Complete (2026-11-24; emulator only, Quest checks open)
**Layer:** event (the recorded performance; see `docs/product/concepts/what-a-hologram-is.md`)

## User outcome

A performer in a headset has no camera on the face, so nothing tracks the
mouth. When the performer speaks while recording, the avatar's mouth moves
with the voice: the jaw opens with the loudness, and the lips go round or
wide with the sound. The recorded hologram keeps this motion through export,
upload and render.

## What is there already

Part of this exists. `VoiceLevel` reads the loudness of the microphone and
`LivenessFace` opens `jawOpen` with it (`apps/capture/src/face/`). The
recorder samples every morph weight of the avatar each frame
(`FrameCaptureStore`), so the jaw is in the exported take. No check plays a
known sound and compares the mouth with it: the face check only reads the
peak of the jaw under Chromium's test beeps. The lips do not move at all.

## Scope

**Included:**

- Lip shapes from the sound, next to the jaw that is there: round lips for
  "oo" sounds, wide lips for "ee" and "eh" sounds. Own code on the Web Audio analyser. No library, no model, no
  service.
- A resume of the audio context when the browser holds it suspended, and
  the analyser connected only in a running context, so the level is not a
  silent zero in a headset.
- An end-to-end check in the IWER emulator with a fixed, hand-made sound as
  the microphone (`mic-mouth` XR check).
- Documentation of the rule, the threshold and the smoothing values.

**Excluded:**

- Speech recognition, phonemes and consonant closures ("p", "b", "m"). A
  level and a spectrum cannot tell them from a short pause.
- An adaptive noise floor. The threshold is a fixed level (see below).
- A WebXR face-tracking source. No browser on a Quest gives one today. The
  priority rule below already has its place.
- Any change to the eyes, the brows, the camera path (`trackedFace.ts`), the
  seven approved expressions, or the authored takes (`lips.ts`,
  `direct.ts`).
- A new microphone prompt, a change to the recording flow, a change to a bar
  or a check limit.

## The rule: face tracking first

`FaceDriver` picks the expression source by priority: tracked scores
(automation replay), then the camera's face tracker, then liveness. **The
microphone drives the mouth only while the source is liveness**, which means
only when no face tracking is available. When a tracked face is there, the
voice is not read and the tracked mouth is the mouth. A future WebXR face
source enters this list above liveness and gets the same rule. On a change
of source the driver crossfades in 0.25 s, as today.

## Values

| Value | Number | Where |
|---|---|---|
| Analysis window | 1024 samples (21 ms at 48 kHz), no analyser smoothing for the spectrum | `VoiceLevel` |
| Noise threshold | RMS 0.01 of full scale (−40 dBFS). Below it the level is 0 and the mouth is closed | `VoiceLevel.read` (unchanged) |
| Full level | RMS 0.13 (level = (RMS − 0.01) / 0.12, limits 0 and 1) | unchanged |
| Jaw | `jawOpen` = min(0.55, 0.9 × level) | `LivenessFace` (unchanged) |
| Jaw smoothing | time constant 0.04 s to open, 0.09 s to close | unchanged |
| Bands | low 150–600 Hz, mid 600–1500 Hz, high 1500–3500 Hz (sum of power) | new, `VoiceLevel` |
| Wide | 10 × log10(high ÷ mid) in dB, from −20 dB (none) to −5 dB (full) | new, `VoiceMouth` |
| Round | low ÷ (low + mid), from 0.5 (none) to 0.9 (full), times (1 − wide) | new, `VoiceMouth` |
| Lip gate | the lip shapes scale with min(1, level ÷ 0.25): no level, no shape | new |
| Lip amounts | `mouthFunnel` 0.5 × round, `mouthPucker` 0.35 × round, `mouthStretchLeft/Right` 0.4 × wide | new |
| Lip smoothing | time constant 0.06 s, both directions | new |

The lip numbers are tuned on synthetic vowels in a low voice (120 Hz) and a
high voice (220 Hz). High ÷ mid is about −3 dB on "ee", −8 to −15 dB on
"eh", and below −30 dB on "oo" and "ah". Low ÷ (low + mid) is above 0.95 on
"oo" and "ee", 0.3 to 0.4 on "oh", and below 0.1 on "ah"; so "oh" gets no
round lips, only the jaw. The owner's check on a Quest can change the
numbers.

## Undo

None. The feature adds no authoring action. The mouth is part of the
recorded performance, as the body and the hands are; undo of a take already
removes it with the take.

## Acceptance criteria

- [x] A1. In the emulated headset, in VR, with the fixed sound as the
  microphone and the expression source `liveness`: `jawOpen` follows the
  loudness. Over the voiced parts, the correlation between `jawOpen` and the
  jaw that the values above give for the sound is at least 0.8 (at the
  best delay from 0 to 150 ms, which the check reports); `jawOpen` is at
  least 0.25 in each loud part; and in a run of four syllables of unequal
  loudness the jaw's four peaks have the order of the loudness.
- [x] A2. In the silent parts (after 0.4 s to close) `jawOpen` and every
  lip channel are at most 0.02.
- [x] A3. In the part with room noise below the threshold (RMS 0.004) they
  are at most 0.02 too.
- [x] A4. Lips, in a low and in a high voice: in the "oo" part `mouthFunnel` is at least 0.2 and more than
  `mouthStretchLeft`; in the "ee" part `mouthStretchLeft` is at least 0.2
  and more than `mouthFunnel`; in the "ah" part both are below 0.15.
- [x] A5. Sound moves only the mouth and the jaw: during the run no channel
  other than `jawOpen`, `mouthFunnel`, `mouthPucker`, `mouthStretchLeft`,
  `mouthStretchRight` and the liveness channels that move without sound
  (blinks and the lids that follow the gaze) goes above 0.001. Measured on
  the driver's weights, before the rig spreads them.
- [x] A6. Face tracking first: with tracked scores set (jaw closed) while
  the loud sound plays, `jawOpen` and the lip channels stay at most 0.02
  after the crossfade.
- [x] A7. The exported take keeps the mouth: the head's weights track in the
  GLB has each sampled value of `jawOpen`, `mouthFunnel` and
  `mouthStretchLeft` within one key of its time (RMS error at most 0.02,
  equal peaks), and the GLB carries the recorded sound.
- [x] A8. No second prompt: the app's own microphone request (when it
  loads, and again at a recording, as before this feature) comes first; the
  voice meter opens its stream only after that request was granted, and one
  time. With the microphone denied the meter never asks, the mouth stays
  closed and no error shows.
- [x] A9. The `live-face` check's rows do not change: every channel of every
  set is equal before and after this change (largest difference 0). The
  `face` check passes with its bars as they are.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Room or fan noise opens the mouth | Fixed threshold RMS 0.01; A3. A real Quest's noise level is an owner check |
| Audio context suspended (made before the page counted a user action): level reads 0, the mouth never moves | `VoiceLevel.read` asks for a resume once, and once more after the first user action; the analyser connects only in a running context. The check makes this case on purpose and reports it; Quest check |
| A refused microphone is asked for again on every frame | A failed start is not repeated until the microphone state changes to granted |
| The meter asks for the microphone before the recording does (second prompt) | Starts only when `micPermission` is `granted`, set by the recorder; A8 |
| Microphone denied or missing | `start` catches the error and `read` returns 0; A8 |
| A tracked face and the microphone both write the mouth | One source at a time in `FaceDriver`; the voice is read only for liveness; A6 |
| Two writers on the morphs | `FaceRig.apply` stays the only writer; the voice only adds to the liveness weights |
| Lip shapes flicker between round and wide | 0.06 s smoothing, a dead band below each "none" value, round scaled by (1 − wide); frames in the proof video |
| Sound changes the eyes or the approved expressions | Lips come only in the liveness source; A5, A9 |
| Authored takes change | `LivenessFace` and `lips.ts` are not edited; `direct.ts` passes level 0 |
| The mouth is lost in export | Recorder samples all morph weights; A7 |
| The mouth lags the recorded sound | Smoothing is 0.04–0.09 s; the check reports the lag at best correlation |
| Echo: the hologram's own sound from the speaker moves the mouth | `echoCancellation` on the meter's stream (as today); Quest check |
| Slow frames under load | Smoothing uses the frame's own time step; the check runs in real time, reads the sound's clock, and has parts long enough for 3 frames a second |
| The headset's automatic gain control lifts room noise above the threshold | Not solved here: the stream keeps the browser's default gain control. Quest check 2 |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Claude (this session) | Brief, integration, final handoff |
| Design reviewer | `design-reviewer` subagent (Opus) | Read-only review before implementation |
| Implementer | Claude (this session) | `apps/capture/src/face/VoiceLevel.ts`, `VoiceMouth.ts` (new), `FaceDriver.ts`; `apps/capture/scripts/ci-mic-mouth-playwright.ts` (new), `run-xr-checks.ts`; docs |
| Independent verifier | `verifier` subagent (Opus) and a code review of the diff | Read-only verification; test artifacts only |

## Design decision

**Chosen:** keep the jaw as it is, and add a small `VoiceMouth` that turns
four band powers into two lip amounts (round, wide). `FaceDriver` adds its
channels to the liveness weights. `FaceRig.apply` stays the only writer.

**Alternatives considered:**

- A viseme library or a speech model (for example a phoneme recogniser):
  better consonants, but a download, a licence to read and CPU on a
  headset. Rejected: the task allows none without the owner's yes.
- Viseme channels (`viseme_O`, `viseme_I`) in place of ARKit channels: the
  avatar package routes them to the same lip shapes, but each also adds to
  `jawOpen`, and the jaw would then have two sources. Rejected.
- Move the jaw into the new class: one place for the whole mouth, but it
  changes `LivenessFace`, which the authored takes use. Rejected to keep
  those takes byte-equal.

**Defaults chosen without the owner (cheapest safe):**

1. Lip shapes come from the spectrum with own code; no library.
2. The threshold is fixed at RMS 0.01; no adaptive floor.
3. The meter opens the microphone after the app's own request was granted
   (the app asks when it loads, at a recording and at the AR entry tap), as
   today. The feature adds no request of its own kind and no prompt.
4. The jaw's numbers do not change.

**Review changes** (design review, 2026-11-23, verdict "go with changes"):

- Taken: no value that is not a number can reach the lips; a refused
  microphone is not asked for again each frame; one resume request per
  state of the audio context; the lips are sampled every frame, with no
  sound while another source drives the face, so they do not jump when the
  source comes back; the hiss rule is removed (noise suppression removes
  most hiss, and it could not be tested without a recorded voice).
- Taken in the check: one microphone stand-in serves the recorder and the
  meter, with a stream for each; real time, no page clock; A1 by
  correlation against the expected jaw with the delay reported; two voices;
  A5 on the driver's weights; no autoplay flag, a real key press in its
  place.
- Not taken: `autoGainControl: false` on the meter's stream. The stream's
  constraints stay as they were; the gain control risk is a Quest check.
- Found while building: in Chromium a stream source made in a suspended
  audio context stayed silent after the resume (with the check's stand-in
  stream). `VoiceLevel` now connects the stream only in a running context.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| A1–A8 | `node --import tsx scripts/run-xr-checks.ts mic-mouth` in `apps/capture`: builds the fixed sound in the script (a pulse train through three formant filters: "ah", "ee", "oo", four syllables of unequal loudness, low noise, silence, in a low and a high voice), gives it to the page as the microphone (a Web Audio stream in place of `getUserMedia`), enters emulated VR, records in real time, samples the face on each frame against the sound's own clock, waits for the sound's end, stops, exports and reads the GLB | `mic-mouth-report.json` (numbers for each criterion), `mic-mouth-rows.json`, `mic-mouth.wav`, the exported GLB. Pass on 2026-11-24 (emulator, 320×180, 18.6 frames a second, 395 sound frames). A1: jaw correlation 0.998 at 0 ms lag; vowel jaw peaks 0.55; syllable peaks (loudness 0.1, 0.04, 0.07, 0.05) low voice 0.55, 0.239, 0.474, 0.32, high voice 0.55, 0.231, 0.457, 0.306. A2: largest mouth value in silence 0.005. A3: 0 in the room noise. A4 (both voices): "oo" `mouthFunnel` 0.5, stretch 0; "ee" `mouthStretch*` 0.4, funnel 0; "ah" both 0. A5: channels moved: `jawOpen`, `mouthFunnel`, `mouthPucker`, `mouthStretchLeft/Right`, `eyeBlinkLeft/Right` (the blink of the idle face). A6: source `automation`, mouth 0 under the loud sound. A7: 637 keys; jaw, funnel and stretch RMS error 0, correlation 0.998–0.999, equal peaks; 426 108 bytes of sound in the take. A8: requests `recorder`, then `meter` one time; with the microphone refused the meter never asks and the mouth stays 0. The meter's audio context was made suspended in this run and resumed. |
| A9 | `LIVE_FACE_FRAMES=1 … run-xr-checks.ts live-face` on `origin/main` and on the branch; compare the two `live-face-rows.json` | 8550 numbers compared in `live-face-rows.json`: 0 different, largest difference 0. (Run without `LIVE_FACE_FRAMES`; the rows are written in both modes.) |
| A9 | `run-xr-checks.ts face` | Pass, bars unchanged |
| Proof video | `MIC_MOUTH_VIDEO=1 MIC_MOUTH_GPU=metal … run-xr-checks.ts mic-mouth`, then the page recording and `mic-mouth.wav` joined on the white start marker | `apps/capture/output/mic-mouth.mp4` (not committed): the live avatar in the emulator speaks the sound, mouth view, with the sound. That run: 120 frames a second, jaw correlation 1 at 20 ms lag. |
| Render | Not run for this take. The take holds the mouth in the head's weights track (A7), the same track the phone face writes; the viewer plays it with three's `AnimationMixer` | None: playback of this take in the viewer is Quest check 7 |

The sound is made in the script from numbers; no recorded voice and no
system voice is used.

## Physical-device limits

The emulator proves the path from a sound to the mouth and to the exported
take. It does not prove a headset. Only the owner can check, on a physical
Quest:

1. The mouth moves with the owner's own voice while recording, and closes
   between phrases.
2. The headset's fan and room noise do not move the mouth (threshold),
   also with the browser's automatic gain control at work.
3. The headset shows only one microphone prompt.
4. The mouth moves in the first take after a fresh page load (audio context
   not suspended).
5. The lip shapes look right on a real voice (round and wide on the right
   sounds), and the mouth is in time with the sound in the posted hologram.
6. The hologram's own playback from the headset speakers does not move the
   mouth.
7. The posted hologram shows the mouth motion in the viewer (the upload and
   the viewer's playback of this take were not run in the emulator).
