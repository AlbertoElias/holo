import { DEFAULT_HANDEDNESS, parseHandedness, type Handedness } from '@holoim/xr-ui-core';

// Stored per device (docs/features/ui-redesign.md, Q8): this browser's
// storage, never an account. Unreadable storage (private windows, blocked
// site data) falls back to right-handed.
const STORAGE_KEY = 'holoim.handedness';

export function loadHandedness(): Handedness {
  try {
    return parseHandedness(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_HANDEDNESS;
  }
}

export function saveHandedness(handedness: Handedness): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, handedness);
  } catch {
    // The setting still holds for this page; it is just not remembered.
  }
}
