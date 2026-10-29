import type * as THREE from 'three';
import type { InputRecordingSession } from '../debug/inputRecording';
import { nextFrame, withTimeout } from '../shared/async';
import type { UIStateStore } from '../ui/UIStateStore';
import { AudioRecorder } from './AudioRecorder';
import { AvatarRecorder } from './AvatarRecorder';
import { CameraRecorder } from './CameraRecorder';
import { testHooks } from '../testHooks';

interface RecordingSessionDeps {
  ui: UIStateStore;
  renderer: THREE.WebGLRenderer;
  getAvatar: () => { avatar: THREE.Object3D | undefined; worldModel: THREE.Object3D | undefined };
  // Starting a recording locks avatar size; an in-progress height fit stops.
  onSizeLocked: () => void;
  /** Before the first frame of a take: summoned objects from the last take leave (PRD-045). */
  onTakeStart: () => void;
  /** The AR session authors a camera take (docs/features/archive/ar-recording.md): decided once per session. */
  isCameraAuthor: () => boolean;
  /**
   * Why Record is refused in this session, or null: with camera takes on, an
   * AR session that is not a phone (a headset in passthrough) spectates and
   * records nothing.
   */
  recordRefusal: () => string | null;
  /** The set's placement has finished its entry frames. */
  isPlacementSettled: () => boolean;
  /** The group whose local frame a camera take is recorded in. */
  setFrame: THREE.Object3D;
}

/** What a take records: a performer (avatar, today) or the phone as a camera. */
export type TakeKind = 'performer' | 'camera';

/**
 * A recording: avatar frames sampled once per simulation step, microphone
 * audio, and (in development) the raw headset input behind it. Avatar size
 * stays locked from start until the export finishes.
 */
const EXPORT_TIMEOUT_MS = 60_000;
const NOTICE_MS = 4000;

export class RecordingSession {
  readonly recorder = new AvatarRecorder();
  readonly cameraRecorder = new CameraRecorder();
  /** Decided at start; a take keeps its kind until it has exported. */
  private takeKind: TakeKind = 'performer';
  private readonly audio = new AudioRecorder();
  /** A camera take admitted and waiting for its microphone; cancelled by a hidden page or the session's end. */
  private startingCamera: { cancelled: boolean } | null = null;
  private inputRecording: InputRecordingSession | null = null;
  private sizeLocked = false;
  // Checks re-export the last take to compare bytes (chrome visible or not);
  // off in production, where a take's samples are freed once it downloads.
  private retainLastTake = false;
  private lastTake: { avatar: THREE.Object3D; worldModel: THREE.Object3D | undefined; audioData: { buffer: ArrayBuffer; mimeType: string } | undefined } | null = null;

