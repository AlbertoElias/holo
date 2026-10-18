import type { AppMode, UiViewModel } from '../types/contracts';

export class UIStateStore {
  private value: UiViewModel = {
    mode: 'desktop-third',
    controls: 'Loading controls...',
    loadState: 'loading',
    warning: null,
    recordingState: 'idle',
    recordingMessage: null,
    micPermission: 'pending'
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
        ? 'Desktop: WASD + Space, hold C to crouch, V toggles 3rd/1st person, R to record. VR: crouch with headset height and use the floating panel to record.'
        : 'VR: hold a neutral standing or seated posture briefly on entry to fit your height. Re-enter VR to refit. Point at the floating panel and press select to record. R also works.';
    this.value = { ...this.value, mode, controls };
    this.emit();
  }

  setMicPermission(micPermission: UiViewModel['micPermission']): void {
    this.value = { ...this.value, micPermission };
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
