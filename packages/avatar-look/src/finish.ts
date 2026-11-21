import type { Accessor, Document, Material, Node, Primitive } from '@gltf-transform/core';
import { linear, type SRGB } from './traits.js';

/**
 * A finish is a set of materials on the house base's own meshes and bones,
 * plus at most one extra mesh (the ink line's outline), with no change to the
 * face shapes (docs/features/directed-performance.md, "Finishes", slice 2f).
 * Clay is the base as built; ink and light are applied after the look card's
 * colours, so every card wears every finish. Core glTF only (no extensions),
 * so the take writer, the viewer and the USDZ converter carry them as they
 * are. The values follow Astra's `ink-turnaround.png`, `light-turnaround.png`
 * and `base-finishes.png`, decided by the agent in the owner's absence on
 * 2026-11-19, for review.
 */
export const FINISHES = ['clay', 'ink', 'light'] as const;
export type Finish = (typeof FINISHES)[number];

/** Ink: how much of each colour is emitted rather than lit, so the shading flattens toward the sheet's flat fills while lids and mouth keep a little form. */
export const INK_FLAT = 0.6;
/** Ink: the outline's colour (the sheet's dark brown line). */
export const INK_LINE: SRGB = [52, 32, 26];
/** Ink: the outline's width in metres, on the body and on the head (the sheet draws the face's lines thinner). */
export const INK_WIDTH = { body: 0.006, head: 0.0025 } as const;
/** Ink: the outline's material. The outline is line work, drawn only on its far side, so a measure of surfaces (the audition's geometry tier) leaves out the primitives that wear it. */
export const INK_MATERIAL = 'HouseBase_ink';
/** Ink: a body vertex within this distance of a garment is under it and gets no line (else the skin's line shows through the cloth). */
export const INK_COVERED = 0.03;

/**
 * Light: the share of the warm light colour mixed into each colour, the
 * opacity of the body and garments, and how much of the paled colour is
 * emitted. A translucent mesh draws without depth, so its inner surfaces show
 * through; the opacity stays high enough that the garments' do not.
 */
export const LIGHT = { pale: 0.4, tint: [255, 240, 214] as SRGB, opacity: 0.86, glow: 0.45 } as const;
/**
 * Light, garments only: instead of the warm white, each garment colour is
 * mixed `lift` of the way toward its own brightest version (the same colour
 * scaled until its largest channel is 1), so it brightens and keeps its hue;
 * the warm white took two performers' clothes to the same cream (2f
 * evidence). The owner asked for this tune on 2026-11-19 ("Decision 4:
 * Tune"); the value 0.25 was picked by the agent, for the owner to judge.
 */
export const LIGHT_GARMENT_LIFT = 0.25;
const LIGHT_GARMENT = /^HouseBase_(top|trousers|shoes)$/;

/** Materials a finish leaves exactly as they are: the eyes, lashes, mouth, teeth and tongue carry the face's reading. */
const FACE_PARTS = /^HouseBase_(eye_|lash|mouth|teeth|tongue)/;
/**
 * Materials that stay opaque in the light finish: the brows and frames are
 * lines on a lit body, and the skin glows but is not see-through, because a
 * translucent face shows the teeth and the mouth's inside through the lips
 * and the face stops reading; the lips are skin of another colour and stay
 * opaque with it. Only the garments and hair are translucent.
 */
const LIGHT_OPAQUE = /^HouseBase_(brow|frames|skin|lips)$/;
/** Meshes that get an ink outline, and of the body, the primitives that do. */
const INKED_MESH = /^(HouseBase_(Body|Jumper|Trousers|Shoes)|Hair_)/;
const INKED_BODY_PART = /^HouseBase_(skin|brow)$/;
const GARMENT = /^HouseBase_(Jumper|Trousers|Shoes)$/;

const houseMaterials = (doc: Document): Material[] => doc.getRoot().listMaterials().filter((m) => m.getName().startsWith('HouseBase_'));

function flatten(m: Material, share: number): void {
  const c = m.getBaseColorFactor();
  m.setEmissiveFactor([c[0]! * share, c[1]! * share, c[2]! * share]);
  m.setBaseColorFactor([c[0]! * (1 - share), c[1]! * (1 - share), c[2]! * (1 - share), c[3]!]);
  m.setRoughnessFactor(1).setMetallicFactor(0);
}

