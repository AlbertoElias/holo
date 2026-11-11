import { BoxGeometry, BufferGeometry, CircleGeometry, Float32BufferAttribute, Color } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { add, lowpass, noise, normalize, pluck, sine, swell, toWav, track } from './lib/audio.mjs';
import { Glb, sample } from './lib/glb.mjs';
import { fbm3, noise3, quat, rng } from './lib/parts.mjs';
import { T } from './lib/tokens.mjs';

// "From where you stand": one sculpture of small cubes. From the feed's first
// view it reads ALONE; a quarter turn to the right, the very same cubes read
// LOVED. A cube exists where the ALONE letter's cell (seen from the front)
// and the LOVED letter's cell (seen from the right) are both filled, so each
// view sees one word and nothing is hidden in either.

export const meta = {
  slug: 'from-where-you-stand',
  name: 'From where you stand',
  submittedBy: 'Claude (agent-authored)'
};

const LOOP = 24;
const YAW = (18 * Math.PI) / 180;
const CELL = 0.06;
const SIZE = CELL * 0.96;
const BRICK = 0.095; // taller than wide
const SIZE_Y = BRICK * 0.96;
const SHEAR = CELL * Math.tan((16 * Math.PI) / 180); // keeps every depth on one screen row at pitch 16 deg
const COLS = 7;
const ROWS = 9;
const PITCH = (COLS + 2) * CELL;
const BASE = 0.56; // height of the letters' feet above the slab
const SLAB_TOP = 0.05;

const FONT = {
  A: ['..###..', '.#####.', '##...##', '##...##', '#######', '#######', '##...##', '##...##', '##...##'],
  L: ['###....', '###....', '###....', '###....', '###....', '###....', '###....', '#######', '#######'],
  O: ['.#####.', '#######', '##...##', '##...##', '##...##', '##...##', '##...##', '#######', '.#####.'],
  N: ['##...##', '###..##', '###..##', '####.##', '##.####', '##..###', '##..###', '##...##', '##...##'],
  E: ['#######', '#######', '##.....', '##.....', '#####..', '##.....', '##.....', '#######', '#######'],
  V: ['##...##', '##...##', '##...##', '##...##', '##...##', '.##.##.', '.##.##.', '..###..', '..###..'],
  D: ['#####..', '######.', '##...##', '##...##', '##...##', '##...##', '##...##', '######.', '#####..']
};
const ALONE = 'ALONE';
const LOVED = 'LOVED';

const BLUE = '#cfe4ff'; // moonlit, faces that look at the feed's camera
const SLATE_TOP = '#1d2733';
const DIM = '#2a3547';


/** Cube positions in the sculpture's own frame (x' right of the feed view, z' toward it). */
function cubes() {
  const list = [];
  const width = 4 * PITCH + COLS * CELL;
  for (let i = 0; i < 5; i += 1) {
    const a = FONT[ALONE[i]];
    const b = FONT[LOVED[i]];
    for (let row = 0; row < ROWS; row += 1) {
      for (let u = 0; u < COLS; u += 1) {
        if (a[row][u] !== '#') continue;
        for (let w = 0; w < COLS; w += 1) {
          if (b[row][w] !== '#') continue;
          list.push({
            i,
            row,
            x: i * PITCH + u * CELL + CELL / 2 - width / 2,
            z: -(i * PITCH + w * CELL + CELL / 2) + width / 2,
            y: BASE + SLAB_TOP + (ROWS - 1 - row) * BRICK + BRICK / 2 + (u - w) * SHEAR
          });
        }
      }
    }
  }
  return { list, width };
}

function cubeGeometry() {
  const g = new BoxGeometry(SIZE, SIZE_Y, SIZE);
  const n = g.attributes.normal;
  const colors = new Float32Array(n.count * 3);
  const pick = (nx, ny, nz) => {
    if (nz > 0.5) return new Color(BLUE);
    if (nx > 0.5) return new Color(T.glow);
    if (ny > 0.5) return new Color(SLATE_TOP);
    return new Color(DIM);
  };
  for (let k = 0; k < n.count; k += 1) {
    const c = pick(n.getX(k), n.getY(k), n.getZ(k));
    colors.set([c.r, c.g, c.b], k * 3);
  }
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  return g;
}

