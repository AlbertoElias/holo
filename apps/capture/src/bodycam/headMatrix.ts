import type { Quat4 } from './types';

/**
 * The face landmarker's facial transformation matrix (16 numbers, column-major, canonical face to camera, with
 * scale and translation) as a head rotation in the frame `LandmarkFrame` documents: x toward the image's right,
 * y down, z away from the camera, identity facing the camera.
 *
 * MediaPipe's matrix is in the OpenGL camera frame (y up, z toward the viewer), the convention three.js examples
 * apply it in, so the conversion is a half turn about x on both sides: R' = F R F with F = diag(1, -1, -1).
 */
export function headRotationFromMatrix(data: readonly number[]): Quat4 | null {
  if (data.length < 16) return null;
  const col = (c: number): [number, number, number] => {
    const x = data[c * 4]!;
    const y = data[c * 4 + 1]!;
    const z = data[c * 4 + 2]!;
    const n = Math.hypot(x, y, z);
    return n > 1e-6 ? [x / n, y / n, z / n] : [NaN, NaN, NaN];
  };
  const [a, b, c] = [col(0), col(1), col(2)];
  const m = [
    [a[0], b[0], c[0]],
    [a[1], b[1], c[1]],
    [a[2], b[2], c[2]]
  ];
  // F R F flips the entries whose row and column differ in "is x".
  const r = m.map((values, row) => values.map((value, column) => value * ((row === 0) === (column === 0) ? 1 : -1)));
  if (r.flat().some((value) => !Number.isFinite(value))) return null;
  const trace = r[0]![0]! + r[1]![1]! + r[2]![2]!;
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = s / 4;
    x = (r[2]![1]! - r[1]![2]!) / s;
    y = (r[0]![2]! - r[2]![0]!) / s;
    z = (r[1]![0]! - r[0]![1]!) / s;
  } else if (r[0]![0]! > r[1]![1]! && r[0]![0]! > r[2]![2]!) {
    const s = Math.sqrt(1 + r[0]![0]! - r[1]![1]! - r[2]![2]!) * 2;
    w = (r[2]![1]! - r[1]![2]!) / s;
    x = s / 4;
    y = (r[0]![1]! + r[1]![0]!) / s;
    z = (r[0]![2]! + r[2]![0]!) / s;
  } else if (r[1]![1]! > r[2]![2]!) {
    const s = Math.sqrt(1 + r[1]![1]! - r[0]![0]! - r[2]![2]!) * 2;
    w = (r[0]![2]! - r[2]![0]!) / s;
    x = (r[0]![1]! + r[1]![0]!) / s;
    y = s / 4;
    z = (r[1]![2]! + r[2]![1]!) / s;
  } else {
    const s = Math.sqrt(1 + r[2]![2]! - r[0]![0]! - r[1]![1]!) * 2;
    w = (r[1]![0]! - r[0]![1]!) / s;
    x = (r[0]![2]! + r[2]![0]!) / s;
    y = (r[1]![2]! + r[2]![1]!) / s;
    z = s / 4;
  }
  const n = Math.hypot(x, y, z, w);
  return n > 0 ? [x / n, y / n, z / n, w / n] : null;
}
