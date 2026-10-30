import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { Euler, MathUtils, Quaternion, Vector3 } from 'three';

import { CONTROL_NAMES } from '@holoim/xr-ui-core';
import { VRM_REQUIRED_BONES, readHumanoidDeclaration, resolveHumanoidRig } from '@holoim/meaning';

import {
  attachXrEnvironment,
  createXrContext,
  launchXrBrowser,
  waitForPageFunctions,
  waitForTextContentPrefix
} from '@holoim/tooling-testing/xr-env';

import type {} from '../src/runtime/automationHooks';
import type { HumanoidBindingReport } from '../src/avatar/HumanoidSkeleton';
import { buildCandidates, generateAvatarFixtures, readGlb, resolveGltf, type FixtureInfo, type GltfJson } from './lib/avatar-fixtures.ts';

// Standard avatar formats (docs/features/archive/avatar-formats.md), in the real app:
// every generated fixture loads with ?avatar=, reports its humanoid binding
// and crouches like the shipped avatar; three export with HOLOIM_humanoid.
// The geometric fixtures (bone axes, bind pose, facing, scale) then run the
// hand and body replays unchanged, two rigs run the object grip, and one
// non-RPM rig with eye bones (VRM 0.x, facing -Z) runs the face check.
const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5174/';
const artifactDir = process.env.XR_TEST_ARTIFACT_DIR ?? 'output/ci-avatars';
const fixtureDir = path.join(artifactDir, 'fixtures');
// XR_AVATAR_ONLY=<substring> keeps matching fixtures (bindings and replays).
const only = process.env.XR_AVATAR_ONLY;
// XR_AVATAR_BIND_ONLY=1 stops after the in-app bindings, poses and exports (fast loop).
const bindOnly = process.env.XR_AVATAR_BIND_ONLY === '1';

const REPLAYED = ['reoriented-axes', 'a-pose', 't-pose', 't-pose-twisted', 'vrm0-minus-z', 'z-up', 'unreal-cm'];
const FACE_ON = 'vrm0-minus-z';
// Exports checked for HOLOIM_humanoid and per-node tracks: a declared rig facing
// -Z, a renamed rig, and one with duplicate bone names.
const EXPORTED = ['vrm0-minus-z', 'unreal-cm', 'duplicate-names'];
// The object grip derives its offset from the palm: bone axes and names that differ.
const OBJECT_ON = ['reoriented-axes', 'unreal-cm', 'no-fingers'];
const REQUIRED_FEATURES_OFF_WHEN_UNMAPPABLE = ['crouch', 'body solver', 'arm IK'];

const fixtures = (await generateAvatarFixtures(fixtureDir)).filter((f) => !only || f.name.includes(only));
const urlOf = (fixture: FixtureInfo) => `/${path.relative(process.cwd(), fixture.file).split(path.sep).join('/')}`;
const failures: string[] = [];
const fail = (fixture: string, message: string) => failures.push(`${fixture}: ${message}`);

