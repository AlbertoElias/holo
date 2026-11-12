import { CylinderGeometry, Euler, LatheGeometry, Matrix4, Object3D, Quaternion, SphereGeometry, TorusGeometry, Vector2, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { FPS, K, LOOP, PI, bake, box, clamp, flat, frame, mix, quatTrack, smooth, tiny, window, wrap } from './common.mjs';

// The three people of "The way down", as jointed figures driven by IK:
//   man       a man in his thirties, 1950s suit, fedora and briefcase, on
//             the stage. Lit, Kodachrome-coloured.
//   traveller the ethereal one: a translucent body of light that steps out
//             of his chest and goes down through the layers. Its gesture
//             changes with each layer.
//   child     the inner child in the dark core, about 1.05 m tall, unlit
//             and dim until the hug.

// ---------------------------------------------------------------------------
// Skeleton and parts

const ADULT = [
  ['pelvis', null, [0, 0.96, 0]],
  ['spine', 'pelvis', [0, 0.08, -0.005]],
  ['chest', 'spine', [0, 0.18, 0]],
  ['neck', 'chest', [0, 0.225, -0.014]],
  ['head', 'neck', [0, 0.09, 0.01]],
  ['shoulderL', 'chest', [0.172, 0.168, -0.014]],
  ['elbowL', 'shoulderL', [0, -0.3, 0]],
  ['wristL', 'elbowL', [0, -0.25, 0]],
  ['shoulderR', 'chest', [-0.172, 0.168, -0.014]],
  ['elbowR', 'shoulderR', [0, -0.3, 0]],
  ['wristR', 'elbowR', [0, -0.25, 0]],
  ['hipL', 'pelvis', [0.088, -0.065, 0]],
  ['kneeL', 'hipL', [0, -0.42, 0]],
  ['ankleL', 'kneeL', [0, -0.415, 0]],
  ['hipR', 'pelvis', [-0.088, -0.065, 0]],
  ['kneeR', 'hipR', [0, -0.42, 0]],
  ['ankleR', 'kneeR', [0, -0.415, 0]]
];
const LEG = new Set(['hipL', 'kneeL', 'ankleL', 'hipR', 'kneeR', 'ankleR']);
const ARM = new Set(['shoulderL', 'elbowL', 'wristL', 'shoulderR', 'elbowR', 'wristR']);
const HAT_AT = [0, 0.13, 0.012];

/** Proportions: `s` overall, `leg` and `head` relative to it. */
const ADULT_DIMS = { s: 1, leg: 1, head: 1, arm: 1 };
const CHILD_DIMS = { s: 0.6, leg: 0.86, head: 1.42, arm: 0.92 };

function skeleton(d) {
  return ADULT.map(([name, parent, offset]) => {
    let k = d.s;
    if (LEG.has(name) && name.startsWith('knee')) k *= d.leg;
    if (LEG.has(name) && name.startsWith('ankle')) k *= d.leg;
    if (name === 'elbowL' || name === 'elbowR' || name === 'wristL' || name === 'wristR') k *= d.arm;
    if (name === 'pelvis') return [name, parent, [0, 0.96 * d.s * d.leg, 0]];
    return [name, parent, offset.map((v) => v * k)];
  });
}

function ell(rx, ry, rz, c = [0, 0, 0], ws = 22, hs = 16) {
  const g = new SphereGeometry(1, ws, hs);
  g.scale(rx, ry, rz);
  g.translate(...c);
  return g;
}

/** A tapered capsule from a (radius ra) to b (radius rb), squashed sx / sz across. */
function limb(a, b, ra, rb, sx = 1, sz = 1, radial = 16) {
  const A = new Vector3(...a);
  const B = new Vector3(...b);
  const L = A.distanceTo(B);
  const pts = [];
  const cap = 5;
  for (let i = 0; i <= cap; i += 1) {
    const ang = -PI / 2 + (i / cap) * (PI / 2);
    pts.push(new Vector2(Math.max(1e-4, ra * Math.cos(ang)), ra * Math.sin(ang)));
  }
  for (let i = 1; i <= 4; i += 1) {
    const f = i / 5;
    pts.push(new Vector2(ra + (rb - ra) * f, L * f));
  }
  for (let i = 0; i <= cap; i += 1) {
    const ang = (i / cap) * (PI / 2);
    pts.push(new Vector2(Math.max(1e-4, rb * Math.cos(ang)), L + rb * Math.sin(ang)));
  }
  const g = new LatheGeometry(pts, radial);
  g.scale(sx, 1, sz);
  const dir = B.clone().sub(A).normalize();
  const up = new Vector3(0, 1, 0);
  const q = dir.dot(up) < -0.9999 ? new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), PI) : new Quaternion().setFromUnitVectors(up, dir);
  g.applyQuaternion(q);
  g.translate(A.x, A.y, A.z);
  return g;
}

/**
 * The parts of one body as [geometry, role] pairs per joint, in adult
 * units. Roles are coloured by each figure's palette.
 */
