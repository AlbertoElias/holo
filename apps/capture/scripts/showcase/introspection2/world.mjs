import { deflateSync, crc32 } from 'node:zlib';

import { BufferAttribute } from 'three';

// World-space layers (third pass). The gas sprites, the paint streams and the
// pool are authored where the feed sees them, key by key, rather than as a
// home-sized layer grown by the zoom: the shapes are just each key's
// positions, one morph target per key, weighted by a uniform cubic B-spline
// whose weights sum to 1. So the base positions never show (any base will
// do, and the feed's dome fit sees only the base: keep it inside the skies'
// ball) and a mesh costs one target per key, not two.

const B3 = (x) => {
  const a = Math.abs(x);
  if (a >= 2) return 0;
  if (a >= 1) return ((2 - a) ** 3) / 6;
  return (4 - 6 * a * a + 3 * a ** 3) / 6;
};

/**
 * Keys in one or more uniform runs: [{ start, step, count }]. Returns the
 * key times in order and weights(t) over all of them. Inside a run the
 * B-spline blends that run's keys; before the first run, between runs and
 * after the last, the nearest run end holds (make those ends hidden poses).
 */
export function runs(list) {
  const times = [];
  const offsets = [];
  for (const r of list) {
    offsets.push(times.length);
    for (let i = 0; i < r.count; i += 1) times.push(r.start + i * r.step);
  }
  const n = times.length;
  const weights = (t) => {
    const w = new Array(n).fill(0);
    let j = list.findIndex((r) => t < r.start + (r.count - 1) * r.step);
    if (j < 0) {
      w[n - 1] = 1;
      return w;
    }
    const r = list[j];
    const o = offsets[j];
    const u = (t - r.start) / r.step;
    if (u <= 0) {
      w[o] = 1;
      return w;
    }
    const j0 = Math.floor(u);
    for (let k = j0 - 1; k <= j0 + 2; k += 1) w[o + Math.min(r.count - 1, Math.max(0, k))] += B3(u - k);
    return w;
  };
  return { times, weights };
}

/** Morph targets for a world layer: each key's positions (Float32Array) minus the base. */
export function worldMorph(geo, keys, weights0) {
  const base = geo.attributes.position.array;
  geo.morphAttributes.position = keys.map((k) => {
    const d = new Float32Array(base.length);
    for (let i = 0; i < base.length; i += 1) d[i] = k[i] - base[i];
    return new BufferAttribute(d, 3);
  });
  geo.morphTargetsRelative = true;
  geo.userData.weights = weights0;
  return geo;
}

/**
 * Drops the rows of a keyed weights track that linear interpolation already
 * gives exactly (equal to both neighbours). Returns { times, values }.
 */
export function sparseRows(times, rows) {
  const same = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-7);
  const keep = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (i === 0 || i === rows.length - 1 || !same(rows[i], rows[i - 1]) || !same(rows[i], rows[i + 1])) keep.push(i);
  }
  return { times: keep.map((i) => times[i]), values: keep.flatMap((i) => rows[i]) };
}

/** An RGBA PNG from fn(u, v) → [r, g, b, a] in 0..1 (v = 1 at the top). */
export function pngRGBA(width, height, fn) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x += 1) {
      const c = fn((x + 0.5) / width, 1 - (y + 0.5) / height);
      for (let k = 0; k < 4; k += 1) raw[y * stride + 1 + x * 4 + k] = Math.round(Math.min(1, Math.max(0, c[k])) * 255);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
