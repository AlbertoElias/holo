import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Raycaster,
  RingGeometry,
  SphereGeometry,
  Vector3
} from "three";
import type { Group, Material, Object3D } from "three";

import type { SphereClipResult } from "../hologram/useSphereClipping";
import type { PortalStore } from "../portal/portalStore";
import { spanStrength } from "./meaningLinks";
import type { ResolvedLink } from "./meaningLinks";

// What the author pointed at, while they pointed (PRD-022). Recorded links are
// plain; inferred links are lighter. Everything is driven by the primary
// action's time, so looping, pausing and resuming stay right.

type Style = { emissive: number; line: number; glow: number; ring: number };
const STYLES: Record<ResolvedLink["style"], Style> = {
  recorded: { emissive: 0.9, line: 0.55, glow: 0.85, ring: 0.9 },
  inferred: { emissive: 0.4, line: 0.25, glow: 0.4, ring: 0.45 }
};
const HIGHLIGHT_COLOR = new Color("#7fe4ff");
const LINE_RADIUS = 0.006;
const GLOW_RADIUS = 0.11;

export type PointingProbe = {
  links: Array<{
    index: number;
    style: ResolvedLink["style"];
    strength: number;
    referent: string;
    /** Emissive intensity of the referent's first mesh, when it is lit by emissive. */
    emissive: number | null;
    line: boolean;
    glow: boolean;
    ring: boolean;
  }>;
};

type LinkVisuals = {
  line: Mesh;
  glow: Mesh;
  ring: Mesh;
  ringNormal: Vector3 | null;
  wasActive: boolean;
};

type Saved = { color: Color; intensity: number };
type EmissiveMaterial = Material & { emissive: Color; emissiveIntensity: number };

const isEmissive = (material: Material): material is EmissiveMaterial =>
  (material as Partial<EmissiveMaterial>).emissive instanceof Color;

function referentMeshes(to: Object3D): Mesh[] {
  const meshes: Mesh[] = [];
  to.traverse((child) => {
    const mesh = child as Mesh & { isSkinnedMesh?: boolean };
    if (mesh.isMesh && !mesh.isSkinnedMesh) meshes.push(mesh);
  });
  return meshes;
}

