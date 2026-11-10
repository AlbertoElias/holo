import * as THREE from 'three';
import { FACE_CHANNELS, MAX_PITCH, type FaceChannel } from '@holoim/avatar-face';
import { type FaceRigBones, FaceRig, type FaceBindingReport } from './FaceRig';
import type { FaceCameraState, FaceExpressionSource, FaceGaze, FaceGazeSource, FaceSample, FaceWeights } from './faceTypes';
import { LivenessFace } from './LivenessFace';
import { VoiceLevel } from './VoiceLevel';
import { WebcamFace } from './WebcamFace';
import { XrGaze } from './XrGaze';
import type { BodycamSource } from '../bodycam/BodycamSource';
import type { BodycamTracker, TrackerFrameInfo, TrackerStats } from '../bodycam/BodycamTracker';
import type { LandmarkFrame } from '../bodycam/types';

/** Reads each landmark frame the tracker feeds (the clip report taps it). */
export type BodycamTap = (frame: LandmarkFrame, info: TrackerFrameInfo) => void;

// A change of source (a face entering or leaving the camera, automation
// starting) crossfades instead of popping.
const CROSSFADE_SEC = 0.25;
// Looking down drops the upper lids a little, as real lids follow the eyes.
const LID_FOLLOW = 0.3;

export interface FaceSnapshot {
  binding: FaceBindingReport | null;
  expressionSource: FaceExpressionSource;
  gazeSource: FaceGazeSource;
  camera: FaceCameraState;
  cameraDelegate: 'GPU' | 'CPU' | null;
  weights: FaceWeights;
  influences: Record<string, number>;
  gaze: { left: { yaw: number; pitch: number } | null; right: { yaw: number; pitch: number } | null };
}

export interface FaceStepInput {
  timeSec: number;
  deltaSec: number;
  vrActive: boolean;
  micGranted: boolean;
}

/**
 * Chooses the face each step, by priority per part: automation (replayed
 * fixtures), then the webcam, then liveness for the expression; automation,
 * webcam, WebXR eye gaze, then liveness for the gaze. Writes the avatar's
 * morph weights and eye bones, after the body pose and before the recorder.
 */
export class FaceDriver {
  readonly webcam: WebcamFace;
  readonly xrGaze: XrGaze;
  private rig: FaceRig | null = null;
  private readonly liveness = new LivenessFace();
  private readonly voice = new VoiceLevel();
  private automation: FaceSample | null = null;
  private expressionSource: FaceExpressionSource = 'liveness';
  private gazeSource: FaceGazeSource = 'liveness';
  private output: FaceWeights = {};
  private outputGaze: FaceGaze = { left: { yaw: 0, pitch: 0 }, right: { yaw: 0, pitch: 0 } };
  private expressionFade = { from: {} as FaceWeights, startedAt: -Infinity };
  private gazeFade = { from: this.outputGaze, startedAt: -Infinity };
  private readonly lookPoint = new THREE.Vector3();
  private tracker: BodycamTracker | null = null;
  private trackerGeneration = 0;
  private tap: BodycamTap | null = null;
  private turn = 0;
  private stepped: HTMLVideoElement | null = null;

  /** `bodycam` is the camera source of a page opened with `?input=camera`; without it the camera drives the face only. */
  constructor(rig: THREE.Object3D, onCameraState: (state: FaceCameraState) => void, private readonly bodycam?: BodycamSource) {
    this.webcam = new WebcamFace(onCameraState);
    this.xrGaze = new XrGaze(rig);
  }

  attach(avatar: THREE.Object3D, bones?: FaceRigBones): void {
    this.rig = new FaceRig(avatar, bones);
  }

  /** Automation: a full face (channels it omits are 0), or null to release. */
  setAutomationInput(sample: FaceSample | null): void {
    this.automation = sample;
  }

