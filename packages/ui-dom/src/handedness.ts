// The handedness setting (brief Q8), shared by both apps: stored per device
// in this browser's storage, never an account. Unreadable storage (private
// windows, blocked site data) falls back to right-handed.
import { useCallback, useState } from "react";

import { DEFAULT_HANDEDNESS, parseHandedness, type Handedness } from "@holoim/xr-ui-core";

const STORAGE_KEY = "holoim.handedness";

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

/** The stored handedness, and a setter that remembers it. */
export function useHandedness(): [Handedness, (handedness: Handedness) => void] {
  const [handedness, setHandedness] = useState(loadHandedness);
  const set = useCallback((next: Handedness) => {
    saveHandedness(next);
    setHandedness(next);
  }, []);
  return [handedness, set];
}
