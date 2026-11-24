// The look step's photo choice (docs/features/directed-performance.md, slice
// 5b). "From a photo" opens the device's own picker through one hidden file
// input, shared by the phone sheet and the headset panel. The photo is read
// on the device by the lazy `photoLookRead.ts`, the card goes to
// `HouseLookController`, and the photo is dropped: it is not stored, not
// uploaded and not in the take. Only the card is saved, as a hand-made look.
import type { LookCard } from '@holoim/avatar-look';

import type { RecordingSession } from '../recording/RecordingSession';
import type { LookPhotoUi } from '../types/contracts';
import { traitWords } from '../ui/lookPictures';
import type { UIStateStore } from '../ui/UIStateStore';
import type { HouseLookController } from './HouseLookController';
import type { HouseLook } from './houseLook';
import type { PhotoCard, PhotoTrait } from './photoLookRead';

type ReadModule = typeof import('./photoLookRead');
type Reader = Awaited<ReturnType<ReadModule['openReader']>>;

interface PhotoLookDeps {
  houseLook: HouseLookController;
  recording: RecordingSession;
  ui: UIStateStore;
}

const TRAIT_WORDS: Record<PhotoTrait, string> = { skin: 'skin', hairColour: 'hair colour', eyes: 'eyes', hairStyle: 'hair' };

const IDLE: LookPhotoUi = { status: 'idle', message: null, kept: null, previous: false };

/** The status line after a read: the traits the photo set. */
export function setLine(set: PhotoCard['set']): string {
  if (set.length === 0) return 'The photo set no trait, so the look did not change.';
  return `From your photo: ${set.map((s) => `${TRAIT_WORDS[s.trait]} ${traitWords(s.value)}`).join(', ')}. Check each row.`;
}

/** The muted line after a read: the traits kept as they were, and why. */
export function keptLine(kept: PhotoCard['kept']): string | null {
  if (kept.length === 0) return null;
  return `Kept as it was: ${kept.map((k) => `${TRAIT_WORDS[k.trait]}, as ${k.why}`).join('; ')}.`;
}

const REFUSED: Record<string, string> = {
  'no-face': 'No face found in that photo. Use a close photo of your own face.',
  'several-faces': 'That photo shows more than one face. Use a photo of your own face only.',
  'face-too-small': 'The face in that photo is too small. Use a closer or larger photo.'
};

/** One painted frame, so the status line shows before the read holds the main thread. */
const painted = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

export class PhotoLookController {
  private input: HTMLInputElement | null = null;
  private module: Promise<ReadModule> | null = null;
  private reader: Promise<Reader> | null = null;
  /** The number of the latest pick: an older read stops at its next step. */
  private latest = 0;
  /** The look from before the last photo: "Previous look" puts it back. */
  private before: HouseLook | null = null;
  private lastReadMs: number | null = null;
  private lastCard: PhotoCard | null = null;
  /** Picks whose read has ended, refused or not. */
  private picks = 0;

  constructor(private readonly deps: PhotoLookDeps) {
    // A take ends "Previous look" (the look is not in a take's history).
    deps.ui.subscribe((state) => {
      if (state.recordingState !== 'idle' && state.lookPhoto.previous) this.forget();
    });
  }

  /**
   * "From a photo": opens the picker at once (it must run in the person's
   * tap or select), and starts to load the reader beside it.
   */
  pick(): void {
    if (!this.deps.houseLook.look || this.deps.recording.isTakeBusy()) return;
    this.fileInput().click();
    this.startReader();
  }

  /** "Previous look": the look from before the photo, in one step. */
  previous(): void {
    const before = this.before;
    if (!before) return;
    if (this.deps.houseLook.setLook(before)) this.forget();
  }

  /** Any other change to the look ends "Previous look" and the photo's lines. */
  forget(): void {
    this.before = null;
    this.latest += 1;
    const state = this.deps.ui.getState().lookPhoto;
    if (state.status !== 'idle' || state.previous) this.deps.ui.setLookPhoto(IDLE);
  }