  toggleCamera(): void {
    if (this.webcam.active) {
      this.stopBodycam();
      this.webcam.stop();
    } else void this.startCamera();
  }

  /** Body tracking's rates and delegate, or null while it is not running. */
  bodycamStats(): TrackerStats | null {
    return this.tracker?.stats(performance.now()) ?? null;
  }

  setBodycamTap(tap: BodycamTap | null): void {
    this.tap = tap;
  }

  private async startCamera(): Promise<void> {
    await this.webcam.start();
    const source = this.bodycam;
    const video = this.webcam.videoElement;
    if (!source?.enabled || !video || !this.webcam.active) return;
    const generation = ++this.trackerGeneration;
    try {
      // Loaded only now: a session that never starts the camera fetches neither pose nor hand model.
      const { BodycamTracker: Tracker } = await import('../bodycam/BodycamTracker');
      const tracker = await Tracker.create(
        video,
        (frame, info) => {
          source.feed(frame);
          this.tap?.(frame, info);
        },
        () => generation !== this.trackerGeneration || !this.webcam.active
      );
      if (!tracker) return;
      this.tracker = tracker;
    } catch (error) {
      if (generation === this.trackerGeneration) console.warn('Body tracking unavailable', error);
    }
  }

  /** Frame-stepped clip report (see `__bodycamSteppedStart`): the clip stands in for the camera. */
  async startStepped(url: string): Promise<{ durationSec: number; width: number; height: number; delegate: 'GPU' | 'CPU'; faceDelegate: 'GPU' | 'CPU' | null }> {
    const source = this.bodycam;
    if (!source?.enabled) throw new Error('frame-stepped tracking needs ?input=camera');
    const blob = await (await fetch(url)).blob();
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    const loaded = new Promise<void>((resolve, reject) => {
      video.addEventListener('loadeddata', () => resolve(), { once: true });
      video.addEventListener('error', () => reject(new Error('the page cannot decode the clip')), { once: true });
    });
    video.src = URL.createObjectURL(blob);
    await loaded;
    this.stepped = video;
    await this.webcam.startOnVideo(video);
    const { BodycamTracker: Tracker } = await import('../bodycam/BodycamTracker');
    const tracker = await Tracker.create(
      video,
      (frame, info) => {
        source.feed(frame);
        this.tap?.(frame, info);
      },
      () => false
    );
    if (!tracker) throw new Error('tracker did not start');
    this.tracker = tracker;
    return { durationSec: video.duration, width: video.videoWidth, height: video.videoHeight, delegate: tracker.delegate, faceDelegate: this.webcam.delegate };
  }

