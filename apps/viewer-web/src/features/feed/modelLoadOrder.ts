/**
 * Which feed cards may start fetching their hologram. A GLB is a megabyte or
 * more, so parallel downloads only slow the one on screen: the focused card
 * loads at once and alone, and the cards near it follow one at a time, the
 * ones below (older) before the one above. Cards further away wait until the
 * feed scrolls near them.
 */

/** How many cards below the focused one load ahead of a scroll. */
export const LOAD_AHEAD = 2;
/** How many cards above the focused one stay loaded for a scroll back. */
export const LOAD_BEHIND = 1;

/** The cards next to the focused one, nearest first: below (older) before above. */
export function nearFocus(ids: readonly string[], focusedId: string | null): string[] {
  const focus = focusedId === null ? 0 : Math.max(ids.indexOf(focusedId), 0);
  const near: string[] = [];
  for (let step = 1; step <= LOAD_AHEAD; step += 1) {
    const id = ids[focus + step];
    if (id !== undefined) near.push(id);
  }
  for (let step = 1; step <= LOAD_BEHIND; step += 1) {
    const id = ids[focus - step];
    if (id !== undefined) near.push(id);
  }
  return near;
}

/**
 * The ids to start now, given the feed order, the focused card, the cards
 * already started and those of them that have settled (downloaded or failed).
 * The focused card never waits behind a background download.
 */
export function nextModelLoads(
  ids: readonly string[],
  focusedId: string | null,
  started: ReadonlySet<string>,
  settled: ReadonlySet<string>
): string[] {
  const focused = ids[focusedId === null ? 0 : Math.max(ids.indexOf(focusedId), 0)];
  if (focused !== undefined && !started.has(focused)) return [focused];
  const inFlight = [...started].some((id) => !settled.has(id) && ids.includes(id));
  if (inFlight) return [];
  const waiting = nearFocus(ids, focusedId).find((id) => !started.has(id));
  return waiting === undefined ? [] : [waiting];
}

/**
 * Calls back once the browser has received the whole file at `url` from a
 * request started at or after `since` (a performance.now() time), so the next
 * download need not wait for this one to parse and draw. The availability
 * probe's requests come before `since`, so they do not count.
 */
export function watchDownloadEnd(url: string, since: number, onEnd: () => void): () => void {
  if (typeof PerformanceObserver === "undefined") return () => undefined;
  const name = new URL(url, window.location.href).href;
  const observer = new PerformanceObserver((list) => {
    if (list.getEntries().some((entry) => entry.name === name && entry.startTime >= since)) {
      observer.disconnect();
      onEnd();
    }
  });
  try {
    observer.observe({ type: "resource", buffered: true });
  } catch {
    return () => undefined;
  }
  return () => observer.disconnect();
}
