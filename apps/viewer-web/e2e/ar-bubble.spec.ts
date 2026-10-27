import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import type * as Three from "three";
import type { Mesh, Object3D } from "three";
import { tokens } from "@holoim/design-tokens";
import { freezePageClock, waitForIwerSession, waitForXrFrames } from "@holoim/tooling-testing/xr-env";
import { clocheCharShare } from "@holoim/xr-ui-core";

import { diagnosticGltf } from "./bubble-fixture";
import { captureBubblePixels } from "./bubble-pixel-proof";

import { expect, observeFeedCardRenderer, test, waitForFeedCardPresented, pressViewInAr } from "./bootstrap";

import type { Probe } from "./ar-bubble-types";
type ProbeWindow = Window & { __HOLOIM_AR_TEST_OBSERVER__?: (value: Probe) => void; __bubbleProbe?: Probe };

// `/ar/:id` is the IWSDK shell (viewer-xr-interface step 6). Its development
// probe (`__HOLOIM_XR_VIEWER__`) reports placement and the scale chip, and
// holds the clip clock; the AR observer hands the placed hologram's model,
// bubble and cloche to these checks, as the R3F view did.
type Vec3 = [number, number, number];
type ViewerProbeWindow = Window & {
  __HOLOIM_XR_VIEWER__?: {
    snapshot(): {
      placement: { stage: string; position: Vec3 | null };
      hologram: { worldPosition: Vec3; worldScale: Vec3; grabbed: boolean } | null;
      controls: { foot: { text: { scale: string } } } | null;
    };
    setClock(clipTime: number, playing: boolean): void;
  };
};

const viewerSnapshot = (page: Page) => page.evaluate(() => (window as ViewerProbeWindow).__HOLOIM_XR_VIEWER__!.snapshot());

/** From the feed card into the IWSDK AR session (auto-entry on the tap, or the entry button), placed. */
async function enterArFromFeed(page: Page): Promise<void> {
  await pressViewInAr(page);
  await expect(page).toHaveURL(/\/ar\/bubble-render$/);
  const container = page.locator(".xr-view-container");
  await expect(container).toHaveAttribute("data-xr-state", /ready|immersive/, { timeout: 20_000 });
  if ((await container.getAttribute("data-xr-state")) === "ready") await page.getByRole("button", { name: "View in your room" }).click();
  await waitForIwerSession(page, { environmentBlendMode: "alpha-blend" });
  await page.waitForFunction(() => Boolean((window as ProbeWindow).__bubbleProbe?.bubble.active));
  await expect.poll(async () => (await viewerSnapshot(page)).placement.stage, { timeout: 15_000 }).toMatch(/placed|anchored/);
}

type IwerWindow = Window & {
  IWER_DEVICE: {
    controlMode: string;
    position: { x: number; y: number; z: number; set(...v: number[]): void };
    quaternion: { set(...v: number[]): void };
    controllers: Record<"left" | "right", { position: { set(...v: number[]): void }; quaternion: { set(...v: number[]): void }; updateButtonValue(id: string, v: number): void }>;
  };
};

/**
 * The viewer's own rescale on a headset: both grips on the hologram's front,
 * brought together, so it shrinks to `factor` of its recorded size and brings
 * the 4 m diagnostic bubble into the controlled view below.
 */