function bodyParts({ suit = false, child = false } = {}) {
  const side = (sx) => ({
    shoulder: [
      [ell(suit ? 0.06 : 0.054, 0.056, 0.058, [0, -0.012, 0]), 'top'],
      [limb([0, -0.01, 0], [0, -0.3, 0], suit ? 0.052 : 0.048, suit ? 0.042 : 0.037), 'top']
    ],
    elbow: [
      [limb([0, 0, 0], [0, -0.25, 0], suit ? 0.043 : 0.039, suit ? 0.034 : 0.027, 0.85, 1.12), 'top'],
      ...(suit ? [[limb([0, -0.215, 0], [0, -0.245, 0], 0.031, 0.03), 'cuff']] : [])
    ],
    hip: [[limb([0, 0, 0], [0, -0.42, 0], 0.078, 0.052, 1, 1.05), 'legs']],
    knee: [
      [limb([0, 0, 0], [0, -0.415, 0], suit ? 0.054 : 0.052, suit ? 0.044 : 0.034), 'legs'],
      [ell(0.047, 0.12, 0.052, [0, -0.13, -0.014]), 'legs'],
      ...(child ? [[limb([0, -0.34, 0], [0, -0.41, 0], 0.036, 0.036), 'socks']] : [])
    ],
    ankle: [
      [ell(0.039, 0.039, 0.042, [0, -0.004, -0.004]), 'shoes'],
      [limb([0, -0.03, -0.045], [0, -0.04, 0.165], 0.037, 0.03, 1.25, 1), 'shoes']
    ],
    hand: [
      [limb([sx * 0.007, -0.006, 0], [sx * 0.007, -0.16, 0.006], 0.026, 0.02, 0.62, 1.7), 'skin'],
      [limb([sx * 0.011, -0.028, 0.03], [sx * 0.013, -0.085, 0.056], 0.014, 0.011), 'skin']
    ]
  });
  const L = side(-1);
  const R = side(1);
  const torsoTop = child ? 'shirt' : 'top';
  const parts = {
    pelvis: [
      [ell(0.152, 0.11, 0.1, [0, -0.03, 0]), 'legs'],
      [ell(0.14, 0.085, 0.09, [0, -0.055, -0.03]), 'legs']
    ],
    spine: [[ell(0.124, 0.13, 0.092, [0, 0.07, 0.006]), torsoTop]],
    chest: [
      [ell(0.154, 0.165, 0.106, [0, 0.085, 0.012]), torsoTop],
      [ell(0.132, 0.09, 0.097, [0, 0.0, 0.01]), torsoTop],
      [limb([0.03, 0.2, -0.008], [0.168, 0.17, -0.014], suit ? 0.04 : 0.034, suit ? 0.045 : 0.036), torsoTop],
      [limb([-0.03, 0.2, -0.008], [-0.168, 0.17, -0.014], suit ? 0.04 : 0.034, suit ? 0.045 : 0.036), torsoTop]
    ],
    neck: [[limb([0, -0.02, 0], [0, 0.085, 0.006], 0.05, 0.045), 'skin']],
    head: [
      [ell(0.079, 0.113, 0.096, [0, 0.062, 0.014]), 'skin'],
      [ell(0.058, 0.055, 0.066, [0, 0.008, 0.036]), 'skin']
    ],
    shoulderL: L.shoulder,
    elbowL: L.elbow,
    wristL: L.hand,
    shoulderR: R.shoulder,
    elbowR: R.elbow,
    wristR: R.hand,
    hipL: L.hip,
    kneeL: L.knee,
    ankleL: L.ankle,
    hipR: R.hip,
    kneeR: R.knee,
    ankleR: R.ankle
  };
  if (suit) {
    // Jacket: a skirt over the hips, lapels, shirt V, a narrow tie, a collar.
    parts.pelvis.push([ell(0.168, 0.1, 0.118, [0, 0.005, 0.008]), 'top']);
    parts.chest.push(
      [ell(0.052, 0.09, 0.02, [0, 0.165, 0.108]), 'shirt'],
      [limb([0, 0.215, 0.116], [0, 0.03, 0.118], 0.014, 0.021, 1, 0.4), 'tie'],
      [limb([0.022, 0.225, 0.11], [0.075, 0.05, 0.112], 0.017, 0.02, 1, 0.45), 'lapel'],
      [limb([-0.022, 0.225, 0.11], [-0.075, 0.05, 0.112], 0.017, 0.02, 1, 0.45), 'lapel'],
      [ell(0.064, 0.026, 0.06, [0, 0.222, 0.004]), 'shirt']
    );
    parts.wristL.push(
      [new TorusGeometry(0.03, 0.007, 6, 18).rotateX(PI / 2).translate(0, 0.01, 0), 'watch'],
      [new TorusGeometry(0.0125, 0.004, 6, 14).rotateX(PI / 2).translate(-0.004, -0.115, 0.012), 'watch']
    );
  }
  // A face that reads at card size: nose, ears, a brow line; hair with a part.
  parts.head.push(
    [ell(0.013, 0.021, 0.019, [0, 0.055, 0.108]), 'skin'],
    [ell(0.013, 0.026, 0.019, [0.08, 0.058, 0.004]), 'skin'],
    [ell(0.013, 0.026, 0.019, [-0.08, 0.058, 0.004]), 'skin'],
    [ell(0.06, 0.012, 0.02, [0, 0.094, 0.1]), 'brow']
  );
  if (child) {
    parts.head.push([ell(0.088, 0.088, 0.1, [0, 0.105, -0.004]), 'hair'], [ell(0.05, 0.03, 0.04, [0.025, 0.17, 0.06]), 'hair']);
    parts.pelvis.push([ell(0.16, 0.09, 0.106, [0, 0.0, 0.0]), 'shirt']);
  } else if (suit) {
    parts.head.push(
      [ell(0.085, 0.08, 0.1, [0, 0.1, -0.004]), 'hair'],
      [ell(0.02, 0.03, 0.03, [0.077, 0.07, -0.005]), 'temple'],
      [ell(0.02, 0.03, 0.03, [-0.077, 0.07, -0.005]), 'temple']
    );
  }
  return parts;
}

function scaleParts(parts, d) {
  if (d.s === 1 && d.leg === 1 && d.head === 1) return parts;
  const out = {};
  for (const [joint, list] of Object.entries(parts)) {
    out[joint] = list.map(([g, role]) => {
      const c = g.clone();
      if (joint === 'head') c.scale(d.s * d.head, d.s * d.head, d.s * d.head);
      else if (joint.startsWith('knee') || joint.startsWith('ankle')) c.scale(d.s, d.s * d.leg, d.s);
      else if (joint.startsWith('hip')) c.scale(d.s, d.s * d.leg, d.s);
      else if (ARM.has(joint)) c.scale(d.s, d.s * d.arm, d.s);
      else if (joint === 'pelvis') c.scale(d.s * 1.05, d.s, d.s * 1.05);
      else c.scale(d.s, d.s, d.s);
      return [c, role];
    });
  }
  return out;
}

/** A felt fedora with a band and a pinched crown, in the hat node's frame. */
function hatGeometry(crownHex, bandHex) {
  const crown = new CylinderGeometry(0.076, 0.094, 0.112, 28);
  crown.translate(0, 0.068, 0);
  const pinch = ell(0.078, 0.02, 0.072, [0, 0.122, 0], 28, 8);
  const dent = ell(0.02, 0.014, 0.05, [0, 0.13, 0.0], 12, 6);
  const band = new CylinderGeometry(0.096, 0.097, 0.026, 28, 1, true);
  band.translate(0, 0.026, 0);
  const brim = new CylinderGeometry(1, 1, 0.012, 40);
  brim.scale(0.19, 1, 0.205);
  brim.translate(0, 0.008, 0.02);
  brim.rotateX(0.08);
  return mergeGeometries([flat(crown, crownHex), flat(pinch, crownHex), flat(dent, bandHex), flat(band, bandHex), flat(brim, crownHex)]);
}

