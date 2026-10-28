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
    this.scene.add(new THREE.HemisphereLight(0xfff6ea, 0x17424a, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, 2, 3);
    this.scene.add(key);
  }

  /**
   * `liveScene`: the scene the item will be drawn in. Its shaders depend on that
   * scene's lights, so they are compiled against it as well.
   */
  async render(model: THREE.Object3D, liveScene?: THREE.Scene): Promise<TrayThumbnail | null> {
    const { renderer } = this;
    if (liveScene) await renderer.compileAsync(model, this.camera, liveScene);
    // An immersive session draws to its own layers; a thumbnail made there would be blank.
    if (renderer.xr.isPresenting) return this.renderOutsideXr(model);
    return this.draw(model);
  }

  dispose(): void {
    this.target.dispose();
  }

  private async renderOutsideXr(model: THREE.Object3D): Promise<TrayThumbnail | null> {
    const xr = this.renderer.xr;
    xr.enabled = false;
    try {
      return await this.draw(model);
    } finally {
      xr.enabled = true;
    }
  }

  private async draw(model: THREE.Object3D): Promise<TrayThumbnail | null> {
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
    camera.position.set(distance * 0.55, distance * 0.45, distance * 0.7).normalize().multiplyScalar(distance);
    camera.near = distance / 100;
    camera.far = distance * 4;
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    scene.add(proxy);
    try {
      await renderer.compileAsync(proxy, camera, scene);
      const previousTarget = renderer.getRenderTarget();
      const previousClear = renderer.getClearAlpha();
      renderer.setRenderTarget(target);
      renderer.setClearAlpha(0);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, TRAY_THUMBNAIL_PX, TRAY_THUMBNAIL_PX, this.pixels);
      renderer.setRenderTarget(previousTarget);
      renderer.setClearAlpha(previousClear);
    } finally {
      scene.remove(proxy);
    }
    return this.toCanvas();
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
