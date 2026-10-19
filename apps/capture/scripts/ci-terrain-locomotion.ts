import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import {
  attachXrEnvironment, createXrContext, enterIwerSessionFromButton,
  freezePageClock, launchXrBrowser, waitForIwerRuntime, wireXrConsoleErrors,
  waitForPageFunctions, waitForTextContentPrefix
} from '@holoim/tooling-testing/xr-env';

type Vec = { x: number; y: number; z: number };
type Leg = { side: string; foot: Vec; groundY: number | null; correction: number; upper: number[]; lower: number[] };
type State = {
  mode: string;
  character: { position: Vec; grounded: boolean; velocityY: number };
  locomotion: { state: string; horizontalSpeed: number; timeScale: number; activeProfile: string; legs: Leg[]; clip: { name: string; time: number; duration: number } | null };
  crouch: { amount: number };
};
type Input = { forward?: boolean; back?: boolean; left?: boolean; right?: boolean; crouch?: boolean; jump?: boolean };
type Hooks = {
  __setManualClock: (enabled: boolean) => void;
  __respawnCharacter: () => boolean;
  __setMockInput: (input: Input) => void;
  __setMockVrPose: (pose: unknown) => void;
  advanceTime: (ms: number) => void;
  render_game_to_text: () => string;
};
const idle = { forward: false, back: false, left: false, right: false, crouch: false };
const artifactDir = process.env.XR_TEST_ARTIFACT_DIR ?? 'output/ci-terrain-locomotion';
const evidence: Record<string, unknown> = { environment: 'Playwright desktop and IWER mock tracked pose; real GLTF scene loader, avatar, animation and Rapier', geometry: 'Centered 20m floor; ramp y=0.8+0.15x over x=[-3,3],z=[-5,5]; wall z=-4.25', scenarios: {} };
const timelines: Record<string, State[]> = {};
const consoleErrors: string[] = [];
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// Serve an ordinary embedded-buffer GLTF through the real asset-loader route.
// Ramp normals, triangle meshes, character collisions and spawn stay production code.
function sceneGltf(): string {
  const vertices: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => vertices.push(...a, ...b, ...c, ...a, ...c, ...d);
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
    quad([x0,y1,z0], [x0,y1,z1], [x1,y1,z1], [x1,y1,z0]);
    quad([x0,y0,z1], [x0,y0,z0], [x1,y0,z0], [x1,y0,z1]);
    quad([x0,y0,z0], [x0,y1,z0], [x1,y1,z0], [x1,y0,z0]);
    quad([x1,y0,z1], [x1,y1,z1], [x0,y1,z1], [x0,y0,z1]);
    quad([x0,y0,z1], [x0,y1,z1], [x0,y1,z0], [x0,y0,z0]);
    quad([x1,y0,z0], [x1,y1,z0], [x1,y1,z1], [x1,y0,z1]);
  };
  box(-10,10,0,0.2,-10,10);
  quad([-3,0.35,-5], [-3,0.35,5], [3,1.25,5], [3,1.25,-5]);
  box(-3,3,0.2,3.2,-4.5,-4);
  const data = Buffer.from(new Float32Array(vertices).buffer);
  return JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }], materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.25,0.5,0.35,1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true }], buffers: [{ uri: `data:application/octet-stream;base64,${data.toString('base64')}`, byteLength: data.length }], bufferViews: [{ buffer: 0, byteLength: data.length }], accessors: [{ bufferView: 0, componentType: 5126, count: vertices.length / 3, type: 'VEC3', min: [-10,0,-10], max: [10,3.2,10] }] });
}
async function step(page: Page, ms = 40, input?: Input, respawn = false): Promise<State> {
  return page.evaluate(({ ms, input, respawn }) => {
    const hooks = window as unknown as Hooks;
    if (respawn && !hooks.__respawnCharacter()) throw new Error('Respawn failed');
    if (input) hooks.__setMockInput(input);
    hooks.advanceTime(ms);
    return JSON.parse(hooks.render_game_to_text()) as State;
  }, { ms, input, respawn });
}
async function screenshot(page: Page, filename: string): Promise<void> {
  // Force one ordinary draw through the existing debug clock. Resizing a
  // frozen WebGL canvas clears it before its next requestAnimationFrame.
  await page.evaluate(() => {
    const hooks = window as unknown as Hooks;
    hooks.__setManualClock(false);
    hooks.advanceTime(1000 / 60);
    hooks.__setManualClock(true);
  });
  await page.screenshot({ path: path.join(artifactDir, filename) });
}
async function sample(page: Page, label: string, count: number, input?: Input): Promise<State[]> {
  const samples: State[] = [];
  timelines[label] = samples;
  for (let i = 0; i < count; i++) {
    const state = await step(page, 40, i === 0 ? input : undefined);
    samples.push(state);
    for (const leg of state.locomotion.legs) {
      assert([...leg.upper, ...leg.lower, leg.correction, ...Object.values(leg.foot)].every(Number.isFinite), `${label}: non-finite leg transform`);
      assert(Math.abs(leg.correction) <= 1.8 * 0.225, `${label}: correction exceeds reach bound`);
      if (leg.groundY !== null) assert(leg.foot.y >= leg.groundY - 0.05, `${label}: foot penetrates support`);
    }
  }
  return samples;
}
async function settle(page: Page): Promise<State> {
  await step(page, 240, idle, true);
  const states = await sample(page, 'settle', 25);
  const state = states.at(-1)!;
  assert(state.character.grounded && state.locomotion.state === 'idle', `Baseline did not settle: ${JSON.stringify(state.character)}`);
  return state;
}
function quaternionVariation(states: State[]): number {
  const first = states[0]!.locomotion.legs;
  return Math.max(...states.flatMap(state => state.locomotion.legs.map((leg, i) => {
    const reference = first[i]!.upper;
    const dot = Math.abs(leg.upper.reduce((sum, value, j) => sum + value * reference[j]!, 0));
    return 1 - Math.min(1, dot);
  })));
}
function meanCadence(states: State[]): number {
  return states.slice(-10).reduce((sum, state) => sum + state.locomotion.timeScale, 0) / 10;
}
async function runMode(page: Page, mode: 'desktop' | 'xr'): Promise<void> {
  // Claim the public debug clock as soon as it is published, before asset loading
  // starts the realtime loop. Respawn alone cannot erase prior physics history.
  await page.addInitScript(() => {
    Object.defineProperty(window, '__setManualClock', {
      configurable: true,
      set(value: (enabled: boolean) => void) {
        Object.defineProperty(window, '__setManualClock', { value, writable: true, configurable: true });
        value(true);
      }
    });
  });
  wireXrConsoleErrors(page, consoleErrors, { label: mode });
  await page.route('**/locomotion-fixture.gltf', route => route.fulfill({ contentType: 'model/gltf+json', body: sceneGltf() }));
  await attachXrEnvironment(page, { mode: 'iwer', cacheClearState: true });
  const url = new URL(process.env.BASE_URL ?? 'https://127.0.0.1:5374/');
  url.searchParams.set('scene', '/locomotion-fixture.gltf');
  url.searchParams.set('sceneScale', '1');
  url.searchParams.set('avatarHeight', '1.8');
  await page.goto(url.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['__setManualClock', '__setMockInput', '__setMockVrPose', '__respawnCharacter', 'advanceTime', 'render_game_to_text']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  await page.evaluate(() => (window as unknown as Hooks).__setManualClock(true));
  const desktopReference = mode === 'xr' ? await settle(page) : undefined;
  if (mode === 'xr') {
    await page.evaluate(() => (window as unknown as Hooks).__setMockVrPose({ enabled: true, head: { position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } }, hands: { left: { tracked: true, position: { x: -0.26, y: -0.2, z: -0.42 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } }, right: { tracked: true, position: { x: 0.26, y: -0.2, z: -0.42 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } } } }));
    await step(page, 120, idle);
    await waitForIwerRuntime(page);
    await enterIwerSessionFromButton(page, '#VRButton', { readyCheck: () => JSON.parse((window as unknown as Hooks).render_game_to_text()).mode === 'vr' });
  }
  await freezePageClock(page);
  const baseline = await settle(page);
  assert(baseline.locomotion.legs.length === 2, `${mode}: missing leg chains`);
  assert(baseline.locomotion.activeProfile === (mode === 'xr' ? 'vr-lower-body' : 'desktop-full'), `${mode}: wrong animation profile`);
  const standing = await sample(page, `${mode}-standing-ramp`, 10);
  const legs = standing.at(-1)!.locomotion.legs;
  assert(legs.every(leg => leg.groundY !== null), `${mode}: ramp contact missing`);
  assert(Math.abs(legs[0]!.groundY! - legs[1]!.groundY!) > 0.01, `${mode}: independent ramp foot heights missing`);
  for (const state of standing) for (const leg of state.locomotion.legs) {
    assert(Math.abs(leg.groundY! - (0.8 + 0.15 * leg.foot.x)) < 0.02, `${mode}: contact does not match known ramp`);
    assert(Math.abs(leg.correction) <= 1.8 * 0.225, `${mode}: correction exceeds reach bound`);
  }
  assert(legs.some(leg => Math.abs(leg.correction) > 0.005), `${mode}: terrain solver never corrected feet`);
  assert(legs.some(leg => Math.abs(leg.foot.y - leg.groundY!) < 0.25), `${mode}: grounded feet detached from support`);
  await screenshot(page, `${mode}-ramp.png`);

  const walk = await sample(page, `${mode}-walk`, 22, { ...idle, forward: true });
  assert(walk.some(state => state.locomotion.state === 'walk' && state.locomotion.horizontalSpeed > 0.1), `${mode}: no moving walk`);
  assert(quaternionVariation(walk) > 0.001, `${mode}: walking legs are frozen`);
  await settle(page);
  await sample(page, `${mode}-crouch-settle`, 18, { ...idle, crouch: true });
  const crouchWalk = await sample(page, `${mode}-crouch-walk`, 22, { ...idle, forward: true, crouch: true });
  assert(crouchWalk.every(state => state.crouch.amount > 0.8), `${mode}: crouch did not engage`);
  assert(crouchWalk.some(state => state.locomotion.horizontalSpeed > 0.1), `${mode}: crouched avatar did not travel`);
  assert(quaternionVariation(crouchWalk) > 0.001, `${mode}: crouch overwrites leg gait`);
  const meanSpeed = (states: State[]) => states.slice(-10).reduce((sum, state) => sum + state.locomotion.horizontalSpeed, 0) / 10;
  for (const states of [walk, crouchWalk]) {
    const first = states[0]!.character.position;
    const last = states.at(-1)!.character.position;
    const travel = Math.hypot(last.x - first.x, last.z - first.z);
    // A 40ms request deterministically rounds to two 60Hz simulation steps.
    const traveledSpeed = travel / ((states.length - 1) / 30);
    assert(travel > 0.08, `${mode}: gait test did not actually travel`);
    assert(Math.abs(traveledSpeed - meanSpeed(states)) < 0.35, `${mode}: reported speed disagrees with physical travel`);
    const expected = Math.max(0.15, Math.min(2.4, 1.4 * meanSpeed(states) / 3.24));
    assert(Math.abs(meanCadence(states) - expected) < 0.15, `${mode}: cadence fails to follow actual corrected travel`);
  }
  if (meanSpeed(crouchWalk) < meanSpeed(walk) * 0.85) {
    assert(meanCadence(crouchWalk) < meanCadence(walk) * 0.85, `${mode}: crouch cadence fails to follow slower travel`);
  }
  assert(meanSpeed(walk) > 3.24 * 0.75, `${mode}: unobstructed standing walk stuck on ramp`);
  assert(Math.abs(meanCadence(crouchWalk) - meanCadence(walk)) > 0.1, `${mode}: fixed cadence despite distinct measured speeds`);
  await screenshot(page, `${mode}-crouch-walk.png`);

  await settle(page);
  const wall = await sample(page, `${mode}-wall`, 100, { ...idle, forward: true });
  const blocked = wall.slice(-10);
  assert(blocked.every(state => state.locomotion.state === 'idle' && state.locomotion.horizontalSpeed < 0.12), `${mode}: walks in place against wall`);
  assert(Math.max(...blocked.map(state => state.character.position.z)) - Math.min(...blocked.map(state => state.character.position.z)) < 0.01, `${mode}: wall failed to block travel`);
  await screenshot(page, `${mode}-wall.png`);

  const start = await settle(page);
  await step(page, 40, { ...idle, jump: true });
  const jump = await sample(page, `${mode}-jump`, 50, idle);
  const flight = jump.filter(state => !state.character.grounded);
  for (let i = 1; i < flight.length; i++) {
    const previous = flight[i - 1]!, current = flight[i]!;
    const before = previous.locomotion.clip, after = current.locomotion.clip;
    if (previous.locomotion.state === current.locomotion.state && before && after && before.name === after.name) {
      assert(after.time + 1e-6 >= before.time, `${mode}: airborne clip restarted takeoff in flight`);
      assert(after.time <= after.duration + 1e-6, `${mode}: airborne clip exceeded its duration`);
    }
  }
  assert(flight.some(state => state.character.velocityY > 0 && state.locomotion.state === 'jump'), `${mode}: jump ascent missing`);
  assert(flight.some(state => state.character.velocityY < 0 && state.locomotion.state === 'fall'), `${mode}: falling transition missing`);
  assert(Math.max(...flight.map(state => state.character.position.y)) > start.character.position.y + 0.1, `${mode}: jump did not rise`);
  assert(flight.every(state => state.locomotion.legs.every(leg => leg.groundY === null && leg.correction === 0)), `${mode}: airborne feet snap to ground`);
  assert(jump.at(-1)!.character.grounded && jump.at(-1)!.locomotion.state === 'idle', `${mode}: landing did not return to idle`);
  if (mode === 'xr') {
    await settle(page);
    await sample(page, 'xr-before-crouched-exit', 25, { ...idle, crouch: true });
    await page.evaluate(async () => {
      const globals = window as unknown as Hooks & { IWER_DEVICE: { activeSession: { end: () => Promise<void> } } };
      await globals.IWER_DEVICE.activeSession.end();
      globals.__setMockVrPose({ enabled: false });
      globals.__setMockInput({ forward: false, back: false, left: false, right: false, crouch: false });
    });
    const recovered = (await sample(page, 'xr-after-crouched-exit', 35)).at(-1)!;
    assert(recovered.locomotion.activeProfile === 'desktop-full' && recovered.crouch.amount < 0.01, 'XR exit did not restore desktop standing');
    for (const [index, leg] of recovered.locomotion.legs.entries()) {
      const reference = desktopReference!.locomotion.legs[index]!;
      const relativeFootHeight = leg.foot.y - recovered.character.position.y;
      const referenceHeight = reference.foot.y - desktopReference!.character.position.y;
      assert(Math.abs(relativeFootHeight - referenceHeight) < 0.035, 'XR crouch exit left persistent leg/hips displacement');
    }
  }
  (evidence.scenarios as Record<string, unknown>)[mode] = { standing, walkVariation: quaternionVariation(walk), crouchVariation: quaternionVariation(crouchWalk), walkCadence: meanCadence(walk), crouchCadence: meanCadence(crouchWalk), wallEnd: blocked.at(-1), jumpTransitions: jump.map(state => [state.locomotion.state, state.character.grounded, state.character.velocityY]) };
}

await mkdir(artifactDir, { recursive: true });
const browser = await launchXrBrowser(chromium);
try {
  for (const mode of ['desktop', 'xr'] as const) {
    const context = await createXrContext(browser, { viewport: { width: 960, height: 720 } });
    await runMode(await context.newPage(), mode);
    assert(consoleErrors.length === 0, `Browser errors: ${consoleErrors.join(' | ')}`);
    console.log(`[terrain-locomotion] ${mode} passed`);
  }
} catch (error) {
  for (const [index, context] of browser.contexts().entries()) {
    const page = context.pages()[0];
    if (page) await screenshot(page, `failure-${index}.png`).catch(() => undefined);
  }
  evidence.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await writeFile(path.join(artifactDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await writeFile(path.join(artifactDir, 'samples.json'), JSON.stringify(timelines, null, 2));
  await browser.close();
}
