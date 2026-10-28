import type { Handedness } from '@holoim/xr-ui-core';
import type { AppMode, UiViewModel } from '../types/contracts';
import { loadHandedness } from '@holoim/ui-dom';

/** How long a Halo action's notice stays (slice 5 build plan). */
const NOTICE_MS = 1500;

export class UIStateStore {
  private value: UiViewModel = {
    mode: 'desktop-third',
    controls: 'Loading controls...',
    loadState: 'loading',
    warning: null,
    recordingState: 'idle',
    recordingMessage: null,
    heightFit: { enabled: false, pending: false, eyeHeight: null },
    micPermission: 'pending',
    object: { status: 'none', name: null, message: null },
    tray: { names: [], loading: false, message: null },
    faceCamera: 'off',
    handedness: loadHandedness(),
    recordingElapsedMs: 0,
    xrEntry: { vr: 'unknown', ar: 'unknown' },
    notice: null
  };
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  private listeners = new Set<(state: UiViewModel) => void>();

  subscribe(listener: (state: UiViewModel) => void): () => void {
    this.listeners.add(listener);
    listener(this.value);
    return () => this.listeners.delete(listener);
  }

  setLoadState(loadState: UiViewModel['loadState'], warning: string | null): void {
    this.value = { ...this.value, loadState, warning };
    this.emit();
  }

  setRecordingState(recordingState: UiViewModel['recordingState'], recordingMessage: string | null = null): void {
    const recordingElapsedMs = recordingState === 'recording' && this.value.recordingState === 'recording' ? this.value.recordingElapsedMs : 0;
    this.value = { ...this.value, recordingState, recordingMessage, recordingElapsedMs };
    this.emit();
  }

  /** The take's running time; only whole seconds change what anyone sees. */
  setRecordingElapsed(ms: number): void {
    const whole = Math.max(0, Math.floor(ms / 1000) * 1000);
    if (this.value.recordingState !== 'recording' || whole === this.value.recordingElapsedMs) return;
    this.value = { ...this.value, recordingElapsedMs: whole };
    this.emit();
  }

  /** Says `text` on the status line for `ms`, replacing any notice still showing. */
  flashNotice(text: string, ms = NOTICE_MS): void {
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null;
      this.value = { ...this.value, notice: null };
      this.emit();
    }, ms);
    this.value = { ...this.value, notice: text };
    this.emit();
  }

  setHandedness(handedness: Handedness): void {
    if (this.value.handedness === handedness) return;
    this.value = { ...this.value, handedness };
    this.emit();
  }

  setXrEntry(xrEntry: UiViewModel['xrEntry']): void {
    if (this.value.xrEntry.vr === xrEntry.vr && this.value.xrEntry.ar === xrEntry.ar) return;
    this.value = { ...this.value, xrEntry };
    this.emit();
  }

  publishMode(mode: AppMode): void {
    const controls =
      mode === 'desktop-third' || mode === 'desktop-first'
        ? 'Desktop: WASD + Space, hold C to crouch, V toggles 3rd/1st person, R to record, G or a click picks up the object and lets go (moving, it is thrown; Q/E turn it, Z/X tip it), during a take hold T for the tray and press 1–5 to summon.'
        : mode === 'ar'
          ? 'AR: use Recenter AR to place the scene in front of you again.'
          : 'VR: hold a neutral standing or seated posture briefly on entry to fit your height. Choose Refit height after switching sitting/standing. Record with the glyph on your non-dominant wrist: touch it, or point at it and press select. R also works. Settings are on the panel ahead of you. Squeeze or pinch near the object to hold it. Hold the upper face button (Y or B) on your non-dominant controller, or turn that palm up, to open the tray; squeeze or pinch an item with your dominant hand to summon it.';
    this.value = { ...this.value, mode, controls };
    this.emit();
  }

  setHeightFit(heightFit: UiViewModel['heightFit']): void {
    const previous = this.value.heightFit;
    if (previous.enabled === heightFit.enabled && previous.pending === heightFit.pending && previous.eyeHeight === heightFit.eyeHeight) return;
    this.value = { ...this.value, heightFit };
    this.emit();
  }

  setMicPermission(micPermission: UiViewModel['micPermission']): void {
    this.value = { ...this.value, micPermission };
    this.emit();
  }

  setObjectState(object: UiViewModel['object']): void {
    this.value = { ...this.value, object };
    this.emit();
  }

  setTrayState(tray: UiViewModel['tray']): void {
    this.value = { ...this.value, tray };
    this.emit();
  }

  setFaceCamera(faceCamera: UiViewModel['faceCamera']): void {
    if (this.value.faceCamera === faceCamera) return;
    this.value = { ...this.value, faceCamera };
    this.emit();
  }

  getState(): UiViewModel {
    return this.value;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.value);
    }
  }
}
