import { voiceCapabilities } from './voiceInput';

/**
 * A debug line for checking a real headset (PRD-060 slice 2): whether this
 * browser has the Web Speech API and, in a session, the system keyboard.
 * Dev builds show it; a deployed capture shows it with `?debug`.
 */
export const SHOW_CAPABILITIES: boolean = import.meta.env.DEV || new URLSearchParams(globalThis.location?.search ?? '').has('debug');

const mark = (value: boolean | null): string => (value === null ? '–' : value ? 'yes' : 'no');

/** `session`: the immersive session, whose `isSystemKeyboardSupported` only exists in one. */
export function capabilityLine(session: XRSession | null): string {
  const voice = voiceCapabilities();
  const keyboard = session ? Boolean((session as XRSession & { isSystemKeyboardSupported?: boolean }).isSystemKeyboardSupported) : null;
  return `debug · webkitSpeechRecognition ${mark(voice.webkitSpeechRecognition)} · SpeechRecognition ${mark(voice.speechRecognition)} · MediaRecorder ${mark(voice.mediaRecorder)} · system keyboard ${mark(keyboard)}`;
}
