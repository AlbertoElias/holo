import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import type { Vector3 } from "three";

import type { SphereClipResult } from "../hologram/useSphereClipping";
import { BubbleAura } from "./bubbleAura";

type ARBubbleAuraProps = {
  bubble: SphereClipResult;
  baseWorldPosition?: Vector3 | null;
};

export function ARBubbleAura({ bubble, baseWorldPosition }: ARBubbleAuraProps) {
  const aura = useMemo(() => new BubbleAura(), []);
  useEffect(() => () => aura.dispose(), [aura]);
  useFrame((state, delta) => aura.update(bubble, state.clock.elapsedTime, delta * 1000, baseWorldPosition));
  return <primitive object={aura.group} />;
}