/** A tan leather case held by its handle, in the right wrist's frame. */
function briefcaseGeometry() {
  const body = box(-0.045, 0.045, -0.48, -0.17, -0.2, 0.2);
  const lip = box(-0.047, 0.047, -0.2, -0.185, -0.202, 0.202);
  const handle = new TorusGeometry(0.04, 0.009, 6, 16, PI);
  handle.rotateY(PI / 2);
  handle.translate(0, -0.165, 0);
  const latchA = box(-0.05, 0.05, -0.215, -0.195, 0.1, 0.125);
  const latchB = box(-0.05, 0.05, -0.215, -0.195, -0.125, -0.1);
  return mergeGeometries([flat(body, '#8a5530'), flat(lip, '#6d401f'), flat(handle, '#4a2a16'), flat(latchA, '#d8b765'), flat(latchB, '#d8b765')]);
}

const PALETTES = {
  man: {
    top: '#6f7c84', legs: '#5a646b', cuff: '#f2ecdc', shirt: '#f2ecdc', tie: '#d8a23a', lapel: '#5c676e',
    skin: '#e2ac86', hair: '#3a2a1f', temple: '#857a71', brow: '#4a3527', shoes: '#2a1c15', watch: '#d8b765'
  },
  child: {
    top: '#4f6488', shirt: '#4f6488', legs: '#6f5a43', skin: '#b98d7a', hair: '#2a211c', brow: '#3b2c26', shoes: '#30303a', socks: '#8e94a6'
  }
};

class Rig {
  constructor({ dims = ADULT_DIMS, suit = false, child = false } = {}) {
    this.dims = dims;
    this.skeleton = skeleton(dims);
    this.root = new Object3D();
    this.j = {};
    for (const [name, parent, offset] of this.skeleton) {
      const o = new Object3D();
      o.position.set(...offset);
      (parent ? this.j[parent] : this.root).add(o);
      this.j[name] = o;
    }
    this.hat = new Object3D();
    this.hat.position.set(...HAT_AT);
    this.j.head.add(this.hat);
    this.parts = scaleParts(bodyParts({ suit, child }), dims);
    this.ankleH = 0.065 * dims.s * dims.leg;
    this.root.updateMatrixWorld(true);
  }

  /** Each joint's merged geometry, coloured by `paint(geometry, role)`. */
  geometry(paint) {
    const out = {};
    for (const [joint, list] of Object.entries(this.parts)) {
      out[joint] = mergeGeometries(list.map(([g, role]) => paint(g.clone(), role, joint)));
    }
    return out;
  }

  world(joint, x = 0, y = 0, z = 0) {
    this.j[joint].updateWorldMatrix(true, false);
    return new Vector3(x, y, z).applyMatrix4(this.j[joint].matrixWorld);
  }
}

// ---------------------------------------------------------------------------
// IK and posing (from the mirror scene's rig, generalised to any floor)

const _basis = new Matrix4();
function twoBone(upper, lower, endOffset, target, pole, sign) {
  const parentQ = upper.parent.getWorldQuaternion(new Quaternion());
  const s = upper.getWorldPosition(new Vector3());
  const a = lower.position.length();
  const b = endOffset;
  const toT = target.clone().sub(s);
  const dHat = toT.clone().normalize();
  const d = clamp(toT.length(), Math.abs(a - b) + 1e-4, (a + b) * 0.9995);
  const pPerp = pole.clone().sub(dHat.clone().multiplyScalar(pole.dot(dHat))).normalize();
  const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const u = dHat.clone().multiplyScalar(cosA).add(pPerp.clone().multiplyScalar(sinA));
  const e = s.clone().add(u.clone().multiplyScalar(a));
  const f = s.clone().add(dHat.clone().multiplyScalar(d)).sub(e).normalize();
  let bend = f.clone().sub(u.clone().multiplyScalar(f.dot(u)));
  if (bend.lengthSq() < 1e-10) bend = pPerp.clone().negate();
  bend.normalize();
  const Y = u.clone().negate();
  const Z = sign > 0 ? bend : bend.clone().negate();
  const X = new Vector3().crossVectors(Y, Z);
  _basis.makeBasis(X, Y, Z);
  const qWorld = new Quaternion().setFromRotationMatrix(_basis);
  upper.quaternion.copy(parentQ.invert().multiply(qWorld));
  const phi = Math.acos(clamp(u.dot(f), -1, 1));
  lower.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), sign > 0 ? -phi : phi);
  upper.updateMatrixWorld(true);
}

const eul = (x, y, z, order = 'YXZ') => new Quaternion().setFromEuler(new Euler(x, y, z, order));

function setWorldQ(obj, qWorld) {
  const parentQ = obj.parent.getWorldQuaternion(new Quaternion());
  obj.quaternion.copy(parentQ.invert().multiply(qWorld));
  obj.updateMatrixWorld(true);
}

/** A point in the body's frame (x left, z forward, y up from its floor). */
function bodyPoint(P, bx, by, bz) {
  const c = Math.cos(P.yaw);
  const s = Math.sin(P.yaw);
  return new Vector3(P.base.x + bx * c + bz * s, P.floor + by, P.base.z - bx * s + bz * c);
}
function bodyDir(P, bx, by, bz) {
  return bodyPoint(P, bx, by, bz).sub(bodyPoint(P, 0, 0, 0)).normalize();
}

/**
 * Pose P:
 *   base {x, z}, floor, yaw, pelvisY (above floor), pelvisOff (body frame
 *   offset of the pelvis from base), pp / pr pelvis pitch and roll, sp, cp,
 *   cy, np, hp, hy, hr, hat (hat pitch), feet {L, R: {pos, yaw, pitch}},
 *   kneePole (body-frame vector), hands {L, R: [{w, at: () => Vector3, pole}]},
 *   swing (arm swing), shrug, look (optional {at, w}).
 */
