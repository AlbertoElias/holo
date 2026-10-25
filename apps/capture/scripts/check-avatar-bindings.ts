/**
 * Node-only avatar binding check (no browser).
 *
 * Generates the avatar fixtures from the shipped `avatar.glb`, resolves each
 * one with the `@holoim/meaning` humanoid resolver from its glTF JSON, writes
 * `output/ci-avatars/<fixture>-binding.json`, and asserts:
 *   - renamed/declared/geometric fixtures resolve all 15 required and 30 finger
 *     bones, to the same shipped nodes as the shipped avatar's mapping;
 *   - fixture-specific picks (Unreal spine_01/03/05, VRM 1.0 / 0.x declarations,
 *     duplicate names prefer the avatar's skin, unmappable resolves nothing);
 *   - three.js-sanitized names resolve exactly like raw names;
 *   - skinned bind-pose vertices of exact fixtures equal the shipped avatar's
 *     to 1e-5 m, and every joint's bind world × IBM agrees (bind consistency);
 *   - generation is deterministic, and no `skeleton.pose()` call exists in
 *     capture or viewer-web sources.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Matrix4, PropertyBinding, Quaternion, Vector3 } from 'three';
import { VRM_HUMANOID_BONES, VRM_REQUIRED_BONES, type HumanoidMapping, type VrmHumanoidBone } from '@holoim/meaning';
import {
  SHIPPED_AVATAR,
  generateAvatarFixtures,
  readGlb,
  resolveGltf,
  type GltfJson
} from './lib/avatar-fixtures.ts';

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
// Its own directory: the in-app avatars check keeps its evidence in output/ci-avatars.
const OUT_DIR = join(APP_ROOT, 'output', 'ci-avatar-bindings');
const FIXTURE_DIR = join(OUT_DIR, 'fixtures');
const RERUN_DIR = join(OUT_DIR, 'fixtures-rerun');
const VERTEX_SAMPLE = 2000;
const VERTEX_TOLERANCE = 1e-5;
const BIND_TOLERANCE = 1e-4;

const FINGER_BONES: readonly VrmHumanoidBone[] = VRM_HUMANOID_BONES.filter((b) =>
  /(Thumb|Index|Middle|Ring|Little)/.test(b)
);

// ---------------------------------------------------------------------------
// GLB geometry (spec skinning: Σ w · jointWorld · IBM · v; skinned mesh node transform ignored)
// ---------------------------------------------------------------------------

interface Glb {
  readonly json: GltfJson & {
    accessors: { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean }[];
    bufferViews: { byteOffset?: number; byteLength: number; byteStride?: number }[];
    meshes: { primitives: { attributes: Record<string, number> }[] }[];
  };
  readonly bin: Uint8Array;
}

const TYPE_SIZE: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(glb: Glb, index: number, limit = Infinity): { data: Float64Array; size: number; count: number } {
  const acc = glb.json.accessors[index]!;
  const size = TYPE_SIZE[acc.type]!;
  const count = Math.min(acc.count, limit);
  const data = new Float64Array(count * size);
  if (acc.bufferView === undefined) return { data, size, count };
  const bv = glb.json.bufferViews[acc.bufferView]!;
  const view = new DataView(glb.bin.buffer, glb.bin.byteOffset + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0));
  const bytes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[acc.componentType as 5126]!;
  const stride = bv.byteStride ?? bytes * size;
  for (let i = 0; i < count; i += 1) {
    for (let k = 0; k < size; k += 1) {
      const at = i * stride + k * bytes;
      let v: number;
      switch (acc.componentType) {
        case 5126: v = view.getFloat32(at, true); break;
        case 5121: v = view.getUint8(at); if (acc.normalized) v /= 255; break;
        case 5123: v = view.getUint16(at, true); if (acc.normalized) v /= 65535; break;
        case 5125: v = view.getUint32(at, true); break;
        case 5120: v = view.getInt8(at); if (acc.normalized) v = Math.max(v / 127, -1); break;
        case 5122: v = view.getInt16(at, true); if (acc.normalized) v = Math.max(v / 32767, -1); break;
        default: throw new Error(`componentType ${acc.componentType}`);
      }
      data[i * size + k] = v;
    }
  }
  return { data, size, count };
}

function worldMatrices(json: GltfJson): Matrix4[] {
  const nodes = json.nodes ?? [];
  const world: Matrix4[] = nodes.map(() => new Matrix4());
  const local = (i: number): Matrix4 => {
    const n = nodes[i]!;
    if (n.matrix) return new Matrix4().fromArray(n.matrix);
    const t = n.translation ?? [0, 0, 0];
    const r = n.rotation ?? [0, 0, 0, 1];
    const s = n.scale ?? [1, 1, 1];
    return new Matrix4().compose(new Vector3(t[0], t[1], t[2]), new Quaternion(r[0], r[1], r[2], r[3]), new Vector3(s[0], s[1], s[2]));
  };
  const visit = (i: number, parent: Matrix4): void => {
    world[i] = parent.clone().multiply(local(i));
    for (const c of nodes[i]!.children ?? []) visit(c, world[i]!);
  };
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? [];
  for (const r of roots) visit(r, new Matrix4());
  return world;
}

/** Joint matrices (jointWorld × IBM) per skin. */
function jointMatrices(glb: Glb): Matrix4[][] {
  const world = worldMatrices(glb.json);
  return (glb.json.skins ?? []).map((skin) => {
    const ibm = skin.inverseBindMatrices === undefined ? undefined : readAccessor(glb, skin.inverseBindMatrices).data;
    return skin.joints.map((j, k) =>
      world[j]!.clone().multiply(ibm ? new Matrix4().fromArray(Array.from(ibm.subarray(k * 16, k * 16 + 16))) : new Matrix4()));
  });
}

