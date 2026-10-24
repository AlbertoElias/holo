#!/usr/bin/env node
// Adds a tiered set of ARKit-named morph targets to the shipped avatar's head
// (Wolf3D_Head), replacing its two legacy targets (mouthOpen, mouthSmile).
// Shapes are synthesized from the eye bones and the legacy mouth deltas, so
// the script is reproducible and needs no Blender. It is idempotent: it
// always rebuilds from the legacy deltas, which it keeps in the GLB extras.
//
// Usage: node apps/capture/scripts/build-avatar-face.mjs [in.glb] [out.glb] [report.json]
import { NodeIO } from '@gltf-transform/core';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultAvatar = path.resolve(here, '../public/gltf/models/avatar.glb');
const input = process.argv[2] ?? defaultAvatar;
const output = process.argv[3] ?? input;
const reportPath = process.argv[4] ?? path.resolve(here, '../../../output/avatar-face/build-report.json');

const HEAD_MESH = 'Wolf3D_Head';
const EYE_MESHES = { left: 'EyeLeft', right: 'EyeRight' };
const EYE_BONES = { left: 'LeftEye', right: 'RightEye' };
const DEG = Math.PI / 180;

const io = new NodeIO();
const doc = await io.read(input);
const root = doc.getRoot();
const meshByName = (name) => {
  const mesh = root.listMeshes().find((candidate) => candidate.getName() === name);
  if (!mesh) throw new Error(`avatar has no ${name} mesh`);
  return mesh;
};
const nodeByName = (name) => {
  const node = root.listNodes().find((candidate) => candidate.getName() === name);
  if (!node) throw new Error(`avatar has no ${name} node`);
  return node;
};

const readVec3 = (accessor) => {
  const out = new Float32Array(accessor.getCount() * 3);
  const v = [0, 0, 0];
  for (let i = 0; i < accessor.getCount(); i += 1) {
    accessor.getElement(i, v);
    out.set(v, i * 3);
  }
  return out;
};

const head = meshByName(HEAD_MESH);
const prim = head.listPrimitives()[0];
const base = readVec3(prim.getAttribute('POSITION'));
const count = base.length / 3;
const extras = head.getExtras() ?? {};

// Legacy deltas: read from the targets on first run, from extras afterwards.
let legacy = extras.holoimLegacyTargets;
if (!legacy) {
  const names = extras.targetNames ?? [];
  legacy = {};
  prim.listTargets().forEach((target, index) => {
    if (names[index] === 'mouthOpen' || names[index] === 'mouthSmile') {
      legacy[names[index]] = Array.from(readVec3(target.getAttribute('POSITION')), (x) => Math.round(x * 1e6) / 1e6);
    }
  });
  if (!legacy.mouthOpen || !legacy.mouthSmile) throw new Error('head lacks legacy mouthOpen/mouthSmile targets');
}
const mouthOpen = Float32Array.from(legacy.mouthOpen);
const mouthSmile = Float32Array.from(legacy.mouthSmile);

// Eye spheres: centre at the eye bone (the eyeball pivot), radius profile
// from the eye mesh, so lids can be kept outside the eyeball.
const eyes = {};
for (const side of ['left', 'right']) {
  const centre = nodeByName(EYE_BONES[side]).getWorldTranslation();
  const eyePositions = readVec3(meshByName(EYE_MESHES[side]).listPrimitives()[0].getAttribute('POSITION'));
  const dirs = [];
  for (let i = 0; i < eyePositions.length; i += 3) {
    const d = [eyePositions[i] - centre[0], eyePositions[i + 1] - centre[1], eyePositions[i + 2] - centre[2]];
    const len = Math.hypot(...d);
    dirs.push({ dir: d.map((x) => x / len), len });
  }
  const radius = Math.max(...dirs.map((entry) => entry.len));
  // Surface radius in a direction: largest eye radius within 20 degrees.
  const radiusAt = (dir) => {
    let best = 0;
    for (const entry of dirs) {
      const dot = entry.dir[0] * dir[0] + entry.dir[1] * dir[1] + entry.dir[2] * dir[2];
      if (dot > Math.cos(20 * DEG)) best = Math.max(best, entry.len);
    }
    return best || radius * 0.85;
  };
  eyes[side] = { centre, radius, radiusAt };
}

