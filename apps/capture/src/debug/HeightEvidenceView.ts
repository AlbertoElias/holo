import * as THREE from 'three';
import type { AvatarRig } from '../avatar/AvatarRig';

/** Explicit diagnostic render of the live avatar; never changes simulation. */
export class HeightEvidenceView {
  private readonly camera = new THREE.OrthographicCamera(-1.35, 1.35, 1.55, -1.3, 0.01, 20);
  private readonly overlay = new THREE.Group();
  private readonly eye = new THREE.Vector3();

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, world: THREE.Group, rig: AvatarRig, tracked: THREE.Vector3, hud: THREE.Object3D | undefined): void {
    const floorY = rig.avatarRoot.position.y + rig.avatarMinLocalY;
    const x = rig.avatarRoot.position.x;
    const z = rig.avatarRoot.position.z;
    rig.getEyeAnchorWorldPosition(this.eye, 0);
    const hidden = world.children.filter((object) => object !== rig.avatarRoot).map((object) => ({ object, visible: object.visible }));
    const background = scene.background;
    const xrEnabled = renderer.xr.enabled;
    const target = renderer.getRenderTarget();
    const viewport = renderer.getViewport(new THREE.Vector4());
    const scissor = renderer.getScissor(new THREE.Vector4());
    const scissorTest = renderer.getScissorTest();
    const hudVisible = hud?.visible;
    rig.setFirstPersonVisualState('off');
    hidden.forEach(({ object }) => { object.visible = false; });
    if (hud) hud.visible = false;
    scene.background = new THREE.Color('#182531');
    this.overlay.position.set(x, floorY, z);
    const grid = new THREE.GridHelper(3, 12, '#7594a5', '#344f60');
    this.overlay.add(grid);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.MeshBasicMaterial({ color: '#223541', side: THREE.DoubleSide }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.003;
    this.overlay.add(floor);
    const lineMaterial = new THREE.LineBasicMaterial({ color: '#9cb4c2', depthTest: false });
    const points = [new THREE.Vector3(-0.65, 0, -0.05), new THREE.Vector3(-0.65, 2.4, -0.05)];
    for (let height = 0; height <= 2.4; height += 0.1) {
      points.push(new THREE.Vector3(-0.69, height, -0.05), new THREE.Vector3(-0.65, height, -0.05));
    }
    this.overlay.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), lineMaterial));
    for (const height of [0, 0.5, 1, 1.5, 2]) this.label(`${height.toFixed(1)} m`, -0.96, height, '#b7ccd8', 1.4);
    this.label(`Fitted avatar · ${(tracked.y - floorY).toFixed(2)} m tracked eye`, 0, 2.48, '#ffffff', 2.3);
    this.label('Live avatar · fixed meter scale · IWER emulation', 0, 2.34, '#b7ccd8', 2.3);
    this.label('Floor / avatar base', 0.25, -0.13, '#b7ccd8', 1.35);
    const avatarEye = this.eye.clone().sub(new THREE.Vector3(x, floorY, z));
    const trackedEye = tracked.clone().sub(new THREE.Vector3(x, floorY, z));
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.034, 0.043, 32), new THREE.MeshBasicMaterial({ color: '#fbbf24', side: THREE.DoubleSide, depthTest: false }));
    ring.position.copy(avatarEye); ring.position.z -= 0.16; ring.renderOrder = 100;
    this.overlay.add(ring);
    const crossPoints = [new THREE.Vector3(-0.027, 0, 0), new THREE.Vector3(0.027, 0, 0), new THREE.Vector3(0, -0.027, 0), new THREE.Vector3(0, 0.027, 0)];
    const cross = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(crossPoints), new THREE.LineBasicMaterial({ color: '#22d3ee', depthTest: false }));
    cross.position.copy(trackedEye); cross.position.z -= 0.17; cross.renderOrder = 101;
    this.overlay.add(cross);
    this.label(`+ Tracked eye ${(tracked.y - floorY).toFixed(2)} m`, 0.72, trackedEye.y + 0.09, '#22d3ee', 1.1);
    this.label(`○ Avatar eye ${(this.eye.y - floorY).toFixed(2)} m`, 0.72, avatarEye.y - 0.06, '#fbbf24', 1.1);
    scene.add(this.overlay);
    this.camera.position.set(x, floorY + 1.65, z - 4);
    this.camera.lookAt(x, floorY + 1.05, z);
    try {
      renderer.xr.enabled = false;
      renderer.setRenderTarget(null);
      const size = renderer.getSize(new THREE.Vector2());
      renderer.setViewport(0, 0, size.x, size.y);
      renderer.setScissorTest(false);
      renderer.render(scene, this.camera);
    } finally {
      scene.remove(this.overlay);
      this.overlay.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
        if (object instanceof THREE.Sprite) { object.material.map?.dispose(); object.material.dispose(); }
      });
      this.overlay.clear();
      scene.background = background;
      hidden.forEach(({ object, visible }) => { object.visible = visible; });
      if (hud && hudVisible !== undefined) hud.visible = hudVisible;
      rig.setFirstPersonVisualState('vr');
      renderer.xr.enabled = xrEnabled;
      renderer.setRenderTarget(target);
      renderer.setViewport(viewport);
      renderer.setScissor(scissor);
      renderer.setScissorTest(scissorTest);
    }
  }

  private label(text: string, x: number, y: number, color: string, width: number): void {
    const canvas = document.createElement('canvas');
    canvas.width = 1024; canvas.height = 80;
    const context = canvas.getContext('2d')!;
    context.fillStyle = color; context.font = '36px sans-serif'; context.textAlign = 'center';
    context.fillText(text, 512, 52);
    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
    sprite.position.set(x, y, -0.25); sprite.scale.set(width, width * 80 / 1024, 1); sprite.renderOrder = 102;
    this.overlay.add(sprite);
  }
}
