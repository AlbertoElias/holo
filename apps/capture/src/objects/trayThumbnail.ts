import { tokens } from '@holoim/design-tokens';
import * as THREE from 'three';

/** Thumbnail edge in pixels: 2× the flat tray slot's 54 apx, rounded up. */
export const TRAY_THUMBNAIL_PX = 128;

export interface TrayThumbnail {
  /** A PNG data URL for the flat dock row. */
  url: string;
  /** The same pixels, for a UIKit texture in a headset or phone AR. */
  canvas: HTMLCanvasElement;
}

/**
 * Renders a tray item once, when it loads, into a small thumbnail: the item
 * fitted to a square, lit flat, on a clear background. The same render
 * uploads the item's textures and compiles its shaders, so the first draw of
 * a miniature or a summoned copy mid-take does not stall the take.
 */
export class TrayThumbnailer {
  private readonly target = new THREE.WebGLRenderTarget(TRAY_THUMBNAIL_PX, TRAY_THUMBNAIL_PX, { colorSpace: THREE.SRGBColorSpace });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
  private readonly pixels = new Uint8Array(TRAY_THUMBNAIL_PX * TRAY_THUMBNAIL_PX * 4);
  private readonly box = new THREE.Box3();
  private readonly size = new THREE.Vector3();
  private readonly center = new THREE.Vector3();

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    // Lit like the blue hour: warm from above, the ground's teal from below.
    this.scene.add(new THREE.HemisphereLight(tokens.color.text, tokens.color.ground.mid, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, 2, 3);
    this.scene.add(key);
  }

  /**
   * `liveScene`: the scene the item will be drawn in. Its shaders depend on that
   * scene's lights, so they are compiled against it as well. Each costly step
   * (compiles, each texture's upload, the draw that uploads the geometry, the
   * read back) runs in its own task, so a load mid-take never holds one frame
   * for all of them.
   */
  async render(model: THREE.Object3D, liveScene?: THREE.Scene): Promise<TrayThumbnail | null> {
    const { renderer, scene, camera, target } = this;
    const proxy = model.clone();
    proxy.visible = true;
    proxy.position.set(0, 0, 0);
    proxy.quaternion.identity();
    proxy.scale.setScalar(1);
    proxy.updateMatrixWorld(true);
    this.box.setFromObject(proxy);
    if (this.box.isEmpty()) return null;
    this.box.getSize(this.size);
    this.box.getCenter(this.center);
    proxy.position.sub(this.center);
    const radius = Math.max(this.size.length() / 2, 1e-3);
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));
    camera.position.set(0.55, 0.45, 0.7).normalize().multiplyScalar(distance);
    camera.near = distance / 100;
    camera.far = distance * 4;
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    scene.add(proxy);
    try {
      // Against the live scene's lights, as a summoned copy will be drawn. The
      // proxy stands in for the model: compiles skip hidden objects, and a tray
      // item stays hidden until its first summon.
      if (liveScene) await renderer.compileAsync(proxy, camera, liveScene);
      // Drawn into a render target, the proxy uses other programs than on screen.
      await this.withTarget(() => renderer.compileAsync(proxy, camera, scene));
      trayMark('compiled');
      for (const texture of texturesOf(proxy)) {
        await nextTask();
        renderer.initTexture(texture);
        trayMark('texture');
      }
      await nextTask();
      this.drawOnce();
      trayMark('drawn');
      await renderer.readRenderTargetPixelsAsync(target, 0, 0, TRAY_THUMBNAIL_PX, TRAY_THUMBNAIL_PX, this.pixels);
      trayMark('read');
    } finally {
      scene.remove(proxy);
    }
    const thumbnail = this.toCanvas();
    trayMark('thumbnail');
    return thumbnail;
  }

  dispose(): void {
    this.target.dispose();
  }

  private drawOnce(): void {
    const { renderer, scene, camera } = this;
    const previousClear = renderer.getClearAlpha();
    this.withTarget(() => {
      renderer.setClearAlpha(0);
      renderer.clear();
      renderer.render(scene, camera);
    });
    renderer.setClearAlpha(previousClear);
  }

  /**
   * Runs `work` with the thumbnail target bound and the immersive session's
   * layers set aside (a thumbnail drawn through them would be blank). The
   * programs a compile picks depend on that target, so compiles go through here
   * too; their GPU work continues after the target is restored.
   */
  private withTarget<T>(work: () => T): T {
    const { renderer, target } = this;
    const xrEnabled = renderer.xr.enabled;
    const previousTarget = renderer.getRenderTarget();
    renderer.xr.enabled = false;
    try {
      renderer.setRenderTarget(target);
      return work();
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.xr.enabled = xrEnabled;
    }
  }

  private toCanvas(): TrayThumbnail {
    const canvas = document.createElement('canvas');
    canvas.width = TRAY_THUMBNAIL_PX;
    canvas.height = TRAY_THUMBNAIL_PX;
    const context = canvas.getContext('2d')!;
    const image = context.createImageData(TRAY_THUMBNAIL_PX, TRAY_THUMBNAIL_PX);
    // Render targets read bottom row first; the canvas is top row first.
    const row = TRAY_THUMBNAIL_PX * 4;
    for (let y = 0; y < TRAY_THUMBNAIL_PX; y++) {
      image.data.set(this.pixels.subarray((TRAY_THUMBNAIL_PX - 1 - y) * row, (TRAY_THUMBNAIL_PX - y) * row), y * row);
    }
    context.putImageData(image, 0, 0);
    return { url: canvas.toDataURL('image/png'), canvas };
  }
}

/**
 * A User Timing mark at the end of a step of a tray load (`tray:<step>`), so a
 * long task during a load can be traced to the step it overlaps.
 */
export const trayMark = (step: string): void => {
  performance.mark(`tray:${step}`);
};

/** Yields to the frame loop: the next step of a load runs in a task of its own. */
export const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Every texture the model's materials sample, once each. */
function texturesOf(model: THREE.Object3D): THREE.Texture[] {
  const out = new Set<THREE.Texture>();
  model.traverse((node) => {
    const material = (node as THREE.Mesh).material;
    if (!material) return;
    for (const entry of Array.isArray(material) ? material : [material]) {
      for (const value of Object.values(entry)) if ((value as THREE.Texture | null)?.isTexture) out.add(value as THREE.Texture);
    }
  });
  return [...out];
}