const smoothstep = (edge0, edge1, x) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};
// Avatar faces +Z; its own left is +X.
const sideMask = (x, side) => (side === 'left' ? smoothstep(-0.008, 0.008, x) : smoothstep(0.008, -0.008, x));
const vertex = (i) => [base[i * 3], base[i * 3 + 1], base[i * 3 + 2]];

// Eye-local spherical coordinates: elevation phi about the X axis, azimuth
// theta about the Y axis, both measured from straight ahead (+Z).
const toEye = (p, eye) => {
  const d = [p[0] - eye.centre[0], p[1] - eye.centre[1], p[2] - eye.centre[2]];
  const r = Math.hypot(...d);
  return { r, phi: Math.atan2(d[1], Math.hypot(d[0], d[2])), theta: Math.atan2(d[0], d[2]) };
};
const fromEye = ({ r, phi, theta }, eye) => [
  eye.centre[0] + r * Math.cos(phi) * Math.sin(theta),
  eye.centre[1] + r * Math.sin(phi),
  eye.centre[2] + r * Math.cos(phi) * Math.cos(theta),
];

// Lid margins measured on this mesh: the upper lid edge sits about +14
// degrees above straight ahead and the lower edge about -25 degrees.
const UPPER_EDGE = 14 * DEG;
const LOWER_EDGE = -25 * DEG;
const LID_MEET = -14 * DEG;
const LID_SHELL = 0.007; // lid rings lie within this distance of the eyeball; the brow lies beyond
const LID_GAP = 0.0007; // closed lids stay this far outside the eyeball

/**
 * Rotate lid vertices of one eye about its horizontal axis.
 * upperShift/lowerShift are radians (positive = down for the upper lid,
 * up for the lower lid); falloff spreads the motion into the surrounding skin.
 */
const lidShape = (side, upperShift, lowerShift, options = {}) => {
  const eye = eyes[side];
  const delta = new Float32Array(base.length);
  const spread = options.spread ?? 26 * DEG;
  for (let i = 0; i < count; i += 1) {
    const p = vertex(i);
    const s = toEye(p, eye);
    if (s.r > eye.radius + LID_SHELL || s.r < eye.radius * 0.6) continue;
    if (Math.abs(s.theta) > 62 * DEG || p[2] < eye.centre[2] - 0.004) continue;
    const across = 1 - smoothstep(38 * DEG, 62 * DEG, Math.abs(s.theta));
    const shell = 1 - smoothstep(eye.radius + 0.001, eye.radius + LID_SHELL, s.r);
    let shift = 0;
    if (s.phi >= UPPER_EDGE - 2 * DEG && upperShift !== 0) {
      shift = -upperShift * (1 - smoothstep(UPPER_EDGE, UPPER_EDGE + spread, s.phi));
    } else if (s.phi <= LOWER_EDGE + 2 * DEG && lowerShift !== 0) {
      shift = lowerShift * (1 - smoothstep(-LOWER_EDGE, -LOWER_EDGE + spread * 0.6, -s.phi));
    }
    shift *= across * shell;
    if (shift === 0) continue;
    const moved = { ...s, phi: s.phi + shift };
    // Keep the lid on the outside of the eyeball where it now sits.
    const dir = fromEye({ ...moved, r: 1 }, { centre: [0, 0, 0] });
    moved.r = Math.max(s.r, eye.radiusAt(dir) + LID_GAP);
    const q = fromEye(moved, eye);
    delta[i * 3] = q[0] - p[0];
    delta[i * 3 + 1] = q[1] - p[1];
    delta[i * 3 + 2] = q[2] - p[2];
  }
  return delta;
};

const BLINK_UPPER = UPPER_EDGE - LID_MEET;
const BLINK_LOWER = LID_MEET - LOWER_EDGE;

/** Translate vertices by `offset(p)` weighted by `weight(p)` (0..1). */
const fieldShape = (weight, offset) => {
  const delta = new Float32Array(base.length);
  for (let i = 0; i < count; i += 1) {
    const p = vertex(i);
    const w = weight(p);
    if (w <= 0) continue;
    const o = offset(p);
    delta[i * 3] = o[0] * w;
    delta[i * 3 + 1] = o[1] * w;
    delta[i * 3 + 2] = o[2] * w;
  }
  return delta;
};

