import { OBJECT_TRANSCRIBE_MAX_SECONDS } from '@holoim/contracts';

import { TranscribeUnavailableError, transcribeQuery } from './objectSearch';

// Voice search (PRD-060 slice 2). Where the Web Speech API exists and works
// (desktop Chrome), it hears the query with interim results, so the words
// appear while the author speaks. Where it is absent (Quest Browser) or
// fails, the mic is recorded while held, up to the contract's limit, and
// `viewer-api` transcribes it. Each use logs the path it took, so a headset
// probe can report which one a device runs.

export type VoicePath = 'speech-recognition' | 'transcribe';
export type VoiceState = 'idle' | 'listening' | 'transcribing';

export interface VoiceHandlers {
  /** The words so far (speech recognition only). */
  onInterim(text: string): void;
  /** What was heard; empty when nothing was. */
  onFinal(text: string, path: VoicePath): void;
  /** `typeInstead`: voice cannot work here now, so the author types. */
  onError(message: string, typeInstead: boolean): void;
  onState(state: VoiceState, path: VoicePath | null): void;
}

/** Each voice query's path and outcome, newest last (`__sampleObjectSearch`). */
export const voiceLog: Array<{ path: VoicePath; outcome: 'heard' | 'empty' | 'error' | 'fallback'; detail?: string }> = [];

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  const scope = globalThis as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/** What this browser offers, for the dev capability line and the probe. */
export function voiceCapabilities(): { speechRecognition: boolean; webkitSpeechRecognition: boolean; mediaRecorder: boolean } {
  return {
    speechRecognition: speechRecognitionCtor() !== null,
    webkitSpeechRecognition: 'webkitSpeechRecognition' in globalThis,
    mediaRecorder: typeof MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
  };
}

// Errors after which this page stops trying the Web Speech API and records instead.
const RECOGNITION_BROKEN = new Set(['network', 'not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported', 'bad-grammar']);
let recognitionBroken = false;

const RECORDER_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

function log(path: VoicePath, outcome: (typeof voiceLog)[number]['outcome'], detail?: string): void {
  voiceLog.push(detail ? { path, outcome, detail } : { path, outcome });
  console.info(`[object-search] voice path=${path} outcome=${outcome}${detail ? ` (${detail})` : ''}`);
}

/** One push-to-talk query at a time: `start` on press, `stop` on release. */
export class VoiceInput {
  private path: VoicePath | null = null;
  private state: VoiceState = 'idle';
  private held = false;
  private recognition: SpeechRecognitionLike | null = null;
  private heard = { final: '', interim: '' };
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private limit: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  // Each start and cancel moves this on, so a microphone that opens after its
  // hold was cancelled (and perhaps another begun) is closed, not used.
  private generation = 0;

  constructor(private readonly handlers: VoiceHandlers) {}

  get listening(): boolean {
    return this.state === 'listening';
  }

  start(): void {
    if (this.state !== 'idle') return;
    this.held = true;
    this.generation += 1;
    const Recognition = recognitionBroken ? null : speechRecognitionCtor();
    if (Recognition) this.startRecognition(Recognition);
    else void this.startRecorder();
  }

  stop(): void {
    this.held = false;
    if (this.recognition) this.recognition.stop();
    else if (this.recorder?.state === 'recording') this.recorder.stop();
  }

  cancel(): void {
    this.held = false;
    this.generation += 1;
    this.abort?.abort();
    if (this.recognition) {
      this.recognition.onend = null;
      this.recognition.abort();
      this.recognition = null;
    }
    if (this.recorder) {
      this.recorder.onstop = null;
      if (this.recorder.state === 'recording') this.recorder.stop();
      this.recorder = null;
    }
    this.release();
    this.setState('idle');
  }

  private setState(state: VoiceState): void {
    this.state = state;
    this.handlers.onState(state, this.path);
  }

