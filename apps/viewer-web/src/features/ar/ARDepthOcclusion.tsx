import { useFrame, useThree } from "@react-three/fiber";
import { useMemo } from "react";

import { DepthOcclusion } from "./depthOcclusion";

export function ARDepthOcclusion({ enabled }: { enabled: boolean }) {
  const { gl } = useThree();
  const occlusion = useMemo(() => new DepthOcclusion(), []);
  useFrame(() => occlusion.update(gl, enabled));
  return null;
}
