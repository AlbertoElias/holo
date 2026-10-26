import { AdditiveBlending, CircleGeometry, Group, MathUtils, Mesh, MeshBasicMaterial, RingGeometry, Vector3 } from "three";
import type { BufferGeometry, ColorRepresentation } from "three";

import type { SphereClipResult } from "../hologram/sphereClipping";
import { createArBubbleQualityState, updateArBubbleQuality, type ArBubbleQuality } from "./arBubbleQuality";

// The AR bubble's aura in plain three: shared by the R3F view
// (`ARBubbleAura`) and the IWSDK shells. Mount it in the hologram's placed
// and scaled space; it follows the clipping sphere's world centre and radius.

type AuraSegments = {
  halo: number;
  base: number;
  secondary: number;
};

const AURA_SEGMENTS_BY_QUALITY: Record<ArBubbleQuality, AuraSegments> = {
  high: { halo: 72, base: 64, secondary: 88 },
  medium: { halo: 48, base: 40, secondary: 52 },
  low: { halo: 24, base: 24, secondary: 0 }
};

function isFiniteVector(vector: Vector3): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

function auraMaterial(color: ColorRepresentation, opacity: number): MeshBasicMaterial {
  return new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: AdditiveBlending, toneMapped: false });
}

function flatMesh(geometry: BufferGeometry, material: MeshBasicMaterial, y: number, renderOrder: number): Mesh<BufferGeometry, MeshBasicMaterial> {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(0, y, 0);
  mesh.rotation.set(-Math.PI / 2, 0, 0);
  mesh.renderOrder = renderOrder;
  return mesh;
}

export class BubbleAura {
  /** Named `ARBubbleAura`; hidden until a bubble is active. */
  readonly group = new Group();
  private readonly halo: Mesh<BufferGeometry, MeshBasicMaterial>;
  private readonly secondary: Mesh<BufferGeometry, MeshBasicMaterial>;
  private readonly base: Mesh<BufferGeometry, MeshBasicMaterial>;
  private qualityState = createArBubbleQualityState("high");
  private quality: ArBubbleQuality = "high";
  private readonly localCenter = new Vector3();
  private readonly parentScale = new Vector3();
  private readonly baseNormalized = new Vector3();

  constructor() {
    this.group.name = "ARBubbleAura";
    this.group.visible = false;
    this.halo = flatMesh(new RingGeometry(1.02, 1.42, AURA_SEGMENTS_BY_QUALITY.high.halo), auraMaterial("#64aeff", 0.18), 0.03, 1002);
    this.secondary = flatMesh(new RingGeometry(1.34, 1.9, AURA_SEGMENTS_BY_QUALITY.high.secondary), auraMaterial("#b188ff", 0.1), 0.02, 1001);
    this.base = flatMesh(new CircleGeometry(0.64, AURA_SEGMENTS_BY_QUALITY.high.base), auraMaterial("#eaf8ff", 0.12), -0.9, 1000);
    this.group.add(this.halo, this.secondary, this.base);
  }

  /** `timeS` drives the slow turn and breathing; `deltaMs` the frame-time quality steps. */
  update(bubble: SphereClipResult, timeS: number, deltaMs: number, baseWorldPosition?: Vector3 | null): void {
    this.updateQuality(deltaMs);
    const root = this.group;
    const parent = root.parent;
    if (!bubble.active || bubble.radius <= 0 || !isFiniteVector(bubble.center) || !parent) {
      root.visible = false;
      return;
    }

    root.visible = true;
    const localCenter = this.localCenter.copy(bubble.center);
    parent.worldToLocal(localCenter);
    root.position.copy(localCenter);
    // Radius is in world meters; the model parent already applies scale.
    const parentScale = parent.getWorldScale(this.parentScale);
    root.scale.set(
      bubble.radius / Math.max(0.0001, Math.abs(parentScale.x)),
      bubble.radius / Math.max(0.0001, Math.abs(parentScale.y)),
      bubble.radius / Math.max(0.0001, Math.abs(parentScale.z))
    );

    const t = timeS;
    root.rotation.y = t * 0.14;
    this.halo.material.opacity = MathUtils.lerp(0.12, 0.25, (Math.sin(t * 0.9 + 0.8) + 1) * 0.5);
    this.secondary.rotation.z = -t * 0.12;
    this.secondary.material.opacity = MathUtils.lerp(0.06, 0.16, (Math.sin(t * 0.65 + 1.5) + 1) * 0.5);

    if (baseWorldPosition && isFiniteVector(baseWorldPosition) && bubble.radius > 1e-6) {
      root.updateWorldMatrix(true, false);
      const baseNormalized = this.baseNormalized.copy(baseWorldPosition);
      root.worldToLocal(baseNormalized);
      baseNormalized.y -= 0.24;
      this.base.position.copy(baseNormalized);
    } else {
      this.base.position.set(0, -0.9, 0);
    }
    const baseScale = MathUtils.lerp(0.94, 1.06, (Math.sin(t * 1.1 + 0.4) + 1) * 0.5);
    this.base.scale.set(baseScale, baseScale, 1);
    this.base.material.opacity = MathUtils.lerp(0.08, 0.2, (Math.sin(t * 0.95 + 0.2) + 1) * 0.5);
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const mesh of [this.halo, this.secondary, this.base]) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }

  /** A slow frame drops the rings' segments, and the low tier drops the outer ring. */
  private updateQuality(deltaMs: number): void {
    this.qualityState = updateArBubbleQuality(this.qualityState, deltaMs);
    const quality = this.qualityState.quality;
    if (quality === this.quality) return;
    this.quality = quality;
    const segments = AURA_SEGMENTS_BY_QUALITY[quality];
    this.halo.geometry.dispose();
    this.halo.geometry = new RingGeometry(1.02, 1.42, segments.halo);
    this.base.geometry.dispose();
    this.base.geometry = new CircleGeometry(0.64, segments.base);
    this.secondary.visible = segments.secondary > 0;
    if (segments.secondary > 0) {
      this.secondary.geometry.dispose();
      this.secondary.geometry = new RingGeometry(1.34, 1.9, segments.secondary);
    }
  }
}
