import type {} from 'three';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import {
  attachXrEnvironment, createXrContext, enterIwerSessionFromButton,
  freezePageClock, launchXrBrowser, waitForIwerRuntime,
  waitForPageFunctions, waitForTextContentPrefix, wireXrConsoleErrors
} from '@holoim/tooling-testing/xr-env';

type Vec = { x: number; y: number; z: number };
interface State {
  mode: string;
  avatar: Vec;
  character: { position: Vec };
  crouch: { amount: number };
  heightAdaptation: {
    eyeHeight: number | null; scale: number; avatarHeight: number;
    minY: number; baseWorldY: number; eyeWorld: Vec; headWorld: Vec;
    refitPending: boolean; floorHead: Vec | null; recordingSizeLocked: boolean;
  };
  tracking: Record<'left' | 'right', { targetPosition: Vec; bonePosition: Vec; poseValid: boolean }>;
}
declare global {
interface Window {
  __setHeightEvidenceView(enabled: boolean): void;
  __setManualClock(enabled: boolean, draw?: boolean): void;
  advanceTime(ms: number): void;
  render_game_to_text(): string;
  IWER_DEVICE: {
    controlMode: 'manual' | 'programmatic';
    position: { set(x: number, y: number, z: number): void };
    activeSession: XRSession;
    controllers: Record<'left' | 'right', { connected: boolean; updateButtonValue(id: string, value: number): void; quaternion: { set(x: number, y: number, z: number, w: number): void }; position: { set(x: number, y: number, z: number): void } }>;
  };
  __heightSpace?: XRReferenceSpace;
  __heightPoseMissing?: boolean;
  __releaseHeightMic?: () => void;
  __heightGrips?: Partial<Record<'left' | 'right', Vec>>;
}
}
type HeightWindow = Window;
const visualEvidence = process.env.XR_HEIGHT_VISUALS === '1';
const artifacts = process.env.XR_TEST_ARTIFACT_DIR ?? 'output/ci-xr-height';
await mkdir(artifacts, { recursive: true });
const reports: unknown[] = [];
const errors: string[] = [];
const browser = await launchXrBrowser(chromium);

// A real GLB fixture variant changes the rig's eye proportions and asset origin
// before GLTFLoader, rather than bypassing the runtime with synthetic metrics.
async function proportionVariant(): Promise<Buffer> {
  const source = await readFile(new URL('../public/gltf/models/avatar.glb', import.meta.url));
  const length = source.readUInt32LE(12);
  const gltf = JSON.parse(source.toString('utf8', 20, 20 + length)) as {
    scene?: number; scenes: Array<{ nodes: number[] }>;
    nodes: Array<{ name?: string; children?: number[]; translation?: number[] }>;
  };
  const scene = gltf.scenes[gltf.scene ?? 0]!;
  const head = gltf.nodes.find((node) => node.name === 'Head');
  assert(head, 'fixture needs head bone');
  head.translation = [...(head.translation ?? [0, 0, 0])];
  head.translation[1] = (head.translation[1] ?? 0) + 0.12;
  gltf.nodes.push({ name: 'HeightTestOrigin', children: scene.nodes, translation: [0, 0.3, 0] });
  scene.nodes = [gltf.nodes.length - 1];
  const json = Buffer.from(JSON.stringify(gltf));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(padded);
  const header = Buffer.from(source.subarray(0, 20));
  const remainingChunks = source.subarray(20 + length);
  header.writeUInt32LE(20 + padded.length + remainingChunks.length, 8);
  header.writeUInt32LE(padded.length, 12);
  return Buffer.concat([header, padded, remainingChunks]);
}

