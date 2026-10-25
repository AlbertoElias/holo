import { Color, Mesh, MeshBasicMaterial, RingGeometry, Vector3, type Object3D } from "three";

import { COLOR } from "./tokens.js";

// The focus ring (docs/features/viewer-xr-interface.md, step 4): a bare gold
// line on the ground around the focused hologram's base, the one that is
// heard and that the foot controls act on. Like the golden edge (§3.3) its
// width is a share of its size, the gold core's 1.4% of the short side (here
// the ring's diameter), with no glow (§6).

const CORE_SHARE = 0.014;
/** Just above the ground, so it never fights the floor's depth. */
const LIFT_M = 0.002;

export class FocusRing {
  readonly mesh: Mesh<RingGeometry, MeshBasicMaterial>;

  constructor(parent: Object3D) {
    // A unit ring whose width is a share of its diameter: scaling it keeps the share.
    const width = 2 * CORE_SHARE;
    this.mesh = new Mesh(new RingGeometry(1 - width, 1, 96), new MeshBasicMaterial({ color: new Color(COLOR.gold), toneMapped: false }));
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.name = "FocusRing";
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  /** Rings a hologram whose base is at `anchor`, `radiusM` out from it. */
  show(anchor: Vector3, radiusM: number): void {
    this.mesh.position.set(anchor.x, anchor.y + LIFT_M, anchor.z);
    this.mesh.scale.setScalar(radiusM);
    this.mesh.visible = true;
  }

  hide(): void {
    this.mesh.visible = false;
  }

  probe(): { visible: boolean; worldPosition: [number, number, number]; radiusM: number } {
    return { visible: this.mesh.visible, worldPosition: this.mesh.getWorldPosition(new Vector3()).toArray() as [number, number, number], radiusM: this.mesh.scale.x };
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
