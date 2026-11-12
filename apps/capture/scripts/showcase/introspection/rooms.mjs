import { CircleGeometry, CylinderGeometry, Matrix4, Quaternion, SphereGeometry, TorusGeometry, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { fbm3, rng } from '../lib/parts.mjs';
import { T } from '../lib/tokens.mjs';
import {
  CRASH_AT, CRASH_PERIOD, GAS_CLASHES, HUG, LOOP, PI, R_IN, R_OUT, ROOMS, WALL_T,
  Paint, bake, blend, box, clamp, cyl, frame, lin, mix, polar, rad, sector, smooth, sphere, tiny, window, wrap
} from './common.mjs';

// The four layers' places, each in its own quarter frame (see common.mjs),
// plus the plinths, partitions and the well they turn around.

const LIGHT = new Vector3(0.35, 0.8, 0.5).normalize();

// The feed frames a piece by each mesh's box in world space, taken from its
// local box. A big static mesh under a turned room frame has its box corners
// swung out past the rim (3.04 m for a 2.6 m diorama), which on a narrow card,
// where width decides the distance, would push the camera back; so each
// room's static set is baked into world space and hung from the scene.
const WORLD = { scene: null, room: null };
function worldMesh(glb, name, geometry, material) {
  const F = frame(WORLD.room);
  const m = new Matrix4().compose(new Vector3(...F.origin), new Quaternion(...F.rotation), new Vector3(1, 1, 1));
  glb.node({ name, mesh: glb.mesh(name, geometry.applyMatrix4(m), material), parent: WORLD.scene });
}

// Shared key times per sampling rate: one accessor each in the file.
const TIMES = {};
function track(fps, fn) {
  const count = Math.round(LOOP * fps);
  if (!TIMES[fps]) TIMES[fps] = Array.from({ length: count + 1 }, (_, i) => (i / count) * LOOP);
  const values = [];
  for (const t of TIMES[fps]) values.push(...fn(t));
  return { times: TIMES[fps], values };
}
function animate(glb, node, path, fps, fn) {
  const { times, values } = track(fps, fn);
  glb.animate(node, path, times, values);
}

const qAxis = (x, y, z, a) => new Quaternion().setFromAxisAngle(new Vector3(x, y, z).normalize(), a).toArray();
const qEuler = (x, y, z) => {
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), z);
  q.premultiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), x));
  q.premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), y));
  return q.toArray();
};

/** World (x, z) to a room's local (x, z). */
function toLocal(F, wx, wz) {
  const dx = wx - F.origin[0];
  const dz = wz - F.origin[2];
  const c = Math.cos(F.yaw);
  const s = Math.sin(F.yaw);
  return [dx * c - dz * s, dx * s + dz * c];
}

/** A room's floor as a fine polar grid, each face one flat colour from `color(x, z, r)` (local). */
function floorTop(paint, room, color, { rs = 30, us = 54 } = {}) {
  const F = frame(room);
  const a0 = rad(ROOMS[room].yaw - 45);
  const a1 = rad(ROOMS[room].yaw + 45);
  const y = F.floor;
  for (let i = 0; i < us; i += 1) {
    for (let k = 0; k < rs; k += 1) {
      const u0 = mix(a0, a1, i / us);
      const u1 = mix(a0, a1, (i + 1) / us);
      const r0 = mix(R_IN, R_OUT, k / rs);
      const r1 = mix(R_IN, R_OUT, (k + 1) / rs);
      // Built in the room's own frame (its node carries the room's place).
      const loc = (u, r) => { const w = polar(u, r, y); const [lx, lz] = toLocal(F, w[0], w[2]); return [lx, 0, lz]; };
      const a = loc(u0, r0);
      const b = loc(u0, r1);
      const c = loc(u1, r1);
      const d = loc(u1, r0);
      const col = color((a[0] + c[0]) / 2, (a[2] + c[2]) / 2, (r0 + r1) / 2);
      paint.quad(a, b, c, d, col);
    }
  }
}

const shadeK = (n) => 0.55 + 0.45 * Math.max(0, n.dot(LIGHT));

// ---------------------------------------------------------------------------
// The structure: plinths, partitions and the well.

