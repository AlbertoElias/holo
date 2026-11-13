import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  SphereGeometry,
  Vector3
} from 'three';

import { linear } from '../lib/glb.mjs';

// Shared layout and helpers for "The way down" (introspection.mjs).
//
// The piece is a round diorama around a central well. Four quarters face
// outward, each a step lower than the last, turning clockwise seen from
// above: the man's stage (the feed's first view looks at it), then the gas
// room, the liquid room and the dark core. Every quarter is authored in its
// own frame: origin on its floor at radius ROOM_R, +z pointing out of the
// diorama at the viewer, +x toward the next quarter (left to right as you
// look in), +y up.

export const LOOP = 60;
export const FPS = 24;
export const PI = Math.PI;

export const R_IN = 0.55; // the well
export const R_OUT = 2.6;
export const ROOM_R = 1.6;
export const WALL_T = 0.08;

/** Each quarter's centre yaw (degrees; yaw 0 is +z), floor height and name. */
export const ROOMS = {
  stage: { yaw: 18, floor: 0.9 },
  gas: { yaw: 108, floor: 0.6 },
  liquid: { yaw: 198, floor: 0.3 },
  core: { yaw: 288, floor: 0.02 }
};

// The feed's first view: the camera's direction from the target (yaw 18°,
// pitch 16°), the target and the distance, as measured on a local feed.
export const FEED_DIR = [0.297, 0.276, 0.914];
export const FEED_T = [0, 1.776, 0];
export const FEED_D = 12.59;
export const EYE = FEED_T.map((v, i) => v + FEED_DIR[i] * FEED_D);

export const rad = (deg) => (deg * PI) / 180;
export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const mix = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** 1 inside [a, b] with smooth `ramp`-second edges, 0 outside. */
export const window = (a, b, x, ramp = 0.4) => smooth(a - ramp, a, x) * (1 - smooth(b, b + ramp, x));
export const wrap = (t) => ((t % LOOP) + LOOP) % LOOP;

/** Piecewise smootherstep through [t, value] keys, flat at each key and outside. */
export function K(keys) {
  return (t) => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 0; i < keys.length - 1; i += 1) {
      const [a, va] = keys[i];
      const [b, vb] = keys[i + 1];
      if (t <= b) {
        const x = clamp((t - a) / (b - a || 1));
        return va + (vb - va) * x * x * x * (x * (x * 6 - 15) + 10);
      }
    }
    return keys[keys.length - 1][1];
  };
}

/** A quarter's frame: local (x, y, z) to world, and a local yaw to world. */
export function frame(room) {
  const { yaw, floor } = ROOMS[room];
  const th = rad(yaw);
  const c = Math.cos(th);
  const s = Math.sin(th);
  const ox = ROOM_R * s;
  const oz = ROOM_R * c;
  return {
    room,
    yaw: th,
    floor,
    /** World point from local (x along the room, y above its floor, z outward). */
    at: (x, y, z) => new Vector3(ox + x * c + z * s, floor + y, oz - x * s + z * c),
    /** World yaw of a direction given as a local yaw (0 = facing out of the room). */
    yawOf: (localYaw) => th + localYaw,
    origin: [ox, floor, oz],
    rotation: [0, Math.sin(th / 2), 0, Math.cos(th / 2)]
  };
}

export const lin = (hex) => (Array.isArray(hex) ? hex : linear(hex));

/** Hex to linear RGB, mixed: t = 0 gives a, 1 gives b. */
export function blend(a, b, t) {
  const A = lin(a);
  const B = lin(b);
  return [mix(A[0], B[0], t), mix(A[1], B[1], t), mix(A[2], B[2], t)];
}

export function box(x0, x1, y0, y1, z0, z1) {
  const g = new BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

export function cyl(r0, r1, h, x, y, z, seg = 20, open = false) {
  const g = new CylinderGeometry(r0, r1, h, seg, 1, open);
  g.translate(x, y + h / 2, z);
  return g;
}

export function sphere(r, x, y, z, sx = 1, sy = 1, sz = 1, ws = 16, hs = 12) {
  const g = new SphereGeometry(r, ws, hs);
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return g;
}

/**
 * Bakes light into vertex colours for an unlit material: a key light, an
 * ambient floor, and an optional per-vertex tint `glow(x, y, z)` added in
 * linear RGB (lamps, the hug's warmth).
 */
export function bake(geo, hex, { light = new Vector3(0.4, 0.8, 0.45).normalize(), amb = 0.55, glow, gain = 1, shade } = {}) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (!g.attributes.normal) g.computeVertexNormals();
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const base = typeof hex === 'function' ? null : lin(hex).map((v) => v * gain);
  const colors = new Float32Array(pos.count * 3);
  const n = new Vector3();
  for (let i = 0; i < pos.count; i += 1) {
    n.fromBufferAttribute(nor, i);
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const k = amb + (1 - amb) * Math.max(0, n.dot(light));
    const c = base ?? hex(x, y, z).map((v) => v * gain);
    const add = glow ? glow(x, y, z) : [0, 0, 0];
    const m = shade ? shade(x, y, z) : 1;
    colors.set([c[0] * k * m + add[0], c[1] * k * m + add[1], c[2] * k * m + add[2]], i * 3);
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(Array.from(pos.array), 3));
  out.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return out;
}

