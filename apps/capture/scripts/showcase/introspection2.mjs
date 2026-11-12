import { BufferGeometry, DoubleSide, Euler, Float32BufferAttribute, Matrix4, Mesh, MeshBasicMaterial, Quaternion, Raycaster, Vector3 } from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { Glb } from './lib/glb.mjs';
import { quatTrack, tiny } from './introspection/common.mjs';
import { CHILD_DIMS, HAT_AT, PALETTES, Rig, applyPose, briefcaseGeometry, hatGeometry, painter, setDetail, snapshot } from './introspection/figures.mjs';
import { HUG, childPose, childPresence, manPose, travellerBody, travellerPlace, travellerPose } from './introspection2/acting.mjs';
import * as G from './introspection2/gas.mjs';
import * as L from './introspection2/layers.mjs';
import * as LQ from './introspection2/liquid.mjs';
import { layerSounds, voices } from './introspection2/sound.mjs';
import { FPS, K, LOOP, PI, S, U, mix, smooth, sOf } from './introspection2/timeline.mjs';
import { FOLLOW, clampScale, feedFit, layerWeights, morphLayer, zoomed } from './introspection2/zoom.mjs';

// The way down II (see introspection2/BEATS.md). The feed frames a hologram
// once, so the world grows round the point it looks at: every layer is a
// still mesh drawn bigger or smaller by morph targets about C (zoom.mjs), C
// is the man's heart, and the skies are sized at build time so the feed's
// dome fit puts its target exactly on C. The traveller is 4 cm on his
// chest; the zoom carries him through the door until he is Z times that,
// then the world grows round him alone. The hug is drawn in the dark's own
// frame, so the last zoom carries the two of them with it.

export const meta = {
  slug: 'the-way-down-ii',
  name: 'The way down II',
  submittedBy: 'Claude (agent-authored)'
};
/** build.mjs fails the build if Quick Look's moving points × frames exceed this. */
export const budget = { quickLook: 1e8 };

const ZR = {
  statue: { inner: 1e-3, outer: 400 },
  gas: { inner: 0.05, outer: 300 },
  liquid: { inner: 0.001, outer: 500 },
  dark: { inner: 3e-6, outer: 300 },
  sky: { inner: 1e-7, outer: 40 }
};
const SKY_CAP = 8.5;
const TRAV = 0.023; // his scale: 1.75 m of rig is 4 cm
// The camera follows him in: through the door he grows with the zoom until he
// is Z times his size on his chest, and stays that big on screen from then on.
const Z = 5;
// Among the gases and liquids he is bigger again (18×, about 72 cm): at 5× he was a 12 px speck on the busy layers. He shrinks back to Z as he falls into the hole.
const ZW = 18;
const ZW_LIQ = 29; // in the paint he grows to about 1.2 m so the moulds read on a phone
const PELVIS = 0.93;
const R18 = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (18 * PI) / 180);
const Y_PI = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), PI);
const H = new Vector3(HUG.centre[0], HUG.centre[1], 0); // the hug frame's point on C
const SWITCHES = [7, 9.4, 37, 44.6, 58.5];
const EPS = 0.0005;
const add = (a, b, k = 1) => a.map((v, i) => v + k * b[i]);

/** The hug frame (37–58.5): his body's units, H on C, turned to face the feed, growing with the dark from 40. */
function hugFrame(C, t) {
  const F = t < 40 ? 1 : S(t) / (6 * U.dark);
  const s = TRAV * Z * F;
  const RH = H.clone().applyQuaternion(R18).multiplyScalar(s);
  return { T: [C[0] - RH.x, C[1] - RH.y, C[2] - RH.z], Q: R18.clone(), s, F };
}
const frameMatrix = (f) => new Matrix4().compose(new Vector3(...f.T), f.Q, new Vector3(f.s, f.s, f.s));

