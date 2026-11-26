/**
 * Wall-clock time of each phase of a build (setup, each solve pass, export,
 * viewer start), so a slow look can be put on the phase that is slow.
 *
 * A build starts a list with `startPhases()`. Each phase adds its seconds
 * with `phase(name, fn)`, `phaseSync(name, fn)` or `phaseMark(name, since)`.
 * The solver adds its passes to the open list, if there is one.
 */
export interface Phase { readonly name: string; readonly seconds: number }

let open: Phase[] | undefined;

/** Starts a new list of phases and returns it (the list fills as phases end). */
export function startPhases(): Phase[] {
  open = [];
  return open;
}

/** Adds a phase that started at `since` (`performance.now()`) and ends now. */
export function phaseMark(name: string, since: number): void {
  open?.push({ name, seconds: (performance.now() - since) / 1000 });
}

export async function phase<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const since = performance.now();
  try { return await fn(); } finally { phaseMark(name, since); }
}

export function phaseSync<T>(name: string, fn: () => T): T {
  const since = performance.now();
  try { return fn(); } finally { phaseMark(name, since); }
}

/** One line: `setup 12.3 s, solve pass 1 40.1 s, …`. */
export function phaseLine(phases: readonly Phase[]): string {
  return phases.map((p) => `${p.name} ${p.seconds.toFixed(1)} s`).join(', ');
}
