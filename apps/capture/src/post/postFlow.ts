import { MAX_HOLOGRAM_BYTES, postGrantInfoSchema } from '@holoim/contracts';
import { API_ORIGIN } from '../objects/objectSearch';
import { downloadBlob } from './downloadBlob';

// Post a take straight from capture (docs/features/phone-capture.md, slice 1).
// The viewer's Record opens capture with a single-use post grant in the URL
// fragment. It is read once, removed from the address bar at once, and kept
// here only. Without a grant, capture behaves exactly as before: a take
// downloads.

export type PostState =
  /** No grant: takes download. */
  | { kind: 'none' }
  /** A grant, no take yet. */
  | { kind: 'waiting' }
  /** The grant is spent or expired: takes download, and the line says why. */
  | { kind: 'expired'; message: string }
  /** A take waits for Post or Save file. */
  | { kind: 'ready' }
  | { kind: 'posting' }
  /** Post failed; `retry` is false once the grant is spent or expired (Save file still works). */
  | { kind: 'failed'; message: string; retry: boolean }
  /** Posted; the page is on its way to the hologram. */
  | { kind: 'posted' };

type GrantInfo = { displayName: string; returnOrigin: string };

const EXPIRED = 'This recording link has expired. Save the file, or sign in again to record and post.';

function readGrantFromFragment(): string | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const grant = params.get('post');
  if (!grant) return null;
  params.delete('post');
  const rest = params.toString();
  // Off the address bar before anything else runs, so it is never shared or reloaded.
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ''}`);
  return grant;
}

class PostFlow {
  private readonly grant: string | null = readGrantFromFragment();
  private info: GrantInfo | null = null;
  private take: { blob: Blob; name: string } | null = null;
  private state: PostState = this.grant ? { kind: 'waiting' } : { kind: 'none' };
  private readonly listeners = new Set<() => void>();
  private checking: Promise<GrantInfo | null> | null = null;
  /** The grant expired or was refused: no more posts from this page. */
  private spent = false;

  constructor() {
    // Reading the grant also wakes the API, which stops when idle.
    if (this.grant) void this.check();
  }

  get hasGrant(): boolean {
    return this.grant !== null;
  }

  /**
   * Where Sign in again goes: the viewer that minted the grant (server-checked),
   * known once the grant was read; never an origin taken from the page.
   */
  get signInAgainUrl(): string | null {
    return this.info ? `${this.info.returnOrigin.replace(/\/$/, '')}/record` : null;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PostState => this.state;

  /**
   * The recording's export hands its take here first. True when this flow
   * keeps it for Post; false to download as before (no grant, an expired
   * one, or a take over the upload cap, which the viewer would refuse).
   */
  deliverTake = (blob: Blob, name: string): boolean => {
    if (!this.grant || this.spent || this.state.kind === 'posted' || this.state.kind === 'posting') return false;
    if (blob.size > MAX_HOLOGRAM_BYTES) return false;
    this.take = { blob, name };
    this.set({ kind: 'ready' });
    return true;
  };

  /** Save file: the old download, for a take kept for Post. */
  save = (): void => {
    if (!this.take) return;
    downloadBlob(this.take.blob, this.take.name);
  };

  /** Record again: the kept take is dropped. */
  discard = (): void => {
    // A post in flight keeps its take; it leaves the page when it lands.
    if (this.state.kind === 'posting') return;
    this.take = null;
    if (this.state.kind !== 'expired' && !this.spent) this.set({ kind: 'waiting' });
  };

  post = async (): Promise<void> => {
    const take = this.take;
    if (!this.grant || !take || this.spent || this.state.kind === 'posting' || this.state.kind === 'posted') return;
    this.set({ kind: 'posting' });
    const info = this.info ?? (await this.check());
    if (!info) {
      // A 401 during the check already said the link expired.
      if ((this.state as PostState).kind === 'posting') this.set({ kind: 'failed', message: 'Could not reach HoloIM. Check the connection and try again.', retry: true });
      return;
    }
    const form = new FormData();
    form.append('hologramName', defaultTitle());
    form.append('submittedBy', info.displayName);
    form.append('file', take.blob, take.name);
    let response: Response;
    try {
      response = await fetch(`${API_ORIGIN}/api/holograms`, { method: 'POST', headers: { authorization: `Bearer ${this.grant}` }, body: form });
    } catch {
      this.set({ kind: 'failed', message: 'Could not reach HoloIM. Check the connection and try again.', retry: true });
      return;
    }
    if (response.status === 401 || response.status === 410) {
      // The take stays: Save file still works.
      this.spent = true;
      this.set({ kind: 'failed', message: EXPIRED, retry: false });
      return;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      this.set({ kind: 'failed', message: body.error ?? 'Posting failed. Try again, or save the file.', retry: true });
      return;
    }
    const { id } = (await response.json()) as { id: string };
    this.take = null;
    this.set({ kind: 'posted' });
    window.location.assign(`${info.returnOrigin.replace(/\/$/, '')}/h/${encodeURIComponent(id)}?posted=1`);
  };

  private check(): Promise<GrantInfo | null> {
    if (!this.grant) return Promise.resolve(null);
    this.checking ??= (async () => {
      try {
        const response = await fetch(`${API_ORIGIN}/api/auth/post-grant`, { headers: { authorization: `Bearer ${this.grant}` } });
        if (response.status === 401) {
          this.spent = true;
          if (this.take) this.set({ kind: 'failed', message: EXPIRED, retry: false });
          else this.set({ kind: 'expired', message: 'This recording link has expired. Start again from HoloIM to post; takes still save as files.' });
          return null;
        }
        if (!response.ok) return null;
        const parsed = postGrantInfoSchema.parse(await response.json());
        this.info = { displayName: parsed.displayName, returnOrigin: parsed.returnOrigin };
        return this.info;
      } catch {
        return null;
      } finally {
        // A failed check may be tried again at Post.
        if (!this.info) this.checking = null;
      }
    })();
    return this.checking;
  }

  private set(state: PostState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

function defaultTitle(): string {
  const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return `A hologram, ${date}`;
}

export const postFlow = new PostFlow();

/**
 * The phone journey (docs/features/phone-capture.md, slice 2): opened from the
 * viewer's Record on a touch screen. It starts in the selfie view and counts
 * 3-2-1 before a take. Never in AR, and never a camera-only take.
 */
export function isSelfieJourney(): boolean {
  if (!postFlow.hasGrant) return false;
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}