  /** For the e2e: the last read's time and card. Holds no photo pixels. */
  sample(): { picks: number; lastReadMs: number | null; card: LookCard | null; set: PhotoCard['set']; kept: PhotoCard['kept']; hairStyleConfidence: number | null; readerOpen: boolean } {
    return {
      picks: this.picks,
      lastReadMs: this.lastReadMs,
      card: this.lastCard?.card ?? null,
      set: this.lastCard?.set ?? [],
      kept: this.lastCard?.kept ?? [],
      hairStyleConfidence: this.lastCard?.hairStyle.confidence ?? null,
      readerOpen: this.reader !== null
    };
  }

  private fileInput(): HTMLInputElement {
    if (this.input) return this.input;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.hidden = true;
    input.dataset.testid = 'look-photo-input';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      // The same photo can be picked again.
      input.value = '';
      if (file) void this.readFile(file);
      else this.dropReader();
    });
    // The picker closed with no photo: the reader that started to load is dropped.
    input.addEventListener('cancel', () => this.dropReader());
    document.body.append(input);
    this.input = input;
    return input;
  }

  private loadModule(): Promise<ReadModule> {
    this.module ??= import('./photoLookRead');
    // A failed chunk load can be tried again on the next pick.
    this.module.catch(() => (this.module = null));
    return this.module;
  }

  private startReader(): Promise<Reader> {
    if (!this.reader) {
      const reader = this.loadModule().then((m) => m.openReader());
      this.reader = reader;
      reader.catch(() => {
        if (this.reader === reader) this.reader = null;
      });
    }
    return this.reader;
  }

  /** Closes the reader, now or once it has loaded, so its memory goes back. */
  private dropReader(): void {
    const reader = this.reader;
    this.reader = null;
    void reader?.then((r) => r.close()).catch(() => undefined);
  }

  private show(status: LookPhotoUi['status'], message: string | null, kept: string | null = null): void {
    this.deps.ui.setLookPhoto({ status, message, kept, previous: this.before !== null && status !== 'loading' && status !== 'reading' });
  }

  private async readFile(file: File): Promise<void> {
    const id = ++this.latest;
    const stale = (): boolean => id !== this.latest;
    const { houseLook, recording } = this.deps;
    const loading = this.startReader();
    let ready = false;
    void loading.then(() => (ready = true)).catch(() => undefined);
    await Promise.resolve();
    if (!ready) this.show('loading', 'Getting the photo reader ready');
    let m: ReadModule;
    let reader: Reader;
    try {
      [m, reader] = await Promise.all([this.loadModule(), loading]);
    } catch (error) {
      console.error('[look photo] the reader did not load', error);
      if (!stale()) this.show('error', 'The photo reader did not load. Check the connection and try again.');
      this.picks += 1;
      return;
    }
    if (stale()) return;
    this.show('reading', 'Reading your photo');
    let canvas: HTMLCanvasElement | null = null;
    try {
      canvas = await m.photoCanvas(file);
      await painted();
      if (stale()) return;
      const current = houseLook.look;
      if (!current) return;
      const startedAt = performance.now();
      const result = m.readCard(reader, canvas, current.look);
      this.lastReadMs = performance.now() - startedAt;
      this.lastCard = result;
      console.info(`[look photo] read in ${Math.round(this.lastReadMs)} ms: ${result.set.length} trait(s) set`);
      if (stale()) return;
      if (recording.isTakeBusy()) {
        this.show('refused', 'A take started, so the look did not change.');
        return;
      }
      const next: HouseLook = { look: result.card, finish: current.finish };
      if (result.set.length > 0) {
        if (!houseLook.setLook(next)) {
          this.show('refused', 'A take started, so the look did not change.');
          return;
        }
        this.before = current;
      }
      this.show('read', setLine(result.set), keptLine(result.kept));
    } catch (error) {
      if (stale()) return;
      if (error instanceof m.NotAnImage) this.show('refused', 'That file did not open as a photo. Use a JPEG or PNG.');
      else if (error instanceof m.PhotoRefused) this.show('refused', REFUSED[error.reason] ?? 'That photo could not be read. Try another one.');
      else {
        console.error('[look photo] the read failed', error);
        this.show('error', 'That photo could not be read. Try another one.');
      }
    } finally {
      // The photo's pixels go: the canvas is emptied and the reader closed.
      if (canvas) canvas.width = canvas.height = 0;
      if (this.reader === loading) this.dropReader();
      this.picks += 1;
    }
  }
}