async function twoHandShrink(page: Page, factor: number): Promise<void> {
  const { hologram } = await viewerSnapshot(page);
  const [x, y, z] = hologram!.worldPosition;
  // High on the diagnostic body (0.5 m): the foot chip is within 15 cm of
  // its feet, and a touch candidate there outranks the grab.
  const chest = y + 0.45;
  // Just inside the front of the diagnostic body's 0.5 m pointer box.
  const front = z + 0.25 - 0.02;
  const pose = (side: "left" | "right" | "head", position: Vec3, quaternion: [number, number, number, number] = [0, 0, 0, 1]) => page.evaluate(({ side, position, quaternion }) => {
    const device = (window as unknown as IwerWindow).IWER_DEVICE;
    device.controlMode = "programmatic";
    const tracked = side === "head" ? device : device.controllers[side];
    tracked.position.set(...position);
    tracked.quaternion.set(...quaternion);
  }, { side, position, quaternion });
  // One grip a few frames after the other, as hands close.
  const squeeze = async (value: 0 | 1) => {
    for (const side of ["left", "right"] as const) {
      await page.evaluate(({ side, value }) => (window as unknown as IwerWindow).IWER_DEVICE.controllers[side].updateButtonValue("squeeze", value), { side, value });
      await waitForXrFrames(page, 2);
    }
  };
  const spread = 0.2;
  await pose("head", [x, 1.6, z + 0.9]);
  await pose("left", [x - spread, chest, front]);
  await pose("right", [x + spread, chest, front]);
  // Grab pointers pick up what they touch over the next frames.
  await waitForXrFrames(page, 3);
  await squeeze(1);
  await expect.poll(async () => (await viewerSnapshot(page)).hologram!.grabbed, { timeout: 3_000 }).toBe(true);
  for (let step = 1; step <= 10; step += 1) {
    const half = spread * (1 + (factor - 1) * step / 10);
    await pose("left", [x - half, chest, front]);
    await pose("right", [x + half, chest, front]);
    await waitForXrFrames(page, 2);
  }
  await squeeze(0);
  await expect.poll(async () => (await viewerSnapshot(page)).hologram!.grabbed, { timeout: 3_000 }).toBe(false);
  // The hands leave, so nothing grabs again.
  await pose("left", [x - 1, 0.2, z + 2]);
  await pose("right", [x + 1, 0.2, z + 2]);
}

/** Holds the hologram's clock at `clipTime`, paused, or plays it from there. */
const setClock = (page: Page, clipTime: number, playing: boolean) =>
  page.evaluate(([time, play]) => (window as ViewerProbeWindow).__HOLOIM_XR_VIEWER__!.setClock(time, play), [clipTime, playing] as const);

