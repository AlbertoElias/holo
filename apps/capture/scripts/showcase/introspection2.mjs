import { BufferGeometry, DoubleSide, Euler, Matrix4, Mesh, MeshBasicMaterial, Quaternion, Raycaster, Vector3 } from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { Glb } from './lib/glb.mjs';
import { quatTrack } from './introspection/common.mjs';
import { CHILD_DIMS, HAT_AT, PALETTES, Rig, applyPose, briefcaseGeometry, hatGeometry, painter, setDetail, snapshot } from './introspection/figures.mjs';
import { HUG, childPose, manPose, travellerBody, travellerPlace, travellerPose } from './introspection2/acting.mjs';
import * as G from './introspection2/gas.mjs';
import * as L from './introspection2/layers.mjs';
import { GUSTS, KNOCK_PEAK, WAVES, knock, knockCurve, knocked } from './introspection2/events.mjs';
import { POOL, liquid } from './introspection2/liquid.mjs';
import { layerSounds } from './introspection2/sound.mjs';
import { DOORS, FPS, K, LOOP, PI, mix, smooth } from './introspection2/timeline.mjs';
import { scaleGeo } from './introspection2/world.mjs';
import { FOLLOW, SCREEN, feedFit } from './introspection2/zoom.mjs';

// The way down II (see introspection2/BEATS.md and docs/features/deep-zoom.md).
// A still nesting the viewer zooms into by itself: the man (layer 0), the gas
// in his chest (HologramLayer_gas, 1 cm), the liquid in a knot of the gas
// (HologramLayer_liquid), the dark under the liquid's sea
// (HologramLayer_dark). Each layer is built in its own units under its own
// static node, and runs all loop. The traveller is one rigid rig per layer,
// handed over at the doors by STEP scale keys.

export const meta = {
  slug: 'the-way-down-ii',
  name: 'The way down II',
  submittedBy: 'Claude (agent-authored)'
};
/** build.mjs fails the build if Quick Look's moving points × frames exceed these (split as the converter splits them). */
export const budget = { deformed: 1e8, rigid: 5e8 };

const STEP_IN = 0.025; // each inner layer is 40× smaller than the one it sits in
const GAS_SIZE = 0.01;
// The layers' content was first drawn in view metres (the old framing: the camera 6.979 m out);
// a layer's home camera is 1.6 of its units out.
const KV = 1.6 / 6.979;
const TRAV = 0.023; // his size on the man's chest: 1.75 m of rig is 4 cm
const S_DOOR = 0.457; // his size (layer units per rig metre) as he arrives in a layer
const S_GAS = TRAV * 34 * KV; // among the gusts
const S_LIQ = TRAV * 55 * KV; // chest-deep in the sea
const S_DARK = 0.22; // the hug frame's scale in the dark
const PELVIS = 0.93;
const KNOT_R = 0.105;
const ROOM = 4; // the liquid's and the dark's sky radius
const DARK_O = [0, -0.35, 0]; // the dark, under the liquid's sea
const R18 = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (18 * PI) / 180);
const Y_PI = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), PI);
const H = new Vector3(HUG.centre[0], HUG.centre[1], 0); // the hug frame's centre
const { right: SR, up: SU, toward: SF } = SCREEN;

const grid = Array.from({ length: LOOP * FPS + 1 }, (_, i) => i / FPS);
const span = (a, b) => grid.filter((t) => t >= a - 1e-9 && t <= b + 1e-9);
const add = (a, b, k = 1) => a.map((v, i) => v + k * b[i]);
const scl = (a, k) => a.map((v) => v * k);
const deg = (d) => (d * PI) / 180;

// Frames: a rig's root node sits at its pelvis height, (0, 0.93, 0) of its own metres.
const PEL = new Matrix4().makeTranslation(0, PELVIS, 0);
const UNPEL = new Matrix4().makeTranslation(0, -PELVIS, 0);
/** A root { T, Q, s } from F, the map from rig metres to layer units. */
const rootOf = (F) => {
  const T = new Vector3();
  const Q = new Quaternion();
  const S = new Vector3();
  F.clone().multiply(PEL).decompose(T, Q, S);
  return { T: T.toArray(), Q, s: (S.x + S.y + S.z) / 3 };
};
const frameOf = (r) => new Matrix4().compose(new Vector3(...r.T), r.Q, new Vector3(r.s, r.s, r.s)).multiply(UNPEL);
const blend = (a, b, u) => ({ T: a.T.map((v, i) => mix(v, b.T[i], u)), Q: a.Q.clone().slerp(b.Q, u), s: a.s * (b.s / a.s) ** u });
/** The dark's units from the liquid's. */
const DtoL = new Matrix4().compose(new Vector3(...DARK_O), new Quaternion(), new Vector3(STEP_IN, STEP_IN, STEP_IN));
/** The hug frame (his body's metres, H at the centre) to dark units, lifted and scaled. */
const hugMatrix = (lift, s) => new Matrix4().compose(new Vector3(0, lift, 0), R18, new Vector3(s, s, s)).multiply(new Matrix4().makeTranslation(-H.x, -H.y, -H.z));
const F_HUG = hugMatrix(0, S_DARK);

