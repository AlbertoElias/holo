import { deflateSync, crc32 } from 'node:zlib';

import { BufferAttribute, BufferGeometry, Float32BufferAttribute } from 'three';

// Shapes keyed in time: a moving mesh is its positions at key times, one
// morph target each (relative to a base the keys never show), weighted by
// linear hats, so at most two targets are on at once and the glTF's own
// linear interpolation between key rows reproduces the motion exactly
// (keys on the 30 Hz grid). All weights stay in 0..1.

/**
 * Hat weights over sorted key times: between two keys the two blend
 * linearly; outside the first and last key every weight is 0 (the base
 * shows, so make it a hidden pose). With `cyclic`, keys are 0, step, …,
 * LOOP − step and the last blends back into the first at LOOP.
 */
export function hats(times, { cyclic = 0 } = {}) {
  const n = times.length;
  return (t) => {
    const w = new Array(n).fill(0);
    if (cyclic) {
      const u = ((t % cyclic) + cyclic) % cyclic;
      let i = n - 1;
      while (i > 0 && times[i] > u + 1e-9) i -= 1;
      const t1 = i === n - 1 ? cyclic : times[i + 1];
      const x = Math.min(1, Math.max(0, (u - times[i]) / (t1 - times[i])));
      w[i] += 1 - x;
      w[(i + 1) % n] += x;
      return w;
    }
    if (t < times[0] - 1e-9 || t > times[n - 1] + 1e-9) return w;
    let i = 0;
    while (i < n - 2 && times[i + 1] < t - 1e-9) i += 1;
    if (n === 1) {
      w[0] = 1;
      return w;
    }
    const x = Math.min(1, Math.max(0, (t - times[i]) / (times[i + 1] - times[i])));
    w[i] = 1 - x;
    w[i + 1] = x;
    return w;
  };
}

/** Key times from a to b (both on the 30 Hz grid) every `frames` frames, b included. */
export const gridKeys = (a, b, frames) => {
  const out = [];
  const fa = Math.round(a * 30);
  const fb = Math.round(b * 30);
  for (let f = fa; f < fb; f += frames) out.push(f / 30);
  out.push(fb / 30);
  return out;
};

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
 * Drops the rows of a keyed track that linear interpolation between their
 * neighbours already gives (keys evenly spaced, so a run of such rows is a
 * straight line). Returns { times, values } (values flat).
 */
export function linearRows(times, rows, eps = 1e-6) {
  const between = (a, b, c) => a.every((v, i) => Math.abs(b[i] - (v + c[i]) / 2) < eps);
  const keep = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (i === 0 || i === rows.length - 1 || !between(rows[i - 1], rows[i], rows[i + 1])) keep.push(i);
  }
  return { times: keep.map((i) => times[i]), values: keep.flatMap((i) => rows[i]) };
}

/** Scales a geometry's positions and morph deltas by k about the origin (built in view metres, drawn in layer units). */
export function scaleGeo(geo, k) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.array.length; i += 1) p.array[i] *= k;
  for (const d of geo.morphAttributes?.position ?? []) for (let i = 0; i < d.array.length; i += 1) d.array[i] *= k;
  p.needsUpdate = true;
  return geo;
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

/**
 * Packs short events into a few meshes ("slots"): within a group (one set of
 * vertex colours), greedily, so the events in a slot never overlap in time.
 * Each event is { group, times (on the grid, rising), keys (positions at
 * those times) }; its first and last key must draw nothing (zero-size), so
 * the slot shows nothing between its events and outside them.
 * template(group) → { base (a hidden pose), colour: [array, itemSize],
 * uv?, index }. Returns [{ group, geo, times, values }]: one target per key,
 * weighted one at a time (rows one-hot at each key, so linear interpolation
 * between keys reproduces the motion).
 */
export function slotMeshes(events, template) {
  const slots = [];
  for (const e of [...events].sort((a, b) => a.times[0] - b.times[0])) {
    const slot = slots.find((s) => s.group === e.group && s.end < e.times[0] - 1e-6);
    if (slot) {
      slot.events.push(e);
      slot.end = e.times.at(-1);
    } else slots.push({ group: e.group, events: [e], end: e.times.at(-1) });
  }
  return slots.map(({ group, events: list }) => {
    const t = template(group);
    const keys = list.flatMap((e) => e.keys);
    const n = keys.length;
    const times = [];
    const values = [];
    let at = 0;
    for (const e of list) {
      e.times.forEach((time, j) => {
        times.push(time);
        const row = new Array(n).fill(0);
        row[at + j] = 1;
        values.push(...row);
      });
      at += e.times.length;
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(t.base, 3));
    geo.setAttribute('color', new Float32BufferAttribute(t.colour[0], t.colour[1]));
    if (t.uv) geo.setAttribute('uv', new Float32BufferAttribute(t.uv, 2));
    geo.setIndex(t.index);
    worldMorph(geo, keys, values.slice(0, n));
    return { group, geo, times, values, events: list.length };
  });
}
