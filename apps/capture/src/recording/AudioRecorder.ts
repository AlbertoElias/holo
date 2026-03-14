const PREFERRED_MIME_TYPE = 'audio/webm;codecs=opus';
const FALLBACK_MIME_TYPE = 'audio/webm';

export class AudioRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private recording = false;
  private permissionState: 'pending' | 'granted' | 'denied' = 'pending';
  private resolvedMimeType = '';

  async requestMicPermission(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1 }
      });
      this.releaseStream(stream);
      this.permissionState = 'granted';
      return true;
    } catch {
      this.permissionState = 'denied';
      return false;
    }
  }

  async start(): Promise<boolean> {
    if (this.recording) return true;
    const stream = await this.getOrCreateStream();
    if (!stream) return false;

    this.chunks = [];

    const mimeType = MediaRecorder.isTypeSupported(PREFERRED_MIME_TYPE)
      ? PREFERRED_MIME_TYPE
      : MediaRecorder.isTypeSupported(FALLBACK_MIME_TYPE)
        ? FALLBACK_MIME_TYPE
        : '';

    this.resolvedMimeType = mimeType || 'audio/webm';

    this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.chunks.push(event.data);
      }
    };
    this.recorder.start();
    this.recording = true;
    return true;
  }

  stop(): Promise<{ buffer: ArrayBuffer; mimeType: string }> {
    return new Promise((resolve, reject) => {
      if (!this.recorder || !this.recording) {
        reject(new Error('Not recording'));
        return;
      }

      const mimeType = this.resolvedMimeType;
      this.recorder.onstop = async () => {
        try {
          const blob = new Blob(this.chunks, { type: mimeType });
          const buffer = await blob.arrayBuffer();
          this.chunks = [];
          this.recording = false;
          this.recorder = null;
          this.releaseStream(this.stream);
          this.stream = null;
          resolve({ buffer, mimeType });
        } catch (err) {
          reject(err);
        }
      };
      this.recorder.stop();
    });
  }

  clear(): void {
    if (this.recorder && this.recording) {
      this.recorder.stop();
    }
    this.recorder = null;
    this.chunks = [];
    this.recording = false;
    this.releaseStream(this.stream);
    this.stream = null;
  }

  dispose(): void {
    this.clear();
    this.permissionState = 'pending';
  }

  isRecording(): boolean {
    return this.recording;
  }

  getPermissionState(): 'pending' | 'granted' | 'denied' {
    return this.permissionState;
  }

  hasPermission(): boolean {
    return this.permissionState === 'granted';
  }

  private async getOrCreateStream(): Promise<MediaStream | null> {
    if (this.stream) {
      const hasLiveTrack = this.stream.getAudioTracks().some((track) => track.readyState === 'live');
      if (hasLiveTrack) {
        return this.stream;
      }
      this.releaseStream(this.stream);
      this.stream = null;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1 }
      });
      this.permissionState = 'granted';
      return this.stream;
    } catch {
      this.permissionState = 'denied';
      return null;
    }
  }

  private releaseStream(stream: MediaStream | null): void {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }
}
