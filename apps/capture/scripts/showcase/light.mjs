import { BoxGeometry, Color, ConeGeometry, CylinderGeometry, SphereGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { add, lowpass, noise, normalize, pluck, sine, toWav, track } from './lib/audio.mjs';
import { renderLabels } from './lib/browser.mjs';
import { Glb } from './lib/glb.mjs';
import { addLabel, fbm3, floorEllipse, quat } from './lib/parts.mjs';
import { T } from './lib/tokens.mjs';

// "Walk beside light": the Earth and the Moon at 1 : 100,000,000, the true
// 3.844 m apart, and a pulse of light making the round trip at its real
// speed, which at this scale is 3 m/s. Nothing here is rescaled for effect:
// every size, gap and duration is the real one times the one stated scale.

export const meta = {
  slug: 'walk-beside-light',
  name: 'Walk beside light',
  submittedBy: 'Claude (agent-authored)'
};

const KM = 1e-5; // one kilometre at 1 : 100,000,000, in meters
const EARTH_R = 6371 * KM;
const MOON_R = 1737.4 * KM;
const GAP = 384400 * KM; // mean centre-to-centre distance
const LIGHT = 299792.458 * KM; // meters per second at this scale
const HEIGHT = 1.25; // chest height: you stand beside them, not over them
const EARTH_X = -GAP / 2;
const MOON_X = GAP / 2;

const LOOP = 8;
const LEAVE = 1.0;
const START_X = EARTH_X + EARTH_R;
const END_X = MOON_X - MOON_R;
const ONE_WAY = (END_X - START_X) / LIGHT; // 1.255 s surface to surface
const ARRIVE = LEAVE + ONE_WAY;
const RETURN = ARRIVE + ONE_WAY;
const HIDDEN = [1e-4, 1e-4, 1e-4];

const GOLD = T.gold;
const GLOW = T.glow;
const HIGHLIGHT = T.highlight;

function earthGeometry() {
  const geometry = new SphereGeometry(EARTH_R, 96, 64);
  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const ocean = new Color('#0f4fa8');
  const deep = new Color('#08306e');
  const cloud = new Color('#ffffff');
  const scratch = new Color();
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i) / EARTH_R;
    const y = position.getY(i) / EARTH_R;
    const z = position.getZ(i) / EARTH_R;
    // Weather bands: stretch the noise along latitude and shear it with a second noise.
    const swirl = fbm3(x * 2 + 7, y * 2, z * 2, { seed: 11 }) * 2.2;
    const cover = fbm3(x * 3 + swirl, y * 7 + swirl * 0.6, z * 3 - swirl, { octaves: 5, seed: 3 });
    const amount = Math.min(1, Math.max(0, (cover - 0.5) / 0.14));
    const ice = Math.min(1, Math.max(0, (Math.abs(y) - 0.9) / 0.05));
    scratch.copy(deep).lerp(ocean, fbm3(x * 2, y * 2, z * 2, { seed: 5 }));
    scratch.lerp(cloud, Math.max(amount * 0.92, ice));
    colors.set([scratch.r, scratch.g, scratch.b], i * 3);
  }
  geometry.setAttribute('color', new position.constructor(colors, 3));
  return geometry;
}

function moonGeometry() {
  const geometry = new SphereGeometry(MOON_R, 48, 32);
  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const highland = new Color('#cfcbc2');
  const mare = new Color('#77746f');
  const scratch = new Color();
  for (let i = 0; i < position.count; i += 1) {
    const n = fbm3((position.getX(i) / MOON_R) * 2.4, (position.getY(i) / MOON_R) * 2.4, (position.getZ(i) / MOON_R) * 2.4, { seed: 21 });
    scratch.copy(highland).lerp(mare, Math.min(1, Math.max(0, (n - 0.45) / 0.15)));
    colors.set([scratch.r, scratch.g, scratch.b], i * 3);
  }
  geometry.setAttribute('color', new position.constructor(colors, 3));
  return geometry;
}