// Records a short take, exports it, and checks the GLB names the same humanoid
// bones as the fixture and keeps one track per animated node.
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof createXrContext>>['newPage']>>;
async function checkExport(fixture: FixtureInfo, page: Page): Promise<void> {
  await page.getByRole('button', { name: CONTROL_NAMES.startRecording }).click();
  await page.getByRole('button', { name: CONTROL_NAMES.stopRecording }).waitFor();
  await page.evaluate(() => window.advanceTime(1000));
  const download = page.waitForEvent('download', { timeout: 30_000 });
  await page.getByRole('button', { name: CONTROL_NAMES.stopRecording }).click();
  const file = path.join(artifactDir, `${fixture.name}-export.glb`);
  await (await download).saveAs(file);
  const { json } = readGlb(await readFile(file));
  const declaration = readHumanoidDeclaration(json);
  if (declaration?.format !== 'holoim' || !json.extensionsUsed?.includes('HOLOIM_humanoid')) {
    fail(fixture.name, 'export has no HOLOIM_humanoid declaration'); return;
  }
  const mapping = resolveHumanoidRig(buildCandidates(json), declaration);
  if (mapping.declarationErrors.length > 0) fail(fixture.name, `export declaration errors: ${mapping.declarationErrors.join('; ')}`);
  const missing = VRM_REQUIRED_BONES.filter((bone) => declaration.bones[bone] === undefined);
  if (missing.length > 0) fail(fixture.name, `export declares no ${missing.join(', ')}`);
  const source = readGlb(await readFile(fixture.file)).json;
  const sourceMapping = resolveGltf(source);
  const nameOf = (gltf: GltfJson, index: number | undefined) => (index === undefined ? undefined : gltf.nodes?.[index]?.name);
  const renamed = Object.entries(declaration.bones).filter(([bone, index]) =>
    nameOf(json, index) !== nameOf(source, sourceMapping.bones[bone as keyof typeof sourceMapping.bones]));
  if (renamed.length > 0) fail(fixture.name, `export declares other nodes than the fixture for ${renamed.map(([bone]) => bone).join(', ')}`);
  if (fixture.name === 'duplicate-names') {
    // Names alone cannot tell the avatar's Hips from the prop's: walk up from the declared node.
    const parentOf = new Map<number, number>();
    (json.nodes ?? []).forEach((node, i) => node.children?.forEach((child) => parentOf.set(child, i)));
    for (const bone of ['hips', 'head'] as const) {
      for (let at = declaration.bones[bone]; at !== undefined; at = parentOf.get(at)) {
        if (json.nodes?.[at]?.name === 'Prop') { fail(fixture.name, `export declares the prop's ${bone}`); break; }
      }
    }
  }
  const animations = (json.animations ?? []) as { channels: { target: { node?: number; path: string } }[] }[];
  const targets = animations.flatMap((a) => a.channels.map((c) => `${c.target.node}/${c.target.path}`));
  const doubled = targets.filter((t, i) => targets.indexOf(t) !== i);
  if (doubled.length > 0) fail(fixture.name, `export animates ${doubled.length} node paths twice (${doubled.slice(0, 3).join(', ')})`);
  if (!targets.includes(`${declaration.bones.hips}/rotation`)) fail(fixture.name, 'export does not animate the declared hips');
  exportSummary.push({ fixture: fixture.name, declared: Object.keys(declaration.bones).length, channels: targets.length });
}
const exportSummary: Record<string, unknown>[] = [];

// Standing and desktop-crouched bone positions relative to the avatar root. The
// crouch pose (no body tracking) reads the avatar's canonical frame, so a rig
// whose bone axes, rest pose or facing differ must still crouch like the shipped one.
type PoseBones = Record<'standing' | 'crouched', Record<string, [number, number, number]>>;
async function samplePoses(page: Page): Promise<PoseBones> {
  const relativeBones = (ms: number, input: { crouch?: boolean }) => page.evaluate(({ ms, input }) => {
    window.__setMockInput(input);
    window.advanceTime(ms);
    const sample = window.__sampleBody();
    const root = sample.root;
    return Object.fromEntries(Object.entries(sample.bones).map(([k, v]) => [k, [v![0] - root[0], v![1] - root[1], v![2] - root[2]]])) as PoseBones['standing'];
  }, { ms, input });
  const standing = await relativeBones(500, {});
  const crouched = await relativeBones(1500, { crouch: true });
  await relativeBones(1000, {});
  return { standing, crouched };
}
const POSE_TOLERANCE_M = 0.015;
// A rig whose arms are corrected has a desktop idle clip (the correction), so walking crossfades in and
// out of it, where the shipped avatar (no desktop idle clip) starts and stops at once.
const CROSSFADE_TOLERANCE_M = 0.03;
// t-pose-twisted's forward arms move its bounds-based centering 3.9 cm, which the terrain legs and crouch
// see: its take compares the upper body at the normal tolerance, not the legs, and its leg poses take this.
const TWISTED_TOLERANCE_M = 0.055;