test("immersive AR renders the animated bubble and clips outside geometry in both eyes", async ({ page }, testInfo) => {
  test.setTimeout(90000);
  const hologram = { id: "bubble-render", url: "/uploads/bubble-render.glb", usdzUrl: null, quickLookEnabled: false, createdAt: "2026-10-18T00:00:00Z", sizeBytes: 4096, filenameOriginal: "bubble-render.glb", hologramName: "Bubble rendering diagnostic", submittedBy: "automation" };
  await page.setViewportSize({ width: 640, height: 480 });
  await page.addInitScript(() => {
    (window as ProbeWindow).__HOLOIM_AR_TEST_OBSERVER__ = (value) => { (window as ProbeWindow).__bubbleProbe = value; };
  });
  await page.route("**/api/holograms?*", (route) => route.fulfill({ json: { items: [hologram], nextCursor: null } }));
  await page.route("**/api/holograms/bubble-render", (route) => route.fulfill({ json: hologram }));
  await page.route("**/uploads/bubble-render.glb", (route) => route.fulfill({ body: diagnosticGltf(), contentType: "model/gltf-binary" }));
  await observeFeedCardRenderer(page);
  await page.goto("/");
  await waitForFeedCardPresented(page);
  await enterArFromFeed(page);
  await page.evaluate(() => {
    const device = (window as unknown as { IWER_DEVICE: { stereoEnabled: boolean; ipd: number } }).IWER_DEVICE;
    device.stereoEnabled = true; device.ipd = 0.064;
  });
  // AR opens at true scale (Q13); the viewer's own two-hand rescale gives the
  // non-unit transform the clipping must survive, and brings the 4 m
  // diagnostic bubble into the controlled view below.
  expect((await viewerSnapshot(page)).hologram!.worldScale[0], "AR opens at recorded scale").toBeCloseTo(1, 6);
  await twoHandShrink(page, 0.45);
  await expect.poll(async () => (await viewerSnapshot(page)).controls?.foot.text.scale).toMatch(/^\d+%$/);
  await freezePageClock(page);
  await page.clock.runFor(100);
  // The room chooses placement, but the pixel oracle needs a controlled view
  // in which its positive outside marker is on screen in every SEM scene.
  await page.evaluate(async () => {
    const moduleUrl = "/node_modules/.vite/deps/three.js";
    const { Vector3 } = await import(moduleUrl) as typeof Three;
    const probe = (window as ProbeWindow).__bubbleProbe!;
    const center = probe.model.getObjectByName("RecordedBubbleSphere")!.getWorldPosition(new Vector3());
    const device = (window as unknown as { IWER_DEVICE: { controlMode: string; position: { set: (...v: number[]) => void }; quaternion: { set: (...v: number[]) => void } } }).IWER_DEVICE;
    device.controlMode = "programmatic";
    device.position.set(center.x, center.y, center.z + 3);
    device.quaternion.set(0, 0, 0, 1);
  });
  await page.clock.runFor(50);

  await setClock(page, 0, true);
  await page.clock.runFor(50);
  const sphereBefore = await page.evaluate(() => (window as ProbeWindow).__bubbleProbe!.model.getObjectByName("RecordedBubbleSphere")!.position.toArray());
  const before = await page.evaluate(() => (window as ProbeWindow).__bubbleProbe!.model.getObjectByName("RecordedAvatar")!.position.x);
  await page.clock.runFor(400);
  const after = await page.evaluate(() => (window as ProbeWindow).__bubbleProbe!.model.getObjectByName("RecordedAvatar")!.position.x);
  expect.soft(Math.abs(after - before), "recorded animation advances in the actual immersive session").toBeGreaterThan(0.03);

  const sphereAfter = await page.evaluate(() => (window as ProbeWindow).__bubbleProbe!.model.getObjectByName("RecordedBubbleSphere")!.position.toArray());
  expect(sphereAfter, "AR sphere remains pinned while recording plays").toEqual(sphereBefore);

  const evidence = await page.evaluate(async () => {
    const moduleUrl = "/node_modules/.vite/deps/three.js";
    const { WebGLRenderTarget, Vector3, Quaternion, Color, MeshBasicMaterial } = await import(moduleUrl) as typeof Three;
    const { renderer, scene, model, bubble } = (window as ProbeWindow).__bubbleProbe!;
    const root = model.parent!;
    const shell = model.getObjectByName("RecordedBubbleSphere") as Mesh;
    const inside = model.getObjectByName("RecordedAvatar") as Mesh;
    const outside = model.getObjectByName("OutsideMarker") as Mesh;
    const aura = root.getObjectByName("ARBubbleAura")!;
    const xrCamera = renderer.xr.getCamera();
    const eyes = xrCamera.cameras.map((camera) => camera.clone());
    const eyePositions = eyes.map((eye) => eye.position.toArray());
    const visibility = new Map<Object3D, boolean>();
    scene.traverse((node) => { visibility.set(node, node.visible); });
    const previousTarget = renderer.getRenderTarget();
    const previousClear = renderer.getClearColor(new Color());
    const previousAlpha = renderer.getClearAlpha();
    const previousBackground = scene.background;
    const rootPosition = root.position.clone();
    const rootQuaternion = root.quaternion.clone();
    const markerPosition = outside.position.clone();
    const target = new WebGLRenderTarget(256, 256);
    function pixels(camera: typeof eyes[number]): Uint8Array {
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, camera);
      const rgba = new Uint8Array(256 * 256 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 256, 256, rgba);
      return rgba;
    }
    function png(rgba: Uint8Array): string {
      const canvas = document.createElement("canvas");
      canvas.width = 256; canvas.height = 256;
      const ctx = canvas.getContext("2d")!;
      const flipped = new Uint8ClampedArray(rgba.length);
      for (let row = 0; row < 256; row++) flipped.set(rgba.subarray(row * 1024, (row + 1) * 1024), (255 - row) * 1024);
      // Composite over dark background so translucent glass remains visible.
      ctx.putImageData(new ImageData(flipped, 256, 256), 0, 0);
      ctx.globalCompositeOperation = "destination-over"; ctx.fillStyle = "#101820"; ctx.fillRect(0, 0, 256, 256);
      const presentation = document.createElement("canvas");
      presentation.width = Math.round(256 * eyes[0]!.projectionMatrix.elements[5]! / eyes[0]!.projectionMatrix.elements[0]!);
      presentation.height = 256;
      presentation.getContext("2d")!.drawImage(canvas, 0, 0, presentation.width, presentation.height);
      return presentation.toDataURL("image/png").split(",")[1]!;
    }
    function redCount(rgba: Uint8Array): number {
      let count = 0;
      for (let i = 0; i < rgba.length; i += 4) if (rgba[i]! > 100 && rgba[i + 1]! < 30 && rgba[i + 2]! < 30) count++;
      return count;
    }
    function litCount(rgba: Uint8Array): number {
      let count = 0;
      for (let i = 0; i < rgba.length; i += 4) if (rgba[i]! + rgba[i + 1]! + rgba[i + 2]! > 12) count++;
      return count;
    }
    try {
      // Use the cameras actually supplied by the active XR session. Render to
      // an inspectable target without changing the session's framebuffer.
      renderer.xr.enabled = false;
      renderer.setClearColor(0, 0);
      scene.background = null;
      // The halo is chrome, not recorded geometry: its embers and sparks
      // (points, not meshes) would count as geometry outside the bubble.
      scene.traverse((node) => { if (node.userData.holoimChrome === true) node.visible = false; });
      scene.traverse((node) => {
        if (!(node as Mesh).isMesh) return;
        let ancestor: Object3D | null = node;
        while (ancestor && ancestor !== root) ancestor = ancestor.parent;
        if (!ancestor) node.visible = false;
      });
      shell.visible = false;
      aura.visible = false;
      inside.visible = false;
      outside.visible = true;
      const outsideMaterial = outside.material;
      const unpatched = new MeshBasicMaterial({ color: "red" });
      outside.material = unpatched;
      const outsidePositiveControl = eyes.map((eye) => redCount(pixels(eye)));
      outside.material = outsideMaterial;
      unpatched.dispose();
      const clipped = eyes.map((eye) => redCount(pixels(eye)));
      outside.position.copy(inside.position);
      const visible = eyes.map((eye) => redCount(pixels(eye)));
      outside.visible = false;
      shell.visible = true;
      const shells = eyes.map((eye) => pixels(eye));
      const shellPixels = shells.map(litCount);
      // Rotate the entire view and model together: the relative view remains
      // identical, so the Fresnel rim must remain identical too. Comparing a
      // world-space view direction against view-space normals fails this.
      const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.9);
      root.position.applyQuaternion(rotation);
      root.quaternion.premultiply(rotation);
      root.updateMatrixWorld(true);
      const rotated = eyes.map((eye) => {
        eye.position.applyQuaternion(rotation);
        eye.quaternion.premultiply(rotation);
        eye.updateMatrixWorld(true);
        return pixels(eye);
      });
      const rotationError = shells.map((image, index) => image.reduce((sum, value, offset) => sum + Math.abs(value - rotated[index]![offset]!), 0) / image.length);
      const frames: string[] = [];
      for (let frame = 0; frame < 24; frame++) {
        const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), frame / 23 * 1.4);
        root.position.copy(rootPosition).applyQuaternion(turn);
        root.quaternion.copy(rootQuaternion).premultiply(turn);
        root.updateMatrixWorld(true);
        const eye = xrCamera.cameras[0]!.clone();
        eye.position.applyQuaternion(turn); eye.quaternion.premultiply(turn); eye.updateMatrixWorld(true);
        frames.push(png(pixels(eye)));
      }
      const auraScale = aura.getWorldScale(new Vector3()).toArray();
      const shellScale = shell.getWorldScale(new Vector3()).toArray();
      return { eyePositions, outsidePositiveControl, frames, eyeCount: eyes.length, clipped, visible, shellPixels, rotationError, bubbleRadius: bubble.radius, auraScale, shellScale, modelScale: root.scale.x };
    } finally {
      root.position.copy(rootPosition);
      root.quaternion.copy(rootQuaternion);
      outside.position.copy(markerPosition);
      visibility.forEach((visible, node) => { node.visible = visible; });
      scene.background = previousBackground;
      renderer.setClearColor(previousClear, previousAlpha);
      renderer.setRenderTarget(previousTarget);
      renderer.xr.enabled = true;
      target.dispose();
      scene.updateMatrixWorld(true);
    }
  });
  const artifactDir = resolve("../../output/bubble-rendering", process.env.BUBBLE_EVIDENCE_PHASE ?? "after");
  await mkdir(artifactDir, { recursive: true });
  const { frames, ...metrics } = evidence;
  for (let index = 0; index < frames.length; index++) await writeFile(resolve(artifactDir, `frame-${String(index).padStart(3, "0")}.png`), Buffer.from(frames[index]!, "base64"));
  await writeFile(resolve(artifactDir, "metrics.json"), JSON.stringify({ ...metrics, animationPositions: [before, after] }, null, 2));
  expect.soft(evidence.eyeCount, "active immersive AR has two independently rendered eyes").toBe(2);
  expect.soft(evidence.modelScale, "exercise a non-unit model transform (the viewer's rescale)").not.toBeCloseTo(1);
  for (let eye = 0; eye < evidence.eyeCount; eye++) {
    expect.soft(evidence.outsidePositiveControl[eye], `outside marker is on screen before clipping in eye ${eye}`).toBeGreaterThan(20);
    expect.soft(evidence.clipped[eye], `outside geometry is absent in eye ${eye}`).toBe(0);
    expect.soft(evidence.visible[eye], `same geometry is visible inside sphere in eye ${eye}`).toBeGreaterThan(50);
    expect.soft(evidence.shellPixels[eye], `glass bubble contributes visible pixels in eye ${eye}`).toBeGreaterThan(100);
    expect.soft(evidence.rotationError[eye], `bubble rim remains correct when view rotates in eye ${eye}`).toBeLessThan(0.2);
  }
  evidence.auraScale.forEach((scale) => expect.soft(scale, "aura and clipping sphere share the same world-space radius").toBeCloseTo(evidence.bubbleRadius, 4));
  const headSamples = [];
  for (let frame = 0; frame < 24; frame++) {
    const requested = await page.evaluate(async (frame) => {
      const moduleUrl = "/node_modules/.vite/deps/three.js";
      const { Vector3, Matrix4, Quaternion } = await import(moduleUrl) as typeof Three;
      const probe = (window as ProbeWindow).__bubbleProbe!;
      const center = probe.model.getObjectByName("RecordedBubbleSphere")!.getWorldPosition(new Vector3());
      const yaw = -0.65 + frame / 23 * 1.3;
      const pitch = Math.sin(frame / 23 * Math.PI * 2) * 0.12;
      const position = center.clone().add(new Vector3(Math.sin(yaw) * 3, Math.sin(pitch) * 3, Math.cos(yaw) * 3));
      const orientation = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(position, center, new Vector3(0, 1, 0)));
      const device = (window as unknown as { IWER_DEVICE: { controlMode: string; position: { set: (...v: number[]) => void }; quaternion: { set: (...v: number[]) => void } } }).IWER_DEVICE;
      device.controlMode = "programmatic";
      device.position.set(...position.toArray()); device.quaternion.set(...orientation.toArray());
      // Hold the clip clock at an exact time; browser RAF phase must not
      // change the avatar pose between the before and after recordings.
      (window as ViewerProbeWindow).__HOLOIM_XR_VIEWER__!.setClock(frame / 24, false);
      return { position: position.toArray(), quaternion: orientation.toArray(), yaw, pitch };
    }, frame);
    await page.clock.runFor(50);
    const observed = await page.evaluate(() => (window as ProbeWindow).__bubbleProbe!.renderer.xr.getCamera().cameras.map((eye) => ({ position: eye.position.toArray(), quaternion: eye.quaternion.toArray() })));
    const eyeMidpoint = observed[0]!.position.map((value, i) => (value + observed[1]!.position[i]!) / 2);
    eyeMidpoint.forEach((value, i) => expect(value, "actual IWER eye midpoint follows requested head position").toBeCloseTo(requested.position[i]!, 4));
    expect(observed[0]!.position, "IWER delivers distinct stereo eye poses").not.toEqual(observed[1]!.position);
    const sample = await captureBubblePixels(page, "ar", artifactDir, `head-${String(frame).padStart(3, "0")}`, true);
    headSamples.push({ requested, observed, ...sample });
  }
  await writeFile(resolve(artifactDir, "head-motion.json"), JSON.stringify(headSamples, null, 2));
  await testInfo.attach("stereo-bubble-render.json", { body: JSON.stringify({ ...metrics, animationPositions: [before, after] }, null, 2), contentType: "application/json" });
  await page.clock.runFor(50);
  await page.screenshot({ path: testInfo.outputPath("immersive-ar-bubble.png") });
  await testInfo.attach("immersive-ar-bubble", { path: testInfo.outputPath("immersive-ar-bubble.png"), contentType: "image/png" });
});