async function sample(page: Page, ms = 0): Promise<State> {
  return page.evaluate((delta) => {
    const app = window as HeightWindow;
    if (delta) app.advanceTime(delta);
    return JSON.parse(app.render_game_to_text()) as State;
  }, ms);
}
async function frames(page: Page, count: number): Promise<State> {
  for (let i = 0; i < count; i += 1) {
    await page.clock.runFor(17);
    await sample(page, 1000 / 60);
  }
  return sample(page);
}
async function captureAvatar(page: Page, name: string): Promise<void> {
  if (!visualEvidence) return;
  await page.evaluate(() => {
    const app = window as HeightWindow;
    app.__setHeightEvidenceView(true);
    app.__setManualClock(true, true);
    // Remove app/emulator HTML chrome only; the live avatar is drawn by Three.
    for (const element of document.querySelectorAll<HTMLElement>('#ui-root, #VRButton, #ARButton, [data-webxr_runtime] > div')) element.style.visibility = 'hidden';
  });
  await page.clock.runFor(34);
  await page.screenshot({ path: path.join(artifacts, `${name}.png`) });
  await page.evaluate(() => {
    const app = window as HeightWindow;
    app.__setHeightEvidenceView(false);
    app.__setManualClock(true, false);
    for (const element of document.querySelectorAll<HTMLElement>('#ui-root, #VRButton, #ARButton, [data-webxr_runtime] > div')) element.style.visibility = '';
  });
}
async function clickRefit(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Refit height', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
}
async function selectRefitInVr(page: Page, height: number): Promise<void> {
  await page.evaluate((y) => {
    const app = window as HeightWindow;
    // Opposite controller deliberately points at Record: selecting Right must
    // use only Right's ray, otherwise a refit unexpectedly starts recording.
    app.IWER_DEVICE.controllers.left.position.set(0.35, y - 0.15, -0.25);
    app.IWER_DEVICE.controllers.left.quaternion.set(0, 0, 0, 1);
    const controller = app.IWER_DEVICE.controllers.right;
    controller.position.set(0.35, y - 0.32, -0.25);
    controller.quaternion.set(0, 0, 0, 1);
  }, height);
  await frames(page, 3);
  await page.evaluate(() => (window as HeightWindow).IWER_DEVICE.controllers.right.updateButtonValue('trigger', 1));
  await frames(page, 2);
  await page.evaluate(() => (window as HeightWindow).IWER_DEVICE.controllers.right.updateButtonValue('trigger', 0));
  await frames(page, 2);
}