  constructor(private readonly deps: RecordingSessionDeps) {
    // A hidden page is a mid-take exit: stop and export it as Stop does.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.endCameraTake();
      });
    }
  }

  get kind(): TakeKind {
    return this.takeKind;
  }

  /**
   * In the AR entry tap (user activation): asks for the microphone and keeps
   * it open for camera takes. Never awaited before the session request.
   */
  holdMicForArTake(): void {
    this.audio.holdStream().then((held) => {
      this.deps.ui.setMicPermission(held ? 'granted' : this.audio.getPermissionState());
    }).catch(() => {
      this.deps.ui.setMicPermission('denied');
    });
  }

  isMicHeld(): boolean {
    return this.audio.isHoldingStream();
  }

  /** The session is not (or no longer) a camera author: the held microphone goes. */
  releaseHeldMic(): void {
    this.audio.releaseHeldStream();
  }

  /**
   * The XR session ended, or the page hid: a camera take in progress stops and
   * exports as Stop does, and one still waiting for its microphone never begins.
   */
  endCameraTake(): void {
    if (this.startingCamera) this.startingCamera.cancelled = true;
    if (this.takeKind !== 'camera') return;
    if (this.deps.ui.getState().recordingState !== 'recording') return;
    void this.stopAndExportCamera();
  }

  /** A take is starting, recording or exporting: placement must not move under it. */
  isTakeBusy(): boolean {
    return this.startingCamera !== null || this.deps.ui.getState().recordingState !== 'idle';
  }

  get isSizeLocked(): boolean {
    return this.sizeLocked;
  }

  /** Asks early, before VR entry, where permission dialogs are awkward; recording works without it. */
  requestMicPermission(): void {
    this.audio.requestMicPermission().then((granted) => {
      this.deps.ui.setMicPermission(granted ? 'granted' : 'denied');
    }).catch(() => {
      this.deps.ui.setMicPermission('denied');
    });
  }

  toggle(): void {
    const state = this.deps.ui.getState();
    if (state.recordingState === 'exporting' || (this.sizeLocked && state.recordingState === 'idle')) return;
    if (state.recordingState === 'recording') void this.stopAndExport();
    else void this.start();
  }

  /** Keep the last take's samples after it downloads, for `reexportLastTake`. */
  setRetainLastTake(retain: boolean): void {
    this.retainLastTake = retain;
    if (!retain) this.lastTake = null;
  }

  /**
   * The last take exported again from the same samples, against the scene as
   * it is now; with `trim` false, without dropping what no viewer draws.
   */
  async reexportLastTake({ trim = true }: { trim?: boolean } = {}): Promise<ArrayBuffer | null> {
    const take = this.lastTake;
    if (!take) return null;
    this.recorder.setTrimHidden(trim);
    try {
      const blob = await this.recorder.exportToGlbBlob(take.avatar, take.worldModel, take.audioData);
      return await blob.arrayBuffer();
    } finally {
      this.recorder.setTrimHidden(true);
    }
  }

  /** Raw device input for this XR frame; called inside the frame's callback. */
  recordInputFrame(frame: XRFrame): void {
    this.inputRecording?.recordFrame(frame);
  }

  private async start(): Promise<void> {
    const refusal = this.deps.recordRefusal();
    if (refusal) {
      this.deps.ui.flashNotice(refusal, NOTICE_MS);
      return;
    }
    if (this.deps.isCameraAuthor()) {
      await this.startCamera();
      return;
    }
    this.takeKind = 'performer';
    this.sizeLocked = true;
    this.deps.onSizeLocked();
    this.lastTake = null;
    this.recorder.clear();
    this.deps.onTakeStart();
    this.recorder.setEnabled(true);
    await this.startInputRecording();
    try {
      await this.audio.start();
    } catch {
      // Audio capture is best-effort; continue without it
    } finally {
      this.deps.ui.setMicPermission(this.audio.getPermissionState());
    }
    this.deps.ui.setRecordingState('recording');
  }

  private async startCamera(): Promise<void> {
    const ui = this.deps.ui;
    const { worldModel } = this.deps.getAvatar();
    if (this.startingCamera) return;
    if (!this.deps.isPlacementSettled()) {
      ui.flashNotice('Wait for the set to settle before recording.', NOTICE_MS);
      return;
    }
    // Cleared before the reach test, which keeps where the camera stood for the take's bubble.
    this.cameraRecorder.clear();
    if (!worldModel || !this.cameraRecorder.hasSetInReach(this.deps.setFrame, this.deps.renderer.xr.getCamera(), worldModel)) {
      ui.flashNotice('Nothing to record: no part of the set is near.', NOTICE_MS);
      return;
    }
    this.takeKind = 'camera';
    this.sizeLocked = true;
    this.deps.onSizeLocked();
    this.lastTake = null;
    this.deps.onTakeStart();
    this.cameraRecorder.setEnabled(true);
    const start = { cancelled: false };
    this.startingCamera = start;
    try {
      await this.audio.start();
    } catch {
      // Audio capture is best-effort; the take is silent
    } finally {
      ui.setMicPermission(this.audio.getPermissionState());
      this.startingCamera = null;
    }
    if (start.cancelled || !this.deps.isCameraAuthor() || document.visibilityState === 'hidden') {
      // The session ended, or the page hid (even if it came back), while the
      // microphone was starting: the take never began, so nothing is exported.
      this.cameraRecorder.setEnabled(false);
      this.cameraRecorder.clear();
      if (this.audio.isRecording()) await this.audio.stop().catch(() => undefined);
      this.sizeLocked = false;
      return;
    }
    if (!this.audio.isRecording()) ui.flashNotice('No microphone: this take is silent.', NOTICE_MS);
    ui.setRecordingState('recording');
  }

  private async stopAndExportCamera(): Promise<void> {
    const ui = this.deps.ui;
    ui.setRecordingState('exporting', 'Exporting...');
    this.cameraRecorder.setEnabled(false);
    try {
      const { worldModel } = this.deps.getAvatar();
      if (!worldModel) throw new Error('No set to export');
      const baseName = `camera-recording-${Date.now()}`;
      let audioData: { buffer: ArrayBuffer; mimeType: string } | undefined;
      if (this.audio.isRecording()) {
        try {
          audioData = await this.audio.stop();
        } catch {
          // Audio export is best-effort; continue without it
        }
      }
      await nextFrame();
      const blob = await withTimeout(this.cameraRecorder.exportToGlbBlob(this.deps.setFrame, worldModel, audioData), EXPORT_TIMEOUT_MS, 'GLB export timed out after 60s');
      this.download(blob, `${baseName}.glb`);
      this.cameraRecorder.clear();
      ui.setRecordingState('idle');
    } catch (err) {
      console.error(err);
      ui.setRecordingState('idle', (err as Error).message);
    } finally {
      this.sizeLocked = false;
    }
  }

  private download(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private async stopAndExport(): Promise<void> {
    if (this.takeKind === 'camera') {
      await this.stopAndExportCamera();
      return;
    }
    const ui = this.deps.ui;
    ui.setRecordingState('exporting', 'Exporting...');
    this.recorder.setEnabled(false);

    try {
      const { avatar, worldModel } = this.deps.getAvatar();
      if (!avatar) throw new Error('No avatar to export');
      const baseName = `avatar-recording-${Date.now()}`;
      // Save the headset input first: nothing below may stall it.
      await this.finishInputRecording(baseName);

      let audioData: { buffer: ArrayBuffer; mimeType: string } | undefined;
      if (this.audio.isRecording()) {
        try {
          audioData = await this.audio.stop();
        } catch {
          // Audio export is best-effort; continue without it
        }
      }

      // Frames stop when the headset sleeps or the session ends; an
      // unbounded wait here once froze the UI in "exporting" (B-010).
      await nextFrame();
      const blob = await withTimeout(this.recorder.exportToGlbBlob(avatar, worldModel, audioData), EXPORT_TIMEOUT_MS, 'GLB export timed out after 60s');
      this.download(blob, `${baseName}.glb`);
      if (this.retainLastTake) this.lastTake = { avatar, worldModel, audioData };
      else this.recorder.clear();
      ui.setRecordingState('idle');
    } catch (err) {
      console.error(err);
      ui.setRecordingState('idle', (err as Error).message);
    } finally {
      this.sizeLocked = false;
    }
  }

  // Development and test builds also keep the raw headset input behind each capture
  // recording so it can be replayed as a test fixture.
  private async startInputRecording(): Promise<void> {
    this.inputRecording = null;
    const session = this.deps.renderer.xr.getSession();
    const refSpace = this.deps.renderer.xr.getReferenceSpace();
    if (!testHooks || !session || !refSpace) return;
    try {
      const { InputRecordingSession } = await import('../debug/inputRecording');
      this.inputRecording = await InputRecordingSession.start(session, refSpace);
    } catch (error) {
      console.warn('Input recording unavailable.', error);
    }
  }

  private async finishInputRecording(baseName: string): Promise<void> {
    const inputRecording = this.inputRecording;
    this.inputRecording = null;
    if (!inputRecording) return;
    try {
      const { saveInputRecording } = await import('../debug/inputRecording');
      const savedTo = await saveInputRecording(inputRecording.finish(), baseName);
      this.deps.ui.setRecordingState('exporting', `Saved headset input to ${savedTo}`);
    } catch (error) {
      console.warn('Saving input recording failed.', error);
    }
  }
}
