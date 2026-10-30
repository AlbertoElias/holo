// Chrome while recording (styleguide 8.5): everything but the stop control,
// the running time and the Halo hides until the take ends, and the state is
// carried by shape and word, never by red alone. The Halo stays because it
// carries the take's own actions: stop, and undo or redo the held mark. The
// tray and Find stay too (the user, 2026-10-28): objects are summoned, and
// searched for, mid-take. Put back stays with them: an object leaving is part
// of the take as well (docs/features/archive/tray-remove.md).
import type { Control } from "./placement.js";

const SHOWN_WHILE_RECORDING: ReadonlySet<Control> = new Set(["record", "timecode", "status", "halo", "tray", "find", "putBack"]);

/** Whether a control shows. While recording only record (as stop), the timecode slot, the status line, the Halo, the tray, Find and Put back do. */
export function chromeVisible(control: Control, recording: boolean): boolean {
  return !recording || SHOWN_WHILE_RECORDING.has(control);
}

/** "0:12", "12:05", "1:02:03": counts up, whole seconds. */
export function formatRunningTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** "Recording 0:12": in place of the timecode on a flat screen, on the periphery status line in a headset. */
export function recordingText(ms: number): string {
  return `Recording ${formatRunningTime(ms)}`;
}

/** "Paused · 0:08", beside Play (7.2). */
export function pausedText(ms: number): string {
  return `Paused · ${formatRunningTime(ms)}`;
}