/** World positions of a primitive's vertices at rest (the meshes are skinned, so their node transforms are the bind pose's). */
function restPositions(node: Node, prim: Primitive): Float32Array {
  const pos = prim.getAttribute('POSITION')!;
  const out = new Float32Array(pos.getCount() * 3);
  const m = node.getWorldMatrix();
  const v = [0, 0, 0];
  for (let i = 0; i < pos.getCount(); i++) {
    pos.getElement(i, v);
    out[i * 3] = m[0] * v[0]! + m[4] * v[1]! + m[8] * v[2]! + m[12];
    out[i * 3 + 1] = m[1] * v[0]! + m[5] * v[1]! + m[9] * v[2]! + m[13];
    out[i * 3 + 2] = m[2] * v[0]! + m[6] * v[1]! + m[10] * v[2]! + m[14];
  }
  return out;
}

/** A coarse grid over points, for "is anything within r of (x, y, z)". */
function nearTest(points: Float32Array[], r: number): (x: number, y: number, z: number) => boolean {
  const cell = (v: number) => Math.floor(v / r);
  const grid = new Map<string, number[]>();
  for (const pts of points) for (let i = 0; i < pts.length; i += 3) {
    const k = `${cell(pts[i]!)},${cell(pts[i + 1]!)},${cell(pts[i + 2]!)}`;
    let list = grid.get(k);
    if (!list) grid.set(k, (list = []));
    list.push(pts[i]!, pts[i + 1]!, pts[i + 2]!);
  }
  return (x, y, z) => {
    const [cx, cy, cz] = [cell(x), cell(y), cell(z)];
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const list = grid.get(`${cx + a},${cy + b},${cz + c}`);
      if (!list) continue;
      for (let i = 0; i < list.length; i += 3) {
        const dx = list[i]! - x, dy = list[i + 1]! - y, dz = list[i + 2]! - z;
        if (dx * dx + dy * dy + dz * dz < r * r) return true;
      }
    }
    return false;
  };
}

/**
 * The inverted hull: a copy of the primitive pushed out along its welded
 * normals and wound inside out, so only its far side draws, as a line around
 * the silhouette. It shares the primitive's joints, weights, normals and
 * morph targets (and sits in the same mesh, so the same weights animation
 * drives it), so it moves with the body and the face shapes; only its
 * positions and indices are new. A triangle whose corners all have width 0
 * is left out.
 */
function hull(doc: Document, prim: Primitive, line: Material, width: (i: number) => number): Primitive | null {
  const pos = prim.getAttribute('POSITION')!;
  const nrm = prim.getAttribute('NORMAL');
  const idx = prim.getIndices();
  if (!nrm || !idx) return null;
  const n = pos.getCount();
  // Weld normals by position, so a seam does not split the line.
  const key = (v: number[]) => v.map((x) => Math.round(x * 1e5)).join(',');
  const sum = new Map<string, [number, number, number]>();
  const p = [0, 0, 0], q = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    pos.getElement(i, p); nrm.getElement(i, q);
    const s = sum.get(key(p)) ?? [0, 0, 0];
    sum.set(key(p), [s[0] + q[0]!, s[1] + q[1]!, s[2] + q[2]!]);
  }
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos.getElement(i, p);
    const s = sum.get(key(p))!;
    const len = Math.hypot(...s) || 1;
    const w = width(i);
    for (let k = 0; k < 3; k++) out[i * 3 + k] = p[k]! + (s[k]! / len) * w;
  }
  const tris: number[] = [];
  const ix = idx.getArray()!;
  for (let t = 0; t < ix.length; t += 3) {
    const [a, b, c] = [ix[t]!, ix[t + 1]!, ix[t + 2]!];
    if (width(a) === 0 && width(b) === 0 && width(c) === 0) continue;
    tris.push(a, c, b); // inside out
  }
  if (!tris.length) return null;
  const buffer = pos.getBuffer();
  const position = doc.createAccessor(`${pos.getName()}_ink`, buffer).setType('VEC3').setArray(out);
  const indices = doc.createAccessor(`${idx.getName()}_ink`, buffer).setType('SCALAR').setArray(n > 65535 ? new Uint32Array(tris) : new Uint16Array(tris));
  const h = doc.createPrimitive().setMaterial(line).setIndices(indices).setAttribute('POSITION', position);
  for (const s of prim.listSemantics()) if (s !== 'POSITION') h.setAttribute(s, prim.getAttribute(s) as Accessor);
  for (const t of prim.listTargets()) h.addTarget(t);
  return h;
}