// Locomotion on avatars without their own clips (docs/features/locomotion-retarget.md).
// 1. Each state's clip, posed at fixed clip times on each profile, with nothing
//    blended in: every canonical bone and fingertip on desktop, the legs in VR.
// 2. A physics-driven desktop take (walk, stop, jump, land) sampled every 100 ms.
// 3. A mock-VR walk (the animation path in XR) sampled every 100 ms: legs only.
// 4. Pointing, then releasing, returns the arm to the clip's pose. After a
//    round trip through mock VR the arms match the shipped avatar's (which
//    keeps the arm IK's last pose: nothing restores it on the shipped rig either).
// Fixtures share the shipped proportions, so all compare against the shipped
// avatar at the same times, hips-relative (a rest that moves the avatar's
// bounds moves its centering), except the bones a fixture maps elsewhere or
// lacks by design (eyes, fingers: the binding check covers those).
type Bones = Record<string, [number, number, number]>;
type PoseSample = { bones: Bones; locomotion: { state: string; profile: string; clip: string | null } };
interface LocomotionSamples {
  clips: Record<string, Bones>;
  take: PoseSample[];
  mockVr: PoseSample[];
  armRest: Bones;
  afterPoint: Bones;
  afterVr: Bones;
}
const CLIP_TIMES = [0, 0.15, 0.3, 0.45];
const TWISTED = 't-pose-twisted';
const LEG_KEYS = /^(hips|(left|right)(UpperLeg|LowerLeg|Foot|Toes))$/;
const ARM_KEYS = /^(left|right)(LowerArm|Hand|(Middle|Thumb)DistalTip)$/;
async function sampleLocomotion(page: Page): Promise<LocomotionSamples> {
  const clips = await page.evaluate(({ times }) => {
    const out: Record<string, Bones> = {};
    for (const [profile, states] of [['desktop-full', ['idle', 'walk', 'jump', 'fall']], ['vr-lower-body', ['walk', 'jump', 'fall']]] as const) {
      for (const state of states) {
        for (const t of times) {
          window.__poseLocomotion(state, profile, t);
          out[`${profile} ${state} @${t}s`] = window.__sampleAvatarPose().bones;
        }
      }
    }
    window.__poseLocomotion('idle', 'desktop-full', 0);
    return out;
  }, { times: CLIP_TIMES });
  // Mock input changes only the keys it names: release each one explicitly.
  const steps = (plan: { ms: number; input: Record<string, unknown> }[]) => page.evaluate((plan) => {
    const out: PoseSample[] = [];
    for (const step of plan) {
      window.__setMockInput(step.input);
      for (let at = 0; at < step.ms; at += 100) { window.advanceTime(100); out.push(window.__sampleAvatarPose()); }
    }
    return out;
  }, plan);
  await page.evaluate(() => { window.__respawnCharacter(); window.__setMockInput({}); window.advanceTime(800); });
  const take = await steps([
    { ms: 1200, input: { forward: true } }, { ms: 1500, input: { forward: false } }, { ms: 200, input: { jump: true } }, { ms: 1500, input: {} }
  ]);
  const armRest = await page.evaluate(() => window.__sampleAvatarPose().bones);
  await steps([{ ms: 800, input: { point: true } }, { ms: 1500, input: { point: false } }]);
  const afterPoint = await page.evaluate(() => window.__sampleAvatarPose().bones);
  await page.evaluate(() => { window.__respawnCharacter(); window.__setMockVrPose({ enabled: true }); window.__setMockInput({}); window.advanceTime(800); });
  const mockVr = await steps([{ ms: 1200, input: { forward: true } }, { ms: 600, input: { forward: false } }]);
  await page.evaluate(() => { window.__setMockVrPose({ enabled: false }); window.__setMockInput({}); window.advanceTime(1000); });
  const afterVr = await page.evaluate(() => window.__sampleAvatarPose().bones);
  return { clips, take, mockVr, armRest, afterPoint, afterVr };
}