function footprintGeometry() {
  const ball = floorEllipse(0.075, 0.046);
  ball.translate(0.055, 0, 0);
  const heel = floorEllipse(0.04, 0.036);
  heel.translate(-0.095, 0, 0);
  return mergeGeometries([ball, heel]);
}

function sound() {
  const out = track(LOOP);
  // A room-tone bed: two low partials a fifth apart, whole cycles per loop so it joins.
  add(out, 0, LOOP, (t) => 0.03 * sine(55)(t) + 0.018 * sine(82.5)(t) * (0.6 + 0.4 * sine(0.125)(t)));
  const hiss = track(LOOP);
  const random = noise(7);
  for (let i = 0; i < hiss.length; i += 1) hiss[i] = random() * 0.012;
  lowpass(hiss, 400);
  for (let i = 0; i < out.length; i += 1) out[i] += hiss[i];

  const bell = (hz) => (t) => sine(hz)(t) + 0.35 * sine(hz * 2.01)(t) + 0.12 * sine(hz * 3.02)(t);
  add(out, LEAVE, 2.5, bell(329.63), (t) => 0.3 * pluck(0.004, 0.55)(t)); // leaving Earth
  add(out, ARRIVE, 3.5, bell(659.25), (t) => 0.14 * pluck(0.004, 0.9)(t)); // touching the Moon, far away
  add(out, RETURN, 3.5, bell(246.94), (t) => 0.26 * pluck(0.004, 0.8)(t)); // home again
  return toWav(normalize(out, 0.7));
}