function applyPose(rig, P) {
  const { j } = rig;
  const po = P.pelvisOff ?? [0, 0];
  const pel = bodyPoint(P, po[0], P.pelvisY, po[1]);
  j.pelvis.position.copy(pel);
  j.pelvis.quaternion.copy(eul(P.pp ?? 0, P.yaw + (P.py ?? 0), P.pr ?? 0));
  j.spine.quaternion.copy(eul(P.sp ?? 0, (P.cy ?? 0) * 0.4, 0));
  j.chest.quaternion.copy(eul(P.cp ?? 0, (P.cy ?? 0) * 0.6, P.cr ?? 0));
  j.neck.quaternion.copy(eul(P.np ?? 0, (P.hy ?? 0) * 0.3, 0));
  j.head.quaternion.copy(eul(P.hp ?? 0, (P.hy ?? 0) * 0.7, P.hr ?? 0));
  rig.hat.quaternion.copy(eul(P.hat ?? 0, 0, 0));
  rig.root.updateMatrixWorld(true);

  if (P.look && P.look.w > 1e-4) {
    const at = rig.world('head', 0, 0.07, 0.02);
    const Z = P.look.at.clone().sub(at).normalize();
    const X = new Vector3(0, 1, 0).cross(Z).normalize();
    const Y = new Vector3().crossVectors(Z, X);
    const look = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(X, Y, Z)).multiply(eul(0, 0, P.hr ?? 0));
    const now = j.head.getWorldQuaternion(new Quaternion());
    setWorldQ(j.head, now.slerp(look, P.look.w));
  }

  const kp = P.kneePole ?? [0, 0, 1];
  for (const side of ['L', 'R']) {
    const foot = P.feet[side];
    const pole = bodyDir(P, kp[0], kp[1], kp[2]);
    twoBone(j[`hip${side}`], j[`knee${side}`], j[`ankle${side}`].position.length(), foot.pos, pole, -1);
    setWorldQ(j[`ankle${side}`], eul(foot.pitch ?? 0, foot.yaw, 0));
  }

  for (const side of ['L', 'R']) {
    const sgn = side === 'L' ? 1 : -1;
    const sh = j[`shoulder${side}`];
    const el = j[`elbow${side}`];
    const wr = j[`wrist${side}`];
    const lean = (P.pp ?? 0) + (P.sp ?? 0) + (P.cp ?? 0);
    const swing = (P.swing ?? 0) * sgn;
    sh.quaternion.copy(eul(-0.04 + 0.85 * lean + swing, 0, sgn * (0.1 + (P.spread ?? 0)), 'XYZ'));
    el.quaternion.copy(eul(-0.22 - Math.abs(swing) * 0.4 - (P.elbow ?? 0), 0, 0, 'XYZ'));
    wr.quaternion.copy(eul(0, 0, sgn * 0.05, 'XYZ'));
    sh.updateMatrixWorld(true);
    for (const g of P.hands?.[side] ?? []) {
      if (!(g.w > 1e-4)) continue;
      const cur = [sh.quaternion.clone(), el.quaternion.clone(), wr.quaternion.clone()];
      const target = typeof g.at === 'function' ? g.at() : g.at;
      const pole = g.pole ?? bodyDir(P, sgn * 0.75, -1, -0.35);
      twoBone(sh, el, wr.position.length(), target, pole, 1);
      if (g.q) setWorldQ(wr, g.q);
      sh.quaternion.copy(cur[0].slerp(sh.quaternion, g.w));
      el.quaternion.copy(cur[1].slerp(el.quaternion, g.w));
      wr.quaternion.copy(cur[2].slerp(wr.quaternion, g.w));
      sh.updateMatrixWorld(true);
    }
  }
  rig.root.updateMatrixWorld(true);
}

// ---------------------------------------------------------------------------
// Walking: real steps. Each foot is planted where the body will be at its
// next plant time, and swings there in the first part of its cycle.

function stepFeet(body, t, { period = 0.55, width = 0.1, lift = 0.07, swingPart = 0.45, ankleH, floor }) {
  const out = {};
  for (const [side, off, sx] of [['L', 0, 1], ['R', 0.5, -1]]) {
    const phase = t / period - off;
    const k = Math.floor(phase);
    const f = phase - k;
    const plant = (n) => {
      const tp = (n + off + swingPart) * period;
      const b = body(tp);
      const c = Math.cos(b.yaw);
      const s = Math.sin(b.yaw);
      return { x: b.x + sx * width * c, z: b.z - sx * width * s, yaw: b.yaw + sx * 0.12, floor: b.floor ?? floor };
    };
    const from = plant(k - 1);
    const to = plant(k);
    const u = smooth(0, swingPart, f);
    const moved = Math.hypot(to.x - from.x, to.z - from.z) + 0.15 * Math.abs(to.yaw - from.yaw);
    const h = lift * Math.sin(PI * clamp(f / swingPart)) * smooth(0.01, 0.05, moved);
    const fl = mix(from.floor, to.floor, u);
    out[side] = {
      pos: new Vector3(mix(from.x, to.x, u), fl + ankleH + h, mix(from.z, to.z, u)),
      yaw: mix(from.yaw, to.yaw, u),
      pitch: h * 2.5
    };
  }
  return out;
}

/** Feet standing still at the body, with toes turned out. */
function standFeet(P, { width = 0.11, out = 0.14, ankleH, fwd = 0.02 }) {
  const res = {};
  for (const [side, sx] of [['L', 1], ['R', -1]]) {
    res[side] = { pos: bodyPoint(P, sx * width, ankleH, fwd), yaw: P.yaw + sx * out, pitch: 0 };
  }
  return res;
}

function blendFeet(a, b, w) {
  if (w <= 0) return a;
  if (w >= 1) return b;
  const out = {};
  for (const s of ['L', 'R']) {
    out[s] = { pos: a[s].pos.clone().lerp(b[s].pos, w), yaw: mix(a[s].yaw, b[s].yaw, w), pitch: mix(a[s].pitch ?? 0, b[s].pitch ?? 0, w) };
  }
  return out;
}

/** Body path from [t, x, z, localYaw] keys in a room's frame. */
function path(room, list) {
  const F = frame(room);
  const xs = K(list.map(([t, x]) => [t, x]));
  const zs = K(list.map(([t, , z]) => [t, z]));
  const ys = K(list.map(([t, , , y]) => [t, y]));
  return (t) => {
    const p = F.at(xs(t), 0, zs(t));
    return { x: p.x, z: p.z, yaw: F.yawOf(ys(t)), floor: F.floor };
  };
}

// ---------------------------------------------------------------------------
// The man (stage)

const STAGE = frame('stage');
const MAN_AT = { x: -0.12, z: 0.4 };