const OPTIONAL_KEYS = /Eye$|Thumb|Index|Middle|Ring|Little/;
/** Worst hips-relative distance between matching keys that `keep` accepts; a missing required bone is listed. */
function worstOf(want: Bones, got: Bones, keep: (key: string) => boolean): { d: number; key: string; missing: string[] } {
  let d = 0;
  let key = '';
  const missing: string[] = [];
  const wh = want.hips ?? [0, 0, 0];
  const gh = got.hips ?? [0, 0, 0];
  for (const [k, w] of Object.entries(want)) {
    if (!keep(k)) continue;
    const g = got[k];
    if (!g) { if (!OPTIONAL_KEYS.test(k)) missing.push(k); continue; }
    const e = Math.hypot(g[0] - gh[0] - w[0] + wh[0], g[1] - gh[1] - w[1] + wh[1], g[2] - gh[2] - w[2] + wh[2]);
    if (e > d) { d = e; key = k; }
  }
  return { d, key, missing };
}

function checkLocomotion(fixture: FixtureInfo, want: LocomotionSamples, got: LocomotionSamples): Record<string, unknown> {
  const remapped = new Set(Object.keys(fixture.expect.bonesByName ?? {}));
  const body = (k: string) => !remapped.has(k.replace(/Tip$/, ''));
  const worst = { clips: 0, take: 0, mockVr: 0, point: 0, vr: 0 };
  const note = (kind: keyof typeof worst, label: string, w: Bones, g: Bones, keep: (k: string) => boolean, limit = POSE_TOLERANCE_M) => {
    const r = worstOf(w, g, keep);
    if (r.missing.length > 0) fail(fixture.name, `${label}: no ${r.missing.slice(0, 3).join(', ')}`);
    worst[kind] = Math.max(worst[kind], r.d);
    if (r.d > limit) fail(fixture.name, `${label}: ${r.key} is ${(r.d * 100).toFixed(1)} cm off`);
  };
  for (const [key, w] of Object.entries(want.clips)) {
    note('clips', `clip ${key}`, w, got.clips[key] ?? {}, (k) => body(k) && (key.startsWith('desktop') || LEG_KEYS.test(k)));
  }
  const sequence = (samples: PoseSample[]) => samples.map((s) => s.locomotion.state).filter((s, i, a) => s !== a[i - 1]).join('>');
  const armCorrected = fixture.expect.armBelowHorizontalDegrees !== undefined;
  for (const [kind, w, g, keep] of [
    ['take', want.take, got.take, body],
    ['mockVr', want.mockVr, got.mockVr, (k: string) => body(k) && LEG_KEYS.test(k)]
  ] as const) {
    if (sequence(g) !== sequence(w)) fail(fixture.name, `${kind} states ${sequence(g)} (shipped ${sequence(w)})`);
    const changed = (i: number) => i === 0 || (i > 0 && w[i]!.locomotion.state !== w[i - 1]!.locomotion.state);
    w.forEach((sample, i) => {
      const crossfade = armCorrected && kind === 'take' && (changed(i) || changed(i - 1));
      const twisted = fixture.name === TWISTED;
      const limit = twisted ? (kind === 'mockVr' ? TWISTED_TOLERANCE_M : POSE_TOLERANCE_M) : crossfade ? CROSSFADE_TOLERANCE_M : POSE_TOLERANCE_M;
      const compared = twisted && kind === 'take' ? (k: string) => keep(k) && !LEG_KEYS.test(k) : keep;
      note(kind, `${kind} at ${(i + 1) * 100} ms`, sample.bones, g[i]?.bones ?? {}, compared, limit);
    });
  }
  if (!got.mockVr.some((s) => s.locomotion.profile === 'vr-lower-body' && s.locomotion.state === 'walk')) fail(fixture.name, 'mock VR never walked on the VR profile');
  note('point', 'arm after pointing', got.armRest, got.afterPoint, (k) => ARM_KEYS.test(k));
  note('vr', 'arm after a mock VR round trip', want.afterVr, got.afterVr, (k) => ARM_KEYS.test(k));
  return {
    sequence: { take: sequence(got.take), mockVr: sequence(got.mockVr) },
    worstCm: Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, +(v * 100).toFixed(2)]))
  };
}