/** Flat vertex colour (for lit materials), normals kept. */
export function flat(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g.attributes.uv) g.deleteAttribute('uv');
  if (!g.attributes.normal) g.computeVertexNormals();
  const c = typeof hex === 'string' ? lin(hex) : hex;
  const colors = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < g.attributes.position.count; i += 1) colors.set(c, i * 3);
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return g;
}

/** Triangles with per-vertex colours, for hand-built surfaces. */
export class Paint {
  constructor() {
    this.p = [];
    this.c = [];
  }

  tri(a, b, c, ca, cb = ca, cc = ca) {
    this.p.push(...a, ...b, ...c);
    this.c.push(...ca, ...cb, ...cc);
  }

  quad(a, b, c, d, ca, cb = ca, cc = ca, cd = ca) {
    this.tri(a, b, c, ca, cb, cc);
    this.tri(a, c, d, ca, cc, cd);
  }

  geometry() {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.c, 3));
    return g;
  }
}

/** World point at yaw (radians) and radius on the diorama, at height y. */
export const polar = (yaw, r, y) => [r * Math.sin(yaw), y, r * Math.cos(yaw)];

/**
 * A ring-sector solid (a quarter's plinth): yaws a0..a1, radii r0..r1,
 * heights y0..y1, coloured by `color(face, x, y, z)` in linear RGB.
 */
export function sector(paint, { a0, a1, r0, r1, y0, y1, seg = 24, color, top = true, outer = true, inner = true, sides = true }) {
  for (let i = 0; i < seg; i += 1) {
    const u0 = mix(a0, a1, i / seg);
    const u1 = mix(a0, a1, (i + 1) / seg);
    const P = (u, r, y) => polar(u, r, y);
    const C = (face, p) => color(face, p[0], p[1], p[2]);
    if (top) {
      const a = P(u0, r0, y1);
      const b = P(u0, r1, y1);
      const c = P(u1, r1, y1);
      const d = P(u1, r0, y1);
      paint.quad(a, b, c, d, C('top', a), C('top', b), C('top', c), C('top', d));
    }
    if (outer) {
      const a = P(u0, r1, y1);
      const b = P(u0, r1, y0);
      const c = P(u1, r1, y0);
      const d = P(u1, r1, y1);
      paint.quad(a, b, c, d, C('outer', a), C('outer', b), C('outer', c), C('outer', d));
    }
    if (inner) {
      const a = P(u0, r0, y0);
      const b = P(u0, r0, y1);
      const c = P(u1, r0, y1);
      const d = P(u1, r0, y0);
      paint.quad(a, b, c, d, C('inner', a), C('inner', b), C('inner', c), C('inner', d));
    }
  }
  if (sides) {
    for (const [u, flip] of [[a0, false], [a1, true]]) {
      const a = polar(u, r0, y0);
      const b = polar(u, r1, y0);
      const c = polar(u, r1, y1);
      const d = polar(u, r0, y1);
      const q = flip ? [a, b, c, d] : [a, d, c, b];
      paint.quad(...q, ...q.map((p) => color('side', p[0], p[1], p[2])));
    }
  }
}

/** Track `fn(t)` on the clip's shared times at `fps`. */
export function keys(fps, fn) {
  const count = Math.round(LOOP * fps);
  const times = [];
  const values = [];
  for (let i = 0; i <= count; i += 1) {
    const t = (i / count) * LOOP;
    times.push(t);
    values.push(...fn(t));
  }
  return { times, values };
}

/** Quaternion list with sign continuity, flattened. */
export function quatTrack(list) {
  const values = [];
  let prev = null;
  for (let q of list) {
    if (prev && prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3] < 0) q = q.map((v) => -v);
    values.push(...q);
    prev = q;
  }
  return values;
}

/** Yaw (radians about +y) as a glTF quaternion. */
export const yawQ = (y) => [0, Math.sin(y / 2), 0, Math.cos(y / 2)];

/** Never a zero scale: the viewer's bounds and some exporters dislike it. */
export const tiny = (s) => Math.max(1e-4, s);

// Shared beats, so the rooms and the traveller stay in step.
/** When pastel gases collide next to the traveller (it ducks). */
export const GAS_CLASHES = [11.3, 13.9, 16.8, 18.9];
/** The liquid room's crash period and first crash: 1.5 + 5n s. */
export const CRASH_PERIOD = LOOP / 12;
export const CRASH_AT = 1.5;
/** The hug, and the light that grows from it. */
export const HUG = { open: 46.4, hold: 48.2, peak: 54, fade: 57.2, gone: 59.4 };