function manPose(rig, t) {
  t = wrap(t);
  const base = STAGE.at(MAN_AT.x + 0.012 * Math.sin((2 * PI * t) / 6), 0, MAN_AT.z);
  const P = { base, floor: STAGE.floor, yaw: STAGE.yawOf(-0.06), pelvisY: 0.935 };
  // Façade: chest out, chin up, a little sway. Relief at the hug: shoulders
  // drop, the head lifts, one slow breath.
  const relief = window(49.6, 56.8, t, 1.2);
  const breath = Math.sin((2 * PI * t) / 4) * 0.012 + relief * 0.035 * Math.sin((2 * PI * (t - 49.6)) / 7.2);
  P.pr = 0.018 * Math.sin((2 * PI * t) / 6);
  P.sp = -0.02 + 0.04 * relief;
  P.cp = -0.06 + breath + 0.05 * relief;
  P.np = 0.0;
  P.hp = -0.05 - 0.16 * relief;
  P.hy = 0;
  P.feet = standFeet(P, { ankleH: rig.ankleH });

  const tip = window(1.1, 2.3, t, 0.45);
  const watch = window(9.2, 10.6, t, 0.4) + window(27.0, 28.2, t, 0.3) + window(40.2, 42.6, t, 0.35);
  const collar = window(33.6, 35.0, t, 0.35);
  const heart = relief;
  P.hp += 0.13 * window(1.5, 2.0, t, 0.25) + 0.38 * watch + 0.08 * collar;
  P.hat = -0.12 * tip;
  P.hr = 0.08 * collar;
  // During the storm below, the free hand drums the thigh.
  const fidget = window(22.5, 37.5, t, 1) * (1 - collar) * (1 - watch);
  P.swing = 0.03 * fidget * Math.sin(2 * PI * 4 * t) * (0.6 + 0.4 * Math.sin(2 * PI * 0.5 * t));
  const tremble = 0.006 * window(40.2, 42.6, t, 0.3) * Math.sin(2 * PI * 9 * t);
  const head = (x, y, z) => () => rig.world('head', x, y, z);
  P.hands = {
    L: [
      { w: tip, at: head(0.05, 0.14, 0.14), pole: bodyDir(P, 0.8, -0.6, 0.2) },
      { w: watch, at: () => bodyPoint(P, 0.02, 1.2 + tremble, 0.3), pole: bodyDir(P, 0.9, -0.7, -0.1) },
      { w: collar, at: head(0.03, -0.11, 0.08), pole: bodyDir(P, 0.9, -0.7, 0.1) },
      { w: heart, at: () => bodyPoint(P, 0.06, 1.34 + 0.02 * breath, 0.15), pole: bodyDir(P, 0.9, -0.8, 0) }
    ],
    R: []
  };
  // The briefcase arm hangs a touch away from the case.
  P.spread = 0.04;
  return P;
}

// ---------------------------------------------------------------------------
// The traveller: its route through the four layers, its gestures in each.

const T_STAGE = path('stage', [
  [2.8, MAN_AT.x, MAN_AT.z, 0],
  [3.9, MAN_AT.x - 0.02, MAN_AT.z - 0.36, 0],
  [4.5, MAN_AT.x + 0.05, MAN_AT.z - 0.42, PI / 2],
  [6.2, 0.72, -0.14, PI / 2],
  [7.8, 0.72, -0.14, PI / 2]
]);
const T_GAS = path('gas', [
  [8.0, -0.72, -0.08, PI / 2],
  [9.6, -0.7, -0.05, PI / 2],
  [10.6, -0.45, 0.28, 1.1],
  [11.6, -0.36, 0.3, 0.6],
  [12.5, -0.18, -0.26, 2.4],
  [13.6, 0.02, -0.3, 1.6],
  [14.6, 0.06, 0.22, 0.4],
  [15.0, 0.06, 0.22, 0.4 + 2 * PI],
  [15.9, 0.08, 0.22, 0.6 + 2 * PI],
  [17.0, 0.32, -0.18, 2.2 + 2 * PI],
  [18.2, 0.5, 0.24, 0.9 + 2 * PI],
  [19.6, 0.72, -0.1, PI / 2 + 2 * PI],
  [21.6, 0.72, -0.1, PI / 2 + 2 * PI]
]);
const T_LIQUID = path('liquid', [
  [21.8, -0.72, 0.08, PI / 2],
  [23.0, -0.72, 0.08, PI / 2],
  [26.2, -0.42, 0.04, 1.45],
  [26.9, -0.6, 0.1, 1.75],
  [28.4, -0.3, 0.0, 1.5],
  [30.4, 0.12, -0.02, 1.55],
  [31.4, 0.26, 0.04, 1.4],
  [32.0, 0.1, 0.1, 1.9],
  [33.6, 0.44, -0.04, 1.5],
  [34.3, 0.46, -0.06, 0.6],
  [34.9, 0.48, -0.08, 2.5],
  [35.4, 0.56, -0.18, 2.2],
  [37.8, 0.6, -0.22, 2.2]
]);
// The child sits near the back of the core, turned a little toward the
// viewer; the traveller kneels in front of it.
export const CHILD_AT = { x: 0.44, z: -0.34, yaw: -0.5 };
const KNEEL = {
  x: CHILD_AT.x + 0.4 * Math.sin(CHILD_AT.yaw),
  z: CHILD_AT.z + 0.4 * Math.cos(CHILD_AT.yaw),
  yaw: CHILD_AT.yaw + PI
};
const T_CORE = path('core', [
  [37.9, -0.7, 0.06, PI / 2],
  [40.5, -0.7, 0.06, PI / 2],
  [42.0, -0.32, 0.22, 1.2],
  [43.6, 0.0, 0.16, 1.9],
  [44.6, KNEEL.x, KNEEL.z, KNEEL.yaw],
  [LOOP, KNEEL.x, KNEEL.z, KNEEL.yaw]
]);

/** Which layer the traveller is in at t, and its body path. */
function travellerLeg(t) {
  if (t < 7.9) return { room: 'stage', body: T_STAGE };
  if (t < 21.7) return { room: 'gas', body: T_GAS };
  if (t < 37.85) return { room: 'liquid', body: T_LIQUID };
  return { room: 'core', body: T_CORE };
}

/** How present the traveller is (its scale) and the point it grows from or shrinks to. */
export function travellerPresence(t) {
  t = wrap(t);
  const s =
    smooth(2.8, 4.0, t) * (1 - smooth(7.0, 7.7, t)) +
    smooth(8.0, 8.7, t) * (1 - smooth(21.0, 21.6, t)) +
    smooth(21.9, 22.4, t) * (1 - smooth(36.0, 36.7, t)) +
    smooth(38.0, 39.0, t) * (1 - smooth(57.2, 59.4, t));
  return s;
}

