import { BufferGeometry, Float32BufferAttribute } from 'three';

// Motion for still, morph-targeted layers (see zoom.mjs). A layer's moving
// shape is sampled at key times as whole vertex positions, and played back as
// a uniform cubic B-spline through those keys: every vertex follows a smooth
// (C2) path, the weights always sum to 1, and at most four keys are blended at
// once. The keys can come from a simulation (curl-noise advection for the
// gas), from authored poses (the paint waves), or from the figure's limbs (the
// wisps and paint ropes that hold him).

// ---------------------------------------------------------------------------
// Noise: Perlin's improved gradient noise, seeded.

export function noise3(seed = 1) {
  const p = new Uint8Array(512);
  const perm = Array.from({ length: 256 }, (_, i) => i);
  let s = seed >>> 0 || 1;
  for (let i = 255; i > 0; i -= 1) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  for (let i = 0; i < 512; i += 1) p[i] = perm[i & 255];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (t, a, b) => a + t * (b - a);
  const grad = (h, x, y, z) => {
    const k = h & 15;
    const u = k < 8 ? x : y;
    const v = k < 4 ? y : k === 12 || k === 14 ? x : z;
    return ((k & 1) === 0 ? u : -u) + ((k & 2) === 0 ? v : -v);
  };
  return (x, y, z) => {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const Z = Math.floor(z) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    z -= Math.floor(z);
    const u = fade(x);
    const v = fade(y);
    const w = fade(z);
    const A = p[X] + Y;
    const AA = p[A] + Z;
    const AB = p[A + 1] + Z;
    const B = p[X + 1] + Y;
    const BA = p[B] + Z;
    const BB = p[B + 1] + Z;
    return lerp(w,
      lerp(v, lerp(u, grad(p[AA], x, y, z), grad(p[BA], x - 1, y, z)), lerp(u, grad(p[AB], x, y - 1, z), grad(p[BB], x - 1, y - 1, z))),
      lerp(v, lerp(u, grad(p[AA + 1], x, y, z - 1), grad(p[BA + 1], x - 1, y, z - 1)), lerp(u, grad(p[AB + 1], x, y - 1, z - 1), grad(p[BB + 1], x - 1, y - 1, z - 1))));
  };
}

/** Fractal noise: `octaves` of n, each twice the frequency and half the amplitude. */
export const fbm = (n, octaves = 4) => (x, y, z) => {
  let a = 0.5;
  let f = 1;
  let s = 0;
  for (let i = 0; i < octaves; i += 1) {
    s += a * n(x * f, y * f, z * f);
    a *= 0.5;
    f *= 2.03;
  }
  return s;
};

/**
 * A divergence-free turbulent velocity field: the curl of a vector potential
 * made of three offset noise fields, with two octaves for eddies inside eddies.
 * `scale` is the size of the largest eddy; the field drifts in time with `t`.
 */
export function curlField(seed, scale) {
  const n = [noise3(seed), noise3(seed + 101), noise3(seed + 202)];
  const psi = (k, x, y, z, t) => {
    const f = 1 / scale;
    return n[k](x * f + 0.31 * t, y * f - 0.17 * t, z * f + 0.23 * t) + 0.45 * n[k](x * f * 2.3 - 0.4 * t, y * f * 2.3 + 0.5 * t, z * f * 2.3);
  };
  const e = scale * 1e-3;
  return (x, y, z, t) => {
    const d = (k, ax) => {
      const a = [x, y, z];
      const b = [x, y, z];
      a[ax] += e;
      b[ax] -= e;
      return (psi(k, ...a, t) - psi(k, ...b, t)) / (2 * e);
    };
    // curl ψ = (∂ψz/∂y − ∂ψy/∂z, ∂ψx/∂z − ∂ψz/∂x, ∂ψy/∂x − ∂ψx/∂y), in units of 1/scale.
    return [d(2, 1) - d(1, 2), d(0, 2) - d(2, 0), d(1, 0) - d(0, 1)].map((v) => v * scale);
  };
}

// ---------------------------------------------------------------------------
// Keyed shapes.

