import { gazeFromArkit, toCanonical } from '@holoim/avatar-face';
import type { FaceSample, FaceWeights } from './faceTypes';

// What the camera face tracker (MediaPipe FaceLandmarker) gives for a real face (B-093): almost no cheek raise,
// almost no frown on a plainly sad face, eyes that open wide to a small part of the range, a resting eye squint
// well above zero on many faces, and little mouth stretch. Applied one to one, a smile moved only the mouth
// and a sad face moved nothing. So the scores are shaped here before they reach the face: weak scores get a gain,
// a resting level is taken off, and the parts of an expression that the tracker does not report follow the parts
// that it does (cheeks and lower lids with the mouth corners, mouth corners and inner brows with a sad face).
const JAW_REST = 0.03; // below this the lips stay closed, so m, b and p close the mouth
const JAW_GAIN = 1.25;
const SQUINT_REST = 0.3;
const SMILE_TO_CHEEK = 0.8;
const SMILE_TO_SQUINT = 0.35;
const SMILE_SQUINT_MAX = 0.6; // a laugh narrows the eyes; it does not close them
const SMILE_TO_BROW = 0.15;
const SMILE_TO_DIMPLE = 0.35;
const EYE_WIDE_GAIN = 3;
const BROW_UP_GAIN = 1.5;
const BROW_DOWN_GAIN = 1.3;
const ROUND_GAIN = 1.4;
const ROUND_FUNNEL_OFF = 0.5;
const ROUND_JAW_OFF = 0.7; // pursed lips (oo) stay a small ring: the jaw's share falls as the pucker rises
const STRETCH_GAIN = 4;
// A sad face: the lower lip pushed up, a trace of frown and raised inner brows, with no smile and a closed jaw.
// The mouth corners take `corners` of the sad level: the brows carry the feeling, the mouth a small frown (B-102).
// The upper lids come down by `lids` of the sad level: heavy lids, not a blink (B-105).
const SAD = { shrug: 4, frown: 6, brow: 1.2, floor: 0.2, mouthFull: 0.4, smileOff: 5, jawOff: 2.5, riseSec: 0.35, fallSec: 0.5, corners: 0.69, brows: 1, lowerLip: 0.32, lids: 0.32 };
// A laugh (a wide smile with an open jaw): the cheeks and eyes carry it (they rise and narrow more), so the jaw
// opens less far and the lips stay nearer the teeth. The cheeks push the lower lids up and the upper lids stay open
// (`squint` below zero, a little `wide`), so the eyes smile and do not look sleepy (B-105). Below `smileFrom` or `jawFrom` nothing changes: a smile and speech are as before (B-102).
const LAUGH = { smileFrom: 0.5, smileSpan: 0.3, jawFrom: 0.15, jawSpan: 0.2, jawEase: 0.4, upperEase: 0.25, lowerEase: 0.6, cheek: 0.3, squint: -0.03, wide: 0.12 };
// A scowl (brows hard down) wrinkles the nose and narrows the eyes.
const SCOWL = { from: 0.35, span: 0.4, sneer: 0.6, squint: 0.3, press: 0.4 };

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * The face the avatar shows for the camera face tracker's scores (ARKit names). The camera and a replayed
 * recording of tracker scores (`__setFaceTrackerInput`) both pass through one of these. It keeps the level of
 * the sad face between frames, because that is read from weak scores and must not flicker.
 */
export class TrackedFace {
  private sad = 0;
  private lastMs: number | null = null;

  reset(): void {
    this.sad = 0;
    this.lastMs = null;
  }

  sample(raw: Record<string, number>, nowMs: number): FaceSample {
    const tracked = toCanonical('arkit', raw);
    const dtSec = this.lastMs === null ? 0 : Math.min(0.5, Math.max(0, (nowMs - this.lastMs) / 1000));
    this.lastMs = nowMs;
    return { weights: this.shape(tracked, dtSec), gaze: gazeFromArkit(tracked) };
  }

