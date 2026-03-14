import type { UIStateStore } from './UIStateStore';

export class DesktopHud {
  private unsubscribe: (() => void) | undefined;
  private recordBtn: HTMLButtonElement | null = null;
  private recordingUi: HTMLElement | null = null;
  private readonly boundOnRecordClick: () => void;

  constructor(
    private readonly statusElement: HTMLElement,
    private readonly store: UIStateStore,
    onRecordToggle: () => void
  ) {
    this.boundOnRecordClick = () => onRecordToggle();
  }

  init(): void {
    this.recordingUi = document.getElementById('recording-ui');
    this.recordBtn = document.getElementById('record-btn') as HTMLButtonElement | null;

    if (this.recordBtn) {
      this.recordBtn.addEventListener('click', this.boundOnRecordClick);
    }

    this.unsubscribe = this.store.subscribe((state) => {
      if (state.loadState === 'loading') {
        this.statusElement.textContent = 'Loading scene...';
        this.setRecordingUiVisible(false);
        return;
      }

      if (state.loadState === 'error') {
        this.statusElement.textContent = state.warning ?? 'Failed to load scene/avatar assets.';
        this.setRecordingUiVisible(false);
        return;
      }

      if (state.loadState === 'warning') {
        this.statusElement.textContent = state.warning ?? 'Loaded with warnings: spawn/physics setup incomplete.';
        this.setRecordingUiVisible(true);
      } else {
        this.statusElement.textContent = `Loaded. ${state.controls}`;
        this.setRecordingUiVisible(true);
      }

      this.updateRecordButton(state.recordingState, state.recordingMessage);
    });
  }

  private setRecordingUiVisible(visible: boolean): void {
    if (this.recordingUi) {
      this.recordingUi.style.display = visible ? 'flex' : 'none';
    }
  }

  private updateRecordButton(recordingState: 'idle' | 'recording' | 'exporting', message: string | null): void {
    if (!this.recordBtn) return;

    const isRecording = recordingState === 'recording';
    const isExporting = recordingState === 'exporting';

    this.recordBtn.classList.toggle('recording', isRecording);
    this.recordBtn.disabled = isExporting;

    if (isExporting) {
      this.recordBtn.textContent = message ?? 'Exporting...';
    } else if (isRecording) {
      this.recordBtn.textContent = 'Stop Recording';
    } else {
      this.recordBtn.textContent = 'Start Recording';
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    if (this.recordBtn) {
      this.recordBtn.removeEventListener('click', this.boundOnRecordClick);
    }
    this.recordBtn = null;
    this.recordingUi = null;
  }
}