function travellerPose(rig, t, ctx) {
  t = wrap(t);
  const { room, body } = travellerLeg(t);
  const F = frame(room);
  const b = body(t);
  const P = { base: new Vector3(b.x, 0, b.z), floor: b.floor, yaw: b.yaw, pelvisY: 0.93 };
  const head = (x, y, z) => () => rig.world('head', x, y, z);
  P.hands = { L: [], R: [] };
  // Feet hanging under the pelvis, toes down: floating, falling, sinking.
  const fallFeet = () => {
    const res = {};
    for (const [side, sx] of [['L', 1], ['R', -1]]) {
      res[side] = { pos: bodyPoint(P, sx * 0.09, P.pelvisY - 0.84, 0.03), yaw: P.yaw + sx * 0.1, pitch: 0.7 };
    }
    return res;
  };
  const walk = (opts) => stepFeet(body, t, { ankleH: rig.ankleH, floor: b.floor, ...opts });

  if (room === 'stage') {
    // Layer 1: calm, curious. It backs out of the man's chest, turns,
    // looks back at him once, walks to the trap door and sinks through it.
    const sink = smooth(6.6, 7.6, t);
    P.pelvisY = 0.93 - 0.9 * sink;
    P.sp = 0.03;
    P.cp = 0.02;
    P.hp = 0.05;
    P.hy = -1.0 * window(5.0, 5.7, t, 0.35);
    P.cy = -0.3 * window(5.0, 5.7, t, 0.35);
    P.swing = 0.18 * Math.sin((2 * PI * t) / 1.1) * window(4.5, 6.2, t, 0.2);
    P.hands.L.push({ w: 0.35 * (1 - sink), at: () => bodyPoint(P, 0.24, 0.9, 0.16) });
    P.hands.R.push({ w: 0.35 * (1 - sink), at: () => bodyPoint(P, -0.24, 0.9, 0.16) });
    P.feet = blendFeet(walk({ period: 1.1, lift: 0.06 }), fallFeet(), sink);
    P.hands.L.push({ w: sink, at: () => bodyPoint(P, 0.22, P.pelvisY + 0.75, 0.05) });
    P.hands.R.push({ w: sink, at: () => bodyPoint(P, -0.22, P.pelvisY + 0.75, 0.05) });
  } else if (room === 'gas') {
    // Layer 2: anxious. Floats down, then hurries in small quick steps,
    // head darting, ducking and shielding its face when the gases clash,
    // and once whirls round to see where they come from.
    const land = smooth(8.0, 9.6, t);
    const sink = smooth(20.6, 21.6, t);
    const clash = Math.max(...[11.3, 13.9, 16.8, 18.9].map((c) => window(c - 0.25, c + 0.35, t, 0.3)));
    P.pelvisY = mix(2.0, 0.93, land) - 0.17 * clash - 0.9 * sink;
    P.pp = 0.1 * land + 0.18 * clash;
    P.sp = 0.06 + 0.2 * clash;
    P.cp = 0.08 + 0.12 * clash;
    P.hy = (0.55 * Math.sin(2 * PI * (54 / LOOP) * t) + 0.3 * Math.sin(2 * PI * (138 / LOOP) * t)) * (1 - clash) * land;
    P.hp = 0.1 - 0.15 * clash;
    P.swing = 0.22 * Math.sin((2 * PI * t) / 0.38) * land * (1 - clash);
    P.shrug = 1;
    const shield = Math.max(clash, 0.25 * land);
    P.hands.L.push({ w: shield, at: () => bodyPoint(P, 0.1, P.pelvisY + 0.62, 0.24), pole: bodyDir(P, 1, -0.4, -0.2) });
    P.hands.R.push({ w: shield, at: () => bodyPoint(P, -0.12, P.pelvisY + 0.56, 0.26), pole: bodyDir(P, -1, -0.4, -0.2) });
    const floating = 1 - land;
    P.feet = blendFeet(blendFeet(walk({ period: 0.38, lift: 0.05, width: 0.09 }), fallFeet(), Math.max(floating, sink)), fallFeet(), sink);
  } else if (room === 'liquid') {
    // Layer 3: overwhelmed. Flung down, it braces into the surge with both
    // arms forward, is knocked back at each crash, crawls through the crash
    // line with its arms over its head, searches, and dives into the hole.
    const land = smooth(21.9, 22.9, t);
    const knock = window(26.5, 26.9, t, 0.25) + 0.7 * window(31.5, 31.95, t, 0.25);
    const crouch = window(28.4, 30.4, t, 0.6);
    const search = window(33.6, 34.9, t, 0.3);
    const dive = smooth(35.3, 36.4, t);
    P.pelvisY = mix(1.9, 0.9, land) - 0.36 * crouch - 0.1 * (1 - search) * land - 1.3 * dive;
    P.pp = (0.32 - 0.3 * search) * land - 0.25 * knock + 0.2 * crouch + 1.0 * dive;
    P.sp = 0.16 * land - 0.2 * knock + 0.25 * crouch + 0.3 * dive;
    P.cp = 0.12 * land - 0.15 * knock + 0.2 * crouch;
    P.hp = -0.1 - 0.5 * knock + 0.3 * crouch - 0.2 * dive;
    P.hy = search * 0.9 * Math.sin(2 * PI * 1.2 * (t - 33.6));
    P.pr = 0.12 * Math.sin(2 * PI * (36 / LOOP) * t) * land * (1 - crouch);
    P.pelvisOff = [0, -0.06 * land * (1 - search)];
    const brace = land * (1 - knock) * (1 - crouch) * (1 - search) * (1 - dive);
    P.hands.L.push({ w: brace, at: () => bodyPoint(P, 0.18, P.pelvisY + 0.36, 0.5), pole: bodyDir(P, 1, -0.6, -0.4) });
    P.hands.R.push({ w: brace, at: () => bodyPoint(P, -0.18, P.pelvisY + 0.34, 0.5), pole: bodyDir(P, -1, -0.6, -0.4) });
    P.hands.L.push({ w: knock, at: () => bodyPoint(P, 0.36, P.pelvisY + 0.82, -0.12) });
    P.hands.R.push({ w: knock, at: () => bodyPoint(P, -0.36, P.pelvisY + 0.8, -0.1) });
    P.hands.L.push({ w: crouch, at: head(0.06, 0.2, 0.02), pole: bodyDir(P, 1, 0.2, 0.3) });
    P.hands.R.push({ w: crouch, at: head(-0.06, 0.2, 0.02), pole: bodyDir(P, -1, 0.2, 0.3) });
    P.hands.L.push({ w: dive, at: () => bodyPoint(P, 0.08, P.pelvisY + 0.2, 0.75) });
    P.hands.R.push({ w: dive, at: () => bodyPoint(P, -0.08, P.pelvisY + 0.2, 0.75) });
    P.kneePole = [0, -0.2, 1];
    const steps = walk({ period: 0.7, lift: 0.045, width: 0.15 });
    P.feet = blendFeet(blendFeet(steps, fallFeet(), 1 - land), fallFeet(), dive);
  } else {
    // Layer 4: careful in the dark, then still. It drifts down, walks with
    // its hands a little ahead, sees the child, kneels, opens its arms and
    // holds it, rocking gently, until both go to light.
    const land = smooth(38.0, 40.4, t);
    const kneel = smooth(44.6, 46.4, t);
    const open = window(46.4, 47.8, t, 0.6);
    const hug = smooth(47.8, 49.0, t);
    const rock = Math.sin((2 * PI * (t - 49)) / 3.6) * hug;
    P.pelvisY = mix(1.9, 0.93, land) - (0.93 - 0.36) * kneel;
    P.pp = 0.04 + 0.12 * hug;
    P.sp = 0.06 + 0.12 * kneel + 0.15 * hug;
    P.cp = 0.04 + 0.16 * hug;
    P.py = 0.05 * rock;
    P.pr = 0.04 * rock;
    P.hp = 0.15 + 0.15 * kneel + 0.12 * hug;
    P.hy = (0.5 * Math.sin(2 * PI * 0.25 * (t - 40)) * window(40.4, 43.4, t, 0.5)) + 0.35 * hug;
    P.hr = 0.18 * hug;
    P.swing = 0.1 * Math.sin((2 * PI * t) / 1.5) * window(40.6, 44.4, t, 0.3);
    const careful = window(40.4, 44.5, t, 0.5);
    P.hands.L.push({ w: careful * 0.6, at: () => bodyPoint(P, 0.24, 0.98, 0.32) });
    P.hands.R.push({ w: careful * 0.6, at: () => bodyPoint(P, -0.24, 0.98, 0.32) });
    P.hands.L.push({ w: open, at: () => bodyPoint(P, 0.48, P.pelvisY + 0.55, 0.26), pole: bodyDir(P, 1, -0.8, -0.2) });
    P.hands.R.push({ w: open, at: () => bodyPoint(P, -0.48, P.pelvisY + 0.55, 0.26), pole: bodyDir(P, -1, -0.8, -0.2) });
    const back = ctx?.childBack;
    if (back) {
      P.hands.L.push({ w: hug, at: () => back.L.clone(), pole: bodyDir(P, 1, -0.3, 0.2) });
      P.hands.R.push({ w: hug, at: () => back.R.clone(), pole: bodyDir(P, -1, -0.3, 0.2) });
    }
    // Kneeling, then sitting back on the heels.
    const kneelFeet = {};
    for (const [side, sx] of [['L', 1], ['R', -1]]) {
      kneelFeet[side] = { pos: bodyPoint(P, sx * 0.12, rig.ankleH * 0.7, -0.26), yaw: P.yaw + sx * 0.05, pitch: -1.25 };
    }
    P.kneePole = [0, -0.6 * kneel, 1];
    const steps = walk({ period: 0.8, lift: 0.04 });
    P.feet = blendFeet(blendFeet(steps, fallFeet(), 1 - land), kneelFeet, kneel);
    P.look = { at: F.at(CHILD_AT.x, 0.45, CHILD_AT.z), w: smooth(43.2, 44.2, t) * (1 - hug) };
  }
  return P;
}