test("grouped materials survive setup, reconfiguration and repeated unmount", async ({ page }, testInfo) => {
  await page.goto("/e2e/bubble-harness.html");
  await page.waitForFunction(() => (window as unknown as { __bubbleLifecycle?: { mounts: number } }).__bubbleLifecycle?.mounts === 3);
  const read = () => page.evaluate(() => {
    const state = (window as unknown as { __bubbleLifecycle: {
      grouped: Mesh; originals: Three.Material[]; mounts: number; disposals: number; result: { active: boolean };
    } }).__bubbleLifecycle;
    const materials = state.grouped.material;
    return { array: Array.isArray(materials), count: Array.isArray(materials) ? materials.length : 1,
      originals: materials === state.originals, colors: (Array.isArray(materials) ? materials : [materials]).map((mat) => (mat as Three.MeshBasicMaterial).color.getHexString()),
      mounts: state.mounts, disposals: state.disposals, active: state.result.active };
  });
  expect(await read()).toMatchObject({ array: true, count: 2, colors: ["ff0000", "00ff00"], originals: false, active: true });
  await page.screenshot({ path: testInfo.outputPath("grouped-materials.png") });
  await page.evaluate(() => (window as unknown as { __bubbleFalloff: (value: number) => void }).__bubbleFalloff(0.4));
  await expect.poll(async () => (await read()).disposals).toBe(3);
  expect(await read()).toMatchObject({ array: true, count: 2, mounts: 6, active: true });
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.evaluate(() => (window as unknown as { __bubbleMount: (value: boolean) => void }).__bubbleMount(false));
    await expect.poll(async () => (await read()).disposals).toBe(6 + cycle * 3);
    expect(await read()).toMatchObject({ originals: true, active: false });
    await page.evaluate(() => (window as unknown as { __bubbleMount: (value: boolean) => void }).__bubbleMount(true));
    await expect.poll(async () => (await read()).mounts).toBe(9 + cycle * 3);
  }
  const lifecycleDir = resolve("../../output/bubble-rendering/after");
  await mkdir(lifecycleDir, { recursive: true });
  await writeFile(resolve(lifecycleDir, "material-lifecycle.json"), JSON.stringify(await read(), null, 2));
});