/** The torn gold-rimmed slab: an ellipse along the diagonal the word runs on. */
function slabParts(a, b) {
  const N = 160;
  const edge = (k, grow = 0) => {
    const th = (k / N) * Math.PI * 2;
    const tr = 0.09 * (fbm3(Math.cos(th) * 1.4 + 3, Math.sin(th) * 1.4, 1.7, { octaves: 3, seed: 4 }) - 0.5) * 2 + 0.02 * (noise3(Math.cos(th) * 9, Math.sin(th) * 9, 2, 8) - 0.5) * 2;
    const d = (a + tr + grow) * Math.cos(th);
    const bb = (b + tr + grow) * Math.sin(th);
    // d runs along (1, -1)/sqrt2, bb along (1, 1)/sqrt2, in the sculpture's frame.
    return [(d + bb) / Math.SQRT2, (bb - d) / Math.SQRT2];
  };
  const pos = [];
  const col = [];
  const idx = [];
  const push = (x, y, z, c) => {
    pos.push(x, y, z);
    const k = new Color(c);
    col.push(k.r, k.g, k.b);
    return pos.length / 3 - 1;
  };
  const body = '#1b3a42';
  const side = '#10242b';
  const rimC = T.gold;
  const char = '#24140b';
  const center = push(0, SLAB_TOP, 0, '#173239');
  const ring = [];
  const inner = [];
  const rim = [];
  const bot = [];
  for (let k = 0; k < N; k += 1) {
    const [x0, z0] = edge(k, -0.05);
    const [x1, z1] = edge(k, -0.015);
    const [x2, z2] = edge(k, 0);
    ring.push(push(x0, SLAB_TOP, z0, body));
    inner.push(push(x1, SLAB_TOP, z1, char));
    rim.push(push(x2, SLAB_TOP + 0.002, z2, rimC));
    bot.push(push(x2, 0, z2, side));
  }
  for (let k = 0; k < N; k += 1) {
    const m = (k + 1) % N;
    idx.push(center, ring[m], ring[k]);
    for (const [p, q] of [[ring, inner], [inner, rim], [rim, bot]]) idx.push(p[k], p[m], q[m], p[k], q[m], q[k]);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  // Winding is not guaranteed; the material is double-sided.
  const points = Array.from({ length: N }, (_, k) => edge(k, 0));
  return { geometry: g, points };
}

/** The arc of gold dots from the front standing spot round to the right-hand one. */
function dotsGeometry(radius) {
  const parts = [];
  const count = 13;
  for (let k = 0; k < count; k += 1) {
    const phi = ((k + 0.5) / count) * (Math.PI / 2);
    const r = 0.017 + 0.014 * (k / (count - 1));
    const c = new CircleGeometry(r, 18);
    c.rotateX(-Math.PI / 2);
    c.translate(radius * Math.sin(phi), SLAB_TOP + 0.004, radius * Math.cos(phi));
    c.deleteAttribute('normal');
    c.deleteAttribute('uv');
    parts.push(c);
  }
  return mergeGeometries(parts);
}

const smooth = (f) => f * f * (3 - 2 * f);
const FRACTIONS = [0.2, 0.4, 0.6, 0.8];

function sound(landings) {
  const out = track(LOOP);
  // Drone: two low partials, whole cycles per loop, breathing slowly.
  add(out, 0, LOOP, (t) => 0.05 * sine(55)(t) + 0.03 * sine(82.5)(t) * (0.6 + 0.4 * sine(1 / 12)(t)));
  const r = rng(77);
  // Woody ticks as the cubes land, denser toward 5 s.
  for (const at of landings) {
    for (let k = 0; k < 2; k += 1) {
      const t0 = at + (r() - 0.5) * 0.3;
      const hz = 620 + r() * 520;
      add(out, Math.max(0, t0), 0.09, (t) => sine(hz)(t) + 0.4 * sine(hz * 2.4)(t), (t) => 0.05 * (0.5 + 0.5 * (t0 / 5)) * pluck(0.001, 0.018)(t));
    }
  }
  // One lone held note, answered late by a warm major third.
  const held = (hz) => (t) => sine(hz)(t) + 0.25 * sine(hz * 2)(t) + 0.08 * sine(hz * 3)(t);
  add(out, 4.6, 14.6, held(220), (t) => 0.1 * swell(14.6)(t));
  add(out, 12.5, 7, held(277.18), (t) => 0.07 * swell(7)(t));
  // Air as they let go.
  const air = track(LOOP);
  const random = noise(5);
  for (let i = 0; i < air.length; i += 1) air[i] = random();
  lowpass(air, 1100);
  const at = Math.round(19 * 32000);
  const len = Math.round(4.6 * 32000);
  for (let i = 0; i < len; i += 1) out[(at + i) % out.length] += air[i] * 0.22 * Math.sin((Math.PI * i) / len) ** 2;
  return toWav(normalize(out, 0.6));
}

export async function build() {
  const { list, width } = cubes();
  const topY = BASE + SLAB_TOP + ROWS * BRICK + 6 * SHEAR;
  const slabA = 1.75;
  const slabB = 0.85;
  const slab = slabParts(slabA, slabB);
  // Scatter stays inside the world AABB of slab + letters.
  const cy = Math.cos(YAW);
  const sy = Math.sin(YAW);
  const toWorld = (x, z) => [x * cy + z * sy, -x * sy + z * cy];
  let hx = 0;
  let hz = 0;
  for (const [x, z] of slab.points) {
    const [wx, wz] = toWorld(x, z);
    hx = Math.max(hx, Math.abs(wx));
    hz = Math.max(hz, Math.abs(wz));
  }
  const half = (width / 2) * 1.2;
  const rand = rng(2024);
  const scatterPoint = () => {
    for (;;) {
      const x = (rand() * 2 - 1) * half;
      const z = (rand() * 2 - 1) * half;
      const [wx, wz] = toWorld(x, z);
      if (Math.abs(wx) > hx - 0.05 || Math.abs(wz) > hz - 0.05) continue;
      return [x, 0.15 + rand() * (topY - 0.15), z];
    }
  };

  const glb = new Glb();
  glb.provenance({
    holoim: {
      authored: 'synthetic',
      author: meta.submittedBy,
      title: meta.name,
      cubes: list.length
    }
  });
  const root = glb.node({ name: 'FromWhereYouStand', rotation: quat([0, 1, 0], YAW) });

  const slabInk = glb.material({ name: 'Slab', unlit: true, doubleSided: true });
  glb.node({ name: 'Slab', mesh: glb.mesh('Slab', slab.geometry, slabInk), parent: root });
  const dotInk = glb.material({ name: 'Dots', color: T.gold, unlit: true, doubleSided: true });
  glb.node({ name: 'InvitationDots', mesh: glb.mesh('InvitationDots', dotsGeometry(0.72), dotInk), parent: root });

  const cubeInk = glb.material({ name: 'Cube', unlit: true });
  const cubeMesh = glb.mesh('Cube', cubeGeometry(), cubeInk);

  // One slow shared breath per letter block, phase by position along the word.
  const breathTimes = [];
  for (let k = 0; k <= LOOP; k += 1) breathTimes.push(k);
  const bobs = [0, 1, 2, 3, 4].map((i) => {
    const node = glb.node({ name: `Block${i}`, parent: root });
    const { values } = sample(LOOP, 1, (t) => [0, 0.006 * Math.sin((2 * Math.PI * t) / 12 + i * 0.9), 0]);
    glb.animate(node, 'translation', breathTimes, values);
    return node;
  });

  const timeSets = new Map();
  const landings = [];
  const swirlRand = rng(31);
  for (const c of list) {
    const key = `${c.i}:${c.row}`;
    if (!timeSets.has(key)) {
      const a = 0.3 + c.i * 0.55 + ((ROWS - 1 - c.row) / (ROWS - 1)) * 0.45;
      const D = 1.9;
      const d = 19 + c.i * 0.3 + (c.row / (ROWS - 1)) * 0.3;
      const E = 3;
      const times = [0, a, ...FRACTIONS.map((f) => a + f * D), a + D, d, ...FRACTIONS.map((f) => d + f * E), d + E, LOOP];
      timeSets.set(key, { times, a, D, d, E });
      landings.push(a + D);
    }
    const { times } = timeSets.get(key);
    const home = [c.x, c.y, c.z];
    const from = scatterPoint();
    const swirl = [(swirlRand() - 0.5) * 0.5, (swirlRand() - 0.5) * 0.3, (swirlRand() - 0.5) * 0.5];
    const at = (f, e, s) => home.map((h, k) => from[k] + (h - from[k]) * e + swirl[k] * s * Math.sin(Math.PI * f));
    const gather = FRACTIONS.map((f) => at(f, smooth(f), 1));
    const leave = FRACTIONS.map((f) => at(1 - f, smooth(1 - f), -0.8));
    const values = [...from, ...from, ...gather.flat(), ...home, ...home, ...leave.flat(), ...from, ...from];
    const node = glb.node({ name: `cube${list.indexOf(c)}`, mesh: cubeMesh, translation: from, parent: bobs[c.i] });
    glb.animate(node, 'translation', times, values);
  }
  glb.audio(sound(landings.sort((x, y) => x - y)));
  return glb;
}

// The feed's first view for these bounds, and the exact quarter-turn view.
const MID = [0, 0.85, 0];
const dir = (yaw, pitch) => {
  const y = (yaw * Math.PI) / 180;
  const p = (pitch * Math.PI) / 180;
  return [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)];
};
const at = (yaw, pitch, d) => dir(yaw, pitch).map((v, k) => MID[k] + v * d);

export const tiles = [
  { label: 'feed', cam: at(18, 16, 5.6), look: MID, t: 12, fov: 45 },
  { label: 'turn right', cam: at(108, 16, 5.6), look: MID, t: 12, fov: 45 },
  { label: 'between', cam: at(63, 16, 5.6), look: MID, t: 12, fov: 45 },
  { label: 'scatter', cam: at(18, 16, 5.6), look: MID, t: 0, fov: 45 },
  { label: 'gathering', cam: at(18, 16, 5.6), look: MID, t: 3, fov: 45 },
  { label: 'top', view: 'top', t: 12 },
  { label: 'close', cam: at(18, 16, 1.6), look: MID, t: 12, fov: 45 },
  { label: 'letting go', cam: at(18, 16, 5.6), look: MID, t: 21, fov: 45 },
  { label: 'right, low', cam: at(108, 4, 5.6), look: MID, t: 12, fov: 45 }
];

