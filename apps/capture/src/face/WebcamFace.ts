import { FaceLandmarker } from '@mediapipe/tasks-vision';
import { gazeFromArkit, toCanonical } from '@holoim/avatar-face';
import type { FaceCameraState, FaceSample } from './faceTypes';

// Self-hosted: the WASM runtime is bundled from the package and the model is
// served from public/, so tracking never depends on a CDN.
const WASM_LOADER_URL = new URL('../../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js', import.meta.url).href;
const WASM_BINARY_URL = new URL('../../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm', import.meta.url).href;
const MODEL_URL = `${import.meta.env.BASE_URL}mediapipe/face_landmarker.task`;

// MediaPipe's blendshapes follow ARKit: "Left" is the subject's own left,
// whatever the preview mirroring. This is the single place to flip it if a
// real wink on a device shows otherwise.
const SWAP_SIDES = false;
// Hold the last reading through short stalls (a hidden tab, a dropped frame)
// before handing the face back to liveness.
const HOLD_SEC = 0.3;
const DETECT_INTERVAL_MS = 1000 / 30;

/** ARKit-52 weights and gaze from the desktop or phone camera. */
export class WebcamFace {
  state: FaceCameraState = 'off';
  delegate: 'GPU' | 'CPU' | null = null;
  private landmarker: FaceLandmarker | null = null;
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private last: FaceSample | null = null;
  private lastSeenMs = -Infinity;
  private lastDetectMs = -Infinity;
  private lastVideoTime = -1;
  private onChange: (state: FaceCameraState) => void;

  constructor(onChange: (state: FaceCameraState) => void = () => undefined) {
    this.onChange = onChange;
  }

  async start(): Promise<void> {
    if (this.state !== 'off' && this.state !== 'denied' && this.state !== 'unavailable') return;
    this.setState('starting');
    if (!navigator.mediaDevices?.getUserMedia) {
      this.setState('unavailable');
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 }, audio: false });
    } catch (error) {
      this.setState((error as DOMException)?.name === 'NotAllowedError' ? 'denied' : 'unavailable');
      return;
    }
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = this.stream;
    this.video = video;
    try {
      await video.play();
      // Headless Chromium and many phones have no GPU delegate.
      try {
        this.landmarker = await createLandmarker('GPU');
        this.delegate = 'GPU';
      } catch {
        this.landmarker = await createLandmarker('CPU');
        this.delegate = 'CPU';
      }
      this.setState('no-face');
    } catch (error) {
      console.warn('Face tracking unavailable', error);
      this.stop('unavailable');
    }
  }

  stop(state: FaceCameraState = 'off'): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.landmarker?.close();
    this.landmarker = null;
    this.stream = null;
    this.video = null;
    this.last = null;
    this.setState(state);
  }

  /** The latest face, or null when no face has been seen for HOLD_SEC. */
  sample(nowMs: number): FaceSample | null {
    const video = this.video;
    if (this.landmarker && video && video.readyState >= 2 && nowMs - this.lastDetectMs >= DETECT_INTERVAL_MS && video.currentTime !== this.lastVideoTime) {
      this.lastDetectMs = nowMs;
      this.lastVideoTime = video.currentTime;
      const result = this.landmarker.detectForVideo(video, nowMs);
      const categories = result.faceBlendshapes?.[0]?.categories;
      if (categories?.length) {
        const raw: Record<string, number> = {};
        for (const category of categories) raw[swapSides(category.categoryName)] = category.score;
        const weights = toCanonical('arkit', raw);
        this.last = { weights, gaze: gazeFromArkit(weights) };
        this.lastSeenMs = nowMs;
        this.setState('tracking');
      }
    }
    if (nowMs - this.lastSeenMs > HOLD_SEC * 1000) {
      if (this.state === 'tracking') this.setState('no-face');
      return null;
    }
    return this.last;
  }

  private setState(state: FaceCameraState): void {
    if (this.state === state) return;
    this.state = state;
    this.onChange(state);
  }
}

async function createLandmarker(delegate: 'GPU' | 'CPU'): Promise<FaceLandmarker> {
  return FaceLandmarker.createFromOptions(
    { wasmLoaderPath: WASM_LOADER_URL, wasmBinaryPath: WASM_BINARY_URL },
    {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true
    }
  );
}

function swapSides(name: string): string {
  if (!SWAP_SIDES) return name;
  if (name.endsWith('Left')) return `${name.slice(0, -4)}Right`;
  if (name.endsWith('Right')) return `${name.slice(0, -5)}Left`;
  return name;
}
