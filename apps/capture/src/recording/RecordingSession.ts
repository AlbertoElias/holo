import type * as THREE from 'three';
import type { InputRecordingSession } from '../debug/inputRecording';
import { nextFrame, withTimeout } from '../shared/async';
import type { UIStateStore } from '../ui/UIStateStore';
import { AudioRecorder } from './AudioRecorder';
import { AvatarRecorder } from './AvatarRecorder';

interface RecordingSessionDeps {
  ui: UIStateStore;
  renderer: THREE.WebGLRenderer;
  getAvatar: () => { avatar: THREE.Object3D | undefined; worldModel: THREE.Object3D | undefined };
  // Starting a recording locks avatar size; an in-progress height fit stops.
  onSizeLocked: () => void;
}

/**
 * A recording: avatar frames sampled once per simulation step, microphone
 * audio, and (in development) the raw headset input behind it. Avatar size
 * stays locked from start until the export finishes.
 */
const EXPORT_TIMEOUT_MS = 60_000;

export class RecordingSession {
  readonly recorder = new AvatarRecorder();
  private readonly audio = new AudioRecorder();
  private inputRecording: InputRecordingSession | null = null;
  private sizeLocked = false;

  constructor(private readonly deps: RecordingSessionDeps) {}

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

  /** Raw device input for this XR frame; called inside the frame's callback. */
  recordInputFrame(frame: XRFrame): void {
    this.inputRecording?.recordFrame(frame);
  }

  private async start(): Promise<void> {
    this.sizeLocked = true;
    this.deps.onSizeLocked();
    this.recorder.clear();
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

  private async stopAndExport(): Promise<void> {
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
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${baseName}.glb`;
      anchor.click();
      URL.revokeObjectURL(url);
      this.recorder.clear();
      ui.setRecordingState('idle');
    } catch (err) {
      console.error(err);
      ui.setRecordingState('idle', (err as Error).message);
    } finally {
      this.sizeLocked = false;
    }
  }

  // Development builds also keep the raw headset input behind each capture
  // recording so it can be replayed as a test fixture.
  private async startInputRecording(): Promise<void> {
    this.inputRecording = null;
    const session = this.deps.renderer.xr.getSession();
    const refSpace = this.deps.renderer.xr.getReferenceSpace();
    if (!import.meta.env.DEV || !session || !refSpace) return;
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
