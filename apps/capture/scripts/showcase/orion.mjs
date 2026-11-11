import { BoxGeometry, BufferGeometry, CylinderGeometry, Float32BufferAttribute, OctahedronGeometry, Quaternion, SphereGeometry, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { add, lowpass, noise, normalize, pluck, sine, toWav, track } from './lib/audio.mjs';
import { renderLabels } from './lib/browser.mjs';
import { Glb, sample } from './lib/glb.mjs';
import { addLabel, fbm3, noise3, quat, quatMul, rng } from './lib/parts.mjs';
import { T as TOKEN } from './lib/tokens.mjs';

// "Orion isn't flat": the constellation exactly as it looks from Earth, from
// one place. Each star hangs at its own distance along the line of sight, so a
// quarter turn undoes the hunter into a long scatter of light-years.
//
// Honesty: depth along the line of sight (the ruler) is to scale, 1 m =
// 673 light-years. The sideways layout is drawn for the first view, not for
// the Earth marker, and the angular size is not to scale.

export const meta = {
  slug: 'orion-isnt-flat',
  name: "Orion isn't flat",
  submittedBy: 'Claude (agent-authored)'
};

const LOOP = 24;
const RAD = Math.PI / 180;
const YAW = 18; // the feed's first view looks from yaw 18 degrees

// The first view, in root-local meters (+Z toward the viewer, before the root's yaw).
const BOUNDS_H = 2.84; // designed height of the bounds
const T = new Vector3(0, 0.68 * BOUNDS_H, 0.0); // the look target: the viewer measures 0.68 x H
const D = 4.1 * BOUNDS_H; // eye distance from T: the viewer measures 4.1 x H
const SIZE = D / 9; // star sizes were drawn for D = 9 // eye distance from T: the viewer measures 3.6 x H
const FIG_DROP = 0.55; // the figure's central ray passes this far below T, so it stands low over the slab
const DIR = new Vector3(0, Math.sin(16 * RAD), Math.cos(16 * RAD));
const EYE = T.clone().addScaledVector(DIR, D);

const M_PER_LY = 0.001486; // 1 m of depth = 673 light-years
const SLAB_TOP = 0.03;

// J2000 positions and approximate distances (sources vary; these are the values used).
const h = (hh, mm, ss) => (hh + mm / 60 + ss / 3600) * 15;
const dm = (sign, dd, mm) => sign * (dd + mm / 60);
const STARS = [
  { id: 'betelgeuse', ra: h(5, 55, 10), dec: dm(1, 7, 24), ly: 550, r: 0.066, tone: 'red' },
  { id: 'rigel', ra: h(5, 14, 32), dec: dm(-1, 8, 12), ly: 860, r: 0.066, tone: 'blue' },
  { id: 'bellatrix', ra: h(5, 25, 8), dec: dm(1, 6, 21), ly: 250, r: 0.052, tone: 'blue' },
  { id: 'mintaka', ra: h(5, 32, 0), dec: dm(-1, 0, 18), ly: 1200, r: 0.066, tone: 'blue' },
  { id: 'alnilam', ra: h(5, 36, 13), dec: dm(-1, 1, 12), ly: 2000, r: 0.066, tone: 'blue' },
  { id: 'alnitak', ra: h(5, 40, 46), dec: dm(-1, 1, 57), ly: 1260, r: 0.066, tone: 'blue' },
  { id: 'saiph', ra: h(5, 47, 45), dec: dm(-1, 9, 40), ly: 650, r: 0.048, tone: 'blue' },
  { id: 'meissa', ra: h(5, 35, 8), dec: dm(1, 9, 56), ly: 1100, r: 0.040, tone: 'blue' },
  { id: 'hatysa', ra: h(5, 35, 26), dec: dm(-1, 5, 55), ly: 1340, r: 0.040, tone: 'blue' },
  { id: 'nebula', ra: h(5, 35, 17), dec: dm(-1, 5, 23), ly: 1340, r: 0.04, tone: 'pink' }
];
const RODS = [
  ['meissa', 'betelgeuse'], ['meissa', 'bellatrix'], ['betelgeuse', 'bellatrix'], ['betelgeuse', 'alnitak'],
  ['bellatrix', 'mintaka'], ['mintaka', 'alnilam'], ['alnilam', 'alnitak'], ['alnitak', 'saiph'],
  ['mintaka', 'rigel'], ['saiph', 'rigel'], ['alnilam', 'nebula', 'thin'], ['nebula', 'hatysa', 'thin']
];

// Tangent plane about (83.75 deg, 0 deg), then the view frame from the eye.
const A0 = 83.75 * RAD;
const C = new Vector3(Math.cos(A0), Math.sin(A0), 0);
const NORTH = new Vector3(0, 0, 1);
const EAST = new Vector3(-Math.sin(A0), Math.cos(A0), 0);
const F = T.clone().sub(new Vector3(0, FIG_DROP, 0)).sub(EYE).normalize();
const UP = new Vector3(0, 1, 0);
const U = UP.clone().addScaledVector(F, -UP.dot(F)).normalize();
const R = new Vector3().crossVectors(F, U);

function tangent(star) {
  const a = star.ra * RAD;
  const d = star.dec * RAD;
  const s = new Vector3(Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d));
  const k = s.dot(C);
  return { xi: s.dot(EAST) / k, eta: s.dot(NORTH) / k };
}
const tangents = STARS.map(tangent);
const ETA_SPAN = Math.max(...tangents.map((t) => t.eta)) - Math.min(...tangents.map((t) => t.eta));
const K = 2.2 / (D * ETA_SPAN); // the figure is about 2.2 m tall at depth D
const SHIFT = -0.2; // the content sits this far behind T so the world bounds centre on it
const depthZ = (ly) => (1125 - ly) * M_PER_LY + SHIFT; // root-local z of a distance: Earth is nearest the viewer

