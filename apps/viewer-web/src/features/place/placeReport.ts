// What the e2e check reads about the place (docs/features/splat-place.md):
// `window.__HOLOIM_PLACE__`, installed only where the test hooks are on.

export type PlaceStatus = "off" | "loading" | "ready" | "failed" | "timeout";

export type PlaceReport = {
  status: PlaceStatus;
  url: string;
  splatsLoaded: number;
  splatsKept: number;
  floorFound: boolean;
  /** The floor the histogram found, in the scan's own frame (y up), metres. */
  floorFoundY: number;
  /** The median height of the kept splats within a few centimetres of the floor, measured after placing: where the scan's floor really stands. */
  floorBandY: number;
  /** The scan's floor as placed, world y, and the take's floor it was put on (the cloche's foot). */
  scanFloor: number;
  takeFloor: number;
  /** The author's lowest foot bone now, world y (the ankle, a few centimetres above its floor). */
  feetY: number;
  /** Kept splats the shader still shows whose extent leaves the dome where it is now. */
  outside: number;
  /** Splats the shader shows now, at any opacity. */
  shown: number;
  /** The dome the clip last pushed to the shader, and whether the card's dome has moved since. */
  clipStale: boolean;
  /** Spark has sorted the splats for the view it draws. */
  sorted: boolean;
  loadMs: number;
  /** Frames Spark has made dirty (a generation or a sort landing). */
  dirtyFrames: number;
};

export type PlaceReadings = {
  feetY: () => number;
  outside: () => { outside: number; shown: number };
  sorted: () => boolean;
  clipStale: () => boolean;
};

declare global {
  interface Window {
    __HOLOIM_PLACE__?: PlaceReport;
  }
}

const IDLE: PlaceReadings = { feetY: () => Number.NaN, outside: () => ({ outside: 0, shown: 0 }), sorted: () => false, clipStale: () => false };

/** A report whose `feetY`, `outside`, `shown`, `sorted` and `clipStale` read live, so spreading it takes a reading. */
export function createPlaceReport(): { report: PlaceReport; bind: (readings: PlaceReadings | null) => void } {
  let readings = IDLE;
  const report = {
    status: "off" as PlaceStatus,
    url: "",
    splatsLoaded: 0,
    splatsKept: 0,
    floorFound: false,
    floorFoundY: Number.NaN,
    floorBandY: Number.NaN,
    scanFloor: Number.NaN,
    takeFloor: Number.NaN,
    loadMs: 0,
    dirtyFrames: 0
  } as PlaceReport;
  Object.defineProperties(report, {
    feetY: { enumerable: true, get: () => readings.feetY() },
    outside: { enumerable: true, get: () => readings.outside().outside },
    shown: { enumerable: true, get: () => readings.outside().shown },
    sorted: { enumerable: true, get: () => readings.sorted() },
    clipStale: { enumerable: true, get: () => readings.clipStale() }
  });
  return { report, bind: (next) => { readings = next ?? IDLE; } };
}