test("clipping uses deformed vertices and the latest sphere transform at draw time", async ({ page }, testInfo) => {
  await page.goto("/e2e/bubble-harness.html");
  await page.waitForFunction(() => Boolean((window as unknown as { __bubbleLifecycle?: { renderer: unknown } }).__bubbleLifecycle?.renderer));
  await freezePageClock(page);
  const evidence = await page.evaluate(async () => {
    const moduleUrl = "/node_modules/.vite/deps/three.js";
    const { WebGLRenderTarget, Vector3 } = await import(moduleUrl) as typeof Three;
    const state = (window as unknown as { __bubbleLifecycle: {
      renderer: Three.WebGLRenderer; renderScene: Three.Scene; camera: Three.Camera;
      shell: Mesh; grouped: Mesh; scene: Object3D; result: { center: Three.Vector3 };
    } }).__bubbleLifecycle;
    const { renderer, renderScene, camera, shell, grouped, scene } = state;
    const target = new WebGLRenderTarget(320, 240);
    const oldTarget = renderer.getRenderTarget();
    function pixels() {
      renderer.setRenderTarget(target); renderer.clear(); renderer.render(renderScene, camera);
      const bytes = new Uint8Array(320 * 240 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 320, 240, bytes);
      let colored = 0;
      for (let i = 0; i < bytes.length; i += 4) if (Math.max(bytes[i]!, bytes[i + 1]!) > 100 && bytes[i + 2]! < 40) colored++;
      return colored;
    }
    try {
      shell.visible = false;
      grouped.morphTargetInfluences![0] = 0;
      const inside = pixels();
      grouped.morphTargetInfluences![0] = 1;
      const deformedOutside = pixels();
      // Change transforms synchronously with no frame callback between the
      // mutation and draw. The old frame-only hook clips at the old center.
      shell.position.x = 3;
      scene.position.y = 0.4;
      const followsAtDraw = pixels();
      return { inside, deformedOutside, followsAtDraw, center: state.result.center.toArray(), shell: shell.getWorldPosition(new Vector3()).toArray() };
    } finally {
      renderer.setRenderTarget(oldTarget); target.dispose();
    }
  });
  await writeFile(testInfo.outputPath("deformation-draw-sync.json"), JSON.stringify(evidence, null, 2));
  expect(evidence.inside).toBeGreaterThan(100);
  expect(evidence.deformedOutside).toBe(0);
  expect(evidence.followsAtDraw).toBeGreaterThan(100);
  expect(evidence.center).toEqual(evidence.shell);
});