// ---------------------------------------------------------------------------
// The child (core)

const CORE = frame('core');

export function childPresence(t) {
  t = wrap(t);
  return smooth(0.4, 2.6, t) * (1 - smooth(57.2, 59.4, t));
}

/** Sobbing: irregular bursts, as a 0..1 pulse train. */
function sob(t) {
  const bursts = [[3, 7], [9.5, 13], [15, 19.5], [21, 26], [28, 33], [35, 38.5], [40, 44.5]];
  let env = 0;
  for (const [a, b] of bursts) env = Math.max(env, window(a, b, t, 0.6));
  const pulse = Math.max(0, Math.sin(2 * PI * 2.3 * t)) ** 3 * 0.7 + Math.max(0, Math.sin(2 * PI * 1.1 * t + 1)) ** 4 * 0.5;
  return env * pulse;
}

function childPose(rig, t, ctx) {
  t = wrap(t);
  const base = CORE.at(CHILD_AT.x, 0, CHILD_AT.z);
  const P = { base, floor: CORE.floor, yaw: CORE.yawOf(CHILD_AT.yaw) };
  const look = smooth(45.6, 47.4, t);
  const rise = smooth(48.0, 49.4, t);
  const hug = smooth(48.2, 49.6, t);
  const s = sob(t) * (1 - look);
  const wipe = window(12.0, 14.4, t, 0.5) + window(30.0, 32.4, t, 0.5);
  const seatY = 0.09;
  const kneelY = 0.27;
  // Seated, knees up, curled over them; then up on its knees into the hug.
  P.pelvisY = mix(seatY, kneelY, rise);
  P.pelvisOff = [0, mix(-0.02, 0.06, rise)];
  P.pp = mix(-0.35, 0.05, rise);
  P.sp = mix(0.42, 0.1, rise) + 0.05 * s;
  P.cp = mix(0.42, 0.18, rise) - 0.12 * look * (1 - rise) + 0.08 * s;
  P.np = mix(0.2, 0.0, look);
  P.hp = mix(0.55, -0.15, look) + 0.1 * s - 0.15 * wipe + mix(0, 0.25, rise);
  P.hy = 0.08 * Math.sin(2 * PI * 0.3 * t) * (1 - look) - 0.5 * hug;
  P.hr = 0.25 * hug;
  P.shrug = s;
  const seatFeet = {};
  const kneelFeet = {};
  for (const [side, sx] of [['L', 1], ['R', -1]]) {
    seatFeet[side] = { pos: bodyPoint(P, sx * 0.075, rig.ankleH, 0.25), yaw: P.yaw + sx * 0.1, pitch: 0.15 };
    kneelFeet[side] = { pos: bodyPoint(P, sx * 0.08, rig.ankleH * 0.7, -0.18), yaw: P.yaw, pitch: -1.2 };
  }
  P.feet = blendFeet(seatFeet, kneelFeet, rise);
  P.kneePole = [0, mix(1, -0.5, rise), 1];
  const head = (x, y, z) => () => rig.world('head', x, y, z);
  // Arms round the knees; wiping the eyes; then round the traveller's neck.
  const knees = (1 - wipe) * (1 - hug);
  P.hands = {
    L: [
      { w: knees, at: () => bodyPoint(P, 0.06, 0.34, 0.27), pole: bodyDir(P, 1, 0, -0.2) },
      { w: wipe * (1 - hug), at: head(0.03, 0.05, 0.11), pole: bodyDir(P, 1, -1, 0) }
    ],
    R: [
      { w: knees, at: () => bodyPoint(P, -0.06, 0.32, 0.27), pole: bodyDir(P, -1, 0, -0.2) },
      { w: wipe * (1 - hug), at: head(-0.03, 0.05, 0.11), pole: bodyDir(P, -1, -1, 0) }
    ]
  };
  if (ctx?.neck) {
    P.hands.L.push({ w: hug, at: () => ctx.neck.L.clone(), pole: bodyDir(P, 1, -0.5, 0) });
    P.hands.R.push({ w: hug, at: () => ctx.neck.R.clone(), pole: bodyDir(P, -1, -0.5, 0) });
  }
  if (ctx?.travellerHead) P.look = { at: ctx.travellerHead, w: look * (1 - hug) };
  return P;
}