/** Skinned bind-pose positions of the first VERTEX_SAMPLE vertices of each primitive of each skinned mesh node. */
function skinnedVertices(glb: Glb): Map<number, Float64Array[]> {
  const joints = jointMatrices(glb);
  const out = new Map<number, Float64Array[]>();
  for (const node of glb.json.nodes ?? []) {
    const skinIndex = node.skin;
    if (node.mesh === undefined || skinIndex === undefined) continue;
    const prims = glb.json.meshes[node.mesh]!.primitives.map((prim) => {
      const pos = readAccessor(glb, prim.attributes.POSITION!, VERTEX_SAMPLE);
      const jn = readAccessor(glb, prim.attributes.JOINTS_0!, VERTEX_SAMPLE);
      const wt = readAccessor(glb, prim.attributes.WEIGHTS_0!, VERTEX_SAMPLE);
      const res = new Float64Array(pos.count * 3);
      const v = new Vector3();
      const acc = new Vector3();
      for (let i = 0; i < pos.count; i += 1) {
        acc.set(0, 0, 0);
        for (let k = 0; k < 4; k += 1) {
          const w = wt.data[i * 4 + k]!;
          if (w === 0) continue;
          v.set(pos.data[i * 3]!, pos.data[i * 3 + 1]!, pos.data[i * 3 + 2]!).applyMatrix4(joints[skinIndex]![jn.data[i * 4 + k]!]!);
          acc.addScaledVector(v, w);
        }
        res.set([acc.x, acc.y, acc.z], i * 3);
      }
      return res;
    });
    out.set(node.mesh, prims);
  }
  return out;
}

function vertexDeviation(shipped: Map<number, Float64Array[]>, fixture: Map<number, Float64Array[]>, transform?: readonly number[]): number {
  const m = transform ? new Matrix4().fromArray([...transform]) : undefined;
  let max = 0;
  for (const [mesh, prims] of shipped) {
    const other = fixture.get(mesh);
    if (!other) return Infinity;
    prims.forEach((a, p) => {
      const b = other[p]!;
      if (a.length !== b.length) max = Infinity;
      const v = new Vector3();
      for (let i = 0; i < a.length; i += 3) {
        v.set(a[i]!, a[i + 1]!, a[i + 2]!);
        if (m) v.applyMatrix4(m);
        max = Math.max(max, Math.abs(v.x - b[i]!), Math.abs(v.y - b[i + 1]!), Math.abs(v.z - b[i + 2]!));
      }
    });
  }
  return max;
}

