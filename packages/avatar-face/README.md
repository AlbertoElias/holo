# @holoim/avatar-face

Canonical face-channel vocabulary and per-standard mappings. No runtime dependencies.

## Canonical set

`FACE_CHANNELS` = the 52 ARKit blendshapes (`ARKIT_BLENDSHAPES`, ARKit casing) plus the
15 Oculus visemes (`OCULUS_VISEMES`, `viseme_sil` ... `viseme_U`). A `FaceFrame` is
`{ weights, gaze? }`; weights are 0..1.

## Conventions

- "Left" and "Right" always mean the avatar's / author's own left and right (ARKit convention).
  Meta `_L` is the user's left, so it maps straight to `Left`.
- Gaze angles are radians: yaw + = toward the avatar's own left, pitch + = up.
  `MAX_YAW` = 30 deg, `MAX_PITCH` = 25 deg. `gazeFromArkit` / `arkitFromGaze` convert
  (left eye: lookOut = +yaw, lookIn = -yaw; right eye: lookIn = +yaw, lookOut = -yaw).

## API

- `TARGET_TABLES[standard]`: avatar morph/expression name -> `TargetFormula` over canonical channels
  (`evaluateTarget` clamps to 0..1; missing channels = 0; `mean` divides by term count).
- `SOURCE_TABLES[standard]` / `toCanonical(standard, weights)`: the reverse direction
  (name-normalized, unknown names ignored, contributions combined with max).
- `resolveMorphTarget(name, preferred?)`: normalizes the name (`normalizeMorphName`) and searches
  arkit, oculus-viseme, cc4, meta-fb2, vrm1, vrm0, rpm-legacy in that order. One-letter keys
  (VRM0 vowels) only match vrm0.

## Standards and approximations

- `arkit`, `oculus-viseme`: identity. MediaPipe's names are ARKit's; `_neutral` is ignored.
- `vrm1`: happy = mean(smileL, smileR); angry = mean(browDownL/R); sad = mean(frownL/R, browInnerUp);
  relaxed = half-strength smile + cheekSquint; surprised = mean(eyeWideL/R, browInnerUp, 0.5 jawOpen);
  aa = max(0.8 jawOpen, viseme_aa); ih = max(viseme_I, 0.5 stretch); ou = max(viseme_U, mouthPucker);
  ee = max(viseme_E, 0.4 smile); oh = max(viseme_O, mouthFunnel); blink = min(blinkL, blinkR);
  blinkLeft/Right direct; lookUp/Down = mean of both eyes; lookLeft = mean(lookOutLeft, lookInRight);
  neutral = 0.
- `vrm0`: same formulas under VRM0 names (joy=happy, sorrow=sad, fun=relaxed, a/i/u/e/o=aa/ih/ou/ee/oh,
  blink_l = avatar's left, lookup/lookdown/lookleft/lookright).
- `meta-fb2`: the 70 XR_FB_face_tracking2 expressions, mapped one-to-one to ARKit where one exists
  (L/R-merged ARKit channels such as cheekPuff, browInnerUp, mouthFunnel, mouthPucker, mouthRoll*
  take the max). LIP_TIGHTENER = 0.5 mouthPress; TONGUE_TIP_INTERDENTAL = 0.5 tongueOut.
  Not mapped: CHEEK_SUCK_L/R, TONGUE_TIP_ALVEOLAR, TONGUE_FRONT_DORSAL_PALATE,
  TONGUE_MID_DORSAL_PALATE, TONGUE_BACK_DORSAL_VELAR, TONGUE_RETREAT.
- `cc4`: Character Creator 4 style names (`Eye_Blink_L`, `Mouth_Smile_R`, `Jaw_Open`, ...), one-to-one.
  `Eye_L_Look_L` is the left eye looking left (= lookOutLeft).
- `rpm-legacy`: mouthOpen = max(jawOpen, 0.8 viseme_aa); mouthSmile = mean(smileL, smileR).
