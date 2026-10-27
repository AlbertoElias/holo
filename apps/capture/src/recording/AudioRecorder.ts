const PREFERRED_MIME_TYPE = 'audio/webm;codecs=opus';
const FALLBACK_MIME_TYPE = 'audio/webm';

export class AudioRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private recording = false;
  private permissionState: 'pending' | 'granted' | 'denied' = 'pending';
  private resolvedMimeType = '';
  // A camera take's microphone, asked for in the AR entry tap and kept open
  // until the session ends (docs/features/archive/ar-recording.md): the stream
  // survives a take's stop, and a late grant after a release is dropped.
  private holdingStream = false;
  private pendingStream: Promise<MediaStream | null> | null = null;

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

  /**
   * Asks for the microphone and keeps the stream open past a take's stop, until
   * `releaseHeldStream`. Call it synchronously inside the tap that needs the
   * user activation; it never throws. Resolves whether a stream is held.
   */
  async holdStream(): Promise<boolean> {
    this.holdingStream = true;
    const stream = await this.getOrCreateStream();
    if (!this.holdingStream) {
      // Released while the permission prompt was open: this late stream is not wanted.
      if (stream && !this.recording) {
        this.releaseStream(stream);
        if (this.stream === stream) this.stream = null;
      }
      return false;
    }
    return stream !== null;
  }

  isHoldingStream(): boolean {
    return this.holdingStream;
  }

  releaseHeldStream(): void {
    this.holdingStream = false;
    if (this.recording) return;
    this.releaseStream(this.stream);
    this.stream = null;
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
          if (!this.holdingStream) {
            this.releaseStream(this.stream);
            this.stream = null;
          }
          resolve({ buffer, mimeType });
        } catch (err) {
          reject(err);
        }
      };
      this.recorder.stop();
    });
  }

  isRecording(): boolean {
    return this.recording;
  }

  getPermissionState(): 'pending' | 'granted' | 'denied' {
    return this.permissionState;
  }

  private getOrCreateStream(): Promise<MediaStream | null> {
    if (this.stream) {
      const hasLiveTrack = this.stream.getAudioTracks().some((track) => track.readyState === 'live');
      if (hasLiveTrack) {
        return Promise.resolve(this.stream);
      }
      this.releaseStream(this.stream);
      this.stream = null;
    }
    // Overlapping callers (the AR tap's hold, then Record while the prompt is
    // open) share one request, so no second stream is left live unowned.
    this.pendingStream ??= navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } }).then(
      (stream) => {
        this.stream = stream;
        this.permissionState = 'granted';
        return stream;
      },
      () => {
        this.permissionState = 'denied';
        return null;
      }
    ).finally(() => {
      this.pendingStream = null;
    });
    return this.pendingStream;
  }

  private releaseStream(stream: MediaStream | null): void {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }
}