export function structure() {
  const paint = new Paint();
  const skirt = { stage: '#2f6f73', gas: '#cbb6e6', liquid: '#5a1a20', core: '#121018' };
  for (const [room, { yaw, floor }] of Object.entries(ROOMS)) {
    if (floor > 0.001) {
      sector(paint, {
        a0: rad(yaw - 45), a1: rad(yaw + 45), r0: R_IN, r1: R_OUT, y0: 0, y1: floor, seg: 36, top: false, inner: false, sides: false,
        color: (face, x, y) => lin(skirt[room]).map((v) => v * (0.62 + 0.38 * (y / floor)))
      });
    }
  }
  // Partitions: section cuts through the man, taller toward the well.
  const names = Object.keys(ROOMS);
  for (let i = 0; i < 4; i += 1) {
    const a = ROOMS[names[i]];
    const b = ROOMS[names[(i + 1) % 4]];
    const yaw = rad(a.yaw + 45);
    const lo = Math.min(a.floor, b.floor);
    const hi = Math.max(a.floor, b.floor);
    const seg = 10;
    const off = (sgn) => [Math.cos(yaw) * sgn * WALL_T * 0.5, -Math.sin(yaw) * sgn * WALL_T * 0.5];
    const top = (r) => hi + mix(0.95, 0.12, smooth(0, 1, (r - R_IN) / (R_OUT - R_IN)));
    const side = '#3a3340';
    const edge = '#d9c9a8';
    for (let k = 0; k < seg; k += 1) {
      const r0 = mix(R_IN, R_OUT, k / seg);
      const r1 = mix(R_IN, R_OUT, (k + 1) / seg);
      for (const sgn of [1, -1]) {
        const [ox, oz] = off(sgn);
        const p = (r, y) => { const q = polar(yaw, r, y); return [q[0] + ox, y, q[2] + oz]; };
        const shade = (y) => lin(side).map((v) => v * (0.7 + 0.5 * clamp((y - lo) / 2)));
        paint.quad(p(r0, 0), p(r1, 0), p(r1, top(r1)), p(r0, top(r0)), shade(0), shade(0), shade(top(r1)), shade(top(r0)));
      }
      const [ax, az] = off(1);
      const [bx, bz] = off(-1);
      const pa = (r) => { const q = polar(yaw, r, top(r)); return [q[0] + ax, top(r), q[2] + az]; };
      const pb = (r) => { const q = polar(yaw, r, top(r)); return [q[0] + bx, top(r), q[2] + bz]; };
      paint.quad(pa(r0), pa(r1), pb(r1), pb(r0), lin(edge));
    }
    const [ax, az] = off(1);
    const [bx, bz] = off(-1);
    const q0 = polar(yaw, R_OUT, 0);
    const q1 = polar(yaw, R_OUT, top(R_OUT));
    paint.quad([q0[0] + ax, 0, q0[2] + az], [q0[0] + bx, 0, q0[2] + bz], [q1[0] + bx, q1[1], q1[2] + bz], [q1[0] + ax, q1[1], q1[2] + az], lin(side));
  }
  // The well: the man's core, cream at the top where the stage is, black at the foot.
  const well = new CylinderGeometry(R_IN - 0.01, R_IN + 0.03, 3.1, 48, 24, false);
  well.translate(0, 1.55, 0);
  const wellGeo = bake(well, (x, y) => blend('#120f16', '#efe2c6', smooth(0.1, 3.1, y) ** 1.4), { light: LIGHT, amb: 0.75 });
  // A cap ring at the top, gold: where the light returns.
  const cap = bake(new TorusGeometry(R_IN + 0.01, 0.025, 8, 48).rotateX(PI / 2).translate(0, 3.1, 0), T.gold, { amb: 0.8 });
  return mergeGeometries([paint.geometry(), wellGeo, cap]);
}

// ---------------------------------------------------------------------------
// Trap doors and portal rings, shared by the layers.

/**
 * A trap door in a room's floor at local (x, z): frame, a hole lit with
 * the next layer's colour, and a lid hinged on its +x edge.
 */
function trapDoor(glb, mats, parent, { x, z, size = 0.46, wood, frameHex, below, open, close }) {
  const h = size / 2;
  const geos = [
    bake(box(x - h, x + h, 0.001, 0.004, z - h, z + h), below, { amb: 1 }),
    bake(box(x - h - 0.03, x + h + 0.03, 0, 0.02, z - h - 0.03, z - h), frameHex, { light: LIGHT }),
    bake(box(x - h - 0.03, x + h + 0.03, 0, 0.02, z + h, z + h + 0.03), frameHex, { light: LIGHT }),
    bake(box(x - h - 0.03, x - h, 0, 0.02, z - h, z + h), frameHex, { light: LIGHT }),
    bake(box(x + h, x + h + 0.03, 0, 0.02, z - h, z + h), frameHex, { light: LIGHT })
  ];
  glb.node({ name: 'trapdoor-frame', mesh: glb.mesh('trapdoor-frame', mergeGeometries(geos), mats.painted), parent });
  const planks = [];
  for (let i = 0; i < 4; i += 1) {
    const z0 = -h + (i * size) / 4;
    planks.push(bake(box(-size, 0, 0, 0.022, z0 + 0.004, z0 + size / 4 - 0.004), i % 2 ? wood : blend(wood, '#000000', 0.12), { light: LIGHT }));
  }
  planks.push(bake(box(-size * 0.62, -size * 0.52, 0.022, 0.034, -0.05, 0.05), '#d8b765', { light: LIGHT }));
  const lid = glb.node({ name: 'trapdoor-lid', mesh: glb.mesh('trapdoor-lid', mergeGeometries(planks), mats.painted), translation: [x + h, 0.004, z], parent });
  animate(glb, lid, 'rotation', 24, (t) => {
    const a = 1.95 * smooth(open[0], open[1], t) * (1 - smooth(close[0], close[1], t));
    return qAxis(0, 0, 1, -a);
  });
  // Light from below while it is open.
  const glow = glb.node({
    name: 'trapdoor-glow',
    mesh: glb.mesh('trapdoor-glow', bake(cyl(h * 0.95, h * 0.6, 0.5, 0, 0, 0, 4, true).rotateY(PI / 4), below, { amb: 1 }), mats.glow),
    translation: [x, 0.005, z],
    parent
  });
  animate(glb, glow, 'scale', 12, (t) => {
    const k = tiny(smooth(open[0], open[1], t) * (1 - smooth(close[0] - 0.4, close[1], t)));
    return [1, k, 1];
  });
}