const scaled = (source, mask, scale = 1, transform = (d) => d) => {
  const delta = new Float32Array(base.length);
  for (let i = 0; i < count; i += 1) {
    const w = mask(vertex(i)) * scale;
    if (w === 0) continue;
    const d = transform([source[i * 3], source[i * 3 + 1], source[i * 3 + 2]], vertex(i));
    delta[i * 3] = d[0] * w;
    delta[i * 3 + 1] = d[1] * w;
    delta[i * 3 + 2] = d[2] * w;
  }
  return delta;
};

const front = (p) => smoothstep(0.035, 0.07, p[2]);
const eyeY = eyes.left.centre[1];
const mouthCentre = [0, 1.568, 0.127];

// Brow band: above the eyes, on the front of the head.
const browBand = (p) => front(p)
  * smoothstep(eyeY + 0.012, eyeY + 0.022, p[1])
  * (1 - smoothstep(eyeY + 0.045, eyeY + 0.06, p[1]));
const browInner = (p) => browBand(p) * (1 - smoothstep(0.012, 0.03, Math.abs(p[0])));
const browOuter = (side) => (p) => browBand(p) * sideMask(p[0], side) * smoothstep(0.028, 0.045, Math.abs(p[0]));
const browWhole = (side) => (p) => browBand(p) * sideMask(p[0], side) * (1 - smoothstep(0.065, 0.08, Math.abs(p[0])));

// Lips: the moving part of the legacy mouthOpen delta near the mouth line.
const lipBand = (p) => front(p)
  * (1 - smoothstep(0.012, 0.022, Math.abs(p[1] - mouthCentre[1])))
  * (1 - smoothstep(0.022, 0.034, Math.abs(p[0])));
const cheek = (side) => (p) => front(p) * sideMask(p[0], side)
  * smoothstep(0.03, 0.045, Math.abs(p[0])) * (1 - smoothstep(0.065, 0.08, Math.abs(p[0])))
  * smoothstep(1.545, 1.56, p[1]) * (1 - smoothstep(1.6, 1.615, p[1]));
const outward = (p) => {
  const d = [p[0], 0, p[2] - 0.02];
  const len = Math.hypot(...d) || 1;
  return d.map((x) => x / len);
};

const shapes = {
  eyeBlinkLeft: lidShape('left', BLINK_UPPER, BLINK_LOWER * 0.35),
  eyeBlinkRight: lidShape('right', BLINK_UPPER, BLINK_LOWER * 0.35),
  eyeSquintLeft: lidShape('left', 7 * DEG, 9 * DEG, { spread: 22 * DEG }),
  eyeSquintRight: lidShape('right', 7 * DEG, 9 * DEG, { spread: 22 * DEG }),
  eyeWideLeft: lidShape('left', -9 * DEG, -3 * DEG, { spread: 30 * DEG }),
  eyeWideRight: lidShape('right', -9 * DEG, -3 * DEG, { spread: 30 * DEG }),
  browInnerUp: fieldShape(browInner, () => [0, 0.0045, 0.0005]),
  browDownLeft: fieldShape(browWhole('left'), (p) => [-0.0012 * Math.sign(p[0]), -0.0035, 0.0008]),
  browDownRight: fieldShape(browWhole('right'), (p) => [-0.0012 * Math.sign(p[0]), -0.0035, 0.0008]),
  browOuterUpLeft: fieldShape(browOuter('left'), () => [0, 0.004, 0]),
  browOuterUpRight: fieldShape(browOuter('right'), () => [0, 0.004, 0]),
  jawOpen: scaled(mouthOpen, () => 1),
  mouthSmileLeft: scaled(mouthSmile, (p) => sideMask(p[0], 'left')),
  mouthSmileRight: scaled(mouthSmile, (p) => sideMask(p[0], 'right')),
  // Frown: the smile's corner motion mirrored downward and softened.
  mouthFrownLeft: scaled(mouthSmile, (p) => sideMask(p[0], 'left'), 0.7, (d) => [d[0] * 0.3, -Math.abs(d[1]) - 0.002 * Math.hypot(d[0], d[1]) / 0.015, d[2] * 0.3]),
  mouthFrownRight: scaled(mouthSmile, (p) => sideMask(p[0], 'right'), 0.7, (d) => [d[0] * 0.3, -Math.abs(d[1]) - 0.002 * Math.hypot(d[0], d[1]) / 0.015, d[2] * 0.3]),
  mouthPucker: fieldShape(lipBand, (p) => [-p[0] * 0.38, (mouthCentre[1] - p[1]) * 0.15, 0.005]),
  mouthFunnel: (() => {
    const pucker = fieldShape(lipBand, (p) => [-p[0] * 0.25, (p[1] - mouthCentre[1]) * 0.25, 0.006]);
    const open = scaled(mouthOpen, () => 0.3);
    return pucker.map((x, i) => x + open[i]);
  })(),
  mouthStretchLeft: fieldShape((p) => lipBand(p) * sideMask(p[0], 'left') * smoothstep(0.004, 0.02, Math.abs(p[0])), () => [0.004, -0.001, -0.001]),
  mouthStretchRight: fieldShape((p) => lipBand(p) * sideMask(p[0], 'right') * smoothstep(0.004, 0.02, Math.abs(p[0])), () => [-0.004, -0.001, -0.001]),
  cheekPuff: fieldShape((p) => Math.max(cheek('left')(p), cheek('right')(p)), (p) => outward(p).map((x) => x * 0.005)),
};

