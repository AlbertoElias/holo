import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BoxGeometry, SphereGeometry, type BufferGeometry } from "three";
import type * as Three from "three";
import type { Mesh, Object3D } from "three";
import { freezePageClock, waitForIwerSession } from "@holoim/tooling-testing/xr-env";

import { captureBubblePixels } from "./bubble-pixel-proof";

import { expect, test } from "./bootstrap";

// A deliberately oversized red object sits outside the recorded sphere. The
// animated green object is inside it. Unlit colors make the pixel oracle
// independent of lighting, textures, driver-specific PBR, or room geometry.
function diagnosticGltf(): Buffer {
  const buffers: Buffer[] = [];
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  let byteLength = 0;
  function attribute(values: Float32Array | Uint16Array | Uint32Array, size: number): number {
    const source = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
    const padded = Buffer.alloc(Math.ceil(source.length / 4) * 4);
    source.copy(padded);
    buffers.push(padded);
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: source.length });
    byteLength += padded.length;
    const rows = Array.from({ length: values.length / size }, (_, index) => Array.from(values.slice(index * size, (index + 1) * size)));
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: values instanceof Float32Array ? 5126 : values instanceof Uint32Array ? 5125 : 5123,
      count: rows.length,
      type: size === 1 ? "SCALAR" : `VEC${size}`,
      min: Array.from({ length: size }, (_, index) => Math.min(...rows.map((row) => row[index]!))),
      max: Array.from({ length: size }, (_, index) => Math.max(...rows.map((row) => row[index]!)))
    });
    return accessors.length - 1;
  }
  function primitive(geometry: BufferGeometry, material: number) {
    return { attributes: { POSITION: attribute(geometry.getAttribute("position").array as Float32Array, 3), NORMAL: attribute(geometry.getAttribute("normal").array as Float32Array, 3) }, indices: attribute(geometry.index!.array as Uint16Array, 1), material };
  }
  const meshes = [
    { primitives: [primitive(new SphereGeometry(2, 32, 24), 0)] },
    { primitives: [primitive(new BoxGeometry(0.5, 0.5, 0.5), 1)] },
    { primitives: [primitive(new BoxGeometry(0.6, 0.6, 0.6), 2)] }
  ];
  const input = attribute(new Float32Array([0, 1, 2]), 1);
  const output = attribute(new Float32Array([-0.4, 2, 0, 0.4, 2, 0, -0.4, 2, 0]), 3);
  const json = JSON.stringify({
    asset: { version: "2.0" }, extensionsUsed: ["KHR_materials_unlit"], scene: 0,
    scenes: [{ nodes: [0, 1, 2] }],
    nodes: [{ name: "RecordedBubbleSphere", mesh: 0, translation: [0, 2, 0] }, { name: "RecordedAvatar", mesh: 1, translation: [0, 2, 0] }, { name: "OutsideMarker", mesh: 2, translation: [2.7, 2, 0] }],
    meshes,
    materials: [[0.1, 0.4, 0.8, 0.2], [0, 1, 0, 1], [1, 0, 0, 1]].map((color) => ({ pbrMetallicRoughness: { baseColorFactor: color }, extensions: { KHR_materials_unlit: {} }, alphaMode: color[3]! < 1 ? "BLEND" : "OPAQUE" })),
    animations: [{ name: "RecordedMotion", samplers: [{ input, output }], channels: [{ sampler: 0, target: { node: 1, path: "translation" } }, { sampler: 0, target: { node: 0, path: "translation" } }] }],
    accessors, bufferViews, buffers: [{ byteLength, uri: `data:application/octet-stream;base64,${Buffer.concat(buffers).toString("base64")}` }]
  });
  const padded = Buffer.from(json + " ".repeat((4 - Buffer.byteLength(json) % 4) % 4));
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + padded.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, padded]);
}

import type { Probe } from "./ar-bubble-types";
type ProbeWindow = Window & { __HOLOIM_AR_TEST_OBSERVER__?: (value: Probe) => void; __bubbleProbe?: Probe };

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
  await page.goto("/");
  await page.locator(".ar-trigger-button").first().click();
  await waitForIwerSession(page, { environmentBlendMode: "alpha-blend" });
  await page.waitForFunction(() => Boolean((window as ProbeWindow).__bubbleProbe?.bubble.active));
  await page.evaluate(() => {
    const device = (window as unknown as { IWER_DEVICE: { stereoEnabled: boolean; ipd: number } }).IWER_DEVICE;
    device.stereoEnabled = true; device.ipd = 0.064;
  });
  await expect.poll(() => page.locator(".ar-view-container").getAttribute("data-placement-stage")).toMatch(/placed|anchored|locked/);
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

  await page.evaluate(() => { Object.values((window as ProbeWindow).__bubbleProbe!.actions).forEach((action) => { action.time = 0; }); });
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
  expect.soft(evidence.modelScale, "exercise a non-unit model transform").not.toBeCloseTo(1);
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
      Object.values(probe.actions).forEach((action) => { action.time = frame / 24; });
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