  private startRecognition(Recognition: SpeechRecognitionCtor): void {
    this.path = 'speech-recognition';
    this.heard = { final: '', interim: '' };
    let failed: string | null = null;
    const recognition = new Recognition();
    recognition.lang = navigator.language || 'en-US';
    // One phrase: it ends at the first pause, or on release.
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]!;
        if (result.isFinal) this.heard.final += result[0]!.transcript;
        else interim += result[0]!.transcript;
      }
      this.heard.interim = interim;
      this.handlers.onInterim(`${this.heard.final}${interim}`.trim());
    };
    recognition.onerror = (event) => {
      if (event.error === 'aborted' || event.error === 'no-speech') return;
      failed = event.error;
    };
    recognition.onend = () => {
      this.recognition = null;
      if (failed && RECOGNITION_BROKEN.has(failed)) {
        // This browser lists the API but cannot use it: record instead, now if still held.
        recognitionBroken = true;
        log('speech-recognition', 'fallback', failed);
        this.state = 'idle';
        if (this.held) void this.startRecorder();
        else {
          this.setState('idle');
          this.handlers.onError('Could not hear that; hold Speak and try again.', false);
        }
        return;
      }
      const text = `${this.heard.final}${this.heard.interim}`.trim();
      log('speech-recognition', failed ? 'error' : text ? 'heard' : 'empty', failed ?? undefined);
      this.setState('idle');
      if (failed) this.handlers.onError('Could not hear that; try again or type.', false);
      else this.handlers.onFinal(text, 'speech-recognition');
    };
    this.recognition = recognition;
    try {
      recognition.start();
      this.setState('listening');
    } catch (error) {
      this.recognition = null;
      recognitionBroken = true;
      log('speech-recognition', 'fallback', (error as Error).message);
      void this.startRecorder();
    }
  }

  private async startRecorder(): Promise<void> {
    this.path = 'transcribe';
    if (!voiceCapabilities().mediaRecorder) {
      log('transcribe', 'error', 'no MediaRecorder');
      this.handlers.onError('Voice search is not available here; type instead.', true);
      return;
    }
    this.setState('listening');
    const generation = this.generation;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (error) {
      if (generation !== this.generation) return;
      log('transcribe', 'error', (error as Error).name);
      this.release();
      this.setState('idle');
      this.handlers.onError('The microphone is off; type instead.', true);
      return;
    }
    if (generation !== this.generation) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.stream = stream;
    // Released while the mic was still opening: nothing was said.
    if (!this.held) {
      this.release();
      this.setState('idle');
      this.handlers.onError('Hold Speak while you talk.', false);
      return;
    }
    const mimeType = RECORDER_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch (error) {
      this.recorderFailed(error as Error);
      return;
    }
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      this.recorder = null;
      this.release();
      void this.transcribe(new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' }));
    };
    this.recorder = recorder;
    try {
      recorder.start();
    } catch (error) {
      recorder.onstop = null;
      this.recorder = null;
      this.recorderFailed(error as Error);
      return;
    }
    this.limit = setTimeout(() => this.stop(), OBJECT_TRANSCRIBE_MAX_SECONDS * 1000);
  }

  private recorderFailed(error: Error): void {
    log('transcribe', 'error', error.message);
    this.release();
    this.setState('idle');
    this.handlers.onError('Voice search is not available here; type instead.', true);
  }

  private async transcribe(audio: Blob): Promise<void> {
    if (audio.size === 0) {
      log('transcribe', 'empty');
      this.setState('idle');
      this.handlers.onFinal('', 'transcribe');
      return;
    }
    this.setState('transcribing');
    const abort = new AbortController();
    this.abort = abort;
    try {
      const text = await transcribeQuery(audio, abort.signal);
      if (abort.signal.aborted) return;
      log('transcribe', text ? 'heard' : 'empty');
      this.setState('idle');
      this.handlers.onFinal(text, 'transcribe');
    } catch (error) {
      if (abort.signal.aborted) return;
      const unavailable = error instanceof TranscribeUnavailableError;
      log('transcribe', 'error', (error as Error).message);
      this.setState('idle');
      this.handlers.onError(unavailable ? 'Voice search is unavailable; type instead.' : (error as Error).message, unavailable);
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }

  private release(): void {
    if (this.limit) clearTimeout(this.limit);
    this.limit = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }
}
