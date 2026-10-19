import { useSyncExternalStore } from "react";

import type { PortalState, PortalStore } from "./portalStore";

/** Re-renders only when the selected primitive changes, not on every orbit tick. */
export function usePortalValue<T extends string | number | boolean>(
  store: PortalStore,
  select: (state: PortalState) => T
): T {
  return useSyncExternalStore(store.subscribe, () => select(store.getState()), () => select(store.getState()));
}