/** The portal a traveller arrives through: a ring of light overhead that opens when it comes. */
function portalRing(glb, mats, parent, { x, y, z, hex, active, spin = 0.6, dark = false }) {
  const ring = mergeGeometries([
    bake(new TorusGeometry(0.26, 0.022, 10, 40).rotateX(PI / 2), hex, { amb: 1 }),
    bake(new TorusGeometry(0.19, 0.008, 6, 40).rotateX(PI / 2), dark ? '#0a0810' : '#ffffff', { amb: 1 })
  ]);
  const disc = new CircleGeometry(0.25, 40).rotateX(PI / 2);
  const node = glb.node({ name: 'portal', translation: [x, y, z], parent });
  const spinNode = glb.node({ name: 'portal-ring', mesh: glb.mesh('portal-ring', ring, mats.painted), parent: node });
  glb.node({ name: 'portal-disc', mesh: glb.mesh('portal-disc', bake(disc, dark ? '#05040a' : hex, { amb: 1 }), dark ? mats.painted : mats.glow), parent: spinNode });
  animate(glb, node, 'scale', 12, (t) => {
    const k = 0.45 + 0.55 * window(active[0], active[1], t, 0.7);
    return [k, k, k];
  });
  animate(glb, spinNode, 'rotation', 12, (t) => qAxis(0, 1, 0, (2 * PI * spin * t) % (2 * PI)));
}

// ---------------------------------------------------------------------------
// Layer 1: the stage. A house front on a film set, a lawn, a picket fence:
// everything as it should be, from the front.

