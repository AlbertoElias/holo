// Development-only capture of raw headset input (head, hands, controllers) in
// IWER's ActionRecorder format, so a real session can be replayed through the
// app's WebXR input path in tests. Loaded lazily and never in production.

type ActionRecorderLike = {
  recordFrame(frame: XRFrame): void;
  getRecording(): { schema: unknown[]; frames: unknown[][] };
};

export type InputRecording = {
  schema: unknown[];
  frames: unknown[][];
  // 'iwer-emulated' when IWER produced the input; real headset sessions are
  // the only ones that count as tracked-hand ground truth.
  // `query` is the page's search string (scene and avatar options), so a
  // replay loads the same environment the input was recorded in.
  meta: { source: 'headset' | 'iwer-emulated'; recordedAt: string; durationMs: number; frameRateHz: number; userAgent: string; query: string };
};

// Quest renders at 72–120 Hz; replay interpolates between frames, so 30 Hz
// keeps finger motion while holding fixtures to a few hundred KB per minute.
const TARGET_FRAME_RATE_HZ = 30;
export const INPUT_RECORDING_ENDPOINT = '/__holoim/input-recordings';

export class InputRecordingSession {
  private constructor(private readonly recorder: ActionRecorderLike) {}

  static async start(session: XRSession, refSpace: XRReferenceSpace): Promise<InputRecordingSession> {
    const { ActionRecorder } = await import('iwer');
    return new InputRecordingSession(new ActionRecorder(session as never, refSpace as never) as unknown as ActionRecorderLike);
  }

  recordFrame(frame: XRFrame): void {
    this.recorder.recordFrame(frame);
  }

  finish(): InputRecording {
    const { schema, frames } = this.recorder.getRecording();
    // Keep the first frame at or after each tick of a fixed 30 Hz grid, so
    // 72/90/120 Hz sessions all yield an even 30 Hz.
    const period = 1000 / TARGET_FRAME_RATE_HZ;
    const kept: unknown[][] = [];
    let nextTick = -Infinity;
    for (const frame of frames) {
      const timeStamp = frame[0] as number;
      if (timeStamp + 1e-6 < nextTick) continue;
      kept.push(frame);
      nextTick = Number.isFinite(nextTick) ? nextTick + period : timeStamp + period;
      while (nextTick <= timeStamp) nextTick += period;
    }
    const first = (kept[0]?.[0] as number | undefined) ?? 0;
    const last = (kept.at(-1)?.[0] as number | undefined) ?? first;
    return {
      schema: structuredClone(schema),
      frames: structuredClone(kept),
      meta: {
        source: 'IWER_DEVICE' in window ? 'iwer-emulated' : 'headset',
        recordedAt: new Date().toISOString(),
        durationMs: last - first,
        frameRateHz: TARGET_FRAME_RATE_HZ,
        userAgent: navigator.userAgent,
        query: window.location.search
      }
    };
  }
}

// Saves through the dev server into apps/capture/fixtures/input-recordings;
// falls back to a browser download when no dev server sink is available.
export async function saveInputRecording(recording: InputRecording, baseName: string): Promise<string> {
  const body = JSON.stringify(recording);
  try {
    const response = await fetch(`${INPUT_RECORDING_ENDPOINT}?name=${encodeURIComponent(baseName)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000)
    });
    if (response.ok) {
      const { path } = (await response.json()) as { path: string };
      return path;
    }
  } catch {
    // Fall through to a download.
  }
  const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${baseName}.input.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  return anchor.download;
}