export async function build() {
  const glb = new Glb();
  glb.provenance({
    holoim: {
      authored: 'synthetic',
      author: meta.submittedBy,
      title: meta.name,
      note: 'A still nesting of layers (HologramLayer_*), each in its own units and running all loop; the traveller is one rig per layer, handed over at the doors.'
    }
  });
  const drawn = []; // [{ node, geo }] for the feed-fit check
  const shared = new Map(); // one mesh per geometry, however many nodes draw it
  const meshNode = (name, geo, mat, opts = {}) => {
    if (!shared.has(geo)) {
      const g = geo.index ? geo : mergeVertices(geo, 1e-5);
      shared.set(geo, { g, mesh: glb.mesh(name, g, mat) });
    }
    const { g, mesh } = shared.get(geo);
    const node = glb.node({ name, mesh, ...opts });
    drawn.push({ node, geo: g });
    return node;
  };
  const keyed = (node, times, values) => glb.animate(node, 'weights', times, values);

  const mats = {
    man: glb.material({ name: 'Man', color: '#ffffff', emissive: '#1c1814', roughness: 0.72 }),
    flat: glb.material({ name: 'Layer', color: '#ffffff', unlit: true }),
    paint: glb.material({ name: 'Paint', color: '#ffffff', unlit: true, doubleSided: true }),
    trav: glb.material({ name: 'Traveller', color: '#ffffff', unlit: true }),
    child: glb.material({ name: 'Child', color: '#ffffff', unlit: true }),
    glow: glb.material({ name: 'Glow', color: '#ffffff', unlit: true, opacity: 0.14 }),
    pool: glb.material({ name: 'Light pool', color: '#ffffff', unlit: true, blend: true }),
    puff: glb.material({ name: 'Gas puffs', color: '#ffffff', unlit: true, doubleSided: true, blend: true, texture: glb.texture(G.puffTexture()) })
  };

  // --- Figures --------------------------------------------------------------
  setDetail(0.6);
  const man = new Rig({ suit: true });
  setDetail(0.5);
  const trav = new Rig();
  const child = new Rig({ dims: CHILD_DIMS, child: true });
  setDetail(1);

  // C, his heart, at the 7 s pose: the point in his chest farthest from any of his surfaces over the
  // loop (4.8 cm), so the gas's sky fits inside him; the door is where the line from C toward the feed
  // leaves his shirt.
  applyPose(man, manPose(man, 7));
  const chest7 = man.j.chest.matrixWorld.clone();
  const C = man.world('chest', 0, -0.03, 0.01).toArray();
  const C3 = new Vector3(...C);
  const manGeo = man.geometry(painter(PALETTES.man));
  const hatGeo = hatGeometry('#5a4a3c', '#2a2a2a');
  const caseGeo = briefcaseGeometry();
  const shirtGeo = mergeVertices(mergeGeometries(man.skeleton.map(([joint]) => {
    const g = manGeo[joint].clone().applyMatrix4(man.j[joint].matrixWorld);
    const out = new BufferGeometry();
    out.setAttribute('position', g.attributes.position.clone());
    if (g.index) out.setIndex(g.index.clone());
    return out;
  })), 1e-5);
  const ray = new Raycaster(C3.clone(), new Vector3(...FOLLOW));
  const hits = ray.intersectObject(new Mesh(shirtGeo, new MeshBasicMaterial({ side: DoubleSide })));
  const shirt = hits.filter((h) => h.distance < 0.18).at(-1);
  if (!shirt) throw new Error('no shirt in front of C');
  const n = shirt.face.normal.clone();
  if (n.dot(new Vector3(...FOLLOW)) < 0) n.negate();
  const dd = shirt.distance;
  const pinLocal = shirt.point.clone().addScaledVector(n, 0.0058).applyMatrix4(chest7.clone().invert());

  // The man, alive all loop; how near his body comes to C (the gas's sky stays inside him).
  const frames = { man: [] };
  const chestW = [];
  let clearance = Infinity;
  const v = new Vector3();
  grid.forEach((t, i) => {
    applyPose(man, manPose(man, t));
    frames.man.push(snapshot(man));
    chestW.push(man.j.chest.matrixWorld.clone());
    if (i % 6 === 0) {
      for (const [joint] of man.skeleton) {
        const p = manGeo[joint].attributes.position;
        const m = man.j[joint].matrixWorld;
        for (let k = 0; k < p.count; k += 1) clearance = Math.min(clearance, v.fromBufferAttribute(p, k).applyMatrix4(m).distanceTo(C3));
      }
    }
  });
  const R_GAS = Math.min(5, (0.8 * clearance) / GAS_SIZE);
  console.error(`C ${C.map((x) => x.toFixed(3))}; shirt ${dd.toFixed(3)} m out; his body comes within ${clearance.toFixed(3)} m of C; gas sky ${R_GAS.toFixed(2)} gas units`);
  const manNodes = writeJoints(glb, meshNode, man, frames.man, grid, undefined, 'man', manGeo, mats.man);
  const hat = meshNode('man-hat', hatGeo, mats.man, { translation: HAT_AT, rotation: frames.man[0].hat, parent: manNodes.head });
  glb.animate(hat, 'rotation', grid, quatTrack(frames.man.map((f) => f.hat)));
  meshNode('man-briefcase', caseGeo, mats.man, { parent: manNodes.wristR });

  // --- The layers: static nodes, each in the one before -----------------------------
  const gasLayer = glb.node({ name: 'HologramLayer_gas', translation: C, scale: [GAS_SIZE, GAS_SIZE, GAS_SIZE] });
  const gasHomeVm = add(scl(SF, 0.45), SU, 0.05); // where he hangs in the gas (view metres)
  const KNOT = add(scl(gasHomeVm, KV), SU, -0.3); // the knot under him: the liquid's door
  const liquidLayer = glb.node({ name: 'HologramLayer_liquid', translation: KNOT, scale: [STEP_IN, STEP_IN, STEP_IN], parent: gasLayer });
  const darkLayer = glb.node({ name: 'HologramLayer_dark', translation: DARK_O, scale: [STEP_IN, STEP_IN, STEP_IN], parent: liquidLayer });

  // --- The traveller: where he is in each layer ---------------------------------
  const iAt = (t) => Math.round(t * FPS);
  const RIGHT = new Vector3(...SR);
  const F3 = new Vector3(...SF);
  const chestQ = (t) => new Quaternion().setFromRotationMatrix(chestW[iAt(t)]).multiply(Y_PI);
  const pinned = (t) => ({ T: pinLocal.clone().applyMatrix4(chestW[iAt(t)]).sub(C3).toArray(), Q: chestQ(t), s: TRAV });
  // The handover into the gas: in front of C toward the feed, inside his shirt and the gas's sky.
  const HP = scl(SF, Math.min((dd - 0.012) / GAS_SIZE, 0.85 * R_GAS)); // gas units
  const CTRL = add(scl(SF, 2.6), SU, 0.9);
  const YAW = K([[11.4, deg(40)], [24.0, deg(40)], [26.0, deg(30)], [27, deg(40)], [36.8, deg(40)]]);
  const Q_OUT = new Quaternion().setFromEuler(new Euler(0, deg(40), 0));
  // Each blow turns and tips him away from it.
  const tumble = (events, t, k) => {
    let yaw = 0;
    let pitch = 0;
    let roll = 0;
    for (const e of events) {
      const x = (e.power * knockCurve(t - e.t)) / KNOCK_PEAK;
      if (x < 1e-4) continue;
      const side = new Vector3(...e.d).dot(RIGHT);
      const front = new Vector3(...e.d).dot(F3);
      yaw += k * 0.6 * x * side;
      pitch += k * 0.45 * x * front;
      roll -= k * 0.5 * x * side;
    }
    return new Quaternion().setFromEuler(new Euler(pitch, YAW(t) + yaw, roll, 'YXZ'));
  };
  // His limbs trail the way the strongest blow is pushing him.
  const REACH = { wristL: [[0.19, 1.45, 0], 0.72], wristR: [[-0.19, 1.45, 0], 0.72], ankleL: [[0.1, 0.9, 0], 0.92], ankleR: [[-0.1, 0.9, 0], 0.92] };
  const pulls = (t, root, events, legs) => {
    const { best } = knocked(events, t);
    if (!best || best.k < 0.05) return [];
    const w = Math.min(1, best.k) * (legs ? 0.7 : 0.55);
    const away = new Vector3(...best.d).negate().applyQuaternion(root.Q.clone().invert()).normalize();
    return Object.entries(REACH).filter(([limb]) => legs || !limb.startsWith('ankle')).map(([limb, [from, l]]) => ({
      limb, w, at: new Vector3(...from).addScaledVector(away, l).add(new Vector3(0, limb.startsWith('ankle') ? 0 : 0.1, 0))
    }));
  };

  // The man's layer (relative to C): on his chest, into it (8.3–9), and back to the pocket (57.6–58.4).
  const doorM = (t) => ({ T: scl(HP, GAS_SIZE), Q: chestQ(t), s: S_DOOR * GAS_SIZE });
  const rootM = (t) => (t <= DOORS.in.gas ? blend(pinned(t), doorM(t), smooth(8.3, DOORS.in.gas, t)) : blend(doorM(DOORS.out.man), pinned(t), smooth(DOORS.out.man, 58.4, t)));
  // The gas (gas units).
  const buffet = (t) => smooth(11.5, 13, t) * (1 - smooth(21.5, 22.5, t));
  const gasBaseVm = (t) => {
    const e = buffet(t);
    return add(add(gasHomeVm, SR, e * (0.04 * Math.sin(1.3 * t) + 0.025 * Math.sin(3.1 * t + 1))), SU, e * (0.03 * Math.sin(0.9 * t + 2) + 0.02 * Math.sin(2.7 * t)));
  };
  const gasRoot = (t) => scl(add(gasBaseVm(t), knock(GUSTS, t, 0.42)), KV);
  const INTO_KNOT = add(KNOT, SU, 0.06); // = the liquid's (0, 2.4, 0) on screen-up
  const HOVER = add(add(KNOT, SU, 0.16), SF, 0.02);
  const Q_M9 = chestQ(DOORS.in.gas);
  const rootG = (t) => {
    if (t >= 40) {
      const u = smooth(DOORS.out.gas, DOORS.out.man, t);
      return blend({ T: INTO_KNOT, Q: Q_OUT, s: S_DOOR * STEP_IN }, { T: HP, Q: chestQ(DOORS.out.man), s: S_DOOR }, u);
    }
    if (t < 11.6) {
      const u = smooth(DOORS.in.gas, 11.6, t);
      const P = gasRoot(t);
      const T = HP.map((h, k) => (1 - u) ** 2 * h + 2 * u * (1 - u) * CTRL[k] + u * u * P[k]);
      return { T, Q: Q_M9.clone().slerp(tumble(GUSTS, t, 1), u), s: S_DOOR * (S_GAS / S_DOOR) ** u };
    }
    let T = gasRoot(t);
    T = T.map((x, k) => mix(x, HOVER[k], smooth(24.1, 24.65, t)));
    const sink = smooth(24.65, DOORS.in.liquid, t);
    T = T.map((x, k) => mix(x, INTO_KNOT[k], sink));
    return { T, Q: tumble(GUSTS, t, 1 - sink), s: S_GAS * ((S_DOOR * STEP_IN) / S_GAS) ** sink }; // the gusts' tumble settles as he sinks, so he enters the liquid level
  };
  // The liquid (liquid units): his pelvis against the sea, chest-deep, sinking a little once he lets go.
  const OFF = K([[27, -0.25], [35.9, -0.27], [36.45, -0.6], [36.9, -0.9]]);
  const liqY = (t) => -POOL.drop + TRAV * 55 * OFF(Math.max(t, 27)); // view metres
  const TOP = scl(SU, 2.4);
  // The dark (dark units): the hug frame, lifted and big as he arrives, down and in to the hug, and back up.
  const liftD = (t) => 2.45 * (t < 46 ? 1 - smooth(DOORS.in.dark, 39.6, t) : smooth(55.3, DOORS.out.liquid, t));
  const sD = (t) => (t < 46 ? S_DOOR * (S_DARK / S_DOOR) ** smooth(DOORS.in.dark, 39.5, t) : S_DARK * (S_DOOR / S_DARK) ** smooth(55.3, DOORS.out.liquid, t));
  const FD = (t) => hugMatrix(liftD(t), sD(t));
  // The hug's points in each frame: the child (hug frame) for him, him (dark frame) for the child.
  const childCtx = (t, toD) => {
    applyPose(child, childPose(child, t, null));
    const back = { L: child.world('chest', 0.11, 0.1, -0.1).applyMatrix4(toD), R: child.world('chest', -0.11, 0.1, -0.1).applyMatrix4(toD) };
    return { back, shoulder: child.world('shoulderR', 0, 0.02, 0).applyMatrix4(toD), pull: [] };
  };
  const toDark = (t) => FD(t).invert().multiply(F_HUG);
  const pelvisAt = (P) => {
    applyPose(trav, P);
    return trav.j.pelvis.matrixWorld.clone();
  };
  // Where the liquid's rig must stand so his pelvis meets the dark's (placed in the hug frame).
  const meetDark = (t) => {
    const M1 = pelvisAt(travellerPose(trav, t, travellerPlace(trav, t), childCtx(t, toDark(t))));
    const M0 = pelvisAt(travellerPose(trav, t, {}, { pull: [] }));
    return rootOf(DtoL.clone().multiply(FD(t)).multiply(M1.multiply(M0.invert())));
  };
  const L_IN = meetDark(DOORS.in.dark);
  const L_OUT = meetDark(DOORS.out.liquid);
  const knockedL = (t) => {
    const kn = knock(WAVES, t, 0.25);
    kn[1] *= 0.35; // the sea holds him: the waves rock him, they do not throw him
    return { T: scl(add([0, liqY(t), 0], kn), KV), Q: tumble(WAVES, t, 0.8), s: S_LIQ };
  };
  const rootL = (t) => {
    if (t >= 40) return blend(L_OUT, { T: TOP, Q: Q_OUT, s: S_DOOR }, smooth(DOORS.out.liquid, DOORS.out.gas, t));
    if (t < 26.95) {
      const u = smooth(DOORS.in.liquid, 26.95, t);
      return { T: TOP.map((x, k) => mix(x, KV * [0, liqY(t), 0][k], u ** 1.6)), Q: tumble(WAVES, t, 0.8), s: S_DOOR * (S_LIQ / S_DOOR) ** u };
    }
    if (t < 36.2) return knockedL(t);
    return blend(knockedL(36.2), L_IN, smooth(36.2, DOORS.in.dark, t));
  };

  // --- The traveller's rigs and the child ------------------------------------------
  // Amber, not pale gold: pale gold matched the pastel gas in luminance and vanished there.
  const travGeo = trav.geometry(painter({ top: '#f2a63a', shirt: '#f2a63a', legs: '#e08a2a', skin: '#ffd98c', hair: '#b4601a', brow: '#a35416', shoes: '#c27322', socks: '#f2a63a', temple: '#f2a63a', watch: '#f2a63a' }, { baked: true, light: new Vector3(0.2, 1, 0.5).normalize() }));
  const glowGeo = L.glowShells([0, 0, 0], 0.6);
  const bigBreath = (t) => Math.max(smooth(22.55, 23.2, t) * (1 - smooth(23.25, 23.95, t)), smooth(34.65, 35.15, t) * (1 - smooth(35.2, 35.8, t)));
  const handover = {};
  function travRig(key, parent, at, spans, presence, rootAt, poseAt, breathes) {
    const times = spans.flatMap(([a, b]) => span(a, b));
    const roots = [];
    const snaps = [];
    for (const t of times) {
      const r = rootAt(t);
      roots.push(r);
      applyPose(trav, poseAt(t, r));
      snaps.push(snapshot(trav));
    }
    const shown = glb.node({ name: `traveller-${key}`, parent, translation: at, scale: Array(3).fill(presence[1][0]) });
    glb.animate(shown, 'scale', presence[0], presence[1].flatMap((p) => [p, p, p]), 'STEP');
    const root = glb.node({ name: `traveller-${key}-root`, parent: shown, translation: roots[0].T, rotation: roots[0].Q.toArray(), scale: Array(3).fill(roots[0].s) });
    glb.animate(root, 'translation', times, roots.flatMap((r) => r.T));
    glb.animate(root, 'rotation', times, quatTrack(roots.map((r) => r.Q.toArray())));
    glb.animate(root, 'scale', times, roots.flatMap((r) => [r.s, r.s, r.s]));
    const body = glb.node({ name: `traveller-${key}-body`, translation: [0, -PELVIS, 0], parent: root });
    const nodes = writeJoints(glb, meshNode, trav, snaps, times, body, `traveller-${key}`, travGeo, mats.trav);
    const glow = meshNode(`traveller-${key}-glow`, glowGeo, mats.glow, { translation: [0, 0.3, 0], parent: nodes.pelvis });
    if (breathes) glb.animate(glow, 'scale', times, times.flatMap((t) => Array(3).fill(1 + 1.1 * bigBreath(t))));
    handover[key] = { times, roots, snaps };
  }
  const plain = (t) => travellerPose(trav, t, {}, { pull: [] });
  travRig('man', undefined, C, [[0, DOORS.in.gas], [DOORS.out.man, LOOP]], [[0, DOORS.in.gas, DOORS.out.man], [1, 0, 1]], rootM, plain, false);
  travRig('gas', gasLayer, undefined, [[DOORS.in.gas, DOORS.in.liquid], [DOORS.out.gas, DOORS.out.man]], [[0, DOORS.in.gas, DOORS.in.liquid, DOORS.out.gas, DOORS.out.man], [0, 1, 0, 1, 0]], rootG,
    (t, r) => travellerPose(trav, t, {}, { pull: t < 30 ? pulls(t, r, GUSTS, true) : [] }), true);
  travRig('liquid', liquidLayer, undefined, [[DOORS.in.liquid, DOORS.in.dark], [DOORS.out.liquid, DOORS.out.gas]], [[0, DOORS.in.liquid, DOORS.in.dark, DOORS.out.liquid, DOORS.out.gas], [0, 1, 0, 1, 0]], rootL,
    (t, r) => travellerPose(trav, t, {}, { pull: t < 40 ? pulls(t, r, WAVES, false) : [] }), true);

  // The dark: the child all loop, and the traveller with him (37–56), each posed against the other.
  const kid = [];
  const hugT = span(DOORS.in.dark, DOORS.out.liquid);
  const darkSnaps = [];
  let held = null; // his head and neck where the child last saw them, while the child's look fades
  for (const t of grid) {
    let ctx = null;
    if (t >= DOORS.in.dark && t <= DOORS.out.liquid) {
      const toD = toDark(t);
      const c = childCtx(t, toD);
      applyPose(trav, travellerPose(trav, t, travellerPlace(trav, t), c));
      darkSnaps.push(snapshot(trav));
      const toHug = toD.clone().invert();
      ctx = {
        neck: { L: trav.world('neck', 0.07, 0.03, -0.05).applyMatrix4(toHug), R: trav.world('neck', -0.07, 0.03, -0.05).applyMatrix4(toHug) },
        head: trav.world('head', 0, 0.07, 0.02).applyMatrix4(toHug)
      };
      held = ctx;
    } else if (t > DOORS.out.liquid && t < 57.5) ctx = held;
    applyPose(child, childPose(child, t, ctx));
    kid.push(snapshot(child));
  }
  {
    const roots = hugT.map((t) => rootOf(FD(t)));
    const shown = glb.node({ name: 'traveller-dark', parent: darkLayer, scale: [0, 0, 0] });
    glb.animate(shown, 'scale', [0, DOORS.in.dark, DOORS.out.liquid], [0, 0, 0, 1, 1, 1, 0, 0, 0], 'STEP');
    const root = glb.node({ name: 'traveller-dark-root', parent: shown, translation: roots[0].T, rotation: roots[0].Q.toArray(), scale: Array(3).fill(roots[0].s) });
    glb.animate(root, 'translation', hugT, roots.flatMap((r) => r.T));
    glb.animate(root, 'rotation', hugT, quatTrack(roots.map((r) => r.Q.toArray())));
    glb.animate(root, 'scale', hugT, roots.flatMap((r) => [r.s, r.s, r.s]));
    const body = glb.node({ name: 'traveller-dark-body', translation: [0, -PELVIS, 0], parent: root });
    const nodes = writeJoints(glb, meshNode, trav, darkSnaps, hugT, body, 'traveller-dark', travGeo, mats.trav);
    meshNode('traveller-dark-glow', glowGeo, mats.glow, { translation: [0, 0.3, 0], parent: nodes.pelvis });
    handover.dark = { times: hugT, roots, snaps: darkSnaps };
  }
  const childAt = rootOf(F_HUG.clone().multiply(UNPEL));
  const childRoot = glb.node({ name: 'child', parent: darkLayer, translation: childAt.T, rotation: childAt.Q.toArray(), scale: Array(3).fill(childAt.s) });
  writeJoints(glb, meshNode, child, kid, grid, childRoot, 'child', child.geometry(painter(PALETTES.child, { baked: true, dim: 0.5 })), mats.child);

  // --- The gas (gas units): its sky, the knot, the puffs and the gusts ---------------------------
  meshNode('gas-sky', L.sky([0, 0, 0], R_GAS, '#e6dcf5', '#f8dcc8'), mats.flat, { parent: gasLayer });
  const knotSpin = glb.node({ name: 'gas-knot', parent: gasLayer, translation: KNOT });
  const spinT = grid.filter((_, i) => i % 15 === 0);
  glb.animate(knotSpin, 'rotation', spinT, quatTrack(spinT.map((t) => new Quaternion().setFromAxisAngle(new Vector3(0.2, 1, 0.1).normalize(), (4 * PI * t) / LOOP).toArray())));
  meshNode('gas-knot-shell', L.knotShell([0, 0, 0], KNOT_R, ['#3a0810', '#7a1a18', '#b5341d', '#e07a3a', '#f2b86a']), mats.flat, { parent: knotSpin });
  const gOf = (t) => (t > DOORS.in.gas && t < DOORS.in.liquid ? rootG(t).T : scl(gasHomeVm, KV));
  const near = (t) => {
    const w = smooth(9.5, 11.6, t) * (1 - smooth(24.2, 25.0, t));
    return gasHomeVm.map((x, k) => mix(x, gOf(t)[k] / KV, w));
  };
  const puffs = G.gasSprites({ k: 34 / 18, near, knot: scl(KNOT, 1 / KV), knotR: KNOT_R / KV });
  keyed(meshNode('gas-puffs', scaleGeo(puffs.geo, KV), mats.puff, { parent: gasLayer }), puffs.times, puffs.values);
  const gusts = G.gusts({ k: 34 / 18, him: gasBaseVm });
  gusts.forEach((g, i) => keyed(meshNode(`gas-gust-${i}`, scaleGeo(g.geo, KV), mats.puff, { parent: gasLayer }), g.times, g.values));
  console.error(`gas: ${puffs.puffs} puffs (${puffs.times.length} keys), ${gusts.length} gust meshes`);

  // --- The liquid (liquid units): its sky, the sea, the waves, the dark's knot under the sea ---
  meshNode('liquid-sky', L.sky([0, 0, 0], ROOM, '#3d0c10', '#24060a'), mats.flat, { parent: liquidLayer });
  const LQ = liquid({ him: (t) => [0, liqY(t), 0] });
  keyed(meshNode('liquid-sea', scaleGeo(LQ.pool.geo, KV), mats.paint, { parent: liquidLayer }), LQ.pool.times, LQ.pool.values);
  LQ.waves.forEach((w, i) => keyed(meshNode(`liquid-wave-${i}`, scaleGeo(w.geo, KV), mats.paint, { parent: liquidLayer }), w.times, w.values));
  meshNode('liquid-knot-shell', L.knotShell(DARK_O, KNOT_R, ['#050306', '#1a0508', '#43101a', '#701c1a']), mats.flat, { parent: liquidLayer });
  console.error(`liquid: ${LQ.pool.times.length} sea keys, ${LQ.waves.length} wave meshes`);

  // --- The dark (dark units): its sky and floor, his light on the floor -------------------
  meshNode('dark-sky', L.darkSky([0, 0, 0], ROOM), mats.flat, { parent: darkLayer });
  meshNode('dark-floor', L.darkFloor([0, 0, 0], 3.6, H.y * S_DARK), mats.flat, { parent: darkLayer });
  const lightT = span(39.8, 55.7);
  const lightAt = (t) => {
    const b = travellerBody(t);
    return new Vector3(b.x, 0.012, b.z).applyMatrix4(F_HUG).toArray();
  };
  const lightOn = (t) => smooth(39.9, 40.3, t) * (1 - smooth(55.3, 55.6, t));
  const light = meshNode('dark-light', L.lightPool([0, 0, 0], 1.4 * S_DARK), mats.pool, { parent: darkLayer, translation: lightAt(lightT[0]), scale: [0, 0, 0] });
  glb.animate(light, 'translation', lightT, lightT.flatMap(lightAt));
  glb.animate(light, 'scale', lightT, lightT.flatMap((t) => Array(3).fill(lightOn(t))));

  // --- Sound: each layer's music and heart, placed in its layer --------------------------
  const sounds = layerSounds();
  const emit = (name, parent, translation, refDistance, maxDistance) => {
    const node = glb.node({ name: `sound-${name}`, parent, translation });
    glb.sound(sounds[name], { node, name: `layer-${name}`, distanceModel: 'linear', refDistance, maxDistance });
  };
  emit('stage', undefined, add(add(C, FOLLOW, 1.6), [0, 0.1, 0]), 0.9, 2.3);
  emit('heart-man', undefined, C, 2.6, 4);
  emit('gas', gasLayer, scl(SF, 0.5), 1.8, 4);
  emit('heart-gas', gasLayer, scl(gasHomeVm, KV), 1.8, 4);
  emit('liquid', liquidLayer, scl(SF, 0.5), 1.8, 4);
  emit('dark', darkLayer, scl(SF, 0.5), 1.8, 4);
  emit('heart-child', darkLayer, new Vector3(HUG.child.x, 0.45, HUG.child.z).applyMatrix4(F_HUG).toArray(), 1.8, 4);

  // --- Checks: the doors meet, and the feed's fit is the man's alone ------------------------
  const nodes = glb.json.nodes;
  const parentOf = new Map();
  nodes.forEach((node, i) => (node.children ?? []).forEach((c) => parentOf.set(c, i)));
  const worldOf = (i, r) => {
    let m = frameOf(r).multiply(PEL);
    for (let p = parentOf.get(i); p !== undefined; p = parentOf.get(p)) {
      const nd = nodes[p];
      m = new Matrix4().compose(new Vector3(...(nd.translation ?? [0, 0, 0])), new Quaternion(...(nd.rotation ?? [0, 0, 0, 1])), new Vector3(...(nd.scale ?? [1, 1, 1]))).multiply(m);
    }
    return m;
  };
  const rootNode = (key) => nodes.findIndex((nd) => nd.name === `traveller-${key}-root`);
  const presenceFree = (i) => { // the presence node's scale is a STEP 0/1: take it as 1
    const saved = nodes[parentOf.get(i)].scale;
    nodes[parentOf.get(i)].scale = [1, 1, 1];
    return () => { nodes[parentOf.get(i)].scale = saved; };
  };
  const pelvisWorld = (key, t) => {
    const i = rootNode(key);
    const h = handover[key];
    const j = h.times.findIndex((x) => Math.abs(x - t) < 1e-6);
    const undo = presenceFree(i);
    const f = h.snaps[j];
    const m = worldOf(i, h.roots[j]).multiply(UNPEL).multiply(new Matrix4().compose(new Vector3(...f.pelvis), new Quaternion(...f.q.pelvis), new Vector3(1, 1, 1)));
    undo();
    return [new Vector3(0, 0, 0), new Vector3(0, 0.5, 0), new Vector3(0.3, 0, 0)].map((p) => p.applyMatrix4(m));
  };
  const doorPairs = [['man', 'gas', DOORS.in.gas], ['gas', 'liquid', DOORS.in.liquid], ['liquid', 'dark', DOORS.in.dark], ['dark', 'liquid', DOORS.out.liquid], ['liquid', 'gas', DOORS.out.gas], ['gas', 'man', DOORS.out.man]];
  for (const [a, b, t] of doorPairs) {
    const pa = pelvisWorld(a, t);
    const pb = pelvisWorld(b, t);
    const size = pa[0].distanceTo(pa[1]) / 0.5; // world metres per rig metre
    const gap = Math.max(...pa.map((p, k) => p.distanceTo(pb[k]))) / size;
    console.error(`door ${a}→${b} at ${t}: pelvis frames ${(gap * 1000).toFixed(2)} mm of his body apart`);
  }
  const inLayer = (i) => {
    for (let p = i; p !== undefined; p = parentOf.get(p)) if (nodes[p].name?.startsWith('HologramLayer')) return true;
    return false;
  };
  const fitAll = feedFit(fitPoints(glb, drawn));
  const fitMan = feedFit(fitPoints(glb, drawn.filter((d) => !inLayer(d.node))));
  const dt = Math.hypot(...fitAll.target.map((x, k) => x - fitMan.target[k]));
  console.error(`feed fit: target ${fitAll.target.map((x) => x.toFixed(4))}, distance ${fitAll.distance.toFixed(4)}; without the inner layers ${fitMan.target.map((x) => x.toFixed(4))}, ${fitMan.distance.toFixed(4)} (target moves ${(dt * 1000).toFixed(3)} mm)`);
  if (dt > 1e-4 || Math.abs(fitAll.distance - fitMan.distance) > 1e-4) {
    console.error('feed fit: the inner layers change the fit');
    process.exitCode = 1;
  }
  FIT.target = fitAll.target;
  FIT.distance = fitAll.distance;
  return glb;
}