function stageRoom(glb, mats, parent) {
  const F = frame('stage');
  const paint = new Paint();
  floorTop(paint, 'stage', (x, z, r) => {
    if (z < -0.56) return lin('#bf9d6c').map((v) => v * (0.9 + 0.1 * Math.sin(x * 40)));
    if (Math.abs(x + 0.42) < 0.11 && z < 0.95) return lin('#e9dcc0');
    const stripe = Math.floor((r - 1.1) / 0.14) % 2 === 0;
    const n = fbm3(x * 4, 0, z * 4, { seed: 3 });
    return blend(stripe ? '#6fa35a' : '#82b468', '#5e8f4b', n * 0.5);
  });
  const geos = [paint.geometry()];
  const L = (g, hex, o = {}) => geos.push(bake(g, hex, { light: LIGHT, ...o }));

  // The flat: plywood behind, clapboard in front.
  const zf = -0.55;
  L(box(-0.86, 0.86, 0, 1.46, zf - 0.04, zf), '#c9a878');
  for (let y = 0.06, i = 0; y < 1.44; y += 0.072, i += 1) {
    L(box(-0.85, 0.85, y, y + 0.074, zf, zf + 0.012 + 0.006 * (i % 2)), i % 2 ? '#a8d5c2' : '#9ccbb7');
  }
  // Gable and roof.
  const g = new Paint();
  const gable = lin('#a8d5c2');
  g.tri([-0.86, 1.46, zf + 0.004], [0.86, 1.46, zf + 0.004], [0, 2.02, zf + 0.004], gable, gable, lin('#b8ded0'));
  g.tri([0.86, 1.46, zf - 0.04], [-0.86, 1.46, zf - 0.04], [0, 2.02, zf - 0.04], lin('#c9a878'));
  geos.push(g.geometry());
  for (const sgn of [-1, 1]) {
    const len = Math.hypot(0.96, 0.6);
    const roof = box(-len / 2, len / 2, 0, 0.035, zf - 0.08, zf + 0.06);
    roof.rotateZ(-sgn * Math.atan2(0.6, 0.96));
    roof.translate(sgn * 0.45, 1.75, 0);
    L(roof, '#56656f');
  }
  L(box(0.36, 0.5, 1.6, 2.15, zf - 0.06, zf + 0.06), '#b5523b');
  L(box(0.34, 0.52, 2.15, 2.18, zf - 0.07, zf + 0.07), '#8f3f2e');
  // A TV antenna: the decade's sign of having arrived.
  L(cyl(0.006, 0.006, 0.32, -0.05, 2.0, zf, 6), '#3a3a40');
  for (const [y, w] of [[2.24, 0.26], [2.29, 0.2], [2.315, 0.12]]) L(box(-0.05 - w / 2, -0.05 + w / 2, y, y + 0.008, zf - 0.004, zf + 0.004), '#3a3a40');
  // Trim, the door and its step, the lamp.
  for (const [x0, x1, y0, y1] of [[-0.86, -0.82, 0, 1.46], [0.82, 0.86, 0, 1.46], [-0.86, 0.86, 1.42, 1.48]]) L(box(x0, x1, y0, y1, zf, zf + 0.03), '#f4ead2');
  L(box(-0.58, -0.27, 0, 0.9, zf + 0.012, zf + 0.03), '#f4ead2');
  L(box(-0.555, -0.295, 0, 0.865, zf + 0.03, zf + 0.04), '#e0705a');
  L(box(-0.53, -0.32, 0.5, 0.82, zf + 0.04, zf + 0.046), '#ea8a74');
  L(box(-0.53, -0.32, 0.08, 0.44, zf + 0.04, zf + 0.046), '#ea8a74');
  L(sphere(0.014, -0.33, 0.45, zf + 0.055), '#d8b765', { amb: 0.9 });
  L(box(-0.62, -0.23, 0, 0.05, zf + 0.04, zf + 0.2), '#e9dcc0');
  L(box(-0.6, -0.25, 0.05, 0.09, zf + 0.04, zf + 0.12), '#e9dcc0');
  L(box(-0.665, -0.635, 0.86, 0.94, zf + 0.02, zf + 0.05), '#3a3a40');
  L(sphere(0.038, -0.65, 0.97, zf + 0.07, 1, 1.25, 1), '#ffe2a0', { amb: 1, gain: 1.2 });
  // The window: warm light inside, curtains, a flower box.
  L(box(0.03, 0.57, 0.42, 1.08, zf + 0.012, zf + 0.034), '#f4ead2');
  L(box(0.06, 0.54, 0.45, 1.05, zf + 0.034, zf + 0.04), '#ffd88a', { amb: 1, gain: 1.1 });
  L(box(0.06, 0.16, 0.45, 1.05, zf + 0.04, zf + 0.05), '#f2a7a0', { amb: 0.85 });
  L(box(0.44, 0.54, 0.45, 1.05, zf + 0.04, zf + 0.05), '#f2a7a0', { amb: 0.85 });
  L(box(0.295, 0.305, 0.45, 1.05, zf + 0.04, zf + 0.052), '#f4ead2');
  L(box(0.06, 0.54, 0.745, 0.755, zf + 0.04, zf + 0.052), '#f4ead2');
  L(box(0.02, 0.58, 0.33, 0.42, zf + 0.03, zf + 0.12), '#f4ead2');
  const rand = rng(11);
  for (let i = 0; i < 11; i += 1) L(sphere(0.026, 0.05 + i * 0.048, 0.44, zf + 0.08 + 0.02 * rand(), 1, 0.9, 1, 8, 6), i % 3 ? '#e0705a' : '#f6c94a', { amb: 0.8 });
  for (let i = 0; i < 6; i += 1) L(sphere(0.04, 0.07 + i * 0.09, 0.42, zf + 0.08, 1, 0.7, 1, 8, 6), '#4e8a46');
  // Round gable window, dark.
  L(new CylinderGeometry(0.07, 0.07, 0.02, 24).rotateX(PI / 2).translate(0, 1.7, zf + 0.012), '#f4ead2');
  L(new CylinderGeometry(0.055, 0.055, 0.02, 24).rotateX(PI / 2).translate(0, 1.7, zf + 0.02), '#2b3a44');
  // Behind the flat: the struts that hold it up. Turn round and it is a set.
  for (const x of [-0.7, -0.1, 0.5]) {
    const len = Math.hypot(1.3, 0.34);
    const s = box(-0.02, 0.02, 0, len, -0.02, 0.02);
    s.rotateX(-Math.atan2(0.34, 1.3));
    s.translate(x, 0, zf - 0.38);
    L(s, '#9c7b52');
    L(box(x - 0.06, x + 0.06, 0, 0.03, zf - 0.44, zf - 0.32), '#7a5c3a');
  }
  L(box(-0.86, 0.86, 0.68, 0.72, zf - 0.07, zf - 0.04), '#9c7b52');
  // Shrubs either side of the door; a hedge line.
  for (const [x, z, r] of [[-0.74, zf + 0.12, 0.13], [-0.16, zf + 0.12, 0.1], [0.68, zf + 0.12, 0.14], [0.78, zf + 0.28, 0.1]]) {
    const s = new SphereGeometry(r, 16, 12);
    const p = s.attributes.position;
    for (let i = 0; i < p.count; i += 1) {
      const k = 0.85 + 0.3 * fbm3(p.getX(i) * 18 + x * 9, p.getY(i) * 18, p.getZ(i) * 18, { seed: 5 });
      p.setXYZ(i, p.getX(i) * k + x, Math.max(0, p.getY(i) * k * 0.9 + r * 0.8), p.getZ(i) * k + z);
    }
    s.computeVertexNormals();
    L(s, '#4f8a49');
  }
  // The picket fence, along the front, open where the path meets it.
  const fenceR = 2.42;
  for (let a = -40; a <= 40; a += 2.6) {
    const yaw = rad(ROOMS.stage.yaw + a);
    const p = polar(yaw, fenceR, 0);
    const [lx, lz] = toLocal(F, p[0], p[2]);
    if (Math.abs(lx + 0.42) < 0.14) continue;
    const pk = box(-0.016, 0.016, 0, 0.24, -0.008, 0.008);
    pk.rotateY(rad(a));
    pk.translate(lx, 0, lz);
    L(pk, '#f6f1e4');
    L(sphere(0.017, lx, 0.24, lz, 1, 1.3, 0.5, 8, 6), '#f6f1e4');
  }
  for (const y of [0.07, 0.18]) {
    for (const [a0, a1] of [[-40, -4], [6.5, 40]]) {
      for (let a = a0; a < a1; a += 2.6) {
        const p0 = polar(rad(ROOMS.stage.yaw + a), fenceR - 0.012, y);
        const p1 = polar(rad(ROOMS.stage.yaw + Math.min(a1, a + 2.6)), fenceR - 0.012, y);
        const l0 = toLocal(F, p0[0], p0[2]);
        const l1 = toLocal(F, p1[0], p1[2]);
        const len = Math.hypot(l1[0] - l0[0], l1[1] - l0[1]);
        const rail = box(-len / 2, len / 2, -0.012, 0.012, -0.006, 0.006);
        rail.rotateY(-Math.atan2(l1[1] - l0[1], l1[0] - l0[0]));
        rail.translate((l0[0] + l1[0]) / 2, y, (l0[1] + l1[1]) / 2);
        L(rail, '#ece6d6');
      }
    }
  }
  // The mailbox.
  L(cyl(0.012, 0.012, 0.3, -0.62, 0, 0.82, 8), '#f4ead2');
  L(box(-0.66, -0.58, 0.3, 0.36, 0.74, 0.9), '#5a7fa0');
  L(new CylinderGeometry(0.04, 0.04, 0.16, 16).rotateX(PI / 2).translate(-0.62, 0.36, 0.82), '#5a7fa0');
  L(box(-0.585, -0.575, 0.36, 0.44, 0.78, 0.8), '#e0705a');
  // Footlights along the front edge of the plinth.
  for (let a = -40; a <= 40; a += 5) {
    const p = polar(rad(ROOMS.stage.yaw + a), R_OUT + 0.01, -0.06);
    const [lx, lz] = toLocal(F, p[0], p[2]);
    L(sphere(0.022, lx, -0.06, lz, 1, 1, 0.7, 8, 6), '#ffe2a0', { amb: 1, gain: 1.3 });
  }
  worldMesh(glb, 'stage-set', mergeGeometries(geos), mats.painted);

  trapDoor(glb, mats, parent, { x: 0.72, z: -0.14, wood: '#8a6a48', frameHex: '#f4ead2', below: '#e8d6ff', open: [5.9, 6.5], close: [8.4, 9.1] });
}

