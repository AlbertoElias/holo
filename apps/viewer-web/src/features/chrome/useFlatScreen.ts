// Which flat screen the page is on, and the size of an element, for the
// parts whose rules differ between a phone and a desktop (styleguide 9.3, 9.4).
import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

import { VIEW_TARGETS, type ViewTarget } from "@holoim/xr-ui-core";

/** Phones are narrow or touch-first; everything else follows the desktop rules. */
const PHONE_QUERY = "(max-width: 768px), (pointer: coarse) and (max-width: 1024px)";

function matchesPhone(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(PHONE_QUERY).matches;
}

export function useFlatTarget(): ViewTarget & { kind: "flat" } {
  const [phone, setPhone] = useState(matchesPhone);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(PHONE_QUERY);
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return phone ? VIEW_TARGETS.phone : VIEW_TARGETS.desktop;
}

export type ElementBox = { width: number; height: number; top: number; left: number };

/** The element's size and its offset in its offset parent, kept current. */
export function useElementBox(ref: RefObject<HTMLElement | null>): ElementBox | null {
  const [box, setBox] = useState<ElementBox | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => {
      const next = { width: element.offsetWidth, height: element.offsetHeight, top: element.offsetTop, left: element.offsetLeft };
      setBox((current) => (
        current && current.width === next.width && current.height === next.height && current.top === next.top && current.left === next.left
          ? current
          : next
      ));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.parentElement) observer.observe(element.parentElement);
    return () => observer.disconnect();
  }, [ref]);
  return box;
}