/** One figure's joints under `parent`, keyed from its snapshots. */
function writeJoints(glb, meshNode, rig, frames, times, parent, name, geo, mat) {
  const nodes = {};
  for (const [joint, parentJoint, offset] of rig.skeleton) {
    nodes[joint] = meshNode(`${name}-${joint}`, geo[joint], mat, {
      translation: joint === 'pelvis' ? frames[0].pelvis : offset,
      rotation: frames[0].q[joint],
      parent: parentJoint ? nodes[parentJoint] : parent
    });
    glb.animate(nodes[joint], 'rotation', times, quatTrack(frames.map((f) => f.q[joint])));
  }
  glb.animate(nodes.pelvis, 'translation', times, frames.flatMap((f) => f.pelvis));
  return nodes;
}

// ---------------------------------------------------------------------------
// The points the feed fits its dome to (viewer-web drawnPoints.ts): every
// mesh's vertices as the file stands, and the box corners (morph targets
// included) of every mesh whose world matrix moves, at eight times through
// the take.

function fitPoints(glb, drawn) {
  const nodes = glb.json.nodes;
  const parent = new Map();
  nodes.forEach((node, i) => (node.children ?? []).forEach((c) => parent.set(c, i)));
  const byNode = new Map();
  for (const ch of glb.channels) {
    if (ch.path === 'weights') continue;
    if (!byNode.has(ch.node)) byNode.set(ch.node, {});
    byNode.get(ch.node)[ch.path] = ch;
  }
  const value = (ch, t) => {
    const { times, values } = ch;
    const size = ch.path === 'rotation' ? 4 : 3;
    let i = 0;
    while (i < times.length - 2 && times[i + 1] <= t) i += 1;
    const x = ch.interpolation === 'STEP' ? (t >= times[i + 1] ? 1 : 0) : Math.min(1, Math.max(0, (t - times[i]) / (times[i + 1] - times[i] || 1)));
    const out = Array.from({ length: size }, (_, k) => values[i * size + k] * (1 - x) + values[(i + 1) * size + k] * x);
    if (size === 4) {
      const l = Math.hypot(...out);
      return out.map((v) => v / l);
    }
    return out;
  };
  const worlds = (t) => {
    const memo = new Map();
    const world = (i) => {
      if (memo.has(i)) return memo.get(i);
      const node = nodes[i];
      const ch = t === null ? {} : byNode.get(i) ?? {};
      const T = ch.translation ? value(ch.translation, t) : node.translation ?? [0, 0, 0];
      const R = ch.rotation ? value(ch.rotation, t) : node.rotation ?? [0, 0, 0, 1];
      const Sc = ch.scale ? value(ch.scale, t) : node.scale ?? [1, 1, 1];
      const m = new Matrix4().compose(new Vector3(...T), new Quaternion(...R), new Vector3(...Sc));
      const p = parent.get(i);
      const w = p === undefined ? m : world(p).clone().multiply(m);
      memo.set(i, w);
      return w;
    };
    return world;
  };
  const points = [];
  const still = worlds(null);
  const v = new Vector3();
  for (const { node, geo } of drawn) {
    const m = still(node);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i += 1) points.push(v.fromBufferAttribute(p, i).applyMatrix4(m).toArray());
  }
  const box = (geo) => {
    const p = geo.attributes.position;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const grow = (x, y, z) => [x, y, z].forEach((c, k) => { min[k] = Math.min(min[k], c); max[k] = Math.max(max[k], c); });
    for (let i = 0; i < p.count; i += 1) grow(p.getX(i), p.getY(i), p.getZ(i));
    for (const d of geo.morphAttributes?.position ?? []) for (let i = 0; i < p.count; i += 1) grow(p.getX(i) + d.getX(i), p.getY(i) + d.getY(i), p.getZ(i) + d.getZ(i));
    return { min, max };
  };
  let first = null;
  for (let k = 0; k < 8; k += 1) {
    const world = worlds((LOOP * k) / 8);
    const mats = drawn.map(({ node }) => world(node));
    if (!first) {
      first = mats;
      continue;
    }
    drawn.forEach(({ geo }, j) => {
      if (mats[j].equals(first[j])) return;
      const b = box(geo);
      for (let i = 0; i < 8; i += 1) {
        points.push(new Vector3(i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]).applyMatrix4(mats[j]).toArray());
      }
    });
  }
  return points;
}

// The contact sheet: the feed's own view of the man (its target and Follow distance, filled in by build()).
const FIT = { target: [0, 1.32, 0], distance: 7 };
const view = (t, label) => ({
  label,
  get cam() { return FIT.target.map((v, k) => v + FOLLOW[k] * FIT.distance); },
  get look() { return FIT.target; },
  fov: 38,
  t
});
export const tiles = [view(1.5, 'man'), view(8.2, 'in'), view(30, 'man'), view(58.2, 'home')];