// ---------------------------------------------------------------------------
// Sampling and writing

function snapshot(rig) {
  const f = { q: {}, pelvis: rig.j.pelvis.position.toArray(), hat: rig.hat.quaternion.toArray() };
  for (const [name] of rig.skeleton) f.q[name] = rig.j[name].quaternion.toArray();
  return f;
}

/** All three figures, sampled in step so the hug can hold each other. */
export function performFigures() {
  const man = new Rig({ suit: true });
  const trav = new Rig();
  const child = new Rig({ dims: CHILD_DIMS, child: true });
  const count = LOOP * FPS;
  const times = [];
  const frames = { man: [], traveller: [], child: [] };
  for (let i = 0; i <= count; i += 1) {
    const t = (i / count) * LOOP;
    times.push(t);
    applyPose(man, manPose(man, t));
    frames.man.push(snapshot(man));

    // The child's body first (arms aside) to find its back, then the
    // traveller holding that back, then the child's arms round its neck.
    applyPose(child, childPose(child, t, null));
    const childBack = {
      L: child.world('chest', 0.11, 0.1, -0.1),
      R: child.world('chest', -0.11, 0.1, -0.1)
    };
    applyPose(trav, travellerPose(trav, t, { childBack }));
    frames.traveller.push(snapshot(trav));
    const neck = { L: trav.world('neck', 0.07, 0.03, -0.05), R: trav.world('neck', -0.07, 0.03, -0.05) };
    applyPose(child, childPose(child, t, { neck, travellerHead: trav.world('head', 0, 0.07, 0.02) }));
    frames.child.push(snapshot(child));
  }
  return { rigs: { man, traveller: trav, child }, frames, times };
}

/**
 * Writes one figure. `presence(t)` and `pivot(frames, i)` let it grow from
 * and shrink to a point: root at the pivot scaled by presence, the body
 * under it shifted back by the pivot.
 */
export function writeFigure(glb, rig, frames, times, { name, materials, paint, hatGeo, hatMaterial, extra, presence, pivotOf }) {
  const root = glb.node({ name });
  const inner = glb.node({ name: `${name}-body`, parent: root });
  const geo = rig.geometry(paint);
  const nodes = {};
  for (const [joint, parentJoint, offset] of rig.skeleton) {
    nodes[joint] = glb.node({
      name: `${name}-${joint}`,
      mesh: glb.mesh(`${name}-${joint}`, geo[joint], materials.body),
      translation: joint === 'pelvis' ? frames[0].pelvis : offset,
      rotation: frames[0].q[joint],
      parent: parentJoint ? nodes[parentJoint] : inner
    });
  }
  if (hatGeo) {
    const hat = glb.node({ name: `${name}-hat`, mesh: glb.mesh(`${name}-hat`, hatGeo, hatMaterial), translation: HAT_AT, rotation: frames[0].hat, parent: nodes.head });
    glb.animate(hat, 'rotation', times, quatTrack(frames.map((f) => f.hat)));
  }
  for (const [joint] of rig.skeleton) glb.animate(nodes[joint], 'rotation', times, quatTrack(frames.map((f) => f.q[joint])));
  glb.animate(nodes.pelvis, 'translation', times, frames.flatMap((f) => f.pelvis));
  if (extra) extra(nodes);
  if (presence) {
    const pts = [];
    const scales = [];
    for (let i = 0; i < times.length; i += 1) {
      const p = pivotOf(frames, i);
      const s = tiny(presence(times[i]));
      pts.push(p);
      scales.push(s, s, s);
    }
    glb.animate(root, 'translation', times, pts.flat());
    glb.animate(root, 'scale', times, scales);
    glb.animate(inner, 'translation', times, pts.flatMap((p) => p.map((v) => -v)));
  }
  return { root, nodes };
}

export { briefcaseGeometry, hatGeometry, PALETTES, ell };

/** The pelvis of frame i, raised to the chest: where a figure grows from. */
export const chestPivot = (lift) => (frames, i) => {
  const p = frames[i].pelvis;
  return [p[0], p[1] + lift, p[2]];
};

/** Vertex colours for a figure's role, lit or baked. */
export function painter(palette, { baked = false, dim = 1, light } = {}) {
  return (g, role) => {
    const hex = palette[role] ?? palette.top;
    if (!baked) return flat(g, hex);
    return bake(g, hex, { light, amb: 0.6, gain: dim });
  };
}

// The pivot the traveller grows from and goes to: the man's chest at the
// start, a point between it and the child at the end.
export function travellerPivot(frames, manFrames) {
  return (all, i) => {
    const t = (i / (all.length - 1)) * LOOP;
    if (t < 5) {
      const m = manFrames[i].pelvis;
      return [m[0], m[1] + 0.38, m[2]];
    }
    const p = all[i].pelvis;
    return [p[0], p[1] + 0.3, p[2]];
  };
}

export { smooth };