/** The point on the ray through (xi, eta) at the floor depth of `ly`, and its size scale. */
function place(xi, eta, ly) {
  const dir = F.clone().addScaledVector(U, K * eta).addScaledVector(R, -K * xi);
  const s = (depthZ(ly) - EYE.z) / dir.z;
  return { p: EYE.clone().addScaledVector(dir, s), scale: (s * dir.length()) / D };
}
const placed = STARS.map((star, i) => ({ ...star, ...place(tangents[i].xi, tangents[i].eta, star.ly) }));
const byId = Object.fromEntries(placed.map((star) => [star.id, star]));

const PALE = '#cfe3ff';
const WHITE_BLUE = '#a9ccff';
const HALO_BLUE = '#6f9bff';
const BETEL = '#ff8a4a';
const HALO_RED = '#ff5a1e';
const PINK = '#ff8fc8';
const ROD_COLOR = TOKEN.glow;

// The roll call: nearest to farthest, one note each.
const ORDER = [...placed].sort((a, b) => a.ly - b.ly || (a.id === 'hatysa' ? -1 : 1));
const CALL_START = 7.8;
const CALL_STEP = 0.95;
const NOTES = [880, 783.99, 659.25, 587.33, 523.25, 440, 392, 329.63, 293.66, 261.63];

const pulseAt = (id) => CALL_START + CALL_STEP * ORDER.findIndex((s) => s.id === id);
const bump = (tau) => (tau <= 0 || tau > 2 ? 0 : (tau / 0.15) * Math.exp(1 - tau / 0.15));
const HIDDEN = [1e-4, 1e-4, 1e-4];

function slabOutline(theta, a, b, tear) {
  const c = Math.abs(Math.cos(theta));
  const s = Math.abs(Math.sin(theta));
  const base = 1 / Math.pow(Math.pow(c / a, 5) + Math.pow(s / b, 5), 1 / 5);
  return base + tear * 0.08 * (fbm3(theta * 1.4, 0.5, 3.1, { octaves: 3, seed: 4 }) - 0.5) * 2 + tear * 0.022 * (fbm3(theta * 7, 2.5, 3.1, { octaves: 3, seed: 9 }) - 0.5) * 2 + tear * 0.006 * (noise3(theta * 31, 4.5, 3.1, 7) - 0.5) * 2;
}