async function pose(page: Page, y: number): Promise<void> {
  await page.evaluate((height) => (window as HeightWindow).IWER_DEVICE.position.set(0.35, height, -0.25), y);
  await page.clock.runFor(34);
}
function near(actual: number, expected: number, tolerance: number, label: string): void {
  assert(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} expected ${expected} ±${tolerance}`);
}

try {
  for (const [label, height, assetScale] of [['short', 1.25, 1], ['tall', 2.05, 1.3], ['seated', 0.95, 0.7]] as const) {
    const context = await createXrContext(browser, { viewport: visualEvidence ? { width: 1000, height: 1056 } : { width: 320, height: 180 } });
    const page: Page = await context.newPage();
    wireXrConsoleErrors(page, errors, { label });
    await attachXrEnvironment(page, { mode: 'iwer' });
    if (label === 'seated') {
      const body = await proportionVariant();
      await page.route('**/gltf/models/avatar.glb', (route) => route.fulfill({ body, contentType: 'model/gltf-binary' }));
    }
    await page.route('**/__holoim/input-recordings**', (route) => route.fulfill({ json: { path: 'height-test-input.json' } }));
    const url = new URL(process.env.BASE_URL ?? 'https://127.0.0.1:5274/');
    url.searchParams.set('avatarScale', String(assetScale));
    await page.goto(url.href, { waitUntil: 'networkidle' });
    await waitForPageFunctions(page, ['__setManualClock', 'render_game_to_text', 'advanceTime']);
    await waitForTextContentPrefix(page, '#status', 'loaded');
    await waitForIwerRuntime(page);
    const baseline = await sample(page);
    if (label === 'seated') assert(baseline.heightAdaptation.minY > 0.15, 'fixture has nonzero base origin');
    await page.evaluate((y: number) => {
      const app = window as HeightWindow;
      app.__setManualClock(true, false);
      app.IWER_DEVICE.controlMode = 'programmatic';
      app.IWER_DEVICE.position.set(0.35, y, -0.25);
      // Failure injection at the WebXR API boundary, leaving app calibration real.
      const original = XRFrame.prototype.getViewerPose;
      XRFrame.prototype.getViewerPose = function (space) {
        app.__heightSpace = space;
        app.__heightGrips = {};
        for (const input of this.session.inputSources) {
          if ((input.handedness === 'left' || input.handedness === 'right') && input.gripSpace) {
            const grip = this.getPose(input.gripSpace, space)?.transform.position;
            if (grip) app.__heightGrips[input.handedness] = { x: grip.x, y: grip.y, z: grip.z };
          }
        }
        return app.__heightPoseMissing ? (null as unknown as ReturnType<XRFrame['getViewerPose']>) : original.call(this, space);
      };
    }, height);
    await enterIwerSessionFromButton(page, '#VRButton', {
      readyCheck: () => JSON.parse((window as HeightWindow).render_game_to_text()).mode === 'vr'
    });
    await freezePageClock(page);
    await pose(page, height);
    await page.evaluate(() => { (window as HeightWindow).__heightPoseMissing = true; });
    const missing = await frames(page, 40);
    assert.equal(missing.heightAdaptation.eyeHeight, null, `${label}: missing tracking calibrated`);
    await page.evaluate(() => { (window as HeightWindow).__heightPoseMissing = false; });
    await frames(page, 15);
    await page.evaluate(() => (window as HeightWindow).IWER_DEVICE.activeSession.dispatchEvent(new Event('visibilitychange')));
    const interrupted = await frames(page, 15);
    assert.equal(interrupted.heightAdaptation.eyeHeight, null, `${label}: visibility interruption retained pending sample`);
    const calibrated = await frames(page, 30);
    reports.push({ stage: "calibration", label, calibrated });
    near(calibrated.heightAdaptation.eyeHeight ?? 0, height, 0.01, `${label} calibrated height`);
    near(calibrated.heightAdaptation.eyeWorld.y - calibrated.heightAdaptation.baseWorldY, height, 0.025, `${label} eye above base`);
    near(calibrated.heightAdaptation.headWorld.y - calibrated.heightAdaptation.baseWorldY, height, 0.01, `${label} camera above base`);
    near(calibrated.heightAdaptation.headWorld.x, calibrated.heightAdaptation.eyeWorld.x, 0.002, `${label} initial X alignment`);
    near(calibrated.heightAdaptation.headWorld.z, calibrated.heightAdaptation.eyeWorld.z, 0.002, `${label} initial Z alignment`);
    const scale = calibrated.heightAdaptation.scale;
    const baseToBody = calibrated.heightAdaptation.baseWorldY - calibrated.character.position.y;
    near(baseToBody, baseline.heightAdaptation.baseWorldY - baseline.character.position.y, 0.001, `${label} grounding invariant`);
    await page.evaluate((y: number) => {
      const app = window as HeightWindow;
      for (const side of ['left', 'right'] as const) {
        const controller = app.IWER_DEVICE.controllers[side];
        controller.connected = true;
        controller.position.set(0.35 + (side === 'left' ? -0.16 : 0.16), y - 0.18, -0.25 - 0.22);
      }
    }, height);
    const handAligned = await frames(page, 3);
    const gripPoses = await page.evaluate(() => (window as HeightWindow).__heightGrips);
    for (const side of ['left', 'right'] as const) {
      const tracked = handAligned.tracking[side];
      assert(tracked.poseValid, `${label} ${side} real controller unavailable`);
      const grip = gripPoses?.[side];
      assert(grip, `${label} ${side} XR grip unavailable`);
      near(tracked.targetPosition.y - handAligned.heightAdaptation.baseWorldY, grip.y, 0.002, `${label} ${side} tracked meters`);
      near(tracked.targetPosition.x - handAligned.heightAdaptation.headWorld.x, grip.x - 0.35, 0.002, `${label} ${side} tracked X meters`);
      near(tracked.targetPosition.z - handAligned.heightAdaptation.headWorld.z, grip.z + 0.25, 0.002, `${label} ${side} tracked Z meters`);
      near(Math.hypot(
        tracked.bonePosition.x - tracked.targetPosition.x,
        tracked.bonePosition.y - tracked.targetPosition.y,
        tracked.bonePosition.z - tracked.targetPosition.z
      ), 0, 0.04, `${label} ${side} calibrated arm reach`);
    }
    await pose(page, height - 0.4);
    const crouched = await frames(page, 45);
    near(crouched.heightAdaptation.scale, scale, 1e-8, `${label} crouch size lock`);
    near(crouched.heightAdaptation.headWorld.y - crouched.heightAdaptation.baseWorldY, height - 0.4, 0.015, `${label} crouch camera`);
    assert(crouched.crouch.amount > 0.2, `${label} actual crouch path did not run`);
    near(crouched.tracking.left.targetPosition.y - crouched.heightAdaptation.baseWorldY, gripPoses?.left?.y ?? 0, 0.002, `${label} crouch controller fixed in floor space`);
    await pose(page, height + 0.2);
    const raised = await frames(page, 40);
    near(raised.heightAdaptation.scale, scale, 1e-8, `${label} raised head size lock`);
    await page.evaluate(() => {
      const app = window as HeightWindow;
      app.__heightSpace?.dispatchEvent(new Event('reset'));
      app.__heightPoseMissing = true;
    });
    const reset = await frames(page, 40);
    near(reset.heightAdaptation.scale, scale, 1e-8, `${label} reset/tracking-loss size lock`);
    await page.evaluate(() => { (window as HeightWindow).__heightPoseMissing = false; });
    await pose(page, height);
    await frames(page, 45);
    console.log(`[xr-height] ${label}: scale and tracking checks passed`);
    await clickRefit(page);
    const awaiting = await frames(page, 15);
    near(awaiting.heightAdaptation.scale, scale, 1e-8, 'pending refit keeps size');
    assert(awaiting.heightAdaptation.refitPending, 'pending refit remains explicit');
    await page.evaluate(() => { (window as HeightWindow).__heightPoseMissing = true; });
    await frames(page, 40);
    await page.evaluate(() => { (window as HeightWindow).__heightPoseMissing = false; });
    const refitted = await frames(page, 40);
    assert(!refitted.heightAdaptation.refitPending, 'stable refit completed');
    near(refitted.crouch.amount, 0, 0.01, 'refit sets new neutral baseline');
    await captureAvatar(page, label);
    if (label === 'seated') {
      await pose(page, 1.65);
      await frames(page, 40);
      near((await sample(page)).heightAdaptation.scale, scale, 1e-8, 'standing alone keeps size');
      await selectRefitInVr(page, 1.65);
      const vrRequested = await sample(page);
      assert(vrRequested.heightAdaptation.refitPending, 'real VR select activates refit surface');
      near(vrRequested.heightAdaptation.eyeHeight ?? 0, height, 0.01, 'pending VR refit keeps committed height');
      const standingFit = await frames(page, 40);
      near(standingFit.heightAdaptation.eyeHeight ?? 0, 1.65, 0.01, 'same session seated to standing');
      await captureAvatar(page, 'refit-standing');
      await pose(page, height);
      await clickRefit(page);
      const seatedFit = await frames(page, 40);
      near(seatedFit.heightAdaptation.eyeHeight ?? 0, height, 0.01, 'same session standing to seated');
      near(seatedFit.heightAdaptation.baseWorldY - seatedFit.character.position.y, baseToBody, 0.001, 'refit preserves grounding');
      await captureAvatar(page, 'refit-seated-again');
      reports.push({ stage: 'explicit-refit', awaiting, refitted, vrRequested, standingFit, seatedFit });
    }
    if (label === 'tall') {
      // The actual recording/export path must keep its starting scale even
      // when XR ends before the asynchronous export has cloned the asset.
      console.log('[xr-height] starting recording');
      await page.evaluate(() => {
        const app = window as HeightWindow;
        navigator.mediaDevices.getUserMedia = () => new Promise((_resolve, reject) => {
          app.__releaseHeightMic = () => reject(new DOMException('Permission denied for test', 'NotAllowedError'));
        });
      });
      await page.keyboard.press('r');
      await page.waitForFunction(() => Boolean((window as HeightWindow).__releaseHeightMic));
      await frames(page, 12);
      const recording = await sample(page);
      assert(recording.heightAdaptation.recordingSizeLocked);
      assert(await page.getByRole('button', { name: 'Refit height', exact: true }).isDisabled(), 'recording startup disables refit');
      await page.getByRole('button', { name: 'Refit height', exact: true }).dispatchEvent('click');
      assert(!(await sample(page)).heightAdaptation.refitPending, 'recording handler rejects synthetic refit click');
      await page.evaluate(() => (window as HeightWindow).IWER_DEVICE.activeSession.end());
      const recordedExit = await frames(page, 4);
      near(recordedExit.heightAdaptation.scale, scale, 1e-8, 'recording exit size lock');
      await page.evaluate(() => (window as HeightWindow).__releaseHeightMic?.());
      await page.getByRole('button', { name: 'Stop Recording', exact: true }).waitFor();
      const downloadPromise = page.waitForEvent('download');
      await page.keyboard.press('r');
      // Export intentionally awaits animation frames; release browser clock.
      for (let i = 0; i < 20; i += 1) await page.clock.runFor(50);
      const download = await downloadPromise;
      const destination = path.join(artifacts, 'height-recording.glb');
      await download.saveAs(destination);
      const bytes = await readFile(destination);
      assert.equal(bytes.toString('utf8', 0, 4), 'glTF');
      const jsonLength = bytes.readUInt32LE(12);
      const gltf = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength)) as { nodes: Array<{ name?: string; scale?: number[] }> };
      const exported = gltf.nodes.find((node) => node.name === 'RecordedAvatar');
      assert(exported, 'export contains recorded avatar');
      near(exported.scale?.[1] ?? 1, assetScale * scale, 0.0001, 'GLB retains calibrated asset scale');
      await page.getByRole('button', { name: 'Start Recording', exact: true }).waitFor();
      reports.push({ stage: 'recording', recording, recordedExit, exported });
    } else {
      await page.evaluate(() => (window as HeightWindow).IWER_DEVICE.activeSession.end());
    }
    const exited = await frames(page, 4);
    near(exited.heightAdaptation.scale, 1, 1e-8, `${label} desktop restored`);
    near(exited.heightAdaptation.avatarHeight, baseline.heightAdaptation.avatarHeight, 1e-8, `${label} desktop height`);
    await page.evaluate((y: number) => (window as HeightWindow).IWER_DEVICE.position.set(0.35, y, -0.25), height + 0.1);
    // The page clock is frozen; clicking uses Playwright's independent input clock.
    await enterIwerSessionFromButton(page, '#VRButton');
    await pose(page, height + 0.1);
    const reentered = await frames(page, 45);
    near(reentered.heightAdaptation.eyeHeight ?? 0, height + 0.1, 0.01, `${label} fresh entry`);
    reports.push({ label, height, assetScale, baseline, missing, calibrated, crouched, raised, reset, exited, reentered });
    console.log(`[xr-height] ${label}: calibrated, crouched, reset, exited, reentered`);
  }
  assert.deepEqual(errors, [], 'browser console errors');
  if (visualEvidence) {
  const comparison: Page = await browser.newPage({ viewport: { width: 1200, height: 460 } });
  for (const [name, images] of [['height-comparison', ['short', 'tall', 'seated']], ['refit-sequence', ['seated', 'refit-standing', 'refit-seated-again']]] as const) {
    const panels = await Promise.all(images.map(async (file) => `<img alt="${file}" src="data:image/png;base64,${(await readFile(path.join(artifacts, `${file}.png`))).toString('base64')}">`));
    await comparison.setContent(`<html><body style="margin:0;background:#182531;color:white;font:18px sans-serif"><div style="padding:10px;text-align:center">${name === 'refit-sequence' ? 'Same avatar and XR session: seated fit → Refit height standing → Refit height seated' : 'Actual live avatars · identical meter scale and framing'}</div><div style="display:flex">${panels.join('')}</div><style>img{width:400px;height:422px;object-fit:contain}</style></body></html>`, { waitUntil: 'load' });
    await comparison.screenshot({ path: path.join(artifacts, `${name}.png`) });
  }
  }
} finally {
  await writeFile(path.join(artifacts, 'height-report.json'), JSON.stringify({ reports, errors }, null, 2));
  await browser.close();
}
