import { BufferGeometry, DoubleSide, Euler, Float32BufferAttribute, Matrix4, Mesh, MeshBasicMaterial, Quaternion, Raycaster, Vector3 } from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { Glb } from './lib/glb.mjs';
import { lin, quatTrack, tiny } from './introspection/common.mjs';
import { CHILD_DIMS, HAT_AT, PALETTES, Rig, applyPose, briefcaseGeometry, hatGeometry, painter, setDetail, snapshot } from './introspection/figures.mjs';
import { HUG, childPose, childPresence, manPose, travellerBody, travellerPlace, travellerPose } from './introspection2/acting.mjs';
import * as G from './introspection2/gas.mjs';
import * as L from './introspection2/layers.mjs';
import { HITS, HUES, GUSTS, KNOCK_PEAK, knock, knockCurve, knocked } from './introspection2/events.mjs';
import { POOL, liquid } from './introspection2/liquid.mjs';
import { layerSounds, voices } from './introspection2/sound.mjs';
import { FPS, K, LOOP, PI, S, U, mix, smooth, sOf } from './introspection2/timeline.mjs';
import { sparseRows } from './introspection2/world.mjs';
import { FOLLOW, SCREEN, clampScale, feedFit, layerWeights, morphLayer, zoomed } from './introspection2/zoom.mjs';

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
    paint: glb.material({ name: 'Paint', color: '#ffffff', unlit: true, doubleSided: true }),
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

  // --- Time and the switches ------------------------------------------------------
  // Each layer opens as an iris whose hole is painted the next layer's sky as
  // the feed sees it; the switch to that layer happens on the frame the hole
  // first fills the view (TAN: the frame's half diagonal), and on the way out
  // on the last frame it still does. At a switch the layer we leave collapses
  // to C and the next sky closes round the camera.
  const D_CAM = 6.979;
  const TAN = 0.75;
  const solve = (a, b, f) => {
    let lo = a;
    let hi = b;
    const sa = Math.sign(f(a));
    for (let i = 0; i < 60; i += 1) {
      const m = (lo + hi) / 2;
      if (Math.sign(f(m)) === sa) lo = m;
      else hi = m;
    }
    return (lo + hi) / 2;
  };
  const after = (t) => Math.ceil(t * FPS - 1e-6) / FPS;
  const before = (t) => Math.floor(t * FPS + 1e-6) / FPS;
  const IR_SHIRT = 0.022;
  const fillShirt = (t) => S(t) * IR_SHIRT - TAN * (D_CAM - S(t) * dd);
  const GI = { R: 0.035, f: 0.035, drop: 0.012 }; // the gas iris (home units): radius, out toward the feed, down
  const fillGas = (t) => {
    const s = sOf('gas', t);
    return s * GI.R - (TAN * (D_CAM - s * GI.f) + s * GI.drop);
  };
  const S1 = after(solve(7, 12, fillShirt));
  const T_GL = after(solve(24.5, 27.5, fillGas));
  const B_DL = before(solve(55.5, 56.3, (t) => S(t) - 12 * U.liquid));
  const B_GL = before(solve(56.3, 57.2, fillGas));
  const B_S1 = before(solve(57.2, 58.5, fillShirt));
  console.error(`switches: shirt ${S1.toFixed(3)}, gas→liquid ${T_GL.toFixed(3)}, back: dark→liquid ${B_DL.toFixed(3)}, liquid→gas ${B_GL.toFixed(3)}, gas→man ${B_S1.toFixed(3)}`);
  const SWITCHES = [7, 9.4, S1, T_GL, 37, 44.6, B_DL, B_GL, B_S1, 58.5];
  /** Which layer the feed is in at t. */
  const active = (t) => (t < S1 ? 'man' : t < T_GL ? 'gas' : t < 37 ? 'liquid' : t < B_DL ? 'dark' : t < B_GL ? 'liquid' : t < B_S1 ? 'gas' : 'man');

  const grid = Array.from({ length: LOOP * FPS + 1 }, (_, i) => i / FPS);
  const keyT = [...new Set([...grid, ...SWITCHES.map((s) => s - EPS), ...SWITCHES])].sort((a, b) => a - b);
  const frames = { man: [], trav: [], child: [] };
  const roots = { trav: [], child: [] };
  const glowAt = []; // his chest in the hug frame, for the still glow
  const presenceOf = (t) => (t >= 58.5 ? smooth(58.6, 59.6, t) : 1);

  // His root in the world (mode A): chest-pinned, door, then free.
  const C3 = new Vector3(...C);
  const F3 = new Vector3(...FOLLOW);
  const UP = new Vector3(0, 1, 0);
  const SU3 = new Vector3(...SCREEN.up);
  const RIGHT = new Vector3(FOLLOW[2], 0, -FOLLOW[0]).normalize();
  const deg = (d) => (d * PI) / 180;
  // He faces the feed three-quarters (18° is square on) through the gas and the paint.
  const YAW = K([[9.4, deg(158)], [11.4, deg(40)], [24.0, deg(40)], [26.0, deg(30)], [27, deg(40)], [36.8, deg(40)], [37, deg(108)]]);
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
    return { yaw, pitch, roll };
  };
  // His pelvis against the paint, in his own metres (×TRAV·ZW_LIQ): waist-deep, sinking through the opening at the end.
  const OFF = K([[27, -0.12], [35.6, -0.14], [36.1, -0.6], [36.9, -2.4]]);
  const buffet = (t) => smooth(11.5, 13, t) * (1 - smooth(21.5, 22.5, t));
  const floor37 = travellerPlace(trav, 37).floor;
  const zWorld = (t) => mix(mix(Math.min(S(t), ZW), ZW_LIQ, smooth(25.3, 26.8, t)), Z, smooth(36.3, 37, t));
  const sGas = (t) => sOf('gas', t);
  const sLiq = (t) => sOf('liquid', t);
  const gasHome = C3.clone().addScaledVector(F3, 0.5).addScaledVector(SU3, 0.32);
  const giHome = add(add(C, FOLLOW, GI.f), SCREEN.up, -GI.drop);
  const irisW = (t) => new Vector3(...zoomed(giHome, C, sGas(t)));
  // Him in the gas without the blows (the gusts aim here).
  function gasBase(t) {
    const entry = C3.clone().addScaledVector(F3, Math.min(0.55, dd * S(t) - 0.03));
    const p = entry.lerp(gasHome, smooth(9.6, 11.6, t));
    const e = buffet(t);
    return p.addScaledVector(RIGHT, e * (0.04 * Math.sin(1.3 * t) + 0.025 * Math.sin(3.1 * t + 1))).addScaledVector(SU3, e * (0.03 * Math.sin(0.9 * t + 2) + 0.02 * Math.sin(2.7 * t)));
  }
  function gasRoot(t) {
    const p = gasBase(t).add(new Vector3(...knock(GUSTS, t, 0.38)));
    // Letting go: he drifts over the opening and sinks into it, then stays behind its hole.
    const iw = irisW(t);
    p.lerp(iw.clone().addScaledVector(F3, 0.1).addScaledVector(SU3, 0.12), smooth(23.9, 24.6, t));
    p.lerp(iw.clone().addScaledVector(F3, -0.8), smooth(24.6, 25.3, t));
    return p;
  }
  // Him in the paint without the blows.
  const liqY = (t) => -POOL.drop + TRAV * ZW_LIQ * OFF(Math.max(t, 27));
  function liquidBase(t) {
    return C3.clone().addScaledVector(UP, liqY(t));
  }
  function worldRoot(t) {
    let p;
    if (t < T_GL) p = gasRoot(t);
    else {
      // Out of the gas's hole he drops from above the frame into the paint.
      const u = smooth(T_GL, 26.95, t) ** 1.6;
      p = liquidBase(t).addScaledVector(UP, (1 - u) * 3.2);
      const kn = new Vector3(...knock(HITS, t, 0.42));
      kn.y *= 0.35;
      p.add(kn);
      if (t >= 36.3) p.y = mix(p.y, C[1] + TRAV * Z * (floor37 + PELVIS - 0.5), smooth(36.3, 37, t));
    }
    const tb = t < T_GL ? tumble(GUSTS, t, 1) : tumble(HITS, t, 0.8);
    const q = new Quaternion().setFromEuler(new Euler(tb.pitch, YAW(t) + tb.yaw, tb.roll, 'YXZ'));
    return { T: p.toArray(), Q: q, s: TRAV * zWorld(t) };
  }
  // His limbs trail the way the strongest blow is pushing him.
  const REACH = { wristL: [[0.19, 1.45, 0], 0.72], wristR: [[-0.19, 1.45, 0], 0.72], ankleL: [[0.1, 0.9, 0], 0.92], ankleR: [[-0.1, 0.9, 0], 0.92] };
  function pulls(t, root) {
    const { best } = knocked(t < T_GL ? GUSTS : HITS, t);
    if (!best || best.k < 0.05) return [];
    const w = Math.min(1, best.k) * (t < T_GL ? 0.7 : 0.55);
    const away = new Vector3(...best.d).negate().applyQuaternion(root.Q.clone().invert()).normalize();
    return Object.entries(REACH).map(([limb, [from, l]]) => {
      const o = new Vector3(...from);
      return { limb, w, at: o.addScaledVector(away, l).add(new Vector3(0, limb.startsWith('ankle') ? 0 : 0.1, 0)) };
    });
  }

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

  // The statue stands only while the feed is in the man's own world.
  const inMan = (t) => active(t) === 'man';
  zoomLayer('man-statue', statueGeo, mats.man, ZR.statue, (t) => (inMan(t) && !live(t) ? S(t) : ZR.statue.inner));

  // --- The skies: only the one the feed is in, closed round the camera ---------------
  const skyCol = {
    gas: ['#e6dcf5', '#f8dcc8'],
    liquid: ['#3d0c10', '#24060a'],
    dark: ['#030305', '#010102']
  };
  const camW = add(C, FOLLOW, D_CAM);
  /** The colour of a sky (radius SKY_CAP round C) seen through world point p. */
  const skySeen = (layer, p) => {
    const d = p.map((v, k) => v - camW[k]);
    const l = Math.hypot(...d);
    const u = d.map((v) => v / l);
    const o = camW.map((v, k) => v - C[k]);
    const b = o[0] * u[0] + o[1] * u[1] + o[2] * u[2];
    const c = o[0] ** 2 + o[1] ** 2 + o[2] ** 2 - SKY_CAP ** 2;
    const s = -b + Math.sqrt(b * b - c);
    const y = o[1] + s * u[1];
    const k = Math.min(1, Math.max(0, y / (2 * SKY_CAP) + 0.5));
    const [top, bottom] = skyCol[layer].map(lin);
    return bottom.map((v, i) => v + (top[i] - v) * k);
  };

  // --- The doors: one in every layer, the layer itself opening --------------------
  // The man's: on his shirt, where the line from C to the feed leaves it; pleats in his shirt's colours, the gas behind.
  const shirtCol = nearestColour(statueGeo, hit);
  const shirtIris = L.iris({
    centre: hit, right: doorRight.toArray(), up: doorUp.toArray(), normal: n.toArray(), R: IR_SHIRT, lift: 0.0016,
    rim: [shirtCol, shirtCol.map((v) => v * 0.55), shirtCol.map((v) => v * 0.8)],
    hole: (p) => skySeen('gas', zoomed(p, C, S(S1)))
  });
  const shirtOpen = K([[0, 0], [7.0, 0], [8.3, 1], [58.6, 1], [59.2, 0], [60, 0]]);
  zoomLayer('door-man', shirtIris.geo, mats.flat, ZR.statue, (t) => (inMan(t) ? (live(t) ? 1 : S(t)) : ZR.statue.inner), shirtIris.shapes, (t) => L.irisWeights(shirtOpen(t)));
  // The gas's: just under him, the paint's sky behind; pleats in the demands' colours.
  const gasIris = L.iris({
    centre: giHome, right: SCREEN.right, up: SCREEN.up, normal: FOLLOW, R: GI.R, lift: 0.0012, width: 0.35, twist: 1.4,
    rim: G.DEMANDS.map((d) => d.hex),
    hole: (p) => skySeen('liquid', zoomed(p, C, sGas(T_GL)))
  });
  const gasOpen = K([[0, 0], [23.4, 0], [24.6, 1], [B_GL + 0.1, 1], [B_GL + 0.8, 0], [60, 0]]);
  zoomLayer('door-gas', gasIris.geo, mats.flat, ZR.gas, (t) => (active(t) === 'gas' ? sGas(t) : ZR.gas.inner), gasIris.shapes, (t) => L.irisWeights(gasOpen(t)));

  // --- The gas (beats 3–4): puffs and gusts, authored where the feed sees them ---------
  const gasSprites = G.gasSprites({ C, S, from: S1, back: [B_GL, B_S1], him: (t) => gasBase(t).toArray(), iris: (t) => irisW(t).toArray() });
  console.error(`gas: ${gasSprites.puffs} puffs, ${gasSprites.keys} keys`);
  const puffMat = glb.material({ name: 'Gas puffs', color: '#ffffff', unlit: true, doubleSided: true, blend: true, texture: glb.texture(G.puffTexture()) });
  worldLayer('gas-puffs', gasSprites.geo, puffMat, gasSprites.weights);
  gasSprites.gusts.forEach((g, i) => worldLayer(`gas-gust-${i}`, g.geo, puffMat, g.weights));

  // --- The liquid (beats 5–6): the pool, the paint thrown at him, the opening ---------
  const liqOpen = K([[0, 0], [35.6, 0], [36.8, 1], [60, 0]]);
  const LQ = liquid({ C, from: T_GL, to: 37, back: [B_DL, B_GL], sLiq, open: (t) => (t < 37 ? liqOpen(t) : 0), him: (t) => liquidBase(t).toArray() });
  worldLayer('liquid-pool', LQ.pool.geo, mats.paint, LQ.pool.weights);
  LQ.streams.forEach((s, i) => worldLayer(`liquid-stream-${i}`, s.geo, mats.paint, s.weights));
  // The paint's own door: a black hole opening round him, its pleats every colour of the paint.
  const liqN = UP.clone().addScaledVector(F3, 0.15).normalize();
  const liqIris = L.iris({
    centre: [C[0], LQ.P0[1] + 0.02, C[2]], right: RIGHT.toArray(), up: liqN.clone().cross(RIGHT).normalize().toArray(), normal: liqN.toArray(),
    R: 1.15, lift: 0.025, width: 0.22, twist: 2.2, rim: Object.values(HUES), hole: () => [0, 0, 0]
  });
  liqIris.geo.morphAttributes.position = liqIris.shapes.map((d) => new Float32BufferAttribute(d, 3));
  liqIris.geo.morphTargetsRelative = true;
  worldLayer('door-liquid', liqIris.geo, mats.paint, (t) => L.irisWeights(active(t) === 'liquid' && t < 37 ? liqOpen(t) : 0));

  // --- The dark, in its own home units: a hug-frame point p is C + κ·R18·(p − H) ---
  const kappa = (TRAV * Z) / 6;
  const toDark = (p) => {
    const v = new Vector3(...p).sub(H).applyQuaternion(R18).multiplyScalar(kappa);
    return [C[0] + v.x, C[1] + v.y, C[2] + v.z];
  };
  const darkS = (t) => (active(t) === 'dark' ? sOf('dark', t) : ZR.dark.inner);
  const RC = 0.95;
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
  // Only the sky of the layer the feed is in is drawn, closed round the camera; the others are gone.
  const skyS = (layer) => (t) => (active(t) === layer ? SKY_CAP / R0 : ZR.sky.inner);
  for (const layer of ['gas', 'liquid', 'dark']) zoomLayer(`sky-${layer}`, L.sky(C, R0, ...skyCol[layer]), mats.flat, ZR.sky, skyS(layer));

  const fit = feedFit(fitPoints(glb, drawn));
  const off = fit.target.map((v, k) => v - C[k]);
  console.error(`feed fit: target ${fit.target.map((v) => v.toFixed(4))} (off C by ${Math.hypot(...off).toFixed(4)} m), distance ${fit.distance.toFixed(3)}, near ${fit.near.toFixed(3)}, far ${fit.far.toFixed(2)}`);
  FIT.target = fit.target;
  FIT.distance = fit.distance;

  // --- Sound: one emitter per layer, carried by its layer's zoom -----------------------
  const sounds = { ...layerSounds(), ...Object.fromEntries(Object.entries(voices()).map(([id, w]) => [`voice-${id}`, w])) };
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
  // Each demand's voice rides its gust: out where it gathers, in to him as it hits, past him after,
  // drawn toward the feed's ear (×0.45) so the linear rolloff keeps every gust in earshot.
  const ear = add(C, FOLLOW, D_CAM);
  for (const { id } of G.DEMANDS) {
    const mine = GUSTS.filter((g) => g.demand === id);
    emitter(`voice-${id}`, (t) => {
      const g = mine.find((e) => t < e.t + 0.6) ?? mine.at(-1);
      const out = Math.min(1, Math.max(0, (g.t - t) / 1.4));
      const past = Math.min(1, Math.max(0, (t - g.t) / 0.6));
      const p = add(add(gasBase(g.t).toArray(), g.d, 3.6 * out), g.d, -1.5 * past);
      return add(ear, add(p, ear, -1), 0.45);
    }, { distanceModel: 'linear', refDistance: 1, maxDistance: 4 });
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
    animateWeights(node, (t) => layerWeights(s(t), zoom, w(t)));
    return node;
  }

  // A world-space layer (world.mjs): its morph targets are already set; w(t) weights them.
  function worldLayer(name, geo, mat, w) {
    geo.userData.weights = w(0);
    const node = meshNode(name, geo, mat);
    animateWeights(node, w);
    return node;
  }

  // Weights keyed only where they change (a still layer costs Quick Look nothing).
  function animateWeights(node, w) {
    const { times, values } = sparseRows(keyT, keyT.map(w));
    glb.animate(node, 'weights', times, values);
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

/** The linear vertex colour of geo nearest to p. */
function nearestColour(geo, p) {
  const pos = geo.attributes.position;
  const col = geo.attributes.color;
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < pos.count; i += 1) {
    const d = Math.hypot(pos.getX(i) - p[0], pos.getY(i) - p[1], pos.getZ(i) - p[2]);
    if (d < bd) [bd, best] = [d, i];
  }
  return [col.getX(best), col.getY(best), col.getZ(best)];
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
  view(1.5, 'man'), view(6.5, 'door'), view(8.2, 'opening'), view(10.6, 'enter'), view(13.9, 'gust'), view(18.1, 'gusts'),
  view(20.6, 'storm'), view(24.3, 'opening'), view(28.6, 'paint'), view(30.1, 'hit'), view(36.4, 'hole'), view(38.5, 'fall'),
  view(42, 'dark'), view(46.5, 'reach'), view(50.5, 'hug'), view(54.5, 'hug zoom'), view(56, 'liquid back'), view(59.2, 'home')
];