  async steppedFrame(index: number, fps: number): Promise<void> {
    const video = this.stepped;
    if (!video || !this.tracker) throw new Error('frame-stepped tracking is not started');
    const seeked = new Promise<void>((resolve) => video.addEventListener('seeked', () => resolve(), { once: true }));
    video.currentTime = (index + 0.5) / fps;
    await seeked;
    // Let the decoded frame be presented before the models read it.
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(done);
      setTimeout(done, 150);
    });
    const nowMs = ((index + 1) * 1000) / fps;
    this.webcam.detectNow(nowMs);
    this.tracker.runFrame(nowMs, this.webcam.headRotation(nowMs, 0));
  }

  private stopBodycam(): void {
    this.stepped = null;
    this.trackerGeneration += 1;
    this.tracker?.stop();
    this.tracker = null;
    this.bodycam?.release();
  }

  update(input: FaceStepInput): void {
    // The camera cannot see a face under a headset: release it on entering VR.
    if (input.vrActive && this.webcam.active) {
      this.stopBodycam();
      this.webcam.stop();
    }
    if (this.tracker && !this.webcam.active) this.stopBodycam();
    const now = performance.now();
    // With body tracking on, steps rotate face, pose, hands: one model per step, never all three on one frame,
    // whatever the frame rate (a pacing by time alone starves the body models when steps are slow).
    const faceTurn = !this.tracker || this.turn++ % 3 === 0;
    const camera = input.vrActive ? null : this.webcam.sample(now, faceTurn && !this.stepped);
    if (this.tracker && !faceTurn && !this.stepped) this.tracker.step(now, this.webcam.headRotation(now), false);
    const rig = this.rig;
    if (!rig?.hasFace) return;
    if (input.micGranted) void this.voice.start();

    const live = this.liveness.sample(input.timeSec, input.deltaSec, this.automation || camera ? 0 : this.voice.read());

    const expression: [FaceExpressionSource, FaceWeights] = this.automation
      ? ['automation', this.automation.weights]
      : camera
        ? ['webcam', camera.weights]
        : ['liveness', live.weights];
    let gaze: [FaceGazeSource, FaceGaze];
    if (this.automation?.gaze) gaze = ['automation', this.automation.gaze];
    else if (camera?.gaze) gaze = ['webcam', camera.gaze];
    else {
      const point = input.vrActive ? this.xrGaze.lookPoint(this.lookPoint) : null;
      const xr = point ? rig.gazeTowardPoint(point) : null;
      gaze = xr ? ['xr-gaze', xr] : ['liveness', live.gaze];
    }

    if (expression[0] !== this.expressionSource) {
      this.expressionFade = { from: { ...this.output }, startedAt: input.timeSec };
      this.expressionSource = expression[0];
    }
    if (gaze[0] !== this.gazeSource) {
      this.gazeFade = { from: cloneGaze(this.outputGaze), startedAt: input.timeSec };
      this.gazeSource = gaze[0];
    }
    const expressionT = fade(input.timeSec - this.expressionFade.startedAt);
    const gazeT = fade(input.timeSec - this.gazeFade.startedAt);

    const weights: FaceWeights = {};
    for (const channel of FACE_CHANNELS) {
      const value = lerp(this.expressionFade.from[channel] ?? 0, expression[1][channel] ?? 0, expressionT);
      if (value > 1e-4) weights[channel] = value;
    }
    const nextGaze: FaceGaze = {
      left: lerpGaze(this.gazeFade.from.left, gaze[1].left, gazeT),
      right: lerpGaze(this.gazeFade.from.right, gaze[1].right, gazeT)
    };
    this.output = weights;
    this.outputGaze = nextGaze;

    rig.apply(withLidFollow(weights, nextGaze), nextGaze);
  }

  snapshot(): FaceSnapshot {
    return {
      binding: this.rig?.report() ?? null,
      expressionSource: this.expressionSource,
      gazeSource: this.gazeSource,
      camera: this.webcam.state,
      cameraDelegate: this.webcam.delegate,
      weights: { ...this.output },
      influences: this.rig?.sampleInfluences() ?? {},
      gaze: this.rig?.sampleGaze() ?? { left: null, right: null }
    };
  }
}

function fade(elapsed: number): number {
  const t = Math.min(1, Math.max(0, elapsed / CROSSFADE_SEC));
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpGaze(a: { yaw: number; pitch: number }, b: { yaw: number; pitch: number }, t: number): { yaw: number; pitch: number } {
  return { yaw: lerp(a.yaw, b.yaw, t), pitch: lerp(a.pitch, b.pitch, t) };
}

function cloneGaze(gaze: FaceGaze): FaceGaze {
  return { left: { ...gaze.left }, right: { ...gaze.right } };
}

function withLidFollow(weights: FaceWeights, gaze: FaceGaze): FaceWeights {
  const out = { ...weights };
  for (const [side, channel] of [['left', 'eyeBlinkLeft'], ['right', 'eyeBlinkRight']] as const) {
    const down = Math.max(0, -gaze[side].pitch / MAX_PITCH);
    if (down > 0) out[channel as FaceChannel] = Math.min(1, (out[channel] ?? 0) + down * LID_FOLLOW);
  }
  return out;
}