/** Max element deviation of each main-skin joint's world × IBM from the first joint's. */
function bindDeviation(glb: Glb): number {
  const mats = jointMatrices(glb)[0]!;
  const ref = mats[0]!.elements;
  // Normalize by the reference scale so cm-baked rigs compare in the same units.
  const scale = Math.cbrt(Math.abs(mats[0]!.determinant())) || 1;
  let max = 0;
  for (const m of mats) m.elements.forEach((e, i) => { max = Math.max(max, Math.abs(e - ref[i]!) / (i >= 12 ? 1 : scale)); });
  return max;
}

/** Upper-arm angle below horizontal in the world XY plane, left then right, from node TRS. */
function armBelowHorizontal(glb: Glb, mapping: HumanoidMapping): number[] {
  const world = worldMatrices(glb.json);
  const pos = (i: number | undefined): Vector3 => new Vector3().setFromMatrixPosition(world[i!]!);
  return (['left', 'right'] as const).map((side) => {
    const d = pos(mapping.bones[`${side}LowerArm`]).sub(pos(mapping.bones[`${side}UpperArm`]));
    return (Math.atan2(-d.y, Math.abs(d.x)) * 180) / Math.PI;
  });
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

async function poseCalls(): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(ts|tsx|js|mjs|jsx)$/.test(entry.name)) {
        const lines = (await readFile(path, 'utf8')).split('\n');
        lines.forEach((line, i) => {
          if (/\bskeleton\??\.pose\s*\(/i.test(line) || /\.pose\(\s*\)/.test(line)) hits.push(`${relative(REPO_ROOT, path)}:${i + 1}`);
        });
      }
    }
  };
  for (const dir of ['apps/capture/src', 'apps/viewer-web/src']) await walk(join(REPO_ROOT, dir));
  return hits;
}

