/**
 * Sleeve cuffs that move with the hand (B-099). The house base's jumper goes about 3 cm past the wrist, inside the
 * hand, and Blender gives those cuff vertices less of the hand bone than the hand skin around them (0.2–0.4 against
 * up to 1.0). When the wrist bends or the forearm turns, the hand skin goes with the hand and the cuff stays behind,
 * so the cuff comes out through the back of the hand (10 mm in the pinch at 1.2 s): a light, jagged band at the wrist.
 * `fitCuffs` gives each garment vertex at or past the wrist the joints and weights of the nearest skin vertex, so the
 * cuff and the hand skin deform alike. Nothing moves in the bind pose.
 */
import type { Document, Node, Primitive } from '@gltf-transform/core';

/** How far up the forearm from the wrist joint (m) a garment vertex still takes the skin's weights. */
export const CUFF_REACH = 0.015;
/** Only vertices this near the wrist line (m) are a cuff. */
const CUFF_RADIUS = 0.06;
/** Only a skin vertex this near (m) gives its weights. */
const SKIN_NEAR = 0.03;

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
const apply = (m: readonly number[], p: V3): V3 => [
  m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
  m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
  m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
];

/** The bind position of a joint: the translation of its inverse bind matrix's inverse. */
function bindPosition(ibm: readonly number[]): V3 {
  // The inverse of a rigid [R | t] is [Rᵀ | −Rᵀt].
  const t: V3 = [ibm[12]!, ibm[13]!, ibm[14]!];
  return [-(ibm[0]! * t[0] + ibm[1]! * t[1] + ibm[2]! * t[2]), -(ibm[4]! * t[0] + ibm[5]! * t[1] + ibm[6]! * t[2]), -(ibm[8]! * t[0] + ibm[9]! * t[1] + ibm[10]! * t[2])];
}

interface Part { node: Node; prim: Primitive }

/**
 * Copies the skin's joints and weights to the garment vertices at each wrist. `skin` names the body mesh, `garments`
 * the meshes to fit. Returns the number of vertices changed per garment mesh.
 */
export function fitCuffs(doc: Document, skin = /Body$/, garments = /Jumper$/): Record<string, number> {
  const root = doc.getRoot();
  const parts = (re: RegExp): Part[] => root.listNodes().filter((n) => n.getMesh() && n.getSkin() && re.test(n.getMesh()!.getName()))
    .flatMap((node) => node.getMesh()!.listPrimitives().map((prim) => ({ node, prim })));
  const body = parts(skin).filter(({ prim }) => /skin/i.test(prim.getMaterial()?.getName() ?? ''));
  if (!body.length) throw new Error('fitCuffs: no skin primitive');
  const sk = body[0]!.node.getSkin()!;
  const joints = sk.listJoints().map((j) => j.getName().replace(/^.*:/, ''));
  const ibms = sk.getInverseBindMatrices()!.getArray()!;
  const jointAt = (name: string): V3 => { const i = joints.indexOf(name); if (i < 0) throw new Error(`fitCuffs: no ${name} joint`); return bindPosition(Array.from(ibms.subarray(i * 16, i * 16 + 16))); };
  const wrists = (['Left', 'Right'] as const).map((s) => { const h = jointAt(`${s}Hand`); return { h, ax: norm(sub(h, jointAt(`${s}ForeArm`))) }; });
  const inCuff = (p: V3, lo: number): boolean => wrists.some(({ h, ax }) => {
    const v = sub(p, h); const d = dot(v, ax); const r = Math.sqrt(Math.max(0, dot(v, v) - d * d));
    return d > lo && r < CUFF_RADIUS;
  });

  // The skin vertices at the wrists, in world space at bind, with their joints and weights.
  const skinPts: { p: V3; j: number[]; w: number[] }[] = [];
  for (const { node, prim } of body) {
    const m = node.getWorldMatrix(); const pos = prim.getAttribute('POSITION')!; const J = prim.getAttribute('JOINTS_0')!; const W = prim.getAttribute('WEIGHTS_0')!;
    const e: number[] = [], jw: number[] = [], ww: number[] = [];
    for (let i = 0; i < pos.getCount(); i++) {
      const p = apply(m, pos.getElement(i, e) as V3);
      if (inCuff(p, -CUFF_REACH - SKIN_NEAR)) skinPts.push({ p, j: [...J.getElement(i, jw)], w: [...W.getElement(i, ww)] });
    }
  }

  const changed: Record<string, number> = {};
  for (const { node, prim } of parts(garments)) {
    if (node.getSkin() !== sk) throw new Error(`fitCuffs: ${node.getName()} has another skin`);
    const m = node.getWorldMatrix(); const pos = prim.getAttribute('POSITION')!; const J = prim.getAttribute('JOINTS_0')!; const W = prim.getAttribute('WEIGHTS_0')!;
    const e: number[] = [];
    let n = 0;
    for (let i = 0; i < pos.getCount(); i++) {
      const p = apply(m, pos.getElement(i, e) as V3);
      if (!inCuff(p, -CUFF_REACH)) continue;
      let best = -1, bd = SKIN_NEAR * SKIN_NEAR;
      for (let k = 0; k < skinPts.length; k++) { const q = sub(skinPts[k]!.p, p); const d = dot(q, q); if (d < bd) { bd = d; best = k; } }
      if (best < 0) continue;
      J.setElement(i, skinPts[best]!.j); W.setElement(i, skinPts[best]!.w); n += 1;
    }
    const name = node.getMesh()!.getName();
    changed[name] = (changed[name] ?? 0) + n;
  }
  return changed;
}