/** Each vertex's skin weight on the head bone and the bones under it (0 to 1). */
function headWeight(node: Node, prim: Primitive): (i: number) => number {
  const skin = node.getSkin();
  const joints = prim.getAttribute('JOINTS_0');
  const weights = prim.getAttribute('WEIGHTS_0');
  const headNode = skin?.listJoints().find((j) => /(^|[^a-z])head$/i.test(j.getName()));
  if (!skin || !joints || !weights || !headNode) return () => 0;
  const under = new Set<number>();
  skin.listJoints().forEach((j, k) => { for (let x: Node | null = j; x; x = x.getParentNode()) if (x === headNode) { under.add(k); break; } });
  const jv = [0, 0, 0, 0], wv = [0, 0, 0, 0];
  return (i) => {
    joints.getElement(i, jv); weights.getElement(i, wv);
    let w = 0;
    for (let k = 0; k < 4; k++) if (under.has(jv[k]!)) w += wv[k]!;
    return w;
  };
}

function ink(doc: Document): void {
  for (const m of houseMaterials(doc)) if (!FACE_PARTS.test(m.getName())) flatten(m, INK_FLAT);
  const line = doc.createMaterial(INK_MATERIAL).setBaseColorFactor([0, 0, 0, 1]).setEmissiveFactor(linear(INK_LINE)).setRoughnessFactor(1).setMetallicFactor(0).setDoubleSided(false);
  const nodes = doc.getRoot().listNodes().filter((n) => n.getMesh() && INKED_MESH.test(n.getName()));
  const garments = nodes.filter((n) => GARMENT.test(n.getName())).flatMap((n) => n.getMesh()!.listPrimitives().map((p) => restPositions(n, p)));
  const covered = nearTest(garments, INK_COVERED);
  for (const node of nodes) {
    const mesh = node.getMesh()!;
    const isBody = node.getName() === 'HouseBase_Body';
    for (const prim of [...mesh.listPrimitives()]) {
      if (isBody && !INKED_BODY_PART.test(prim.getMaterial()?.getName() ?? '')) continue;
      const head = headWeight(node, prim);
      const rest = isBody ? restPositions(node, prim) : null;
      const cache = new Map<number, number>();
      const width = (i: number): number => {
        let w = cache.get(i);
        if (w !== undefined) return w;
        if (rest && covered(rest[i * 3]!, rest[i * 3 + 1]!, rest[i * 3 + 2]!)) w = 0;
        else { const h = head(i); w = INK_WIDTH.body * (1 - h) + INK_WIDTH.head * h; }
        cache.set(i, w);
        return w;
      };
      const h = hull(doc, prim, line, width);
      if (h) mesh.addPrimitive(h);
    }
  }
}

function light(doc: Document): void {
  for (const m of houseMaterials(doc)) {
    const name = m.getName();
    if (FACE_PARTS.test(name)) continue;
    const c = m.getBaseColorFactor();
    const tint = linear(LIGHT.tint);
    const own = Math.max(c[0]!, c[1]!, c[2]!) || 1;
    const pale = LIGHT_GARMENT.test(name)
      ? [0, 1, 2].map((k) => c[k]! * (1 - LIGHT_GARMENT_LIFT) + (c[k]! / own) * LIGHT_GARMENT_LIFT)
      : [0, 1, 2].map((k) => c[k]! * (1 - LIGHT.pale) + tint[k]! * LIGHT.pale);
    m.setEmissiveFactor([pale[0]! * LIGHT.glow, pale[1]! * LIGHT.glow, pale[2]! * LIGHT.glow]);
    m.setRoughnessFactor(0.5).setMetallicFactor(0);
    if (/^HouseBase_(brow|frames)$/.test(name)) m.setEmissiveFactor([0, 0, 0]);
    if (LIGHT_OPAQUE.test(name)) continue;
    m.setBaseColorFactor([pale[0]!, pale[1]!, pale[2]!, LIGHT.opacity]).setAlphaMode('BLEND');
  }
}

/** Puts a dressed house base in a finish, in place, and records it in the scene's `holoimAvatar` extras. */
export function applyFinish(doc: Document, finish: Finish): void {
  if (!FINISHES.includes(finish)) throw new Error(`applyFinish: no finish "${String(finish)}" (one of ${FINISHES.join(', ')})`);
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const extras = (scene?.getExtras() ?? {}) as { holoimAvatar?: string };
  const avatar = JSON.parse(extras.holoimAvatar ?? 'null') as Record<string, unknown> | null;
  if (!scene || !avatar || avatar.name !== 'house-base') throw new Error('applyFinish: not a house-base avatar (no holoimAvatar extras naming it)');
  if (avatar.finish !== 'clay') throw new Error(`applyFinish: the avatar already wears the ${String(avatar.finish)} finish`);
  if (finish === 'ink') ink(doc);
  if (finish === 'light') light(doc);
  extras.holoimAvatar = JSON.stringify({ ...avatar, finish });
  scene.setExtras(extras);
}