export async function build() {
  const glb = new Glb();
  const rawMesh = glb.mesh.bind(glb);
  glb.mesh = (name, geometry, material) => rawMesh(name, geometry.index ? geometry : mergeVertices(geometry, 1e-5), material);
  glb.provenance({
    holoim: {
      authored: 'synthetic',
      author: meta.submittedBy,
      title: meta.name,
      note: 'One world grown round the point the feed looks at: each layer is a still mesh scaled by morph targets, with its own positional sound.'
    }
  });
  const drawn = []; // [{ node, geo }] for the feed-fit check
  const meshNode = (name, geo, mat, opts = {}) => {
    const g = geo.index ? geo : mergeVertices(geo, 1e-5);
    const node = glb.node({ name, mesh: rawMesh(name, g, mat), ...opts });
    drawn.push({ node, geo: g });
    return node;
  };

  const mats = {
    man: glb.material({ name: 'Man', color: '#ffffff', emissive: '#1c1814', roughness: 0.72 }),
    flat: glb.material({ name: 'Layer', color: '#ffffff', unlit: true }),
    gasBlend: glb.material({ name: 'Gas', color: '#ffffff', unlit: true, doubleSided: true, blend: true }),
    paint: glb.material({ name: 'Paint', color: '#ffffff', unlit: true, doubleSided: true }),
    sea: glb.material({ name: 'Paint sea', color: '#ffffff', roughness: 0.3 }),
    trav: glb.material({ name: 'Traveller', color: '#ffffff', unlit: true }),
    child: glb.material({ name: 'Child', color: '#ffffff', unlit: true }),
    glow: glb.material({ name: 'Glow', color: '#ffffff', unlit: true, opacity: 0.14 }),
    pool: glb.material({ name: 'Light pool', color: '#ffffff', unlit: true, blend: true })
  };

  // --- Figures --------------------------------------------------------------
  setDetail(0.6);
  const man = new Rig({ suit: true });
  setDetail(0.5);
  const trav = new Rig();
  const child = new Rig({ dims: CHILD_DIMS, child: true });
  setDetail(1);

  // The statue: the man at 7 s, baked into one still mesh.
  applyPose(man, manPose(man, 7));
  const chest7 = man.j.chest.matrixWorld.clone();
  const chest7Q = new Quaternion().setFromRotationMatrix(chest7);
  const C = man.world('chest', 0, 0.1, 0).toArray();
  const manGeo = man.geometry(painter(PALETTES.man));
  const hatGeo = hatGeometry('#5a4a3c', '#2a2a2a');
  const caseGeo = briefcaseGeometry();
  const plain = (geo, m) => {
    const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(m);
    const out = new BufferGeometry();
    out.setAttribute('position', g.attributes.position.clone());
    out.setAttribute('normal', g.attributes.normal.clone());
    const c = g.attributes.color;
    out.setAttribute('color', c.itemSize === 3 ? c.clone() : new Float32BufferAttribute(Array.from({ length: c.count * 3 }, (_, i) => c.array[Math.floor(i / 3) * 4 + (i % 3)]), 3));
    return out;
  };
  const statueParts = man.skeleton.map(([joint]) => plain(manGeo[joint], man.j[joint].matrixWorld));
  statueParts.push(plain(hatGeo, man.hat.matrixWorld), plain(caseGeo, man.j.wristR.matrixWorld));
  const statueGeo = mergeVertices(mergeGeometries(statueParts), 1e-5);

  // The door: where the line from C toward the feed leaves his shirt.
  const ray = new Raycaster(new Vector3(...C), new Vector3(...FOLLOW));
  const hits = ray.intersectObject(new Mesh(statueGeo, new MeshBasicMaterial({ side: DoubleSide })));
  const shirt = hits.filter((h) => h.distance < 0.18).at(-1);
  if (!shirt) throw new Error('no shirt in front of C');
  const n = shirt.face.normal.clone();
  if (n.dot(new Vector3(...FOLLOW)) < 0) n.negate();
  const dd = shirt.distance;
  const hit = shirt.point.toArray();
  const doorRight = new Vector3(0, 1, 0).cross(n).normalize();
  const doorUp = n.clone().cross(doorRight).normalize();
  const toChest7 = chest7.clone().invert();
  const pinLocal = shirt.point.clone().addScaledVector(n, 0.0058).applyMatrix4(toChest7);
  const inLocal = shirt.point.clone().addScaledVector(n, -0.03).applyMatrix4(toChest7);
  console.error(`C ${C.map((v) => v.toFixed(3))}  door at ${dd.toFixed(3)} m (hits ${hits.map((h) => h.distance.toFixed(3)).join(' ')})`);

  // --- Time and the sampled performance ---------------------------------------
  const grid = Array.from({ length: LOOP * FPS + 1 }, (_, i) => i / FPS);
  const keyT = [...grid, ...SWITCHES.map((s) => s - EPS)].sort((a, b) => a - b);
  const frames = { man: [], trav: [], child: [] };
  const roots = { trav: [], child: [] };
  const glowAt = []; // his chest in the hug frame, for the still glow
  const presenceOf = (t) => (t >= 58.5 ? smooth(58.6, 59.6, t) : 1);

  // His root in the world (mode A): chest-pinned, door, then free.
  const C3 = new Vector3(...C);
  const F3 = new Vector3(...FOLLOW);
  const UP = new Vector3(0, 1, 0);
  const RIGHT = new Vector3(FOLLOW[2], 0, -FOLLOW[0]).normalize();
  const deg = (d) => (d * PI) / 180;
  // In the gas he faces the feed three-quarters (18° is square on); he turns his back to it to open the hatch.
  const YAW = K([[9.4, deg(158)], [11.4, deg(40)], [23.3, deg(40)], [23.9, deg(198)], [25.4, deg(198)], [27, deg(48)], [29.5, deg(40)], [29.95, deg(18)], [31.1, deg(18)], [31.6, deg(62)], [32.4, deg(40)], [32.95, deg(18)], [35.6, deg(18)], [36.8, deg(108)], [37, deg(108)]]);
  const PITCH = K([[9.4, 0], [37, 0]]);
  // His pelvis against the paint, in his own metres (×TRAV·ZW): he floats waist-deep, is pressed down a little in each mould, heaves up out of the first, and sinks as he goes limp.
  const OFF = K([[27, -0.12], [29.6, -0.12], [30.0, -0.2], [31.1, -0.2], [31.4, 0.02], [32.2, -0.08], [32.6, -0.12], [33.0, -0.22], [34.6, -0.22], [35.4, -0.34], [36.0, -0.4], [36.4, -0.5]]);
  const ySurf = (t) => sOf('liquid', t) * LQ.seaHeight(t);
  const buffet = (t) => smooth(11.5, 13, t) * (1 - smooth(21.5, 22.5, t));
  const floor37 = travellerPlace(trav, 37).floor;
  const zWorld = (t) => mix(mix(Math.min(S(t), ZW), ZW_LIQ, smooth(25.3, 26.8, t)), Z, smooth(36.3, 37, t));
  // The gas (9.4–25.3): in from the door to his place above the hatch (G.anchorWorld), dragged about by the wisps that hold him, then to the hatch's near edge, over it and down through it.
  const sGas = (t) => sOf('gas', t);
  const hatchW = (t) => new Vector3(...zoomed(G.HATCH.centre(C), C, sGas(t)));
  const nH = new Vector3(...G.HATCH.n);
  const farH = new Vector3(...G.HATCH.far);
  function gasRoot(t) {
    const entry = C3.clone().addScaledVector(F3, Math.min(0.55, dd * S(t) - 0.03));
    const anchor = new Vector3(...G.anchorWorld(C, sGas(t)));
    const p = entry.lerp(anchor, smooth(9.6, 11.6, t));
    const e = buffet(t);
    p.addScaledVector(RIGHT, e * (0.04 * Math.sin(1.3 * t) + 0.025 * Math.sin(3.1 * t + 1))).addScaledVector(UP, e * (0.03 * Math.sin(0.9 * t + 2) + 0.02 * Math.sin(2.7 * t)));
    for (const tug of G.TUGS) {
      const h = G.holdOf(tug, t);
      if (h < 1e-3) continue;
      const toward = new Vector3(...zoomed(G.tugCentre(C, tug), C, sGas(t))).sub(anchor).normalize();
      p.addScaledVector(toward, 0.12 * h);
    }
    // Offsets in his own body metres (hs a metre of him).
    const hw = hatchW(t);
    const hs = TRAV * zWorld(t);
    const half = G.HATCH.half * sGas(t);
    const near = hw.clone().addScaledVector(farH, -(half + 0.45 * hs)).addScaledVector(nH, (0.25 + 0.35 * smooth(24.3, 24.6, t)) * hs);
    p.lerp(near, smooth(23.3, 24.0, t));
    p.lerp(hw.clone().addScaledVector(nH, 0.75 * hs), smooth(24.6, 24.85, t));
    p.lerp(hw.clone().addScaledVector(nH, -1.6 * hs), smooth(24.85, 25.3, t));
    return p;
  }
  const through = gasRoot(25.3);
  function worldRoot(t) {
    const gasP = t < 25.3 ? gasRoot(t) : through.clone();
    // The liquid.
    let b = ySurf(t) + TRAV * zWorld(t) * OFF(Math.max(t, 27));
    if (t >= 36.3) b = mix(b, TRAV * Z * (floor37 + PELVIS - 0.5), smooth(36.3, 37, t));
    const liqP = C3.clone().addScaledVector(UP, b);
    const p = gasP.lerp(liqP, smooth(25.3, 26.8, t));
    const q = new Quaternion().setFromEuler(new Euler(PITCH(t), YAW(t), 0, 'YXZ'));
    return { T: p.toArray(), Q: q, s: TRAV * zWorld(t) };
  }
  // A world point in his rig's space, given his root.
  const toRig = (w, root) => new Vector3(...w).sub(new Vector3(...root.T)).applyQuaternion(root.Q.clone().invert()).divideScalar(root.s).add(new Vector3(0, PELVIS, 0));
  const toWorld = (v, root) => v.clone().sub(new Vector3(0, PELVIS, 0)).multiplyScalar(root.s).applyQuaternion(root.Q).add(new Vector3(...root.T));
  // The limbs the gas holds: where a limb would reach toward its billow (shoulder or hip plus a full stretch), and the lid's near edge.
  const REACH = { wristL: [[0.19, 1.45, 0], 0.72], wristR: [[-0.19, 1.45, 0], 0.72], ankleL: [[0.1, 0.9, 0], 0.92], ankleR: [[-0.1, 0.9, 0], 0.92] };
  function pulls(t, root) {
    const out = [];
    for (const tug of G.TUGS) {
      const w = G.holdOf(tug, t);
      if (w < 1e-3) continue;
      const [from, l] = REACH[tug.limb];
      const o = new Vector3(...from);
      const dir = toRig(zoomed(G.tugCentre(C, tug), C, sGas(t)), root).sub(o).normalize();
      out.push({ limb: tug.limb, w, at: o.addScaledVector(dir, l) });
    }
    const grip = smooth(23.95, 24.15, t) * (1 - smooth(24.5, 24.65, t));
    if (grip > 1e-3) {
      for (const [limb, u] of [['wristL', -0.55], ['wristR', 0.55]]) {
        const lw = zoomed(lidPoint(t, u * G.HATCH.half, -0.92 * G.HATCH.half), C, sGas(t));
        out.push({ limb, w: grip, at: toRig(lw, root) });
      }
    }
    return out;
  }
  const limbs = { wristL: [], wristR: [], ankleL: [], ankleR: [] }; // world positions per key time

  const hatchParts = G.hatch(C);
  const lidPoint = hatchParts.lidAt;
  for (const t of keyT) {
    applyPose(man, manPose(man, t));
    frames.man.push(snapshot(man));
    const chestW = man.j.chest.matrixWorld.clone();

    applyPose(child, childPose(child, t, null));
    const back = { L: child.world('chest', 0.11, 0.1, -0.1), R: child.world('chest', -0.11, 0.1, -0.1) };
    const shoulder = child.world('shoulderR', 0, 0.02, 0);
    const hugMode = t >= 37 && t < 58.5;
    const inWorld = t >= 9.4 && t < 37;
    const early = inWorld ? worldRoot(t) : null;
    applyPose(trav, travellerPose(trav, t, hugMode ? travellerPlace(trav, t) : {}, { shoulder, back, pull: inWorld ? pulls(t, early) : [] }));
    for (const limb of Object.keys(limbs)) limbs[limb].push(inWorld ? toWorld(trav.world(limb), early).toArray() : null);
    frames.trav.push(snapshot(trav));
    glowAt.push(trav.world('pelvis', 0, 0.3, 0));
    const neck = { L: trav.world('neck', 0.07, 0.03, -0.05), R: trav.world('neck', -0.07, 0.03, -0.05) };
    applyPose(child, childPose(child, t, { neck, head: trav.world('head', 0, 0.07, 0.02) }));
    frames.child.push(snapshot(child));

    // His root: the node sits at his pelvis height (his frame's (0, 0.93, 0)).
    let root;
    if (t < 7 || t >= 58.5) {
      const p = pinLocal.clone().applyMatrix4(chestW);
      const q = new Quaternion().setFromRotationMatrix(chestW).multiply(Y_PI);
      root = { T: p.toArray(), Q: q, s: TRAV * presenceOf(t) };
    } else if (t < 9.4) {
      const local = pinLocal.clone().lerp(inLocal, smooth(8.4, 9.3, t));
      root = { T: zoomed(local.applyMatrix4(chest7).toArray(), C, S(t)), Q: chest7Q.clone().multiply(Y_PI), s: TRAV * Math.min(S(t), ZW) };
    } else if (t < 37) {
      root = early;
    } else {
      const f = hugFrame(C, t);
      const p = new Vector3(0, PELVIS, 0).applyMatrix4(frameMatrix(f));
      root = { T: p.toArray(), Q: f.Q, s: f.s };
    }
    roots.trav.push(root);
    roots.child.push(hugFrame(C, t));
  }
  const at = (t) => keyT.indexOf(t);

  // --- The zoom, named for the viewer -------------------------------------------
  // The viewer's dome wraps the outermost layer, the man, so it grows with him
  // about C and leaves the view when the world goes into his chest.
  const zoomNode = glb.node({ name: 'HologramZoom', translation: C });
  glb.animate(zoomNode, 'scale', keyT, keyT.flatMap((t) => [S(t), S(t), S(t)]));

  // --- The man: alive before 7 s and after 58.5 s, a statue in between ------------
  const live = (t) => t < 7 || t >= 58.5;
  const manPlace = glb.node({ name: 'man' });
  glb.animate(manPlace, 'scale', keyT, keyT.flatMap((t) => (live(t) ? [1, 1, 1] : [1e-4, 1e-4, 1e-4])));
  const manNodes = writeJoints(glb, meshNode, man, frames.man, keyT, glb.node({ name: 'man-body', parent: manPlace }), 'man', manGeo, mats.man);
  meshNode('man-hat', hatGeo, mats.man, { translation: HAT_AT, rotation: frames.man[0].hat, parent: manNodes.head });
  glb.animate(drawn.at(-1).node, 'rotation', keyT, quatTrack(frames.man.map((f) => f.hat)));
  meshNode('man-briefcase', caseGeo, mats.man, { parent: manNodes.wristR });

  // Once the camera is through his shirt the statue is all inside-out limbs: hide it.
  const statueS = (t) => (live(t) || S(t) > 32 ? ZR.statue.inner : S(t));
  zoomLayer('man-statue', statueGeo, mats.man, ZR.statue, (t) => statueS(t));

  // The door: hidden in him until 4.8 s, opened from 7 s, closed after he is back.
  const doorParts = L.door(hit, { right: doorRight.toArray(), up: doorUp.toArray(), normal: n.toArray() });
  const doorS = (t) => {
    if (t < 4.8) return ZR.statue.inner;
    if (t < 5.0) return mix(ZR.statue.inner, 1, smooth(4.8, 5.0, t));
    if (t < 59.3) return live(t) ? 1 : S(t);
    return mix(1, ZR.statue.inner, smooth(59.3, 59.6, t));
  };
  const doorOpen = K([[0, 0], [7, 0], [8.3, 1], [58.5, 1], [59.2, 0], [60, 0]]);
  zoomLayer('door', doorParts.geo, mats.flat, ZR.statue, doorS, doorParts.shapes, (t) => [doorOpen(t)]);

  // --- The layers -----------------------------------------------------------
  const RC = 0.95; // content stays inside this ball round C (the skies' radius must cover it)
  const gasS = (t) => sOf('gas', t);
  const bank = G.bank(C);
  zoomLayer('gas-bank', bank.geo, mats.flat, ZR.gas, gasS, bank.shapes, bank.weights);
  zoomLayer('gas-floor', bank.floor.geo, mats.gasBlend, ZR.gas, gasS, bank.floor.shapes, bank.floor.weights);
  zoomLayer('gas-lining', G.lining(C), mats.flat, ZR.gas, gasS);
  zoomLayer('gas-hatch', hatchParts.frame, mats.flat, ZR.gas, gasS);
  zoomLayer('gas-lid', hatchParts.lid.geo, mats.flat, ZR.gas, gasS, hatchParts.lid.shapes, hatchParts.lid.weights);
  const ambient = G.ambientBillows(C);
  zoomLayer('gas-ambient', ambient.geo, mats.gasBlend, ZR.gas, gasS, ambient.shapes, ambient.weights);
  const demands = G.demandBillows(C);
  zoomLayer('gas-demands', demands.geo, mats.gasBlend, ZR.gas, gasS, demands.shapes, demands.weights);
  // The wisps, from where his limbs actually were (in the gas's home units).
  G.TUGS.forEach((tug, i) => {
    const track = limbs[tug.limb];
    const limbHome = (t) => {
      let j = keyT.findIndex((k) => k >= t - 1e-9);
      if (j < 0) j = keyT.length - 1;
      return C.map((c, k) => c + (track[j][k] - c) / gasS(keyT[j]));
    };
    const w = G.wisp(C, tug, limbHome, 900 + i);
    zoomLayer(`gas-wisp-${i}`, w.geo, mats.gasBlend, ZR.gas, gasS, w.shapes, w.weights);
  });
  // The liquid: the paint sea, and the two moulds that press him into the man's outline.
  const sLiq = (t) => sOf('liquid', t);
  const sea = LQ.sea(C);
  zoomLayer('liquid-sea', sea.geo, mats.sea, ZR.liquid, sLiq, sea.shapes, sea.weights, sea.normals);
  const place = (t) => {
    const r = worldRoot(t);
    return { p: C.map((c, k) => c + (r.T[k] - c) / sLiq(t)), k: r.s / sLiq(t) };
  };
  LQ.MOULDS.forEach((m, i) => {
    const mo = LQ.mould(C, m, place, 300 + i);
    zoomLayer(`liquid-mould-${i}`, mo.geo, mats.paint, ZR.liquid, sLiq, mo.shapes, mo.weights);
  });

  // The dark, in its own home units: a hug-frame point p is C + κ·R18·(p − H).
  const kappa = (TRAV * Z) / 6;
  const toDark = (p) => {
    const v = new Vector3(...p).sub(H).applyQuaternion(R18).multiplyScalar(kappa);
    return [C[0] + v.x, C[1] + v.y, C[2] + v.z];
  };
  const darkS = (t) => sOf('dark', t);
  zoomLayer('dark-floor', L.darkFloor(C, RC, 0.5 * kappa), mats.flat, ZR.dark, darkS);
  // The pool of his light on the floor follows him by two translation shapes.
  const land = [HUG.land.x, 0.012, HUG.land.z];
  const pool = L.lightPool(toDark(land), 1.4 * kappa);
  const dx = toDark([H.x + 1, 0.5, 0]).map((v, k) => v - C[k]);
  const dz = toDark([H.x, 0.5, 1]).map((v, k) => v - C[k]);
  const poolC = toDark(land);
  const poolShapes = [L.shapeOf(pool, () => dx), L.shapeOf(pool, () => dz), L.shapeOf(pool, (p) => poolC.map((c, k) => c - p[k]))];
  const poolOn = (t) => smooth(39.9, 40.3, t) * (1 - smooth(58.0, 58.4, t));
  zoomLayer('light-pool', pool, mats.pool, ZR.dark, darkS, poolShapes, (t) => {
    const b = travellerBody(Math.min(Math.max(t, 37), 58.5));
    return [b.x - land[0], b.z - land[2], 1 - poolOn(t)];
  });
  // His glow, still in the dark from 44.6 s (he kneels there), so the last zoom can grow it.
  const g0 = glowAt[at(44.6)];
  const glowC = toDark(g0.toArray());
  const stillGlow = L.glowShells(glowC, 0.6 * kappa);
  const glowShapes = [L.shapeOf(stillGlow, (p) => p.map((v, k) => v - glowC[k])), L.shapeOf(stillGlow, (p) => glowC.map((c, k) => c - p[k]))];
  const GLOW_GROW = K([[0, 0], [48, 0], [52, 0.35], [56, 0.35], [58, 0], [60, 0]]);
  zoomLayer('glow-still', stillGlow, mats.glow, ZR.dark, darkS, glowShapes, (t) => [GLOW_GROW(t), t >= 44.6 && t < 58.4 ? 0 : 1]);

  // --- The traveller and the child ------------------------------------------------
  // Amber, not pale gold: pale gold matched the pastel gas in luminance and vanished there; amber still reads as light in the dark.
  const travPaint = painter({ top: '#f2a63a', shirt: '#f2a63a', legs: '#e08a2a', skin: '#ffd98c', hair: '#b4601a', brow: '#a35416', shoes: '#c27322', socks: '#f2a63a', temple: '#f2a63a', watch: '#f2a63a' }, { baked: true, light: new Vector3(0.2, 1, 0.5).normalize() });
  const travRoot = glb.node({ name: 'traveller', translation: roots.trav[0].T, rotation: roots.trav[0].Q.toArray(), scale: [roots.trav[0].s, roots.trav[0].s, roots.trav[0].s] });
  glb.animate(travRoot, 'translation', keyT, roots.trav.flatMap((r) => r.T));
  glb.animate(travRoot, 'rotation', keyT, quatTrack(roots.trav.map((r) => r.Q.toArray())));
  glb.animate(travRoot, 'scale', keyT, roots.trav.flatMap((r) => [tiny(r.s), tiny(r.s), tiny(r.s)]));
  const travBody = glb.node({ name: 'traveller-body', translation: [0, -PELVIS, 0], parent: travRoot });
  const travNodes = writeJoints(glb, meshNode, trav, frames.trav, keyT, travBody, 'traveller', trav.geometry(travPaint), mats.trav);
  const glowNode = meshNode('glow', L.glowShells([0, 0, 0], 0.6), mats.glow, { translation: [0, 0.3, 0], parent: travNodes.pelvis });
  glb.animate(glowNode, 'scale', keyT, keyT.flatMap((t) => (t < 44.6 || t >= 58.5 ? [1, 1, 1] : [1e-4, 1e-4, 1e-4])));

  const kid = roots.child;
  const childRoot = glb.node({ name: 'child', translation: kid[0].T, rotation: kid[0].Q.toArray(), scale: [kid[0].s, kid[0].s, kid[0].s] });
  glb.animate(childRoot, 'translation', keyT, kid.flatMap((r) => r.T));
  glb.animate(childRoot, 'rotation', keyT, quatTrack(kid.map((r) => r.Q.toArray())));
  glb.animate(childRoot, 'scale', keyT, kid.flatMap((r) => [tiny(r.s), tiny(r.s), tiny(r.s)]));
  const base = [HUG.child.x, 0, HUG.child.z];
  const childShow = glb.node({ name: 'child-presence', translation: base, scale: [1e-4, 1e-4, 1e-4], parent: childRoot });
  glb.animate(childShow, 'scale', keyT, keyT.flatMap((t) => { const p = tiny(childPresence(t)); return [p, p, p]; }));
  const childBody = glb.node({ name: 'child-body', translation: base.map((v) => -v), parent: childShow });
  writeJoints(glb, meshNode, child, frames.child, keyT, childBody, 'child', child.geometry(painter(PALETTES.child, { baked: true, dim: 0.5 })), mats.child);

  // --- The skies, sized so the feed's dome fit lands on C ----------------------------
  const others = fitPoints(glb, drawn);
  const skyPoints = (R) => {
    const g = L.sky(C, R, '#ffffff', '#ffffff');
    const p = g.attributes.position;
    return Array.from({ length: p.count }, (_, i) => [p.getX(i), p.getY(i), p.getZ(i)]);
  };
  let lo = 0.5;
  let hi = 2;
  for (let i = 0; i < 50; i += 1) {
    const R = (lo + hi) / 2;
    if (feedFit([...others, ...skyPoints(R)]).target[1] < C[1]) lo = R;
    else hi = R;
  }
  const R0 = (lo + hi) / 2;
  const content = Math.max(...drawn.filter((d) => /gas|liquid|dark|light-pool|glow-still|door/.test(glb.json.nodes[d.node].name)).map((d) => maxDist(d.geo, C)));
  console.error(`sky radius R0 ${R0.toFixed(4)}; layer content reaches ${content.toFixed(3)} from C`);
  if (content > R0) console.error(`WARNING: layer content (${content.toFixed(3)}) is outside the sky radius (${R0.toFixed(3)}) and widens the dome`);
  const skyR = (t) => L.skyRadii(S(t), R0, U, SKY_CAP);
  zoomLayer('sky-gas', L.sky(C, R0, '#e6dcf5', '#f8dcc8'), mats.flat, ZR.sky, (t) => skyR(t).gas / R0);
  zoomLayer('sky-liquid', L.sky(C, R0, '#3d0c10', '#24060a'), mats.flat, ZR.sky, (t) => skyR(t).liquid / R0);
  zoomLayer('sky-dark', L.sky(C, R0, '#030305', '#010102'), mats.flat, ZR.sky, (t) => skyR(t).dark / R0);

  const fit = feedFit(fitPoints(glb, drawn));
  const off = fit.target.map((v, k) => v - C[k]);
  console.error(`feed fit: target ${fit.target.map((v) => v.toFixed(4))} (off C by ${Math.hypot(...off).toFixed(4)} m), distance ${fit.distance.toFixed(3)}, near ${fit.near.toFixed(3)}, far ${fit.far.toFixed(2)}`);
  FIT.target = fit.target;
  FIT.distance = fit.distance;

  // --- Sound: one emitter per layer, carried by its layer's zoom -----------------------
  const sounds = { ...layerSounds(), ...Object.fromEntries(Object.entries(voices(G.DEMANDS)).map(([id, w]) => [`voice-${id}`, w])) };
  const roll = { distanceModel: 'linear', refDistance: 0.9, maxDistance: 2.3 };
  const emitter = (name, fn, opts = roll) => {
    const node = glb.node({ name: `sound-${name}`, translation: fn(0) });
    glb.animate(node, 'translation', keyT, keyT.flatMap(fn));
    glb.sound(sounds[name], { node, name: `layer-${name}`, ...opts });
  };
  const stageP = add(add(C, FOLLOW, 1.6), [0, 0.1, 0]);
  // The stage tune drifts off slowly (S^0.3) so it bends away under the gas rather than vanishing at 8.5 s.
  emitter('stage', (t) => zoomed(stageP, C, Math.min(S(t), 2000) ** 0.3));
  emitter('gas', (t) => add(C, FOLLOW, 0.31 * clampScale(sOf('gas', t), ZR.gas)));
  // The demands nag from their own billows, so each voice comes from where its cloud pulses.
  for (const d of G.DEMANDS) {
    emitter(`voice-${d.id}`, (t) => zoomed(G.demandCentre(C, d), C, clampScale(sOf('gas', t), ZR.gas)), { distanceModel: 'linear', refDistance: 1, maxDistance: 4 });
  }
  // The waltz in the paint presses down from overhead, just above the feed's ear (2.5 m out from the target toward
  // the camera) so the linear rolloff (out to 2.3 m) keeps it at full weight.
  emitter('liquid', (t) => {
    const s = clampScale(sOf('liquid', t), ZR.liquid);
    return add(add(C, FOLLOW, Math.min(2.2, 0.33 * s)), [0, 1, 0], Math.min(0.6, 0.1 * s));
  });
  emitter('dark', (t) => {
    const real = clampScale(sOf('dark', t), ZR.dark);
    const held = t >= 36.9 && t < 58.2 ? mix(6, real, smooth(57.6, 58.2, t)) : real;
    return add(C, FOLLOW, 0.42 * held);
  });
  const heart = glb.node({ name: 'sound-heart', translation: C });
  glb.sound(sounds.heart, { node: heart, name: 'layer-heart', distanceModel: 'linear', refDistance: 2.6, maxDistance: 4 });

  return glb;

  // A still layer drawn at s(t) times its home size, with shapes weighted w(t).
  function zoomLayer(name, geo, mat, zoom, s, shapes = [], w = () => [], normals = null) {
    const g = geo.index ? geo : mergeVertices(geo, 1e-5);
    morphLayer(g, C, zoom, shapes, normals);
    g.userData.weights = layerWeights(s(0), zoom, w(0));
    const node = meshNode(name, g, mat);
    glb.animate(node, 'weights', keyT, keyT.flatMap((t) => layerWeights(s(t), zoom, w(t))));
    return node;
  }
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

function maxDist(geo, C) {
  const p = geo.attributes.position;
  let m = 0;
  for (let i = 0; i < p.count; i += 1) m = Math.max(m, Math.hypot(p.getX(i) - C[0], p.getY(i) - C[1], p.getZ(i) - C[2]));
  return m;
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
    while (i < times.length - 2 && times[i + 1] < t) i += 1;
    const x = Math.min(1, Math.max(0, (t - times[i]) / (times[i + 1] - times[i] || 1)));
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

// The contact sheet: the feed's own view (its target and Follow distance, filled in by build()).
const FIT = { target: [0, 1.32, 0], distance: 7 };
const view = (t, label) => ({
  label,
  get cam() { return FIT.target.map((v, k) => v + FOLLOW[k] * FIT.distance); },
  get look() { return FIT.target; },
  fov: 38,
  t
});
export const tiles = [
  view(1.5, 'man'), view(6.5, 'door'), view(8.2, 'haul'), view(10.6, 'enter'), view(12, 'gas'), view(16.2, 'tugged'),
  view(20.6, 'held'), view(24.3, 'hatch'), view(28.3, 'liquid'), view(33, 'pressed'), view(36.8, 'hole'), view(38.5, 'fall'),
  view(42, 'dark'), view(46.5, 'reach'), view(50.5, 'hug'), view(54.5, 'hug zoom'), view(56, 'liquid back'), view(59.2, 'home')
];