// Any shape (the legacy smile raises the cheek into the lower lid) may push
// skin into an eyeball; project such vertices back onto its outside.
for (const delta of Object.values(shapes)) {
  for (let i = 0; i < count; i += 1) {
    const p = vertex(i);
    const q = [p[0] + delta[i * 3], p[1] + delta[i * 3 + 1], p[2] + delta[i * 3 + 2]];
    for (const eye of Object.values(eyes)) {
      const s = toEye(q, eye);
      const surface = eye.radiusAt(fromEye({ ...s, r: 1 }, { centre: [0, 0, 0] }));
      if (s.r >= surface || s.r >= toEye(p, eye).r) continue;
      const fixed = fromEye({ ...s, r: Math.min(surface + LID_GAP, toEye(p, eye).r) }, eye);
      delta[i * 3] = fixed[0] - p[0];
      delta[i * 3 + 1] = fixed[1] - p[1];
      delta[i * 3 + 2] = fixed[2] - p[2];
    }
  }
}

// Report and safety checks: displacement, vertices moved, and no lid vertex
// inside the eyeball at full weight.
const report = { input, output, vertexCount: count, shapes: {} };
for (const [name, delta] of Object.entries(shapes)) {
  let moved = 0;
  let maxDisplacement = 0;
  let insideEye = 0;
  for (let i = 0; i < count; i += 1) {
    const m = Math.hypot(delta[i * 3], delta[i * 3 + 1], delta[i * 3 + 2]);
    if (m < 1e-5) continue;
    moved += 1;
    maxDisplacement = Math.max(maxDisplacement, m);
    const q = [base[i * 3] + delta[i * 3], base[i * 3 + 1] + delta[i * 3 + 1], base[i * 3 + 2] + delta[i * 3 + 2]];
    for (const eye of Object.values(eyes)) {
      const s = toEye(q, eye);
      const dir = fromEye({ ...s, r: 1 }, { centre: [0, 0, 0] });
      // Lid skin already rests a little inside the eye mesh's bulge; count
      // only vertices a shape pushes more than 0.5 mm deeper into the eye.
      const before = toEye(vertex(i), eye).r;
      if (s.r < eye.radiusAt(dir) - 5e-4 && s.r < before - 5e-4) insideEye += 1;
    }
  }
  report.shapes[name] = { moved, maxDisplacementMm: Math.round(maxDisplacement * 1e5) / 100, insideEye };
}
const failures = Object.entries(report.shapes).filter(([, s]) => s.moved === 0 || s.insideEye > 0 || s.maxDisplacementMm > 20);
report.passed = failures.length === 0;

// Replace the head's targets with the synthesized set.
for (const target of prim.listTargets()) {
  prim.removeTarget(target);
  for (const accessor of target.listAttributes()) accessor.dispose();
  target.dispose();
}
const buffer = root.listBuffers()[0];
const names = Object.keys(shapes);
for (const name of names) {
  const accessor = doc.createAccessor(`${HEAD_MESH}_${name}`)
    .setType('VEC3')
    .setArray(shapes[name])
    .setBuffer(buffer);
  prim.addTarget(doc.createPrimitiveTarget(name).setAttribute('POSITION', accessor));
}
head.setWeights(names.map(() => 0));
head.setExtras({ ...extras, targetNames: names, holoimLegacyTargets: legacy });

await io.write(output, doc);
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ passed: report.passed, shapes: names.length, failures: failures.map(([n]) => n), report: reportPath }));
if (!report.passed) process.exitCode = 1;