const B3 = (x) => {
  const a = Math.abs(x);
  if (a >= 2) return 0;
  if (a >= 1) return ((2 - a) ** 3) / 6;
  return (4 - 6 * a * a + 3 * a ** 3) / 6;
};

/**
 * A keyed track: vertex positions sampled at `count` keys, `step` seconds
 * apart from `start`. Returns the shapes (each key minus the base positions)
 * and weights(t), the B-spline's weight on each key. Before the first key
 * and after the last, the track holds that key.
 */
export function keyTrack(base, start, step, keys) {
  const shapes = keys.map((k) => {
    const d = new Float32Array(base.length);
    for (let i = 0; i < base.length; i += 1) d[i] = k[i] - base[i];
    return d;
  });
  const n = keys.length;
  const weights = (t) => {
    const w = new Array(n).fill(0);
    const u = (t - start) / step;
    if (u <= 0) w[0] = 1;
    else if (u >= n - 1) w[n - 1] = 1;
    else {
      const j0 = Math.floor(u);
      for (let j = j0 - 1; j <= j0 + 2; j += 1) w[Math.min(n - 1, Math.max(0, j))] += B3(u - j);
    }
    return w;
  };
  return { shapes, weights, start, step, count: n };
}

/** Times of a keyed track covering [a, b] at `step`. */
export const keyTimes = (a, b, step) => Array.from({ length: Math.ceil((b - a) / step - 1e-9) + 1 }, (_, i) => a + i * step);

// ---------------------------------------------------------------------------
// Tubes: wisps of gas and ropes of paint, as a fixed ring-and-segment topology
// whose vertex positions are recomputed from a centreline per key.

/** Vertex positions (Float32Array) of a tube along `line` (points) with radius r(u), u in 0..1. */
export function tubePositions(line, r, segs) {
  const out = new Float32Array(tubeCount(line.length, segs) * 3);
  let at = 0;
  let prevN = null;
  const n = line.length;
  for (let i = 0; i < n; i += 1) {
    const a = line[Math.max(0, i - 1)];
    const b = line[Math.min(n - 1, i + 1)];
    let T = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let l = Math.hypot(...T);
    if (l < 1e-9) T = [0, 1, 0];
    else T = T.map((v) => v / l);
    // A parallel-transported normal, so the rings don't twist.
    let N = prevN ?? (Math.abs(T[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
    const dot = N[0] * T[0] + N[1] * T[1] + N[2] * T[2];
    N = N.map((v, k) => v - dot * T[k]);
    l = Math.hypot(...N);
    N = l < 1e-9 ? (Math.abs(T[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]) : N.map((v) => v / l);
    prevN = N;
    const Bv = [T[1] * N[2] - T[2] * N[1], T[2] * N[0] - T[0] * N[2], T[0] * N[1] - T[1] * N[0]];
    const rad = r(i / (n - 1));
    for (let j = 0; j < segs; j += 1) {
      const ang = (j / segs) * 2 * Math.PI;
      const c = Math.cos(ang) * rad;
      const s = Math.sin(ang) * rad;
      for (let k = 0; k < 3; k += 1) out[at++] = line[i][k] + c * N[k] + s * Bv[k];
    }
  }
  // Tip cap.
  for (let k = 0; k < 3; k += 1) out[at++] = line[n - 1][k];
  return out;
}
const tubeCount = (rings, segs) => rings * segs + 1;

/** The tube's triangles, for `rings` rings of `segs`. */
export function tubeGeometry(positions, rings, segs) {
  const idx = [];
  for (let i = 0; i < rings - 1; i += 1) {
    for (let j = 0; j < segs; j += 1) {
      const a = i * segs + j;
      const b = i * segs + ((j + 1) % segs);
      const c = a + segs;
      const d = b + segs;
      idx.push(a, c, b, b, c, d);
    }
  }
  const tip = rings * segs;
  for (let j = 0; j < segs; j += 1) idx.push((rings - 1) * segs + j, tip, (rings - 1) * segs + ((j + 1) % segs));
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setIndex(idx);
  return g;
}