// Styleguide 3.4, 9.2: in WebXR AR the halo is the same cloche as on a flat
// screen, over the placed hologram, in the room. Seen from in front and from
// behind, it stays where the hologram is.
test("the cloche stands over the placed hologram, in the room, from either side", async ({ page }) => {
  test.setTimeout(90000);
  const hologram = { id: "bubble-render", url: "/uploads/bubble-render.glb", usdzUrl: null, quickLookEnabled: false, createdAt: "2026-10-18T00:00:00Z", sizeBytes: 4096, filenameOriginal: "bubble-render.glb", hologramName: "Bubble rendering diagnostic", submittedBy: "automation" };
  await page.setViewportSize({ width: 640, height: 480 });
  await page.addInitScript(() => {
    (window as ProbeWindow).__HOLOIM_AR_TEST_OBSERVER__ = (value) => { (window as ProbeWindow).__bubbleProbe = value; };
  });
  await page.route("**/api/holograms?*", (route) => route.fulfill({ json: { items: [hologram], nextCursor: null } }));
  await page.route("**/api/holograms/bubble-render", (route) => route.fulfill({ json: hologram }));
  await page.route("**/uploads/bubble-render.glb", (route) => route.fulfill({ body: diagnosticGltf(), contentType: "model/gltf-binary" }));
  await observeFeedCardRenderer(page);
  await page.goto("/");
  await waitForFeedCardPresented(page);
  await enterArFromFeed(page);
  const shots = resolve("../../output/redesign-slice-3");
  await mkdir(shots, { recursive: true });

  const placed: number[][] = [];
  for (const side of [{ name: "front", z: 1 }, { name: "back", z: -1 }]) {
    await page.evaluate(async (z) => {
      const { Vector3 } = await import("/node_modules/.vite/deps/three.js") as typeof Three;
      const probe = (window as ProbeWindow).__bubbleProbe!;
      const center = new Vector3(probe.bubble.center.x, probe.bubble.center.y, probe.bubble.center.z);
      const device = (window as unknown as { IWER_DEVICE: { controlMode: string; position: { set: (...v: number[]) => void }; quaternion: { set: (...v: number[]) => void } } }).IWER_DEVICE;
      device.controlMode = "programmatic";
      // Back far enough to see the whole 4 m bubble, at eye height, facing it.
      device.position.set(center.x, 1.6, center.z + z * (probe.bubble.radius * 2.6));
      device.quaternion.set(0, z > 0 ? 0 : 1, 0, z > 0 ? 1 : 0);
    }, side.z);
    // Drawn from the new pose.
    await waitForXrFrames(page, 3);
    const cloche = await page.evaluate(async (exponent) => {
      const { Vector3 } = await import("/node_modules/.vite/deps/three.js") as typeof Three;
      const { renderer, scene, bubble } = (window as ProbeWindow).__bubbleProbe!;
      const group = scene.getObjectByName("cloche");
      if (!group) return null;
      group.updateWorldMatrix(true, true);
      const shell = group.getObjectByName("cloche-shell") as Mesh<Three.BufferGeometry, Three.ShaderMaterial>;
      const uniforms = shell.material.uniforms;
      let unflagged = 0;
      let headLocked = false;
      let drawn = true;
      group.traverse((object) => { if (object.userData.holoimChrome !== true) unflagged += 1; });
      for (let at: Object3D | null = group; at; at = at.parent) {
        if ((at as Three.Camera).isCamera) headLocked = true;
        if (!at.visible) drawn = false;
      }
      shell.geometry.computeBoundingBox();
      const radii = shell.geometry.boundingBox!.max.clone();
      const box = shell.geometry.boundingBox!.clone().applyMatrix4(shell.matrixWorld);
      // Where the recorded author is, in the dome's own space: inside means |x/rx|^n + |y/ry|^n + |z/rz|^n < 1.
      const author = (window as ProbeWindow).__bubbleProbe!.model.getObjectByName("RecordedAvatar")!;
      const local = shell.worldToLocal(author.getWorldPosition(new Vector3()));
      const authorValue = Math.abs(local.x / radii.x) ** exponent + Math.abs(local.y / radii.y) ** exponent + Math.abs(local.z / radii.z) ** exponent;
      return {
        drawn,
        eye: renderer.xr.getCamera().getWorldPosition(new Vector3()).toArray(),
        center: [bubble.center.x, bubble.center.y, bubble.center.z],
        radius: bubble.radius,
        position: group.getWorldPosition(new Vector3()).toArray(),
        width: box.max.x - box.min.x,
        authorValue,
        height: box.max.y - box.min.y,
        opacity: uniforms.uOpacity!.value as number,
        core: uniforms.uLine!.value as number,
        char: uniforms.uCharShare!.value as number,
        unflagged, headLocked,
        glass: (window as ProbeWindow).__bubbleProbe!.model.getObjectByName("RecordedBubbleSphere")?.visible ?? false,
        aura: scene.getObjectByName("ARBubbleAura")?.visible ?? false,
        auraTori: (() => {
          let tori = 0;
          scene.getObjectByName("ARBubbleAura")?.traverse((object) => { if ((object as Mesh).geometry?.type === "TorusGeometry") tori += 1; });
          return tori;
        })()
      };
    }, tokens.edge.cloche.exponent);
    expect(cloche, "the AR route draws the cloche").not.toBeNull();
    expect(cloche!.drawn, `${side.name}: the cloche is drawn`).toBe(true);
    expect(cloche!.headLocked, "the cloche is in the room, not on the head").toBe(false);
    expect(cloche!.unflagged, "every part of the cloche is chrome").toBe(0);
    // The dome is fitted to what the bubble draws, so it centres on the content, not on the bubble's middle.
    const [cx, , cz] = cloche!.center;
    expect(cloche!.authorValue, `${side.name}: the recorded author is under the cloche`).toBeLessThan(1);
    expect(Math.hypot(cloche!.position[0]! - cx!, cloche!.position[2]! - cz!), `${side.name}: the cloche stands within the bubble`).toBeLessThan(cloche!.radius);
    expect(cloche!.height, "the cloche has volume").toBeGreaterThan(0);
    placed.push(cloche!.position);
    expect(cloche!.opacity, "from outside the cloche is fully drawn").toBeGreaterThan(0.99);
    // A Quest has no lighting estimate: the char beside the gold is at full strength (3.2, 3.4).
    expect(cloche!.char).toBeCloseTo(clocheCharShare({ sootOpacity: tokens.edge.soot.arNoEstimateOpacity }), 5);
    expect(cloche!.core).toBe(1);
    expect(cloche!.glass, "the cloche is the bubble's look: the old glass sphere is not drawn").toBe(false);
    expect(cloche!.aura, "the bubble's aura stays").toBe(true);
    expect(cloche!.auraTori, "the aura's cyan equator ring is gone: the gold cloche alone outlines the bubble").toBe(0);
    await page.screenshot({ path: resolve(shots, `ar-cloche-${side.name}.png`) });
  }
  expect(placed[1], "the cloche did not move as the viewer walked round it").toEqual(placed[0]);
});
