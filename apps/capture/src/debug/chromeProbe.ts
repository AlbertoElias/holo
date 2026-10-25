import * as THREE from 'three';
import { markChromeTree } from '@holoim/xr-ui-core';

/**
 * A check's probe for the chrome flag (docs/features/ui-redesign.md, slice
 * 4): a visible box inside the scene model, beside the avatar, where the
 * scene sampler would take it into the exported bubble. Flagged as chrome
 * it must leave the export unchanged; plain, it must change it (the
 * control that shows the probe is in reach). `chrome` moves the live
 * headset chrome itself into the scene model, the worst place it could be.
 */
export class ChromeProbe {
  private mesh: THREE.Mesh | null = null;
  private moved: { chrome: THREE.Object3D; parent: THREE.Object3D | null } | null = null;

  set(mode: 'none' | 'flagged' | 'plain' | 'chrome', worldModel: THREE.Object3D | undefined, avatarRoot: THREE.Object3D, chrome: THREE.Object3D): void {
    if (this.moved) {
      if (this.moved.parent) this.moved.parent.add(this.moved.chrome);
      else this.moved.chrome.removeFromParent();
      this.moved = null;
    }
    this.mesh?.removeFromParent();
    this.mesh?.geometry.dispose();
    (this.mesh?.material as THREE.Material | undefined)?.dispose();
    this.mesh = null;
    if (mode === 'none' || !worldModel) return;
    if (mode === 'chrome') {
      this.moved = { chrome, parent: chrome.parent };
      worldModel.attach(chrome);
      worldModel.updateMatrixWorld(true);
      return;
    }
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), new THREE.MeshBasicMaterial());
    mesh.name = 'chrome-probe';
    worldModel.updateWorldMatrix(true, false);
    const at = avatarRoot.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0.8, 0.3, 0));
    mesh.position.copy(worldModel.worldToLocal(at));
    if (mode === 'flagged') markChromeTree(mesh);
    worldModel.add(mesh);
    worldModel.updateMatrixWorld(true);
    this.mesh = mesh;
  }
}
