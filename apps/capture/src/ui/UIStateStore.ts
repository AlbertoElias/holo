import type { AppMode, UiViewModel } from '../types/contracts';

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
    faceCamera: 'off'
  };

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
    this.value = { ...this.value, recordingState, recordingMessage };
    this.emit();
  }

  publishMode(mode: AppMode): void {
    const controls =
      mode === 'desktop-third' || mode === 'desktop-first'
        ? 'Desktop: WASD + Space, hold C to crouch, V toggles 3rd/1st person, R to record, G picks up or puts down the object (Q/E turn it, Z/X tip it), hold T for the tray and press 1–5 to summon. VR: crouch with headset height and use the floating panel to record.'
        : mode === 'ar'
          ? 'AR: use Recenter AR to place the scene in front of you again.'
          : 'VR: hold a neutral standing or seated posture briefly on entry to fit your height. Choose Refit height after switching sitting/standing. Point at the floating panel and press select to record. R also works. Squeeze or pinch near the object to hold it. Hold left Y, or turn your left palm up, to open the tray; squeeze or pinch an item with the right hand to summon it.';
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