// ---------------------------------------------------------------------------
// Layer 2: pastel gases that meet and recoil. Light, busy, hard to read.

const PASTELS = ['#bfe8d8', '#cdb8ec', '#ffc9a8', '#b8d8f5', '#fbe7a6', '#f6b8cf'];

function cloudGeometry(radius, hex, seed) {
  const rand = rng(seed);
  const parts = [];
  for (let i = 0; i < 5; i += 1) {
    const r = radius * (i === 0 ? 1 : 0.45 + 0.35 * rand());
    const s = new SphereGeometry(r, 14, 10);
    const p = s.attributes.position;
    const c = i === 0 ? [0, 0, 0] : [(rand() - 0.5) * radius * 1.4, (rand() - 0.4) * radius * 0.8, (rand() - 0.5) * radius * 1.2];
    for (let k = 0; k < p.count; k += 1) {
      const x = p.getX(k);
      const y = p.getY(k);
      const z = p.getZ(k);
      const n = 0.82 + 0.36 * fbm3(x * 9 + seed, y * 9, z * 9, { seed, octaves: 3 });
      p.setXYZ(k, x * n + c[0], y * n * 0.82 + c[1], z * n + c[2]);
    }
    s.computeVertexNormals();
    parts.push(s);
  }
  const g = mergeGeometries(parts);
  return bake(g, (x, y) => blend(hex, '#ffffff', 0.08 + 0.22 * clamp(y / radius + 0.5)), { amb: 0.8 });
}

function gasRoom(glb, mats, parent) {
  const paint = new Paint();
  floorTop(paint, 'gas', (x, z) => {
    const n = fbm3(x * 2.2, 0, z * 2.2, { seed: 7 });
    const m = fbm3(x * 2.2 + 9, 0, z * 2.2, { seed: 8 });
    return blend(blend('#d8c8f0', '#c4ead9', n), '#fcd2bd', m * 0.7);
  });
  const geos = [paint.geometry()];
  // Soft pastel banks against the partitions, standing still.
  for (const [x, z, r, hex] of [[-0.95, -0.5, 0.3, '#cdb8ec'], [0.98, -0.45, 0.26, '#bfe8d8'], [-0.2, -0.82, 0.24, '#f6b8cf']]) {
    geos.push(cloudGeometry(r, hex, Math.round(x * 100 + 300)).translate(x, r * 0.55, z));
  }
  worldMesh(glb, 'gas-floor', mergeGeometries([geos[0]]), mats.painted);
  glb.node({ name: 'gas-banks', mesh: glb.mesh('gas-banks', mergeGeometries(geos.slice(1)), mats.gas), parent });

  // Colliding pairs. Four meet right where the traveller is at each of its
  // flinches; two more keep the room busy. Each pair also meets again every
  // `period` seconds, so the room is never still.
  const pairs = GAS_PAIRS;
  let seed = 40;
  pairs.forEach((pair, i) => {
    const dir = [Math.cos(pair.axis), 0.15 * Math.sin(i * 2.3), Math.sin(pair.axis)];
    const rA = 0.2 + 0.04 * (i % 3);
    const rB = 0.18 + 0.05 * ((i + 1) % 3);
    const cols = [PASTELS[i % 6], PASTELS[(i + 3) % 6]];
    const rot = qEuler(0, -pair.axis, 0);
    for (const [side, r, hex] of [[-1, rA, cols[0]], [1, rB, cols[1]]]) {
      const node = glb.node({ name: `gas-${i}-${side > 0 ? 'b' : 'a'}`, parent });
      const body = glb.node({ name: `gas-${i}-${side > 0 ? 'b' : 'a'}-body`, mesh: glb.mesh(`gas-${i}`, cloudGeometry(r, hex, (seed += 7)), mats.gas), rotation: rot, parent: node });
      const phase0 = (t) => wrap(t - pair.when) / pair.period;
      animate(glb, node, 'translation', 12, (t) => {
        const u = phase0(t) % 1;
        const back = u < 0.28 ? Math.sin((PI / 2) * (u / 0.28)) : 1 - ((u - 0.28) / 0.72) ** 2;
        const d = (rA + rB) * 0.82 + 0.42 * back;
        const bob = 0.05 * Math.sin(2 * PI * (t / 6 + i * 0.3)) * side;
        return [pair.at[0] + side * dir[0] * d * 0.5, pair.at[1] + side * dir[1] * d * 0.5 + bob, pair.at[2] + side * dir[2] * d * 0.5];
      });
      animate(glb, body, 'scale', 12, (t) => {
        const u = phase0(t) % 1;
        const after = u * pair.period;
        const sq = 0.38 * Math.exp(-after / 0.32) * smooth(0, 0.05, after);
        const breathe = 1 + 0.06 * Math.sin(2 * PI * (t / 4 + i * 0.17 + side * 0.1));
        // Local x is the collision axis (rotation turns it onto `dir`).
        return [breathe * (1 - sq), breathe * (1 + 0.5 * sq), breathe * (1 + 0.5 * sq)];
      });
    }
    // A puff where they meet, mixing their colours.
    const puffGeo = cloudGeometry(0.16, blend(cols[0], cols[1], 0.5), seed + 1);
    const puff = glb.node({ name: `gas-${i}-puff`, mesh: glb.mesh(`gas-${i}-puff`, puffGeo, mats.gas), translation: pair.at, parent });
    animate(glb, puff, 'scale', 12, (t) => {
      const after = (wrap(t - pair.when) % pair.period);
      const k = tiny(smooth(0, 0.25, after) * (1 - smooth(0.4, 1.6, after)) * (1 + after));
      return [k, k * 0.7, k];
    });
  });
  // Lone drifters.
  for (let i = 0; i < 4; i += 1) {
    const hex = PASTELS[(i * 2 + 1) % 6];
    const base = [[-0.75, 0.5, 0.35], [0.8, 1.1, -0.25], [-0.1, 0.45, 0.6], [0.15, 1.9, -0.4]][i];
    const node = glb.node({ name: `gas-drift-${i}`, mesh: glb.mesh(`gas-drift-${i}`, cloudGeometry(0.17 + 0.03 * i, hex, 90 + i), mats.gas), parent });
    animate(glb, node, 'translation', 12, (t) => [
      base[0] + 0.18 * Math.sin(2 * PI * (t / 20 + i * 0.25)),
      base[1] + 0.08 * Math.sin(2 * PI * (t / 12 + i * 0.4)),
      base[2] + 0.14 * Math.cos(2 * PI * (t / 15 + i * 0.2))
    ]);
  }

  portalRing(glb, mats, parent, { x: -0.72, y: 2.05, z: -0.08, hex: '#fff6e0', active: [7.4, 9.6] });
  trapDoor(glb, mats, parent, { x: 0.72, z: -0.1, wood: '#d9c8ee', frameHex: '#f6b8cf', below: '#9b2a22', open: [19.7, 20.3], close: [22.2, 22.9] });
}

