import { FaceLandmarker } from '@mediapipe/tasks-vision';
import { gazeFromArkit, toCanonical } from '@holoim/avatar-face';
import { headRotationFromMatrix } from '../bodycam/headMatrix';
import type { Quat4 } from '../bodycam/types';
import type { FaceCameraState, FaceSample } from './faceTypes';

// Self-hosted: the WASM runtime is bundled from the package and the model is
// served from public/, so tracking never depends on a CDN.
const WASM_LOADER_URL = new URL('../../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js', import.meta.url).href;
const WASM_BINARY_URL = new URL('../../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm', import.meta.url).href;
/** The self-hosted WASM runtime, shared with the body and hand trackers that load on the same camera. */
export const MEDIAPIPE_WASM = { wasmLoaderPath: WASM_LOADER_URL, wasmBinaryPath: WASM_BINARY_URL };
const MODEL_URL = `${import.meta.env.BASE_URL}mediapipe/face_landmarker.task`;

// MediaPipe's blendshapes follow ARKit: "Left" is the subject's own left,
// whatever the preview mirroring. This is the single place to flip it if a
// real wink on a device shows otherwise.
const SWAP_SIDES = false;
// Hold the last reading through short stalls (a hidden tab, a dropped frame)
// before handing the face back to liveness; with the driver's 0.25 s
// crossfade, a lost face is fully back on liveness within 0.5 s.
const HOLD_SEC = 0.2;
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
  /** performance.now() of the last face detection: the body trackers skip that step so no step runs all three models. */
  lastDetectMs = -Infinity;
  private head: Quat4 | null = null;
  private headSeenMs = -Infinity;
  private lastVideoTime = -1;
  private generation = 0;
  private onChange: (state: FaceCameraState) => void;

  constructor(onChange: (state: FaceCameraState) => void = () => undefined) {
    this.onChange = onChange;
  }

  async start(): Promise<void> {
    if (this.state !== 'off' && this.state !== 'denied' && this.state !== 'unavailable') return;
    // A stop() while permission or the model is pending ends this start: it
    // releases whatever arrives late instead of switching the camera back on.
    const generation = ++this.generation;
    const cancelled = (): boolean => generation !== this.generation;
    this.setState('starting');
    if (!navigator.mediaDevices?.getUserMedia) {
      this.setState('unavailable');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 }, audio: false });
    } catch (error) {
      if (!cancelled()) this.setState((error as DOMException)?.name === 'NotAllowedError' ? 'denied' : 'unavailable');
      return;
    }
    if (cancelled()) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.stream = stream;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    this.video = video;
    try {
      await video.play();
      // Headless Chromium and many phones have no GPU delegate.
      let landmarker: FaceLandmarker;
      let delegate: 'GPU' | 'CPU' = 'GPU';
      try {
        if (cpuOnly()) throw new Error('CPU delegate requested');
        landmarker = await createLandmarker('GPU');
      } catch {
        if (cancelled()) return;
        landmarker = await createLandmarker('CPU');
        delegate = 'CPU';
      }
      if (cancelled()) {
        landmarker.close();
        return;
      }
      this.landmarker = landmarker;
      this.delegate = delegate;
      this.setState('no-face');
    } catch (error) {
      if (cancelled()) return;
      console.warn('Face tracking unavailable', error);
      this.stop('unavailable');
    }
  }

  /** The one camera element, for the pose and hand trackers: a second getUserMedia would open the camera twice. */
  get videoElement(): HTMLVideoElement | null {
    return this.video;
  }

  /** The head's rotation from the face model's transformation matrix, or null when the face was not seen recently. */
  headRotation(nowMs: number, maxAgeMs = HOLD_SEC * 1000): Quat4 | null {
    return nowMs - this.headSeenMs <= maxAgeMs ? this.head : null;
  }

  /**
   * The frame-stepped clip report: tracks a given video element (a clip, not a camera) with no pacing and no
   * getUserMedia. `detectNow` then runs the face model on the frame the video shows.
   */
  async startOnVideo(video: HTMLVideoElement): Promise<void> {
    const generation = ++this.generation;
    this.video = video;
    this.setState('starting');
    let landmarker: FaceLandmarker;
    try {
      if (cpuOnly()) throw new Error('CPU delegate requested');
      landmarker = await createLandmarker('GPU');
      this.delegate = 'GPU';
    } catch {
      landmarker = await createLandmarker('CPU');
      this.delegate = 'CPU';
    }
    if (generation !== this.generation) {
      landmarker.close();
      return;
    }
    this.landmarker = landmarker;
    this.setState('no-face');
  }

  detectNow(nowMs: number): void {
    if (this.landmarker && this.video) this.detect(this.landmarker, this.video, nowMs);
  }

  get active(): boolean {
    return this.state === 'starting' || this.state === 'no-face' || this.state === 'tracking';
  }

  stop(state: FaceCameraState = 'off'): void {
    this.generation += 1;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.landmarker?.close();
    this.landmarker = null;
    this.stream = null;
    this.video = null;
    this.last = null;
    this.head = null;
    this.setState(state);
  }

  /** The latest face, or null when no face has been seen for HOLD_SEC. */
  sample(nowMs: number, detect = true): FaceSample | null {
    const video = this.video;
    if (detect && this.landmarker && video && video.readyState >= 2 && nowMs - this.lastDetectMs >= DETECT_INTERVAL_MS && video.currentTime !== this.lastVideoTime) {
      this.lastDetectMs = nowMs;
      this.lastVideoTime = video.currentTime;
      this.detect(this.landmarker, video, nowMs);
    }
    if (nowMs - this.lastSeenMs > HOLD_SEC * 1000) {
      if (this.state === 'tracking') this.setState('no-face');
      return null;
    }
    return this.last;
  }

  private detect(landmarker: FaceLandmarker, video: HTMLVideoElement, nowMs: number): void {
    const result = landmarker.detectForVideo(video, nowMs);
    const categories = result.faceBlendshapes?.[0]?.categories;
    if (categories?.length) {
      const raw: Record<string, number> = {};
      for (const category of categories) raw[swapSides(category.categoryName)] = category.score;
      const weights = toCanonical('arkit', raw);
      this.last = { weights, gaze: gazeFromArkit(weights) };
      this.lastSeenMs = nowMs;
      this.setState('tracking');
    }
    const matrix = result.facialTransformationMatrixes?.[0]?.data;
    const head = matrix ? headRotationFromMatrix(matrix) : null;
    if (head) {
      this.head = head;
      this.headSeenMs = nowMs;
    }
  }

  private setState(state: FaceCameraState): void {
    if (this.state === state) return;
    this.state = state;
    this.onChange(state);
  }
}

/** `?mpDelegate=cpu` skips the GPU delegate (software-GL runs, such as the clip report, are faster on the CPU one). */
export function cpuOnly(): boolean {
  return new URLSearchParams(window.location.search).get('mpDelegate') === 'cpu';
}

async function createLandmarker(delegate: 'GPU' | 'CPU'): Promise<FaceLandmarker> {
  return FaceLandmarker.createFromOptions(
    MEDIAPIPE_WASM,
    {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true
    }
  );
}

function swapSides(name: string): string {
  if (!SWAP_SIDES) return name;
  if (name.endsWith('Left')) return `${name.slice(0, -4)}Right`;
  if (name.endsWith('Right')) return `${name.slice(0, -5)}Left`;
  return name;
}
