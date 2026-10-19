import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import type * as Three from "three";
import type { Probe } from "./ar-bubble-types";
import { expect } from "./bootstrap";

export async function captureBubblePixels(page: Page, mode: "feed" | "ar", artifactDir: string, tag: string = mode, includeAura = false) {
  const evidence = await page.evaluate(async ({ mode, includeAura }) => {
    const moduleUrl = "/node_modules/.vite/deps/three.js";
    const { WebGLRenderTarget, Vector3, Color } = await import(moduleUrl) as typeof Three;
    const hooks = window as unknown as { __feedProbe: Probe; __bubbleProbe: Probe };
    const { renderer, scene, model, bubble, actions, camera } = mode === "feed" ? hooks.__feedProbe : hooks.__bubbleProbe;
    const cameras = mode === "feed" ? [camera!] : renderer.xr.getCamera().cameras.map((eye) => eye.clone());
    const shell = model.getObjectByName("RecordedBubbleSphere") as Three.Mesh;
    const visibility = new Map<Three.Object3D, boolean>();
    scene.traverse((node) => { visibility.set(node, node.visible); });
    const previousTarget = renderer.getRenderTarget();
    const previousClear = renderer.getClearColor(new Color());
    const previousAlpha = renderer.getClearAlpha();
    const previousBackground = scene.background;
    const previousXr = renderer.xr.enabled;
    const target = new WebGLRenderTarget(320, 240);
    function render(camera: Three.Camera) {
      renderer.setRenderTarget(target); renderer.clear(); renderer.render(scene, camera);
      const bytes = new Uint8Array(320 * 240 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 320, 240, bytes);
      let pixels = 0;
      for (let i = 0; i < bytes.length; i += 4) if (bytes[i + 3]! > 0 && bytes[i]! + bytes[i + 1]! + bytes[i + 2]! > 3) pixels++;
      return { pixels, bytes };
    }
    function png(bytes: Uint8Array, camera: Three.Camera) {
      const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 240;
      const ctx = canvas.getContext("2d")!;
      const flipped = new Uint8ClampedArray(bytes.length);
      for (let row = 0; row < 240; row++) flipped.set(bytes.subarray(row * 1280, (row + 1) * 1280), (239 - row) * 1280);
      ctx.putImageData(new ImageData(flipped, 320, 240), 0, 0);
      ctx.globalCompositeOperation = "destination-over"; ctx.fillStyle = "#101820"; ctx.fillRect(0, 0, 320, 240);
      const presentation = document.createElement("canvas");
      presentation.width = Math.round(240 * camera.projectionMatrix.elements[5]! / camera.projectionMatrix.elements[0]!);
      presentation.height = 240;
      presentation.getContext("2d")!.drawImage(canvas, 0, 0, presentation.width, presentation.height);
      return presentation.toDataURL("image/png").split(",")[1]!;
    }
    try {
      renderer.xr.enabled = false; renderer.setClearColor(0, 0); scene.background = null;
      scene.traverse((node) => {
        if (!(node as Three.Mesh).isMesh) return;
        let ancestor: Three.Object3D | null = node;
        while (ancestor && ancestor !== model) ancestor = ancestor.parent;
        if (!ancestor && !(includeAura && model.parent?.getObjectByName("ARBubbleAura")?.getObjectById(node.id))) node.visible = false;
      });
      const full = cameras.map(render);
      const aura = model.parent?.getObjectByName("ARBubbleAura");
      if (aura) aura.visible = false;
      shell.visible = false;
      const content = cameras.map(render);
      model.traverse((node) => { if ((node as Three.Mesh).isMesh) node.visible = node === shell; });
      const glass = cameras.map(render);
      return { eyeAspects: cameras.map((eye) => eye.projectionMatrix.elements[5]! / eye.projectionMatrix.elements[0]!), full: full.map((item) => item.pixels), content: content.map((item) => item.pixels), glass: glass.map((item) => item.pixels), images: full.map((item, index) => png(item.bytes, cameras[index]!)), sphere: shell.getWorldPosition(new Vector3()).toArray(), clipCenter: [bubble.center.x, bubble.center.y, bubble.center.z], time: Object.values(actions).map((action) => action.time) };
    } finally {
      visibility.forEach((visible, node) => { node.visible = visible; });
      renderer.setRenderTarget(previousTarget); renderer.setClearColor(previousClear, previousAlpha); scene.background = previousBackground; renderer.xr.enabled = previousXr; target.dispose();
    }
  }, { mode, includeAura });
  for (let eye = 0; eye < evidence.images.length; eye++) await writeFile(resolve(artifactDir, `${tag}-eye-${eye}.png`), Buffer.from(evidence.images[eye]!, "base64"));
  evidence.content.forEach((pixels) => expect(pixels, `${mode} captured content draws`).toBeGreaterThan(40));
  evidence.glass.forEach((pixels) => expect(pixels, `${mode} captured glass draws`).toBeGreaterThan(40));
  evidence.sphere.forEach((coordinate, i) => expect(coordinate, `${mode} clipping matches rendered shell`).toBeCloseTo(evidence.clipCenter[i]!, 5));
  const { images: _images, ...metrics } = evidence;
  return metrics;
}
