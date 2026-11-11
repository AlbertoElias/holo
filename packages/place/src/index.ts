// A scanned place, shared by capture (bringing a scan in, exporting its crop)
// and the viewer (drawing a stored place): docs/features/splat-capture.md.
// Plain TS and three; Spark loads only through `decode.ts`'s dynamic import.
export * from "./analysis.js";
export * from "./clip.js";
export * from "./decode.js";
