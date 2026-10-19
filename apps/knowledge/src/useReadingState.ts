import { useEffect, useState } from "react";

/** Preserve only local reading preferences across a source-triggered page reload. */
export function useReadingState<T extends string | number>(
  key: string,
  initial: T,
) {
  type Value = T extends string ? string : number;
  const storageKey = `holoim-atlas:${key}`;
  const [value, setValue] = useState<Value>(() => {
    try {
      const stored: unknown = JSON.parse(
        sessionStorage.getItem(storageKey) ?? "null",
      );
      return typeof stored === typeof initial
        ? (stored as Value)
        : (initial as unknown as Value);
    } catch {
      return initial as unknown as Value;
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      /* Storage may be disabled; reading still works. */
    }
  }, [storageKey, value]);
  return [value, setValue] as const;
}