  private shape(tracked: FaceWeights, dtSec: number): FaceWeights {
    const at = (channel: keyof FaceWeights): number => tracked[channel] ?? 0;
    const out: FaceWeights = { ...tracked };
    const smile = (at('mouthSmileLeft') + at('mouthSmileRight')) / 2;
    const jaw = at('jawOpen');
    const pucker = clamp(at('mouthPucker') * ROUND_GAIN);
    const laugh = clamp((smile - LAUGH.smileFrom) / LAUGH.smileSpan) * clamp((jaw - LAUGH.jawFrom) / LAUGH.jawSpan);
    out.jawOpen = clamp((jaw - JAW_REST) * JAW_GAIN) * (1 - ROUND_JAW_OFF * pucker) * (1 - LAUGH.jawEase * laugh);

    const frown = (at('mouthFrownLeft') + at('mouthFrownRight')) / 2;
    // Raised inner brows count only with a sign at the mouth: alone they are surprise, not a sad face.
    const sadMouth = SAD.shrug * at('mouthShrugLower') + SAD.frown * frown;
    const sadNow =
      clamp(sadMouth + SAD.brow * at('browInnerUp') * clamp(sadMouth / SAD.mouthFull) - SAD.floor) *
      clamp(1 - SAD.smileOff * smile) *
      clamp(1 - SAD.jawOff * jaw);
    const tau = sadNow > this.sad ? SAD.riseSec : SAD.fallSec;
    this.sad += (sadNow - this.sad) * (dtSec > 0 ? 1 - Math.exp(-dtSec / tau) : 1);
    const sad = this.sad;
    out.browInnerUp = clamp(Math.max(at('browInnerUp') * BROW_UP_GAIN, SAD.brows * sad));
    out.mouthShrugLower = clamp(Math.max(at('mouthShrugLower'), SAD.lowerLip * sad));

    for (const side of ['Left', 'Right'] as const) {
      const sideSmile = at(`mouthSmile${side}`);
      const scowl = clamp((at(`browDown${side}`) - SCOWL.from) / SCOWL.span);
      out[`cheekSquint${side}`] = clamp(Math.max(at(`cheekSquint${side}`), SMILE_TO_CHEEK * sideSmile) + LAUGH.cheek * laugh);
      // The eyes narrow by the same amount on both sides: an uneven mouth score must not read as a wink.
      const squint = Math.max(0, at(`eyeSquint${side}`) - SQUINT_REST) / (1 - SQUINT_REST);
      out[`eyeSquint${side}`] = clamp(Math.max(Math.min(squint + SMILE_TO_SQUINT * smile, Math.max(squint, SMILE_SQUINT_MAX)), squint + SCOWL.squint * scowl) + LAUGH.squint * laugh);
      // The lids follow the sad level only while the signs of a sad face are there: they do not hang into the next expression.
      out[`eyeBlink${side}`] = clamp(Math.max(at(`eyeBlink${side}`), SAD.lids * Math.min(sad, sadNow)));
      out[`mouthDimple${side}`] = clamp(Math.max(at(`mouthDimple${side}`), SMILE_TO_DIMPLE * sideSmile));
      out[`eyeWide${side}`] = clamp(at(`eyeWide${side}`) * EYE_WIDE_GAIN + LAUGH.wide * laugh);
      out[`browOuterUp${side}`] = clamp(at(`browOuterUp${side}`) * BROW_UP_GAIN + SMILE_TO_BROW * smile);
      out[`browDown${side}`] = clamp(at(`browDown${side}`) * BROW_DOWN_GAIN);
      out[`mouthPress${side}`] = clamp(Math.max(at(`mouthPress${side}`), SCOWL.press * scowl));
      out[`noseSneer${side}`] = clamp(Math.max(at(`noseSneer${side}`), SCOWL.sneer * scowl));
      out[`mouthFrown${side}`] = clamp(Math.max(at(`mouthFrown${side}`), SAD.corners * sad));
      out[`mouthUpperUp${side}`] = at(`mouthUpperUp${side}`) * (1 - LAUGH.upperEase * laugh);
      out[`mouthLowerDown${side}`] = at(`mouthLowerDown${side}`) * (1 - LAUGH.lowerEase * laugh);
      out[`mouthStretch${side}`] = clamp(at(`mouthStretch${side}`) * STRETCH_GAIN);
    }
    out.mouthPucker = pucker;
    out.mouthFunnel = clamp(at('mouthFunnel') * ROUND_GAIN) * (1 - ROUND_FUNNEL_OFF * pucker);
    return out;
  }
}