function slabGeometries(cx, cz, a, b, tear = 1) {
  const N = 420;
  const rgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  };
  const mixc = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const BODY_A = rgb('#21404b');
  const BODY_B = rgb('#172e38');
  const SCORCH = rgb('#24140b');
  const EMBER = rgb(TOKEN.glow);
  const RIM = rgb(TOKEN.gold);
  const EDGE = rgb(TOKEN.highlight);
  const positions = [];
  const colors = [];
  const indices = [];
  const skirtPositions = [];
  const skirtColors = [];
  const skirtIndices = [];
  const rings = 9;
  const stride = N + 1;
  for (let k = 0; k <= rings + 3; k += 1) {
    for (let i = 0; i <= N; i += 1) {
      const th = ((i % N) / N) * Math.PI * 2;
      const e = slabOutline(th, a, b, tear);
      const w = 0.012 + 0.016 * fbm3(th * 4, 7.7, 2, { octaves: 2, seed: 3 });
      const ch = 0.012 + 0.03 * fbm3(th * 2.2, 3.3, 2, { octaves: 3, seed: 7 });
      let r;
      let color;
      const inner = Math.max(0, e - w - ch);
      if (k <= rings) {
        r = (inner * k) / rings;
        const n = fbm3(cx + r * Math.cos(th) * 2.2, cz + r * Math.sin(th) * 2.2, 1.3, { octaves: 3, seed: 5 });
        color = mixc(BODY_B, BODY_A, n);
      } else if (k === rings + 1) {
        r = e - w;
        color = mixc(BODY_B, SCORCH, 0.85);
      } else if (k === rings + 2) {
        r = e - w * 0.35;
        color = EMBER;
      } else {
        r = e;
        color = EDGE;
      }
      if (k === rings + 2) color = EMBER;
      if (k === rings + 1) color = RIM;
      positions.push(cx + r * Math.cos(th), SLAB_TOP, cz + r * Math.sin(th));
      colors.push(...color);
    }
  }
  // Rim rows: scorch -> ember -> gold -> highlight edge, as bands of vertex colour.
  for (let k = 0; k < rings + 3; k += 1) {
    for (let i = 0; i < N; i += 1) {
      const a = k * stride + i;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  const last = (rings + 3) * stride;
  for (let i = 0; i <= N; i += 1) {
    const th = ((i % N) / N) * Math.PI * 2;
    const e = slabOutline(th, a, b, tear);
    skirtPositions.push(cx + e * Math.cos(th), SLAB_TOP, cz + e * Math.sin(th), cx + e * Math.cos(th), 0, cz + e * Math.sin(th));
    skirtColors.push(...mixc(SCORCH, RIM, 0.4), ...SCORCH);
  }
  for (let i = 0; i < N; i += 1) {
    const a = i * 2;
    skirtIndices.push(a, a + 2, a + 1, a + 2, a + 3, a + 1);
  }
  void last;
  const top = new BufferGeometry();
  top.setAttribute('position', new Float32BufferAttribute(positions, 3));
  top.setAttribute('color', new Float32BufferAttribute(colors, 3));
  top.setIndex(indices);
  const skirt = new BufferGeometry();
  skirt.setAttribute('position', new Float32BufferAttribute(skirtPositions, 3));
  skirt.setAttribute('color', new Float32BufferAttribute(skirtColors, 3));
  skirt.setIndex(skirtIndices);
  return { top, skirt };
}

function spikesGeometry() {
  const parts = [];
  for (const [sx, sy, sz] of [[6.5, 0.26, 0.26], [0.26, 4.0, 0.26], [0.26, 0.26, 4.2]]) {
    const g = new OctahedronGeometry(1);
    g.scale(sx, sy, sz);
    parts.push(g);
  }
  return mergeGeometries(parts);
}

function sound() {
  const out = track(LOOP);
  // A low soft pad: whole cycles per loop, so it joins at the seam.
  add(out, 0, LOOP, (t) => 0.05 * sine(55)(t) + 0.03 * sine(82.5)(t) * (0.65 + 0.35 * sine(1 / 12)(t)) + 0.016 * sine(110)(t) * (0.5 + 0.5 * sine(1 / 8, 1)(t)));
  const hiss = track(LOOP);
  const random = noise(11);
  for (let i = 0; i < hiss.length; i += 1) hiss[i] = random() * 0.008;
  lowpass(hiss, 300);
  for (let i = 0; i < out.length; i += 1) out[i] += hiss[i];
  const bell = (hz) => (t) => sine(hz)(t) + 0.3 * sine(hz * 2.01)(t) + 0.1 * sine(hz * 3.02)(t);
  ORDER.forEach((star, i) => {
    const gain = 0.2 + 0.05 * (i / 9); // lower notes a little firmer
    add(out, CALL_START + CALL_STEP * i, 3.4, bell(NOTES[i]), (t) => gain * pluck(0.005, 0.9)(t));
  });
  return toWav(normalize(out, 0.7));
}

export async function build() {
  const M = 0.0030;
  const labels = await renderLabels([
    { id: 'betelgeuse', text: 'Betelgeuse', font: 'title', italic: true, size: 46, color: '#ffb68c' },
    { id: 'rigel', text: 'Rigel', font: 'title', italic: true, size: 46, color: '#c6dcff' },
    { id: 'front', text: 'Orion, as seen\nfrom here.', font: 'title', italic: true, size: 44, color: TOKEN.glow },
    { id: 'n0', text: '0', font: 'ui', size: 60, weight: 600, color: TOKEN.text },
    { id: 'n500', text: '500', font: 'ui', size: 60, weight: 600, color: TOKEN.text },
    { id: 'n1000', text: '1,000', font: 'ui', size: 60, weight: 600, color: TOKEN.text },
    { id: 'n1500', text: '1,500', font: 'ui', size: 60, weight: 600, color: TOKEN.text },
    { id: 'n2000', text: '2,000', font: 'ui', size: 60, weight: 600, color: TOKEN.text },
    { id: 'words', text: 'light-years from Earth', font: 'title', italic: true, size: 64, color: TOKEN.glow }
  ]);

  const glb = new Glb();
  glb.provenance({
    holoim: {
      authored: 'synthetic',
      author: meta.submittedBy,
      title: meta.name,
      distances: 'approximate',
      depthScale: '1 m = 673 light-years, to scale along the line of sight; sideways layout drawn for the first view; angular size not to scale',
      sources: STARS.map((s) => ({ star: s.id, raDeg: +s.ra.toFixed(3), decDeg: +s.dec.toFixed(3), lightYears: s.ly })),
      decoration: 'about 150 tiny faint background stars are decoration with no data, far fainter than the ten'
    }
  });
  const root = glb.node({ name: 'OrionIsntFlat', rotation: quat([0, 1, 0], YAW * RAD) });

  // The ground: one narrow torn gold-rimmed plank, the ruler spine, under the middle of the figure,
  // and a small plaque at its near end.
  const zFront = depthZ(0) + 0.2;
  const zBack = depthZ(2000) - 0.2;
  const spine = slabGeometries(0, (zFront + zBack) / 2, 0.25, (zFront - zBack) / 2, 0.45);
  const slabInk = glb.material({ name: 'SlabInk', unlit: true, doubleSided: true });
  glb.node({ name: 'Spine', mesh: glb.mesh('Spine', spine.top, slabInk), parent: root });
  glb.node({ name: 'SpineSkirt', mesh: glb.mesh('SpineSkirt', spine.skirt, slabInk), parent: root });
  const plaque = slabGeometries(0, depthZ(0) + 0.36, 0.46, 0.17, 0.5);
  glb.node({ name: 'Plaque', mesh: glb.mesh('Plaque', plaque.top, slabInk), parent: root });
  glb.node({ name: 'PlaqueSkirt', mesh: glb.mesh('PlaqueSkirt', plaque.skirt, slabInk), parent: root });

  // The ruler on the spine: a line and ticks every 250 light-years.
  const RX = 0.2;
  const FLAT = SLAB_TOP + 0.003;
  const ruler = [];
  const bar = (x, z, sx, sz, y = FLAT, sy = 0.004) => {
    const g = new BoxGeometry(sx, sy, sz);
    g.translate(x, y + sy / 2, z);
    ruler.push(g);
  };
  bar(RX, (depthZ(0) + depthZ(2000)) / 2, 0.012, depthZ(0) - depthZ(2000));
  for (let ly = 0; ly <= 2000; ly += 250) {
    const major = ly % 500 === 0;
    const len = major ? 0.13 : 0.08;
    bar(RX - len / 2, depthZ(ly), len, major ? 0.02 : 0.013);
  }
  const rulerInk = glb.material({ name: 'RulerInk', color: TOKEN.gold, unlit: true });
  glb.node({ name: 'Ruler', mesh: glb.mesh('Ruler', mergeGeometries(ruler), rulerInk), parent: root });

  // Earth: a small blue marker at 0.
  const earthInk = glb.material({ name: 'EarthMarker', color: '#4fa8ff', unlit: true });
  const earthHalo = glb.material({ name: 'EarthHalo', color: '#4fa8ff', opacity: 0.25, unlit: true });
  const earth = glb.node({ name: 'EarthMarker', translation: [0.0, FLAT + 0.05, depthZ(0) + 0.1], parent: root });
  glb.node({ name: 'EarthCore', mesh: glb.mesh('EarthCore', new SphereGeometry(0.05, 20, 14), earthInk), parent: earth });
  glb.node({ name: 'EarthGlow', mesh: glb.mesh('EarthGlow', new SphereGeometry(0.1, 16, 12), earthHalo), parent: earth });

  // Text lying on the spine, tilted up, written to be read from the side (the quarter turn).
  const sideTilt = quatMul(quat([0, 1, 0], Math.PI / 2), quat([1, 0, 0], -35 * RAD));
  const NM = 0.0026;
  for (const [id, ly] of [['n0', 0], ['n500', 500], ['n1000', 1000], ['n1500', 1500], ['n2000', 2000]]) {
    addLabel(glb, labels[id], { name: `Label-${id}`, metersPerPx: NM, translation: [0.07, FLAT, depthZ(ly)], rotation: sideTilt, parent: root });
  }
  addLabel(glb, labels.words, { name: 'Label-words', metersPerPx: 0.0016, translation: [-0.06, FLAT, (depthZ(0) + depthZ(2000)) / 2 - 0.1], rotation: sideTilt, parent: root });
  // Facing the first view: leaning back on the plaque.
  const frontTilt = quat([1, 0, 0], -58 * RAD);
  addLabel(glb, labels.front, { name: 'Label-front', metersPerPx: 0.0019, translation: [0, FLAT, depthZ(0) + 0.3], rotation: frontTilt, parent: root });

  // Faint dotted drop-lines, and a bright foot at each star's floor depth.
  const dots = [];
  const feet = [];
  const ribs = [];
  const footY = (x) => (Math.abs(x) < 0.25 ? FLAT + 0.006 : 0.022);
  for (const star of placed) {
    const top = star.p.y - star.r * star.scale * 2.2;
    for (let y = footY(star.p.x) + 0.1; y < top; y += 0.11) {
      const g = new BoxGeometry(0.0045, 0.011, 0.0045);
      g.translate(star.p.x, y, star.p.z);
      dots.push(g);
    }
    const foot = new SphereGeometry(0.03, 10, 6);
    foot.scale(1, 0.25, 1);
    foot.translate(star.p.x, footY(star.p.x), star.p.z);
    feet.push(foot);
    // A thin faint rib across the floor, at right angles to the spine, to its edge.
    const edge = Math.sign(star.p.x) * 0.25;
    if (Math.abs(star.p.x) > 0.26) {
      const rib = new BoxGeometry(Math.abs(star.p.x - edge), 0.004, 0.006);
      rib.translate((star.p.x + edge) / 2, 0.02, star.p.z);
      ribs.push(rib);
    }
  }
  const dotInk = glb.material({ name: 'DropLine', color: '#34566b', unlit: true });
  glb.node({ name: 'DropLines', mesh: glb.mesh('DropLines', mergeGeometries(dots), dotInk), parent: root });
  const ribInk = glb.material({ name: 'Rib', color: '#2a4a5e', unlit: true });
  glb.node({ name: 'Ribs', mesh: glb.mesh('Ribs', mergeGeometries(ribs), ribInk), parent: root });
  const footInk = glb.material({ name: 'Foot', color: '#c4e4ff', unlit: true });
  glb.node({ name: 'Feet', mesh: glb.mesh('Feet', mergeGeometries(feet), footInk), parent: root });

  // Each foot flares when its star is called.
  const flareInk = glb.material({ name: 'Flare', color: '#9fd0ff', opacity: 0.5, unlit: true });
  const flareGeo = new SphereGeometry(0.14, 14, 8);
  flareGeo.scale(1, 0.12, 1);
  const flareMesh = glb.mesh('Flare', flareGeo, flareInk);
  for (const star of placed) {
    const node = glb.node({ name: `Flare-${star.id}`, mesh: flareMesh, translation: [star.p.x, footY(star.p.x) + 0.004, star.p.z], scale: HIDDEN, parent: root });
    const tp = pulseAt(star.id);
    const track3 = sample(LOOP, 30, (t) => {
      const v = Math.max(1e-4, 1.1 * bump(t - tp));
      return [v, v, v];
    });
    glb.animate(node, 'scale', track3.times, track3.values);
  }

  // The stars: core, three crossed spikes, one soft halo. Shared meshes; each star's node sets its size.
  const coreBlue = glb.material({ name: 'CoreBlue', color: PALE, unlit: true });
  const coreRed = glb.material({ name: 'CoreRed', color: '#ffc29a', unlit: true });
  const spikeBlue = glb.material({ name: 'SpikeBlue', color: WHITE_BLUE, unlit: true });
  const spikeRed = glb.material({ name: 'SpikeRed', color: BETEL, unlit: true });
  const haloBlue = glb.material({ name: 'HaloBlue', color: HALO_BLUE, opacity: 0.32, unlit: true });
  const haloRed = glb.material({ name: 'HaloRed', color: HALO_RED, opacity: 0.36, unlit: true });
  const core = new SphereGeometry(1, 16, 10);
  const spikes = spikesGeometry();
  const halo = new SphereGeometry(3.6, 18, 12);
  const meshes = {
    coreBlue: glb.mesh('CoreBlue', core, coreBlue),
    coreRed: glb.mesh('CoreRed', core, coreRed),
    spikeBlue: glb.mesh('SpikeBlue', spikes, spikeBlue),
    spikeRed: glb.mesh('SpikeRed', spikes, spikeRed),
    haloBlue: glb.mesh('HaloBlue', halo, haloBlue),
    haloRed: glb.mesh('HaloRed', halo, haloRed)
  };
  const starNodes = {};
  placed.forEach((star, i) => {
    const base = star.r * star.scale * SIZE;
    const node = glb.node({ name: `Star-${star.id}`, translation: [star.p.x, star.p.y, star.p.z], scale: [base, base, base], parent: root });
    starNodes[star.id] = node;
    if (star.tone === 'pink') {
      const puffInk = glb.material({ name: 'NebulaPuff', color: PINK, opacity: 0.34, unlit: true });
      const brightInk = glb.material({ name: 'NebulaCore', color: '#ffd2ea', unlit: true });
      const random = rng(31);
      const puffs = [];
      for (let n = 0; n < 7; n += 1) {
        const g = new SphereGeometry(1.2 + 1.3 * random(), 12, 8);
        g.translate((random() - 0.5) * 3.2, (random() - 0.5) * 4.2, (random() - 0.5) * 2);
        puffs.push(g);
      }
      glb.node({ name: 'NebulaPuffs', mesh: glb.mesh('NebulaPuffs', mergeGeometries(puffs), puffInk), parent: node });
      glb.node({ name: 'NebulaCore', mesh: glb.mesh('NebulaCore', new SphereGeometry(0.9, 12, 8), brightInk), parent: node });
    } else {
      const red = star.tone === 'red';
      glb.node({ name: `Core-${star.id}`, mesh: red ? meshes.coreRed : meshes.coreBlue, parent: node });
      glb.node({ name: `Spikes-${star.id}`, mesh: red ? meshes.spikeRed : meshes.spikeBlue, scale: ['mintaka', 'alnilam', 'alnitak'].includes(star.id) ? [0.42, 0.42, 0.42] : [0.8, 0.8, 0.8], parent: node });
      glb.node({ name: `Halo-${star.id}`, mesh: red ? meshes.haloRed : meshes.haloBlue, scale: ['mintaka', 'alnilam', 'alnitak'].includes(star.id) ? [0.4, 0.4, 0.4] : [1, 1, 1], parent: node });
    }
    // A few percent of twinkle all loop; one swell when called.
    const cycles = 3 + (i % 4);
    const phase = i * 1.7;
    const tp = pulseAt(star.id);
    const track3 = sample(LOOP, 30, (t) => {
      const s = base * (1 + 0.045 * Math.sin(2 * Math.PI * (cycles * t) / LOOP + phase) + 0.75 * bump(t - tp));
      return [s, s, s];
    });
    glb.animate(node, 'scale', track3.times, track3.values);
  });

  // The figure: rods from star to star, in 3D. They fade at the start of the roll call and grow back.
  const rodInk = glb.material({ name: 'Rod', color: ROD_COLOR, unlit: true });
  const rodMesh = glb.mesh('Rod', new CylinderGeometry(1, 1, 1, 8, 1, true), rodInk);
  const up = new Vector3(0, 1, 0);
  const haloOf = (star) => star.r * star.scale * SIZE * (['mintaka', 'alnilam', 'alnitak'].includes(star.id) ? 1.6 : 3.6) + 0.012;
  RODS.forEach(([from, to, kind], i) => {
    const sa = byId[from];
    const sb = byId[to];
    const dirv = sb.p.clone().sub(sa.p);
    const total = dirv.length();
    dirv.normalize();
    const gapA = haloOf(sa);
    const gapB = haloOf(sb);
    const length = Math.max(0.02, total - gapA - gapB);
    const a = sa.p.clone().addScaledVector(dirv, gapA);
    const mid = a.clone().addScaledVector(dirv, length / 2);
    const q = new Quaternion().setFromUnitVectors(up, dirv);
    const scaleMid = (sa.scale + sb.scale) / 2;
    const radius = (kind === 'thin' ? 0.011 : 0.016) * scaleMid * SIZE;
    const full = [radius, length, radius];
    const node = glb.node({ name: `Rod-${from}-${to}`, mesh: rodMesh, translation: [mid.x, mid.y, mid.z], rotation: [q.x, q.y, q.z, q.w], scale: full, parent: root });
    const out = 6.0 + 0.12 * i;
    const back = 18.0 + 0.15 * i;
    const times = [0, out, out + 0.6, back, back + 0.9, LOOP];
    const values = [...full, ...full, ...HIDDEN, ...HIDDEN, ...full, ...full];
    glb.animate(node, 'scale', times, values);
  });

  // Background dust: decoration, no data, far fainter than the ten.
  const random = rng(77);
  const dust = [];
  const top3 = Math.max(...placed.map((s) => s.p.y));
  const figX = Math.max(...placed.map((s) => Math.abs(s.p.x))) + 0.3;
  while (dust.length < 150) {
    const xi = (random() - 0.5) * 0.46;
    const eta = (random() - 0.5) * 0.62;
    const ly = 250 + random() * 1750;
    const { p, scale } = place(xi, eta, ly);
    if (p.y < 0.6 || p.y > top3 || Math.abs(p.x) > figX) continue;
    if (placed.some((s) => Math.hypot(s.p.x - p.x, s.p.y - p.y) < 0.18)) continue;
    const g = new OctahedronGeometry((0.008 + 0.01 * random()) * scale);
    g.translate(p.x, p.y, p.z);
    dust.push(g);
  }
  const dustInk = glb.material({ name: 'Dust', color: '#6d88aa', unlit: true });
  glb.node({ name: 'Dust', mesh: glb.mesh('Dust', mergeGeometries(dust), dustInk), parent: root });

  // Names, facing the first view.
  const bet = byId.betelgeuse;
  const rig = byId.rigel;
  addLabel(glb, labels.betelgeuse, { name: 'Label-betelgeuse', metersPerPx: M, translation: [bet.p.x - 0.32, bet.p.y + 0.1, bet.p.z], parent: root });
  addLabel(glb, labels.rigel, { name: 'Label-rigel', metersPerPx: M, translation: [rig.p.x + 0.3, rig.p.y - 0.3, rig.p.z], parent: root });

  glb.audio(sound());
  return glb;
}

// The sheet. Cameras are written in root-local meters; `w` turns them to world.
const w = (v) => new Vector3(...v).applyAxisAngle(new Vector3(0, 1, 0), YAW * RAD).toArray();
const MID = [0, 1.75, 0];
export const tiles = [
  { label: 'feed', cam: w(EYE.toArray()), look: w(T.toArray()), fov: 38, t: 0 },
  { label: 'feed 2x', cam: w(EYE.toArray()), look: w(T.toArray()), fov: 19, t: 0 },
  { label: 'feed t=10', cam: w(EYE.toArray()), look: w(T.toArray()), fov: 38, t: 10 },
  { label: 'side 108', cam: w([MID[0] + 7.6, 2.6, MID[2]]), look: w([MID[0], 1.45, MID[2]]), fov: 42, t: 0 },
  { label: 'side called', cam: w([MID[0] + 7.6, 2.6, MID[2]]), look: w([MID[0], 1.45, MID[2]]), fov: 42, t: 14 },
  { label: 'top', cam: w([0.1, 9, 0.1]), look: w([0.1, 1, 0.1]), fov: 34, t: 0 },
  { label: 'close 1.6m', cam: w([T.x + 0.9, T.y - 0.4, T.z + 1.3]), look: w([0, 0.75, -0.3]), fov: 45, t: 12 },
  { label: 'side ruler', cam: w([6.2, 1.1, -0.1]), look: w([0, 0.6, -0.1]), fov: 36, t: 14 },
  { label: 'rods back', cam: w(EYE.toArray()), look: w(T.toArray()), fov: 38, t: 21 }
];
