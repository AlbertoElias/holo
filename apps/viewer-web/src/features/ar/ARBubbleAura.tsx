import { useFrame } from "@react-three/fiber";
import { AdditiveBlending, MathUtils, Vector3 } from "three";
import { useMemo, useRef, useState } from "react";
import type { Group, Mesh } from "three";

import type { SphereClipResult } from "../hologram/useSphereClipping";
import {
  createArBubbleQualityState,
  updateArBubbleQuality,
  type ArBubbleQuality
} from "./arBubbleQuality";

type ARBubbleAuraProps = {
  bubble: SphereClipResult;
  baseWorldPosition?: Vector3 | null;
};

type AuraSegments = {
  ring: number;
  halo: number;
  base: number;
  secondary: number;
};

const AURA_SEGMENTS_BY_QUALITY: Record<ArBubbleQuality, AuraSegments> = {
  high: { ring: 96, halo: 72, base: 64, secondary: 88 },
  medium: { ring: 64, halo: 48, base: 40, secondary: 52 },
  low: { ring: 36, halo: 24, base: 24, secondary: 0 }
};

function isFiniteVector(vector: Vector3): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

export function ARBubbleAura({ bubble, baseWorldPosition }: ARBubbleAuraProps) {
  const rootRef = useRef<Group>(null);
  const ringRef = useRef<Mesh>(null);
  const haloRef = useRef<Mesh>(null);
  const baseRef = useRef<Mesh>(null);
  const secondaryHaloRef = useRef<Mesh>(null);

  const qualityStateRef = useRef(createArBubbleQualityState("high"));
  const [quality, setQuality] = useState<ArBubbleQuality>("high");
  const segments = useMemo(() => AURA_SEGMENTS_BY_QUALITY[quality], [quality]);
  const localCenterRef = useRef(new Vector3());
  const baseLocalToParentRef = useRef(new Vector3());
  const baseNormalizedRef = useRef(new Vector3());

  useFrame((state, delta) => {
    const nextQualityState = updateArBubbleQuality(qualityStateRef.current, delta * 1000);
    qualityStateRef.current = nextQualityState;
    if (nextQualityState.quality !== quality) {
      setQuality(nextQualityState.quality);
    }

    const root = rootRef.current;
    if (!root) {
      return;
    }

    if (!bubble.active || bubble.radius <= 0 || !isFiniteVector(bubble.center)) {
      root.visible = false;
      return;
    }

    const parent = root.parent;
    if (!parent) {
      root.visible = false;
      return;
    }

    root.visible = true;
    const localCenter = localCenterRef.current.copy(bubble.center);
    parent.worldToLocal(localCenter);
    root.position.copy(localCenter);
    root.scale.setScalar(Math.max(0.0001, bubble.radius));

    const t = state.clock.elapsedTime;
    root.rotation.y = t * 0.14;

    if (ringRef.current) {
      ringRef.current.rotation.z = t * 0.21;
      const ringMaterial = ringRef.current.material;
      if (Array.isArray(ringMaterial)) {
        ringMaterial.forEach(() => undefined);
      } else {
        ringMaterial.opacity = MathUtils.lerp(0.28, 0.48, (Math.sin(t * 1.3) + 1) * 0.5);
      }
    }

    if (haloRef.current) {
      const haloMaterial = haloRef.current.material;
      if (!Array.isArray(haloMaterial)) {
        haloMaterial.opacity = MathUtils.lerp(0.12, 0.25, (Math.sin(t * 0.9 + 0.8) + 1) * 0.5);
      }
    }

    if (secondaryHaloRef.current) {
      secondaryHaloRef.current.rotation.z = -t * 0.12;
      const secondaryMaterial = secondaryHaloRef.current.material;
      if (!Array.isArray(secondaryMaterial)) {
        secondaryMaterial.opacity = MathUtils.lerp(0.06, 0.16, (Math.sin(t * 0.65 + 1.5) + 1) * 0.5);
      }
    }

    if (baseRef.current) {
      if (baseWorldPosition && isFiniteVector(baseWorldPosition) && bubble.radius > 1e-6) {
        const baseLocalToParent = baseLocalToParentRef.current.copy(baseWorldPosition);
        parent.worldToLocal(baseLocalToParent);
        const baseNormalized = baseNormalizedRef.current
          .copy(baseLocalToParent)
          .sub(root.position)
          .divideScalar(bubble.radius);
        baseNormalized.y -= 0.24;
        baseRef.current.position.copy(baseNormalized);
      } else {
        baseRef.current.position.set(0, -0.9, 0);
      }

      const baseScale = MathUtils.lerp(0.94, 1.06, (Math.sin(t * 1.1 + 0.4) + 1) * 0.5);
      baseRef.current.scale.set(baseScale, baseScale, 1);
      const baseMaterial = baseRef.current.material;
      if (!Array.isArray(baseMaterial)) {
        baseMaterial.opacity = MathUtils.lerp(0.08, 0.2, (Math.sin(t * 0.95 + 0.2) + 1) * 0.5);
      }
    }
  });

  return (
    <group ref={rootRef} visible={false}>
      <mesh ref={ringRef} rotation={[Math.PI / 2, 0, 0]} renderOrder={1003}>
        <torusGeometry args={[1.07, 0.018, 18, segments.ring]} />
        <meshBasicMaterial
          color="#76e4ff"
          transparent
          opacity={0.35}
          depthWrite={false}
          blending={AdditiveBlending}
          toneMapped={false}
        />
      </mesh>

      <mesh ref={haloRef} position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1002}>
        <ringGeometry args={[1.02, 1.42, segments.halo]} />
        <meshBasicMaterial
          color="#64aeff"
          transparent
          opacity={0.18}
          depthWrite={false}
          blending={AdditiveBlending}
          toneMapped={false}
        />
      </mesh>

      {segments.secondary > 0 ? (
        <mesh
          ref={secondaryHaloRef}
          position={[0, 0.02, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          renderOrder={1001}
        >
          <ringGeometry args={[1.34, 1.9, segments.secondary]} />
          <meshBasicMaterial
            color="#b188ff"
            transparent
            opacity={0.1}
            depthWrite={false}
            blending={AdditiveBlending}
            toneMapped={false}
          />
        </mesh>
      ) : null}

      <mesh ref={baseRef} position={[0, -0.9, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1000}>
        <circleGeometry args={[0.64, segments.base]} />
        <meshBasicMaterial
          color="#eaf8ff"
          transparent
          opacity={0.12}
          depthWrite={false}
          blending={AdditiveBlending}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}
