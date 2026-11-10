import { HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import { cpuOnly, MEDIAPIPE_WASM } from '../face/WebcamFace';
import type { HandLandmarks, LandmarkFrame, PoseLandmarks, Quat4 } from './types';

// This module is imported only when the camera starts (`?input=camera`), so a session that never starts it
// fetches neither model. The models run on the video element the face camera already opened.
const MODEL_BASE = `${import.meta.env.BASE_URL}mediapipe/`;
const POSE_MODEL_URL = `${MODEL_BASE}pose_landmarker_full.task`;
const HAND_MODEL_URL = `${MODEL_BASE}hand_landmarker.task`;
/** A detection older than this no longer describes the author and is left out of the frame. */
const STALE_MS = 300;
const RATE_WINDOW_MS = 2000;

export interface TrackerFrameInfo {
  /** Which model produced fresh data in this frame. */
  /** `all`: the frame-stepped report ran both models on one clip frame. */
  ran: 'pose' | 'hands' | 'all';
  nowMs: number;
}

export interface TrackerStats {
  delegate: 'GPU' | 'CPU';
  /** Landmark frames fed per second over the last two seconds, and how many of them each model made. */
  feedHz: number;
  poseHz: number;
  handHz: number;
  frames: number;
}

/**
 * Pose and hand landmarks from a live video, fused with the face model's head rotation into the landmark frames
 * the camera source reads. Detection is staggered by the caller (face, pose, hands on successive steps, so three
 * models never share a frame); this runs the pose or the hand model, alternating, on the steps it is given.
 */
export class BodycamTracker {
  private pose: { at: number; value: PoseLandmarks | null } = { at: -Infinity, value: null };
  private hands: { at: number; value: HandLandmarks[] } = { at: -Infinity, value: [] };
  private nextModel: 'pose' | 'hands' = 'pose';
  private lastPoseVideoTime = -1;
  private lastHandVideoTime = -1;
  private readonly poseRuns: number[] = [];
  private readonly handRuns: number[] = [];
  private frames = 0;
  private closed = false;

  private constructor(
    private readonly video: HTMLVideoElement,
    private readonly poseLandmarker: PoseLandmarker,
    private readonly handLandmarker: HandLandmarker,
    readonly delegate: 'GPU' | 'CPU',
    private readonly onFrame: (frame: LandmarkFrame, info: TrackerFrameInfo) => void
  ) {}

  /** Loads both models (GPU, then CPU as a pair); null when `cancelled()` turns true meanwhile. */
  static async create(video: HTMLVideoElement, onFrame: (frame: LandmarkFrame, info: TrackerFrameInfo) => void, cancelled: () => boolean): Promise<BodycamTracker | null> {
    const make = async (delegate: 'GPU' | 'CPU') => {
      const pose = await PoseLandmarker.createFromOptions(MEDIAPIPE_WASM, {
        baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate },
        runningMode: 'VIDEO',
        numPoses: 1
      });
      try {
        const hands = await HandLandmarker.createFromOptions(MEDIAPIPE_WASM, {
          baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate },
          runningMode: 'VIDEO',
          numHands: 2
        });
        return { pose, hands, delegate };
      } catch (error) {
        pose.close();
        throw error;
      }
    };
    let made: Awaited<ReturnType<typeof make>>;
    try {
      if (cpuOnly()) throw new Error('CPU delegate requested');
      made = await make('GPU');
    } catch {
      if (cancelled()) return null;
      made = await make('CPU');
    }
    if (cancelled()) {
      made.pose.close();
      made.hands.close();
      return null;
    }
    return new BodycamTracker(video, made.pose, made.hands, made.delegate, onFrame);
  }

  /**
   * Called once per simulation step with the face model's head rotation (or null). Runs at most one model when
   * the face model did not run this step, and feeds a frame when it did.
   */
  step(nowMs: number, head: Quat4 | null, faceRanThisStep: boolean): void {
    const video = this.video;
    if (this.closed || faceRanThisStep || video.readyState < 2) return;
    const order: Array<'pose' | 'hands'> = this.nextModel === 'pose' ? ['pose', 'hands'] : ['hands', 'pose'];
    for (const model of order) {
      const seen = model === 'pose' ? this.lastPoseVideoTime : this.lastHandVideoTime;
      if (video.currentTime === seen) continue;
      if (model === 'pose') {
        this.lastPoseVideoTime = video.currentTime;
        this.runPose(nowMs);
        this.poseRuns.push(nowMs);
      } else {
        this.lastHandVideoTime = video.currentTime;
        this.runHands(nowMs);
        this.handRuns.push(nowMs);
      }
      this.nextModel = model === 'pose' ? 'hands' : 'pose';
      this.frames += 1;
      this.onFrame(
        {
          pose: nowMs - this.pose.at <= STALE_MS ? this.pose.value : null,
          hands: nowMs - this.hands.at <= STALE_MS ? this.hands.value : [],
          head
        },
        { ran: model, nowMs }
      );
      return;
    }
  }

  /** The frame-stepped report: both models on the frame the video shows now, then one fused frame fed. */
  runFrame(nowMs: number, head: Quat4 | null): void {
    if (this.closed) return;
    this.runPose(nowMs);
    this.poseRuns.push(nowMs);
    this.runHands(nowMs);
    this.handRuns.push(nowMs);
    this.frames += 1;
    this.onFrame({ pose: this.pose.value, hands: this.hands.value, head }, { ran: 'all', nowMs });
  }

  stats(nowMs: number): TrackerStats {
    const recent = (runs: number[]): number => {
      while (runs.length > 0 && nowMs - runs[0]! > RATE_WINDOW_MS) runs.shift();
      return runs.length / (RATE_WINDOW_MS / 1000);
    };
    const poseHz = recent(this.poseRuns);
    const handHz = recent(this.handRuns);
    return { delegate: this.delegate, feedHz: poseHz + handHz, poseHz, handHz, frames: this.frames };
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.poseLandmarker.close();
    this.handLandmarker.close();
  }

  private runPose(nowMs: number): void {
    const result = this.poseLandmarker.detectForVideo(this.video, nowMs);
    const world = result.worldLandmarks[0];
    const image = result.landmarks[0];
    this.pose = {
      at: nowMs,
      value: world && image ? { world: world.map((p) => ({ x: p.x, y: p.y, z: p.z })), image: image.map((p) => ({ x: p.x, y: p.y })) } : null
    };
  }

  private runHands(nowMs: number): void {
    const result = this.handLandmarker.detectForVideo(this.video, nowMs);
    const hands: HandLandmarks[] = [];
    for (const [i, world] of result.worldLandmarks.entries()) {
      const image = result.landmarks[i];
      if (!image?.[0] || world.length < 21) continue;
      hands.push({
        world: world.map((p) => ({ x: p.x, y: p.y, z: p.z })),
        imageWrist: { x: image[0].x, y: image[0].y },
        ...(result.handedness[i]?.[0]?.categoryName ? { label: result.handedness[i]![0]!.categoryName } : {})
      });
    }
    this.hands = { at: nowMs, value: hands };
  }
}