export async function build() {
  const labels = await renderLabels([
    { id: 'earth', text: 'Earth', font: 'title', italic: true, size: 44, color: GOLD },
    { id: 'moon', text: 'Moon', font: 'title', italic: true, size: 44, color: GOLD },
    { id: 'gap', text: '384,400 km', font: 'title', size: 64 },
    { id: 'scale', text: 'scale 1 : 100,000,000  ·  light takes 1.3 seconds each way', font: 'ui', size: 26, color: T.textMuted, letterSpacing: 0.04 },
    { id: 'pace', text: 'at this scale light moves at 3 m/s: you can run beside it', font: 'ui', size: 26, color: T.textMuted, letterSpacing: 0.04 }
  ]);

  const glb = new Glb();
  glb.provenance({
    holoim: {
      authored: 'synthetic',
      author: meta.submittedBy,
      title: meta.name,
      scale: '1:100000000',
      facts: { earthMoonKm: 384400, earthRadiusKm: 6371, moonRadiusKm: 1737.4, lightKmPerS: 299792.458 }
    }
  });
  const root = glb.node({ name: 'WalkBesideLight' });

  // The floor: one line under the gap, a mark under each body. It also tells
  // the viewer where y = 0 is, so the bodies stay at chest height.
  const lineInk = glb.material({ name: 'FloorLine', color: '#8a6a3c', emissive: GOLD, emissiveStrength: 0.35, roughness: 1 });
  const line = new BoxGeometry(GAP, 0.002, 0.006);
  line.translate(0, 0.001, 0);
  glb.node({ name: 'FloorLine', mesh: glb.mesh('FloorLine', line, lineInk), parent: root });
  const stemInk = glb.material({ name: 'Stem', color: GOLD, opacity: 0.35, emissive: GOLD, emissiveStrength: 0.4 });
  for (const [name, x, r] of [['Earth', EARTH_X, EARTH_R], ['Moon', MOON_X, MOON_R]]) {
    const mark = floorEllipse(0.03, 0.03);
    mark.translate(x, 0.0015, 0);
    glb.node({ name: `${name}FloorMark`, mesh: glb.mesh(`${name}FloorMark`, mark, lineInk), parent: root });
    const stem = new CylinderGeometry(0.0012, 0.0012, HEIGHT - r, 8);
    stem.translate(x, (HEIGHT - r) / 2, 0);
    glb.node({ name: `${name}Stem`, mesh: glb.mesh(`${name}Stem`, stem, stemInk), parent: root });
  }

  const earth = glb.node({ name: 'Earth', translation: [EARTH_X, HEIGHT, 0], rotation: quat([0, 0, 1], (23.4 * Math.PI) / 180), parent: root });
  const earthSurface = glb.material({ name: 'EarthSurface', roughness: 0.55, emissive: '#0a2a66', emissiveStrength: 0.5 });
  glb.node({ name: 'EarthSurface', mesh: glb.mesh('EarthSurface', earthGeometry(), earthSurface), parent: earth });
  const air = glb.material({ name: 'EarthAir', color: T.identity[3], opacity: 0.14, emissive: T.identity[5], emissiveStrength: 0.5 });
  glb.node({ name: 'EarthAir', mesh: glb.mesh('EarthAir', new SphereGeometry(EARTH_R * 1.035, 48, 32), air), parent: earth });

  const moonSurface = glb.material({ name: 'MoonSurface', roughness: 1, emissive: '#3a3936', emissiveStrength: 0.4 });
  glb.node({ name: 'Moon', mesh: glb.mesh('Moon', moonGeometry(), moonSurface), translation: [MOON_X, HEIGHT, 0], parent: root });

  // The pulse: a bead of light and the tail it drags, there and back.
  const lightInk = glb.material({ name: 'Light', color: HIGHLIGHT, emissive: HIGHLIGHT, emissiveStrength: 6 });
  const tailInk = glb.material({ name: 'LightTail', color: GOLD, opacity: 0.5, unlit: true });
  const pulse = glb.node({ name: 'LightPulse', translation: [START_X, HEIGHT, 0], scale: HIDDEN, parent: root });
  glb.node({ name: 'LightBead', mesh: glb.mesh('LightBead', new SphereGeometry(0.007, 16, 12), lightInk), parent: pulse });
  // Not a size claim: the glow a bright point leaves in the eye, so the bead can be found from across the room.
  const haloInk = glb.material({ name: 'LightHalo', color: GLOW, opacity: 0.22, unlit: true });
  glb.node({ name: 'LightHalo', mesh: glb.mesh('LightHalo', new SphereGeometry(0.024, 20, 14), haloInk), parent: pulse });
  const tailLength = LIGHT * 0.06;
  const tail = new ConeGeometry(0.004, tailLength, 12, 1, true);
  tail.rotateZ(Math.PI / 2);
  tail.translate(-tailLength / 2, 0, 0);
  glb.node({ name: 'LightTail', mesh: glb.mesh('LightTail', tail, tailInk), parent: pulse });
  glb.animate(pulse, 'translation', [0, LEAVE, ARRIVE, RETURN, LOOP], [START_X, HEIGHT, 0, START_X, HEIGHT, 0, END_X, HEIGHT, 0, START_X, HEIGHT, 0, START_X, HEIGHT, 0]);
  glb.animate(pulse, 'scale', [0, LEAVE, RETURN, LOOP], [...HIDDEN, 1, 1, 1, ...HIDDEN, ...HIDDEN], 'STEP');
  const ahead = quat([0, 1, 0], 0);
  const back = quat([0, 1, 0], Math.PI);
  glb.animate(pulse, 'rotation', [0, ARRIVE, RETURN, LOOP], [...ahead, ...back, ...ahead, ...ahead], 'STEP');

  // A soft bloom where the light leaves, lands and comes home.
  const bloomInk = glb.material({ name: 'Bloom', color: GLOW, opacity: 0.3, unlit: true });
  const bloom = (name, x, radius, moments) => {
    const node = glb.node({ name, mesh: glb.mesh(name, new SphereGeometry(radius, 24, 16), bloomInk), translation: [x, HEIGHT, 0], scale: HIDDEN, parent: root });
    const times = [0];
    const values = [...HIDDEN];
    for (const t of moments) {
      times.push(t - 0.02, t + 0.06, t + 0.6);
      values.push(...HIDDEN, 1, 1, 1, ...HIDDEN);
    }
    times.push(LOOP);
    values.push(...HIDDEN);
    glb.animate(node, 'scale', times, values);
  };
  bloom('EarthBloom', START_X, 0.022, [LEAVE, RETURN]);
  bloom('MoonBloom', MOON_X, MOON_R * 1.9, [ARRIVE]);

  // A runner's lane beside the gap: each print lights as the light passes it.
  const printInk = glb.material({ name: 'Footprint', color: '#8a6a3c', opacity: 0.55, roughness: 1 });
  const printGlow = glb.material({ name: 'FootprintLit', color: HIGHLIGHT, emissive: GOLD, emissiveStrength: 2.5 });
  const printMesh = glb.mesh('Footprint', footprintGeometry(), printInk);
  const glowMesh = glb.mesh('FootprintLit', footprintGeometry(), printGlow);
  const STRIDE = GAP / 4;
  for (let i = 0; i < 5; i += 1) {
    const x = EARTH_X + STRIDE * i;
    const z = 0.45 + (i % 2 === 0 ? 0.075 : -0.075);
    glb.node({ name: `Footprint${i + 1}`, mesh: printMesh, translation: [x, 0.002, z], parent: root });
    const lit = glb.node({ name: `FootprintLit${i + 1}`, mesh: glowMesh, translation: [x, 0.004, z], scale: HIDDEN, parent: root });
    const pass = LEAVE + Math.max(0, x - START_X) / LIGHT;
    glb.animate(lit, 'scale', [0, pass, pass + 0.05, pass + 0.45, pass + 0.95, LOOP], [...HIDDEN, ...HIDDEN, 1, 1, 1, 1, 1, 1, ...HIDDEN, ...HIDDEN]);
  }

  // Words have a place: they lie on the floor, tilted up to a standing reader.
  const tilt = quat([1, 0, 0], (-58 * Math.PI) / 180);
  const M = 0.0016;
  addLabel(glb, labels.earth, { name: 'EarthLabel', metersPerPx: M, translation: [EARTH_X, 0, -0.1], rotation: tilt, parent: root });
  addLabel(glb, labels.moon, { name: 'MoonLabel', metersPerPx: M, translation: [MOON_X, 0, -0.1], rotation: tilt, parent: root });
  addLabel(glb, labels.gap, { name: 'GapLabel', metersPerPx: M, translation: [0, 0, -0.1], rotation: tilt, parent: root });
  addLabel(glb, labels.scale, { name: 'ScaleLabel', metersPerPx: M, translation: [0, 0, 0.12], rotation: tilt, parent: root });
  addLabel(glb, labels.pace, { name: 'PaceLabel', metersPerPx: M, translation: [0, 0, 0.78], rotation: tilt, parent: root });

  glb.audio(sound());
  return glb;
}

export const tiles = [
  { view: 'front', t: 1.5 },
  { view: 'quarter', t: 2.0 },
  { view: 'top', t: 2.9 },
  { label: 'from Earth', cam: [EARTH_X - 0.45, HEIGHT + 0.06, 0.16], look: [MOON_X, HEIGHT - 0.1, 0], t: 1.7, fov: 50 },
  { label: 'Earth close', cam: [EARTH_X + 0.05, HEIGHT + 0.05, 0.4], look: [EARTH_X + 0.05, HEIGHT, 0], t: 1.02, fov: 40 },
  { label: 'Moon lands', cam: [MOON_X - 0.12, HEIGHT + 0.03, 0.2], look: [MOON_X - 0.03, HEIGHT, 0], t: ARRIVE + 0.05, fov: 40 },
  { label: 'floor words', cam: [0, 0.75, 1.5], look: [0, 0, 0.2], t: 1.9, fov: 45 },
  { label: 'runner', cam: [EARTH_X - 0.6, 1.6, 0.9], look: [0.4, 0.3, 0.2], t: 1.75, fov: 55 },
  { label: 'back', view: 'back', t: 3.2 }
];