// ---------------------------------------------------------------------------
// Layer 3: dense liquids, two masses that surge and crash together.

export const GAS_PAIRS = [
  { at: [-0.32, 1.45, 0.22], when: GAS_CLASHES[0], period: 10, axis: 0.4 },
  { at: [0.0, 1.5, -0.12], when: GAS_CLASHES[1], period: 12, axis: 1.9 },
  { at: [0.3, 1.42, -0.1], when: GAS_CLASHES[2], period: 10, axis: -0.6 },
  { at: [0.62, 1.48, 0.1], when: GAS_CLASHES[3], period: 15, axis: 1.2 },
  { at: [-0.5, 0.75, -0.45], when: 2.0, period: 6, axis: 0.2 },
  { at: [0.45, 0.85, 0.48], when: 4.6, period: 7.5, axis: 2.6 }
];

const ROTHKO_A = ['#5e1a22', '#3e1420', '#7d2424'];
const ROTHKO_B = ['#b4511f', '#9a4a1c', '#8a2c22'];
const HOLE = { x: 0.6, z: -0.22, r: 0.15 };
const CRASH_X = -0.05;

/** Wave height of the liquid at local (x, z) and time t. */
function liquidHeight(x, z, t) {
  let h = 0.16 + 0.06 * Math.sin(2 * PI * (t / 6 + x * 0.8)) + 0.05 * Math.sin(2 * PI * (t / 4 - z * 1.3));
  // The crash: each mass swells and runs at the line, meets the other, falls.
  const u = wrap(t - CRASH_AT) % CRASH_PERIOD; // 0 at a crash
  const run = u > CRASH_PERIOD - 1.6 ? smooth(CRASH_PERIOD - 1.6, CRASH_PERIOD, u) : 0;
  const after = u < 1.8 ? 1 - smooth(0, 1.8, u) : 0;
  const side = x < CRASH_X ? -1 : 1;
  const front = side < 0 ? mix(-1.0, CRASH_X - 0.1, run) : mix(1.0, CRASH_X + 0.1, run);
  const swell = (0.25 + 0.55 * run) * Math.exp(-(((x - front) / 0.32) ** 2)) * (run > 0 ? 1 : 0);
  const spike = 1.15 * after ** 1.5 * Math.exp(-(((x - CRASH_X) / (0.22 + 0.4 * (1 - after))) ** 2));
  const slosh = 0.2 * after * Math.exp(-(((Math.abs(x - CRASH_X) - 0.5 * (1 - after)) / 0.2) ** 2));
  h += swell + spike + slosh;
  // The path the traveller takes is a trough; so is the ground round the hole.
  const pathDist = Math.abs(z - 0.02);
  h *= 0.35 + 0.65 * smooth(0.12, 0.32, pathDist);
  const hole = Math.hypot(x - HOLE.x, z - HOLE.z);
  h *= 0.25 + 0.75 * smooth(HOLE.r + 0.02, HOLE.r + 0.3, hole);
  return h;
}