function overlayMaterial(blend = false): MeshBasicMaterial {
  return new MeshBasicMaterial({
    color: HIGHLIGHT_COLOR,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    side: DoubleSide,
    ...(blend ? { blending: AdditiveBlending } : {})
  });
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(Math.max((value - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

type Props = {
  links: ResolvedLink[];
  portal: PortalStore;
  bubble: SphereClipResult;
  falloffWidth: number;
  getPlaybackTime: () => number;
  probe: PointingProbe;
};

export function PointingHighlights({ links, portal, bubble, falloffWidth, getPlaybackTime, probe }: Props) {
  const groupRef = useRef<Group>(null);
  const visualsRef = useRef<LinkVisuals[]>([]);
  const savedRef = useRef(new Map<EmissiveMaterial, Saved>());
  const scratch = useMemo(() => ({
    from: new Vector3(),
    to: new Vector3(),
    mid: new Vector3(),
    dir: new Vector3(),
    up: new Vector3(0, 1, 0),
    quat: new Quaternion(),
    raycaster: new Raycaster()
  }), []);

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const saved = savedRef.current;
    const visuals = links.map((): LinkVisuals => {
      const line = new Mesh(new CylinderGeometry(LINE_RADIUS, LINE_RADIUS, 1, 8, 1, true), overlayMaterial());
      const glow = new Mesh(new SphereGeometry(GLOW_RADIUS, 20, 14), overlayMaterial(true));
      const ring = new Mesh(new RingGeometry(0.92, 1, 64), overlayMaterial());
      for (const part of [line, glow, ring]) {
        part.visible = false;
        part.frustumCulled = false;
        part.renderOrder = 998;
        group.add(part);
      }
      return { line, glow, ring, ringNormal: null, wasActive: false };
    });
    visualsRef.current = visuals;

    return () => {
      saved.forEach((original, material) => {
        material.emissive.copy(original.color);
        material.emissiveIntensity = original.intensity;
      });
      saved.clear();
      for (const part of visuals.flatMap((entry) => [entry.line, entry.glow, entry.ring])) {
        group.remove(part);
        part.geometry.dispose();
        (part.material as Material).dispose();
      }
      visualsRef.current = [];
    };
  }, [links]);

  useFrame(() => {
    const visuals = visualsRef.current;
    if (visuals.length !== links.length) return;
    const enabled = portal.getState().highlights;
    const time = getPlaybackTime();
    const saved = savedRef.current;
    const wanted = new Map<EmissiveMaterial, number>();
    const sampled: { record: { emissive: number | null }; material: EmissiveMaterial | null }[] = [];
    probe.links = [];

    const edgeFade = (position: Vector3): number => {
      if (!bubble.active || bubble.radius <= 0) return 1;
      return 1 - smoothstep(bubble.radius - falloffWidth, bubble.radius, position.distanceTo(bubble.center));
    };

    links.forEach((link, index) => {
      const entry = visuals[index]!;
      const strength = enabled ? spanStrength(time, link.mark.span) : 0;
      const active = strength > 0;
      const { anchor } = link.mark;
      const style = STYLES[link.style];
      let lit = false;
      let usesEmissive = false;
      let sampledMaterial: EmissiveMaterial | null = null;

      if (active) {
        link.from.updateWorldMatrix(true, false);
        link.to.updateWorldMatrix(true, false);
        link.from.getWorldPosition(scratch.from);
        const point = anchor.to.point;
        if (point) {
          scratch.to.set(point[0], point[1], point[2]);
          link.to.localToWorld(scratch.to);
        } else {
          link.to.getWorldPosition(scratch.to);
        }
        const fade = Math.min(edgeFade(scratch.from), edgeFade(scratch.to));
        const power = strength * fade;
        const body = anchor.to.bone !== undefined;
        const meshes = body ? [] : referentMeshes(link.to);

        // Referent: raise emissive on the clip-patched material clones.
        for (const mesh of meshes) {
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const material of materials) {
            if (!isEmissive(material)) continue;
            usesEmissive = true;
            wanted.set(material, Math.max(wanted.get(material) ?? 0, power * style.emissive));
          }
        }
        const firstMaterial = meshes[0] && (Array.isArray(meshes[0].material) ? meshes[0].material[0] : meshes[0].material);
        sampledMaterial = firstMaterial && isEmissive(firstMaterial) ? firstMaterial : null;

        // Bone glow for body parts, and for surfaces that cannot glow themselves.
        const showGlow = body || !usesEmissive;
        entry.glow.visible = showGlow && power > 0;
        if (showGlow) {
          entry.glow.position.copy(scratch.to);
          (entry.glow.material as MeshBasicMaterial).opacity = power * style.glow;
        }

        // Thin ray from the fingertip to the referent.
        scratch.dir.subVectors(scratch.to, scratch.from);
        const length = scratch.dir.length();
        entry.line.visible = length > 1e-4 && power > 0;
        if (entry.line.visible) {
          scratch.mid.addVectors(scratch.from, scratch.to).multiplyScalar(0.5);
          entry.line.position.copy(scratch.mid);
          scratch.quat.setFromUnitVectors(scratch.up, scratch.dir.divideScalar(length));
          entry.line.quaternion.copy(scratch.quat);
          entry.line.scale.set(1, length, 1);
          (entry.line.material as MeshBasicMaterial).opacity = power * style.line;
        }

        // Ring on large undivided surfaces (floor, walls).
        const radius = anchor.to.radius;
        entry.ring.visible = radius !== undefined && power > 0;
        if (radius !== undefined) {
          if (!entry.wasActive || !entry.ringNormal) {
            entry.ringNormal = surfaceNormal(link, scratch);
          }
          const normal = entry.ringNormal ?? scratch.dir.negate().normalize();
          scratch.quat.setFromUnitVectors(new Vector3(0, 0, 1), normal);
          entry.ring.quaternion.copy(scratch.quat);
          entry.ring.position.copy(normal).multiplyScalar(0.008).add(scratch.to);
          const worldScale = link.to.getWorldScale(new Vector3());
          entry.ring.scale.setScalar(radius * Math.max(worldScale.x, worldScale.y, worldScale.z));
          (entry.ring.material as MeshBasicMaterial).opacity = power * style.ring;
        }
        lit = power > 0;
      } else {
        entry.line.visible = false;
        entry.glow.visible = false;
        entry.ring.visible = false;
        entry.ringNormal = null;
      }
      entry.wasActive = active;

      if (lit || active) {
        const record = {
          index,
          style: link.style,
          strength,
          referent: link.to.name,
          emissive: null as number | null,
          line: entry.line.visible,
          glow: entry.glow.visible,
          ring: entry.ring.visible
        };
        probe.links.push(record);
        sampled.push({ record, material: sampledMaterial });
      }
    });

    // Apply the strongest request per material; restore the rest.
    wanted.forEach((level, material) => {
      if (!saved.has(material)) {
        saved.set(material, { color: material.emissive.clone(), intensity: material.emissiveIntensity });
      }
      material.emissive.copy(HIGHLIGHT_COLOR);
      const original = saved.get(material)!;
      // A plain material has black emissive (intensity is moot); keep a glowing one at least as bright.
      material.emissiveIntensity = original.color.getHex() === 0 ? level : Math.max(original.intensity, level);
    });
    saved.forEach((original, material) => {
      if (wanted.has(material)) return;
      material.emissive.copy(original.color);
      material.emissiveIntensity = original.intensity;
      saved.delete(material);
    });
    // The probe reports what the viewer sees, so sample once the pass has written it.
    for (const { record, material } of sampled) record.emissive = material ? material.emissiveIntensity : null;
  });

  return <group ref={groupRef} />;
}

/** Surface normal where the ray meets the referent, so the ring lies on the surface. */
function surfaceNormal(
  link: ResolvedLink,
  scratch: { from: Vector3; to: Vector3; dir: Vector3; raycaster: Raycaster }
): Vector3 | null {
  scratch.dir.subVectors(scratch.to, scratch.from);
  const distance = scratch.dir.length();
  if (distance < 1e-4) return null;
  scratch.raycaster.set(scratch.from, scratch.dir.clone().divideScalar(distance));
  scratch.raycaster.far = distance + 0.5;
  const hit = scratch.raycaster.intersectObject(link.to, true)[0];
  if (!hit?.face) return null;
  const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
  // Face the finger.
  if (normal.dot(scratch.dir) > 0) normal.negate();
  return normal;
}