async function hashes(files: readonly string[]): Promise<string[]> {
  return Promise.all(files.map(async (f) => createHash('sha256').update(await readFile(f)).digest('hex')));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Row { fixture: string; kind: string; source: string; standard: string; req: string; fingers: string; identity: string; verts: string; bind: string; failures: string[] }

async function main(): Promise<void> {
  const started = performance.now();
  const source = new Uint8Array(await readFile(SHIPPED_AVATAR));
  await rm(OUT_DIR, { recursive: true, force: true });
  const fixtures = await generateAvatarFixtures(FIXTURE_DIR, source);
  const rerun = await generateAvatarFixtures(RERUN_DIR, source);
  const [first, second] = [await hashes(fixtures.map((f) => f.file)), await hashes(rerun.map((f) => f.file))];
  const nondeterministic = fixtures.filter((_, i) => first[i] !== second[i]).map((f) => f.name);
  await rm(RERUN_DIR, { recursive: true, force: true });

  const shippedGlb = readGlb(source) as Glb;
  const shipped = resolveGltf(shippedGlb.json);
  const shippedNodes = shippedGlb.json.nodes ?? [];
  const shippedVerts = skinnedVertices(shippedGlb);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, 'shipped-binding.json'), `${JSON.stringify(report(shippedGlb.json, shipped), null, 2)}\n`);

  const rows: Row[] = [];
  const records: Record<string, unknown> = {};
  for (const fx of fixtures) {
    const glb = readGlb(new Uint8Array(await readFile(fx.file))) as Glb;
    const nodes = glb.json.nodes ?? [];
    const mapping = resolveGltf(glb.json);
    const sanitized = resolveGltf(glb.json, (n) => PropertyBinding.sanitizeNodeName(n));
    const failures: string[] = [];
    const fail = (msg: string): void => { failures.push(msg); };
    const e = fx.expect;
    const nameOf = (i: number | undefined): string | undefined => (i === undefined ? undefined : nodes[i]?.name);

    if (nodes.length !== fx.origIndex.length) fail(`node count ${nodes.length} != generator's ${fx.origIndex.length}`);
    if (JSON.stringify(sanitized.bones) !== JSON.stringify(mapping.bones)) fail('three-sanitized names resolve differently');

    const missingFingers = FINGER_BONES.filter((b) => mapping.bones[b] === undefined);
    if (e.resolvesAll) {
      if (mapping.missingRequired.length) fail(`missing required: ${mapping.missingRequired.join(',')}`);
      if (missingFingers.length) fail(`missing fingers: ${missingFingers.join(',')}`);
    } else if (e.noFingers) {
      if (mapping.missingRequired.length) fail(`missing required: ${mapping.missingRequired.join(',')}`);
      if (missingFingers.length !== FINGER_BONES.length) fail(`expected no finger bones, got ${FINGER_BONES.length - missingFingers.length}`);
    } else if (fx.kind === 'negative' && e.source === 'none') {
      if (mapping.missingRequired.length !== VRM_REQUIRED_BONES.length) fail(`expected all 15 required missing, got ${mapping.missingRequired.length}`);
      if (Object.keys(mapping.bones).length) fail(`expected no bones, got ${Object.keys(mapping.bones).length}`);
    }
    if (e.source && mapping.source !== e.source) fail(`source ${mapping.source} != ${e.source}`);
    if (e.standard && mapping.standard !== e.standard) fail(`standard ${mapping.standard ?? '-'} != ${e.standard}`);
    if (e.declarationFormat && mapping.declarationFormat !== e.declarationFormat) fail(`declarationFormat ${mapping.declarationFormat ?? '-'} != ${e.declarationFormat}`);
    if (mapping.declarationErrors.length) fail(`declaration errors: ${mapping.declarationErrors.join('; ')}`);

    // Identity: every bone maps to the same shipped node as the shipped avatar's mapping.
    const identityDiffs: string[] = [];
    const lost: string[] = [];
    for (const [bone, name] of Object.entries(e.bonesByName ?? {})) {
      const got = nameOf(mapping.bones[bone as VrmHumanoidBone]);
      if (got !== name) fail(`${bone} → ${got ?? '-'} (expected ${name})`);
    }
    if (e.identity) {
      for (const bone of VRM_HUMANOID_BONES) {
        if (e.bonesByName?.[bone] !== undefined) continue;
        const want = shipped.bones[bone];
        const at = mapping.bones[bone];
        const got = at === undefined ? undefined : fx.origIndex[at];
        if (want === undefined && got === undefined) continue;
        if (got === undefined) { lost.push(bone); continue; }
        if (got !== want) {
          identityDiffs.push(`${bone}: ${nameOf(at)} (shipped ${got === -1 ? 'added node' : shippedNodes[got!]?.name}) vs shipped ${want === undefined ? '-' : shippedNodes[want]?.name}`);
        }
      }
      if (identityDiffs.length) fail(`identity: ${identityDiffs.join('; ')}`);
    }
    if (fx.name === 'vrm0-minus-z') {
      for (const [bone, want] of [['leftThumbMetacarpal', 'LeftHandThumb1'], ['leftThumbProximal', 'LeftHandThumb2'], ['leftThumbDistal', 'LeftHandThumb3']] as const) {
        if (nameOf(mapping.bones[bone]) !== want) fail(`vrm0 thumb ${bone} → ${nameOf(mapping.bones[bone]) ?? '-'} (expected ${want})`);
      }
    }
    if (fx.name === 'duplicate-names') {
      for (const bone of ['hips', 'head'] as const) {
        const at = mapping.bones[bone];
        if (at === undefined || fx.origIndex[at] !== shipped.bones[bone]) fail(`${bone} picked the prop's node ${at}`);
      }
    }

    let verts = '-';
    if (e.vertexExact) {
      const dev = vertexDeviation(shippedVerts, skinnedVertices(glb), e.vertexTransform);
      verts = dev.toExponential(1);
      if (!(dev < VERTEX_TOLERANCE)) fail(`skinned vertices deviate ${dev.toExponential(2)} m`);
    }
    const bindDev = bindDeviation(glb);
    if (e.bindConsistent && !(bindDev < BIND_TOLERANCE)) fail(`bind world × IBM inconsistent by ${bindDev.toExponential(2)}`);
    if (!e.bindConsistent && bindDev < BIND_TOLERANCE) fail('expected an inconsistent bind (IBMs left in T-pose)');
    let armAngles: number[] | undefined;
    if (e.armBelowHorizontalDegrees !== undefined) {
      armAngles = armBelowHorizontal(glb, mapping);
      armAngles.forEach((d) => {
        if (Math.abs(d - e.armBelowHorizontalDegrees!) > 0.5) fail(`upper arm ${d.toFixed(1)}° below horizontal (want ${e.armBelowHorizontalDegrees}°)`);
      });
    }

    const binding = {
      ...report(glb.json, mapping),
      kind: fx.kind,
      expect: fx.expect,
      lostVsShipped: lost,
      sanitizedNamesMatch: JSON.stringify(sanitized.bones) === JSON.stringify(mapping.bones),
      vertexMaxDeviationM: verts === '-' ? undefined : Number(verts),
      bindDeviation: bindDev,
      ...(armAngles ? { armBelowHorizontalDegrees: armAngles, shippedArmBelowHorizontalDegrees: armBelowHorizontal(shippedGlb, shipped) } : {}),
      failures
    };
    records[fx.name] = binding;
    await writeFile(join(OUT_DIR, `${fx.name}-binding.json`), `${JSON.stringify(binding, null, 2)}\n`);
    rows.push({
      fixture: fx.name,
      kind: fx.kind,
      source: mapping.source,
      standard: mapping.standard ?? '-',
      req: `${VRM_REQUIRED_BONES.length - mapping.missingRequired.length}/15`,
      fingers: `${FINGER_BONES.length - missingFingers.length}/30`,
      identity: e.identity ? (identityDiffs.length ? 'DIFF' : lost.length ? `ok-${lost.length}` : 'ok') : '-',
      verts,
      bind: bindDev.toExponential(1),
      failures
    });
  }

  const poseHits = await poseCalls();
  printTable(rows);
  const notes = Object.entries(records).flatMap(([name, r]) => {
    const rec = r as { ambiguities: unknown[]; lostVsShipped: string[] };
    return [
      ...(rec.ambiguities.length ? [`${name}: ambiguities ${JSON.stringify(rec.ambiguities)}`] : []),
      ...(rec.lostVsShipped.length ? [`${name}: not mapped (shipped maps them): ${rec.lostVsShipped.join(',')}`] : [])
    ];
  });
  for (const note of notes) console.log(`  note  ${note}`);
  const globalFailures = [
    ...(nondeterministic.length ? [`non-deterministic fixtures: ${nondeterministic.join(', ')}`] : []),
    ...(poseHits.length ? [`skeleton.pose() calls: ${poseHits.join(', ')}`] : [])
  ];
  console.log(`determinism: ${nondeterministic.length ? 'FAIL' : 'ok'} (${fixtures.length} fixtures generated twice, sha256 equal)`);
  console.log(`pose guard:  ${poseHits.length ? 'FAIL' : 'ok'} (no skeleton.pose() in apps/capture/src, apps/viewer-web/src)`);
  const failed = rows.filter((r) => r.failures.length);
  for (const row of failed) for (const f of row.failures) console.log(`  FAIL  ${row.fixture}: ${f}`);
  for (const f of globalFailures) console.log(`  FAIL  ${f}`);
  console.log(`reports: ${relative(REPO_ROOT, OUT_DIR)}  (${((performance.now() - started) / 1000).toFixed(1)} s)`);
  if (failed.length || globalFailures.length) process.exit(1);
}