function liquidRoom(glb, mats, parent) {
  const F = frame('liquid');
  const paint = new Paint();
  floorTop(paint, 'liquid', (x, z) => blend('#2a1418', '#4a1626', fbm3(x * 3, 0, z * 3, { seed: 12 }) * 0.8));
  const geos = [paint.geometry()];
  // The back wall: two soft-edged fields floating on red.
  const W = new Paint();
  const wx0 = -0.7;
  const wx1 = 0.7;
  const wz = -0.86;
  const nx = 36;
  const ny = 40;
  const fieldCol = (x, y) => {
    const n = (fbm3(x * 6, y * 6, 1, { seed: 21 }) - 0.5) * 0.06;
    const soft = (a, b, v, e = 0.05) => smooth(a - e, a + e, v + n) * (1 - smooth(b - e, b + e, v + n));
    const top = soft(-0.6, 0.6, x) * soft(1.12, 1.78, y);
    const low = soft(-0.6, 0.6, x) * soft(0.22, 0.95, y);
    let c = blend('#9b2a22', '#6e1f24', top);
    c = c.map((v, i) => mix(v, lin('#c8571f')[i], low));
    return c.map((v) => v * (0.9 + 0.2 * fbm3(x * 14, y * 14, 3, { seed: 22 })));
  };
  for (let i = 0; i < nx; i += 1) {
    for (let k = 0; k < ny; k += 1) {
      const x0 = mix(wx0, wx1, i / nx);
      const x1 = mix(wx0, wx1, (i + 1) / nx);
      const y0 = (2.0 * k) / ny;
      const y1 = (2.0 * (k + 1)) / ny;
      W.quad([x0, y0, wz], [x1, y0, wz], [x1, y1, wz], [x0, y1, wz], fieldCol(x0, y0), fieldCol(x1, y0), fieldCol(x1, y1), fieldCol(x0, y1));
    }
  }
  geos.push(W.geometry());
  geos.push(bake(box(wx0 - 0.02, wx1 + 0.02, 0, 2.02, wz - 0.04, wz - 0.001), '#2a1418'));
  // The hole: black, small, rimmed so faintly it is hard to find.
  geos.push(bake(new CircleGeometry(HOLE.r, 32).rotateX(-PI / 2).translate(HOLE.x, 0.006, HOLE.z), '#000000', { amb: 1 }));
  geos.push(bake(new TorusGeometry(HOLE.r + 0.01, 0.008, 6, 32).rotateX(PI / 2).translate(HOLE.x, 0.008, HOLE.z), '#3a1a2c', { amb: 1 }));
  worldMesh(glb, 'liquid-room', mergeGeometries(geos), mats.painted);

  // The masses: columns of liquid on a grid, heaving, leaning into the crash.
  const step = 0.15;
  const rand = rng(31);
  const slabs = [];
  for (let x = -1.05; x <= 1.06; x += step) {
    for (let z = -0.72; z <= 0.78; z += step) {
      const wxz = F.at(x, 0, z);
      const r = Math.hypot(wxz.x, wxz.z);
      const yaw = Math.atan2(wxz.x, wxz.z);
      let dy = ((yaw - F.yaw + 3 * PI) % (2 * PI)) - PI;
      if (r < R_IN + 0.12 || r > R_OUT - 0.08 || Math.abs(dy) > rad(42)) continue;
      if (Math.abs(z - 0.02) < 0.12) continue;
      if (Math.hypot(x - HOLE.x, z - HOLE.z) < HOLE.r + 0.07) continue;
      slabs.push([x + (rand() - 0.5) * 0.03, z + (rand() - 0.5) * 0.03]);
    }
  }
  const colGeo = (hex) => {
    // A tall blob: neighbours overlap, so the grid reads as one heavy mass.
    const g = sphere(0.135, 0, 0.5, 0, 1, 3.9, 1, 16, 12);
    return bake(g, (gx, gy) => blend(hex, '#000000', 0.45 * (1 - clamp(gy * 1.2))), { light: LIGHT, amb: 0.62 });
  };
  const meshes = {};
  slabs.forEach(([x, z], i) => {
    const side = x < CRASH_X ? 'A' : 'B';
    const pal = side === 'A' ? ROTHKO_A : ROTHKO_B;
    const hex = pal[Math.min(pal.length - 1, Math.floor(smooth(0.3, 0.7, fbm3(x * 2.2, 0, z * 2.2, { seed: 33 })) * pal.length))];
    meshes[hex] ??= glb.mesh(`liquid-${hex.slice(1)}`, colGeo(hex), mats.painted);
    const node = glb.node({ name: `liquid-${i}`, mesh: meshes[hex], translation: [x, 0, z], parent });
    animate(glb, node, 'scale', 10, (t) => [1, Math.max(0.02, liquidHeight(x, z, t)), 1]);
    animate(glb, node, 'rotation', 10, (t) => {
      const h = liquidHeight(x, z, t);
      const lean = (liquidHeight(x + 0.12, z, t) - liquidHeight(x - 0.12, z, t)) * 0.9;
      const over = clamp(h - 0.3, 0, 1) * 0.35 * Math.sign(0.02 - z);
      return qEuler(over, 0, clamp(lean, -0.6, 0.6));
    });
  });

  // Spray at each crash: heavy drops thrown up and over.
  const dropGeo = bake(sphere(0.03, 0, 0, 0, 1, 1, 1, 10, 8), '#d06a2a', { amb: 0.9 });
  const dropMesh = glb.mesh('liquid-drop', dropGeo, mats.painted);
  const dropRand = rng(77);
  for (let i = 0; i < 16; i += 1) {
    const vx = (dropRand() - 0.5) * 1.4;
    const vy = 1.6 + dropRand() * 1.4;
    const vz = (dropRand() - 0.5) * 1.6;
    const z0 = (dropRand() - 0.5) * 0.9;
    const s0 = 0.6 + dropRand() * 0.9;
    const node = glb.node({ name: `liquid-drop-${i}`, mesh: dropMesh, parent });
    animate(glb, node, 'translation', 12, (t) => {
      const u = wrap(t - CRASH_AT) % CRASH_PERIOD;
      const f = Math.min(u, 1.2);
      return [CRASH_X + vx * f, Math.max(0.02, 0.7 + vy * f - 4.9 * f * f), z0 + vz * f];
    });
    animate(glb, node, 'scale', 12, (t) => {
      const u = wrap(t - CRASH_AT) % CRASH_PERIOD;
      const k = tiny(s0 * smooth(0, 0.08, u) * (1 - smooth(0.9, 1.2, u)));
      return [k, k, k];
    });
  }

  portalRing(glb, mats, parent, { x: -0.72, y: 1.95, z: 0.08, hex: '#e8d6ff', active: [21.2, 23.0] });
}

// ---------------------------------------------------------------------------
// Layer 4: the dark core. A child; then light from the two of them.

