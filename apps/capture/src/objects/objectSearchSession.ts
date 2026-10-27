import { OBJECT_SEARCH_MAX_QUERY_LENGTH, type ObjectSearchResult } from '@holoim/contracts';

import { objectGlbUrl, prefetchObjectGlb, searchObjects } from './objectSearch';
import { VoiceInput, type VoicePath, type VoiceState } from './voiceInput';

export type Finding = { status: 'idle' } | { status: 'loading'; q: string } | { status: 'error'; message: string } | { status: 'done'; q: string; results: ObjectSearchResult[] };

export interface ObjectSearchState {
  query: string;
  finding: Finding;
  voice: VoiceState;
  /** The path the last voice query took. */
  voicePath: VoicePath | null;
  /** A short line about voice (nothing heard, unavailable: type instead). */
  notice: string | null;
}

/** The shortcuts a headset shows above the query line (PRD-060 slice 2). */
export const OBJECT_CATEGORIES = ['chairs', 'plants', 'lamps', 'food', 'tools'] as const;

/**
 * One Find surface's search: the query line, the last results, and voice.
 * The desktop field and the headset panel each hold one; neither knows the
 * other. Results arriving prefetch the top model, so a pick loads at once.
 */
export class ObjectSearchSession {
  private state: ObjectSearchState = { query: '', finding: { status: 'idle' }, voice: 'idle', voicePath: null, notice: null };
  private readonly listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private readonly voiceInput = new VoiceInput({
    onInterim: (text) => this.set({ query: clip(text) }),
    onFinal: (text) => {
      if (!text) {
        this.set({ notice: 'Nothing heard; try again or type.' });
        return;
      }
      // The transcript stays in the query line, editable, and is searched.
      this.set({ query: clip(text), notice: null });
      this.search(clip(text));
    },
    onError: (message) => this.set({ notice: message }),
    onState: (voice, voicePath) => this.set({ voice, voicePath, ...(voice === 'listening' ? { notice: null } : {}) })
  });

  getState = (): ObjectSearchState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setQuery(query: string): void {
    this.set({ query: clip(query) });
  }

  search(query: string = this.state.query): void {
    const q = clip(query).trim();
    if (!q) return;
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    this.set({ query: clip(query), finding: { status: 'loading', q } });
    searchObjects(q, controller.signal).then(
      (results) => {
        if (controller.signal.aborted) return;
        const top = results[0];
        if (top) prefetchObjectGlb(objectGlbUrl(top));
        this.set({ finding: { status: 'done', q, results } });
      },
      (error: Error) => {
        if (!controller.signal.aborted) this.set({ finding: { status: 'error', message: error.message } });
      }
    );
  }

  startVoice(): void {
    this.voiceInput.start();
  }

  stopVoice(): void {
    this.voiceInput.stop();
  }

  /** A take started or the surface closed: no search or voice keeps running. */
  cancel(): void {
    this.abort?.abort();
    this.voiceInput.cancel();
    if (this.state.finding.status === 'loading') this.set({ finding: { status: 'idle' } });
  }

  private set(patch: Partial<ObjectSearchState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function clip(text: string): string {
  return text.slice(0, OBJECT_SEARCH_MAX_QUERY_LENGTH);
}