function report(json: GltfJson, mapping: HumanoidMapping): Record<string, unknown> {
  const nodes = json.nodes ?? [];
  const name = (i: number): string => nodes[i]?.name ?? `#${i}`;
  return {
    source: mapping.source,
    standard: mapping.standard,
    declarationFormat: mapping.declarationFormat,
    bones: Object.fromEntries(VRM_HUMANOID_BONES.filter((b) => mapping.bones[b] !== undefined).map((b) => [b, name(mapping.bones[b]!)])),
    missingRequired: mapping.missingRequired,
    unmatched: mapping.unmatched,
    ambiguities: mapping.ambiguities.map((a) => ({ bone: a.bone, chosen: `${name(a.chosen)} (#${a.chosen})`, rejected: a.rejected.map((r) => `${name(r)} (#${r})`) })),
    declarationErrors: mapping.declarationErrors
  };
}

function printTable(rows: Row[]): void {
  const cols: (keyof Row)[] = ['fixture', 'kind', 'source', 'standard', 'req', 'fingers', 'identity', 'verts', 'bind'];
  const cells = rows.map((r) => [...cols.map((c) => String(r[c])), r.failures.length ? 'FAIL' : 'ok']);
  const header = [...cols, 'result'];
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[]): string => c.map((v, i) => v.padEnd(widths[i]!)).join('  ');
  console.log(line(header));
  for (const c of cells) console.log(line(c));
}

await main();