function coreRoom(glb, mats, parent, { hugAt }) {
  const paint = new Paint();
  floorTop(paint, 'core', (x, z) => blend('#0b0a10', '#17131f', fbm3(x * 2.5, 0, z * 2.5, { seed: 41 }) * 0.6));
  const geos = [paint.geometry()];
  geos.push(bake(box(-0.72, 0.72, 0, 1.0, -0.9, -0.86), (x, y) => blend('#07060b', '#1c1726', y), { light: LIGHT, amb: 0.8 }));
  worldMesh(glb, 'core-room', mergeGeometries(geos), mats.painted);

  // Its entrance: a dark whirl, not a door.
  portalRing(glb, mats, parent, { x: -0.7, y: 1.95, z: 0.06, hex: '#3a2f52', active: [37.4, 40.6], spin: -0.4, dark: true });

  // The light of the hug: shells of warm light that open from the pair.
  const grow = (t) => smooth(HUG.hold, HUG.peak, t) * (1 - smooth(HUG.fade, HUG.gone, t));
  // Domes on the floor, so the light fills the room rather than poking through it.
  const shells = [[0.45, '#fff3d6', mats.light], [0.75, T.glow, mats.light], [1.05, T.gold, mats.lightFaint]];
  shells.forEach(([r, hex, mat], i) => {
    const dome = new SphereGeometry(r, 32, 12, 0, 2 * PI, 0, PI / 2);
    const node = glb.node({ name: `hug-light-${i}`, mesh: glb.mesh(`hug-light-${i}`, bake(dome, hex, { amb: 1 }), mat), translation: [hugAt[0], 0.01, hugAt[1]], parent });
    animate(glb, node, 'scale', 12, (t) => {
      const breath = 1 + 0.05 * Math.sin(2 * PI * (t - HUG.hold) / 3.6 + i);
      const k = tiny(smooth(HUG.hold + i * 1.2, HUG.peak + i * 0.6, t) * (1 - smooth(HUG.fade + i * 0.3, HUG.gone, t)) * breath);
      return [k, k, k];
    });
  });
  const disc = glb.node({ name: 'hug-floor', mesh: glb.mesh('hug-floor', bake(new CircleGeometry(1, 48).rotateX(-PI / 2), T.gold, { amb: 1 }), mats.light), translation: [hugAt[0], 0.008, hugAt[1]], parent });
  animate(glb, disc, 'scale', 12, (t) => {
    const k = tiny(grow(t) * 0.95);
    return [k, 1, k];
  });
  // Motes that rise from them and climb out of the dark.
  const moteMesh = glb.mesh('hug-mote', bake(sphere(0.016, 0, 0, 0, 1, 1, 1, 8, 6), '#fff3d6', { amb: 1 }), mats.painted);
  const mr = rng(91);
  for (let i = 0; i < 30; i += 1) {
    const a0 = mr() * 2 * PI;
    const r0 = 0.1 + mr() * 0.35;
    const period = 3.2 + mr() * 2.4;
    const off = mr() * period;
    const height = 1.6 + mr() * 0.8;
    const node = glb.node({ name: `hug-mote-${i}`, mesh: moteMesh, parent });
    animate(glb, node, 'translation', 12, (t) => {
      const u = wrap(t - HUG.hold + off) % period / period;
      const a = a0 + u * 2.4;
      const r = r0 * (1 + u * 0.8);
      return [hugAt[0] + r * Math.cos(a), 0.2 + u * height, hugAt[1] + r * Math.sin(a)];
    });
    animate(glb, node, 'scale', 12, (t) => {
      const u = wrap(t - HUG.hold + off) % period / period;
      const k = tiny(smooth(HUG.hold + 0.8, HUG.hold + 2.5, t) * (1 - smooth(HUG.fade + 0.4, HUG.gone, t)) * Math.sin(PI * u));
      return [k, k, k];
    });
  }
}

/** A ring of light that climbs the well from the core to the stage after the hug. */
function riseRing(glb, mats, parent) {
  const node = glb.node({ name: 'well-rise', mesh: glb.mesh('well-rise', bake(new TorusGeometry(R_IN + 0.035, 0.03, 10, 64).rotateX(PI / 2), T.glow, { amb: 1 }), mats.light), parent });
  animate(glb, node, 'translation', 12, (t) => [0, mix(0.05, 3.08, smooth(HUG.hold + 1.5, HUG.peak + 2.5, t)), 0]);
  animate(glb, node, 'scale', 12, (t) => {
    const k = tiny(window(HUG.hold + 1.5, HUG.peak + 3.2, t, 0.6));
    return [1 + 0.02 * k, tiny(k), 1 + 0.02 * k];
  });
}

/** Every layer's room under a node in its own frame. Returns those nodes. */
export function buildRooms(glb, mats, scene, { hugAt }) {
  glb.node({ name: 'structure', mesh: glb.mesh('structure', structure(), mats.painted), parent: scene });
  const groups = {};
  for (const room of Object.keys(ROOMS)) {
    const F = frame(room);
    groups[room] = glb.node({ name: `layer-${room}`, translation: F.origin, rotation: F.rotation, parent: scene });
  }
  WORLD.scene = scene;
  const inRoom = (room, fn) => {
    WORLD.room = room;
    fn();
  };
  inRoom('stage', () => stageRoom(glb, mats, groups.stage));
  inRoom('gas', () => gasRoom(glb, mats, groups.gas));
  inRoom('liquid', () => liquidRoom(glb, mats, groups.liquid));
  inRoom('core', () => coreRoom(glb, mats, groups.core, { hugAt }));
  riseRing(glb, mats, scene);
  return groups;
}

export { qEuler, shadeK };