async function openApp(avatarUrl: string | null, extraParams: Record<string, string> = {}) {
  const context = await createXrContext(browser, { viewport: { width: 640, height: 360 }, acceptDownloads: true });
  const page = await context.newPage();
  const warnings: string[] = [];
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning' && message.text().startsWith('[avatar]')) warnings.push(message.text());
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  await attachXrEnvironment(page, { mode: 'iwer', cacheClearState: true });
  const pageUrl = new URL(baseUrl);
  pageUrl.searchParams.set('manualClock', '1');
  if (avatarUrl) pageUrl.searchParams.set('avatar', avatarUrl);
  for (const [k, v] of Object.entries(extraParams)) pageUrl.searchParams.set(k, v);
  await page.goto(pageUrl.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['__sampleHumanoid', '__sampleBody', '__setMockInput', 'advanceTime', '__poseLocomotion', '__sampleAvatarPose']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  return { context, page, warnings, errors };
}

// 1. Binding in the app: report, warnings, page errors, crouch pose, exports.
const browser = await launchXrBrowser(chromium);
const summary: Record<string, unknown>[] = [];
const shipped = await openApp(null);
const shippedPoses = await samplePoses(shipped.page);
const shippedLocomotion = await sampleLocomotion(shipped.page);
const shippedReport = await shipped.page.evaluate(() => window.__sampleHumanoid()) as HumanoidBindingReport | null;
await shipped.context.close();
await writeFile(path.join(artifactDir, 'shipped-locomotion.json'), JSON.stringify({ report: shippedReport?.locomotion, ...shippedLocomotion }, null, 2));
if (Object.values(shippedReport?.locomotion?.clips ?? {}).some((c) => c !== 'own')) fail('shipped', `locomotion ${JSON.stringify(shippedReport?.locomotion)}`);
// The take must exercise every state, or matching the shipped sequence proves little.
const shippedStates = new Set(shippedLocomotion.take.map((s) => s.locomotion.state));
for (const state of ['idle', 'walk', 'jump', 'fall']) if (!shippedStates.has(state)) fail('shipped', `the take never reaches ${state}`);
await writeFile(path.join(artifactDir, 'shipped-poses.json'), JSON.stringify(shippedPoses, null, 2));
for (const fixture of fixtures) {
  const { context, page, warnings, errors } = await openApp(urlOf(fixture));
  const report = await page.evaluate(() => window.__sampleHumanoid()) as HumanoidBindingReport | null;
  const poses = fixture.name === 'unmappable' ? null : await samplePoses(page);
  const locomotionSamples = fixture.name === 'unmappable' ? null : await sampleLocomotion(page);
  const locomotion = locomotionSamples ? checkLocomotion(fixture, shippedLocomotion, locomotionSamples) : null;
  if (locomotionSamples) await writeFile(path.join(artifactDir, `${fixture.name}-locomotion.json`), JSON.stringify({ report: report?.locomotion, ...locomotion, ...locomotionSamples }, null, 2));
  if (report && fixture.name !== 'unmappable') {
    const want = fixture.expect.ownClips ? 'own' : 'retargeted';
    const clips = report.locomotion?.clips ?? {};
    if (['idle', 'walk', 'jump', 'fall'].some((state) => clips[state] !== want)) fail(fixture.name, `locomotion clips ${JSON.stringify(clips)}; expected ${want}`);
  }
  if (EXPORTED.includes(fixture.name)) await checkExport(fixture, page);
  await context.close();
  await writeFile(path.join(artifactDir, `${fixture.name}-humanoid.json`), JSON.stringify({ report, poses, warnings, errors }, null, 2));
  let poseWorst = 0;
  if (poses) {
    let worstAt = '';
    for (const pose of ['standing', 'crouched'] as const) {
      for (const [bone, want] of Object.entries(shippedPoses[pose])) {
        const got = poses[pose][bone];
        if (!got) { fail(fixture.name, `${pose} sample has no ${bone}`); continue; }
        const d = Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2]);
        if (d > poseWorst) { poseWorst = d; worstAt = `${pose} ${bone}`; }
      }
    }
    if (poseWorst > (fixture.name === TWISTED ? TWISTED_TOLERANCE_M : POSE_TOLERANCE_M)) fail(fixture.name, `${worstAt} is ${(poseWorst * 100).toFixed(1)} cm from the shipped avatar's`);
  }

  const pageErrors = errors.filter((e) => !/Failed to load resource|favicon/.test(e));
  if (!report) { fail(fixture.name, 'no humanoid report'); continue; }
  if (pageErrors.length > 0) fail(fixture.name, `page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
  const disabled = Object.keys(report.disabledFeatures);
  if (fixture.kind === 'negative' && fixture.name === 'unmappable') {
    if (report.missingRequired.length !== 15) fail(fixture.name, `expected 15 missing required bones, got ${report.missingRequired.length}`);
    for (const feature of [...REQUIRED_FEATURES_OFF_WHEN_UNMAPPABLE, 'locomotion']) {
      if (!disabled.includes(feature)) fail(fixture.name, `${feature} should be reported off`);
    }
    if (warnings.length !== 1) fail(fixture.name, `expected one [avatar] warning, got ${warnings.length}`);
  } else {
    if (report.missingRequired.length > 0) fail(fixture.name, `missing required ${report.missingRequired.join(', ')}`);
    const allowedOff = fixture.expect.noFingers ? ['left fingers', 'right fingers'] : [];
    const unexpectedOff = disabled.filter((f) => !allowedOff.includes(f));
    if (unexpectedOff.length > 0) fail(fixture.name, `features off: ${unexpectedOff.join(', ')}`);
    if (allowedOff.some((f) => !disabled.includes(f))) fail(fixture.name, `expected ${allowedOff.join(' and ')} reported off`);
    if (fixture.expect.noFingers && !report.notes.some((n) => /grip estimated/.test(n))) fail(fixture.name, 'grip estimate not reported');
    if (!fixture.expect.noFingers && warnings.length > 0) fail(fixture.name, `unexpected warning: ${warnings[0]}`);
    if (fixture.expect.noFingers && warnings.length !== 1) fail(fixture.name, `expected one [avatar] warning, got ${warnings.length}`);
  }
  // Facing: compare rotations, since one correction has several Euler spellings.
  if (fixture.name !== 'unmappable') {
    const deg = report.facing.correctionDeg ?? [0, 0, 0];
    const got = new Quaternion().setFromEuler(new Euler(...deg.map((d) => d * MathUtils.DEG2RAD) as [number, number, number]));
    const wantYaw = fixture.name === 'vrm0-minus-z' ? 180 : 0;
    const want = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), wantYaw * MathUtils.DEG2RAD);
    if (got.angleTo(want) * MathUtils.RAD2DEG > 1 || report.facing.note) {
      fail(fixture.name, `facing correction ${JSON.stringify(report.facing)}; expected yaw ${wantYaw}`);
    }
  }
  summary.push({ fixture: fixture.name, source: report.source, standard: report.standard ?? '-', bones: Object.keys(report.bones).length, missing: report.missingRequired.length, off: disabled.length, facingDeg: report.facing.correctionDeg, poseCm: poses ? +(poseWorst * 100).toFixed(2) : '-', locomotionCm: locomotion ? JSON.stringify(locomotion.worstCm) : '-', arms: JSON.stringify(report.locomotion?.restCorrectionDeg ?? {}), notes: report.notes.length });
}
// A clip library that fails to load turns locomotion off, says so once, and the avatar still loads.
const tPose = fixtures.find((f) => f.name === 't-pose');
if (tPose) {
  const { context, page, warnings, errors } = await openApp(urlOf(tPose), { locomotionLibrary: '/gltf/animations/missing-library.glb' });
  const report = await page.evaluate(() => window.__sampleHumanoid()) as HumanoidBindingReport | null;
  await context.close();
  const pageErrors = errors.filter((e) => !/Failed to load resource|favicon/.test(e));
  if (!report?.disabledFeatures.locomotion) fail('missing-library', `locomotion not reported off: ${JSON.stringify(report?.disabledFeatures)}`);
  if (warnings.length !== 1) fail('missing-library', `expected one [avatar] warning, got ${warnings.length}`);
  if (pageErrors.length > 0) fail('missing-library', `page errors: ${pageErrors.slice(0, 2).join(' | ')}`);
  summary.push({ fixture: 't-pose (library missing)', off: Object.keys(report?.disabledFeatures ?? {}).join(',') });
}
await browser.close();
console.table(summary);
console.table(exportSummary);

// 2. The hand and body replays, and the face check, as their own checks on fixture avatars.
const runChild = (label: string, script: string, env: Record<string, string>): Promise<boolean> => new Promise((resolve) => {
  console.log(`[avatars] ${label}`);
  const child = spawn('node', ['--import', 'tsx', script], { stdio: 'inherit', env: { ...process.env, ...env } });
  child.on('exit', (code) => resolve(code === 0));
});
for (const fixture of fixtures.filter((f) => !bindOnly && REPLAYED.includes(f.name))) {
  const dir = path.join(artifactDir, fixture.name);
  await mkdir(dir, { recursive: true });
  const avatar = urlOf(fixture);
  if (!await runChild(`${fixture.name}: hand replay`, 'scripts/ci-hand-replay-playwright.ts', { XR_AVATAR_URL: avatar, XR_TEST_ARTIFACT_DIR: path.join(dir, 'hands') })) {
    fail(fixture.name, 'hand replay failed');
  }
  if (!await runChild(`${fixture.name}: body replay (walk-forward, crouch)`, 'scripts/ci-body-replay-playwright.ts', {
    XR_AVATAR_URL: avatar, XR_TEST_ARTIFACT_DIR: path.join(dir, 'body'), XR_REPLAY_ONLY: process.env.XR_AVATAR_BODY_REPLAYS ?? 'walk-forward,crouch'
  })) {
    fail(fixture.name, 'body replay failed');
  }
}
for (const fixture of fixtures.filter((f) => !bindOnly && OBJECT_ON.includes(f.name))) {
  if (!await runChild(`${fixture.name}: object grip`, 'scripts/ci-object-playwright.mjs', {
    XR_AVATAR_URL: urlOf(fixture), XR_TEST_ARTIFACT_DIR: path.join(artifactDir, fixture.name, 'object')
  })) {
    fail(fixture.name, 'object check failed');
  }
}
const faceFixture = fixtures.find((f) => f.name === FACE_ON);
if (!bindOnly && faceFixture && !process.env.XR_AVATAR_FACE_URL) {
  // Run outside run-xr-checks: no Quest Pro server to run the face check on.
  fail(FACE_ON, 'face check not run: XR_AVATAR_FACE_URL is unset (run through test:xr:avatars)');
}
if (!bindOnly && faceFixture && process.env.XR_AVATAR_FACE_URL) {
  // The face check needs the Quest Pro dev server (run-xr-checks passes its URL).
  if (!await runChild(`${FACE_ON}: face`, 'scripts/ci-face-playwright.ts', {
    BASE_URL: process.env.XR_AVATAR_FACE_URL, XR_AVATAR_URL: urlOf(faceFixture), XR_TEST_ARTIFACT_DIR: path.join(artifactDir, FACE_ON, 'face')
  })) {
    fail(FACE_ON, 'face check failed');
  }
}

await writeFile(path.join(artifactDir, 'avatars-report.json'), JSON.stringify({ summary, exports: exportSummary, failures }, null, 2));
if (failures.length > 0) {
  console.error(`[avatars] FAIL\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`[avatars] PASS: ${fixtures.length} fixtures bound; replays on ${fixtures.filter((f) => REPLAYED.includes(f.name)).map((f) => f.name).join(', ')}`);
