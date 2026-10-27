import { OBJECT_SEARCH_MAX_QUERY_LENGTH } from '@holoim/contracts';

/**
 * Quest Browser 26.1+ raises its system keyboard over an immersive session
 * for a focused DOM text field (`XRSession.isSystemKeyboardSupported`).
 * No key events reach the page, only the field's value, and the first key
 * replaces whatever the field held, so the field starts empty and its value
 * is mirrored into the headset's query line. Enter (a submit) or the
 * keyboard closing (blur) searches.
 */
export class SystemKeyboard {
  private readonly input: HTMLInputElement;
  private readonly form: HTMLFormElement;
  private active = false;

  constructor(private readonly handlers: { onInput(value: string): void; onSubmit(value: string): void }) {
    this.form = document.createElement('form');
    this.form.setAttribute('aria-hidden', 'true');
    // On screen but unseen: an element that is hidden or off-screen cannot take focus on some builds.
    Object.assign(this.form.style, { position: 'fixed', left: '0', bottom: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none', overflow: 'hidden' });
    this.input = document.createElement('input');
    this.input.type = 'search';
    this.input.enterKeyHint = 'search';
    this.input.autocomplete = 'off';
    this.input.maxLength = OBJECT_SEARCH_MAX_QUERY_LENGTH;
    this.input.setAttribute('aria-label', 'Find an object (headset keyboard)');
    this.input.addEventListener('input', () => this.handlers.onInput(this.input.value));
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.finish();
    });
    this.input.addEventListener('blur', () => this.finish());
    this.form.append(this.input);
  }

  /** Whether the session can show the system keyboard. Unsupported (and IWER): the in-world keyboard. */
  static supported(session: XRSession | null | undefined): boolean {
    return Boolean((session as (XRSession & { isSystemKeyboardSupported?: boolean }) | null | undefined)?.isSystemKeyboardSupported);
  }

  get isOpen(): boolean {
    return this.active;
  }

  /** Raises the keyboard; call from a select, which counts as the user's gesture. */
  open(): void {
    if (!this.form.isConnected) document.body.append(this.form);
    this.input.value = '';
    this.active = true;
    this.input.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.active) return;
    this.active = false;
    this.input.blur();
  }

  dispose(): void {
    this.active = false;
    this.form.remove();
  }

  private finish(): void {
    if (!this.active) return;
    this.active = false;
    this.input.blur();
    this.handlers.onSubmit(this.input.value);
  }
}
