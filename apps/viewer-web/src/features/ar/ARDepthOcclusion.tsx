import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import type { Material, Mesh, Object3D, WebXRManager } from "three";

type DepthAwareWebXRManager = WebXRManager & {
  getDepthSensingMesh?: () => Object3D | null;
  hasDepthSensing?: () => boolean;
};

function configureOcclusionMaterial(material: Material): void {
  material.colorWrite = false;
  material.depthWrite = true;
  material.transparent = false;
  material.opacity = 1;
}

function configureOcclusionObject(object: Object3D): void {
  object.renderOrder = -1000;
  object.traverse((child) => {
    const mesh = child as Mesh;
    if (!("material" in mesh)) {
      return;
    }

    const material = mesh.material;
    if (Array.isArray(material)) {
      material.forEach(configureOcclusionMaterial);
      return;
    }

    if (material) {
      configureOcclusionMaterial(material);
    }
  });
}

export function ARDepthOcclusion({ enabled }: { enabled: boolean }) {
  const { gl, scene } = useThree();
  const activeMeshRef = useRef<Object3D | null>(null);

  useFrame(() => {
    const xrManager = gl.xr as DepthAwareWebXRManager;
    const hasDepthSensing = enabled
      && xrManager.isPresenting
      && typeof xrManager.hasDepthSensing === "function"
      && xrManager.hasDepthSensing();
    const nextMesh = hasDepthSensing && typeof xrManager.getDepthSensingMesh === "function"
      ? xrManager.getDepthSensingMesh() ?? null
      : null;

    if (activeMeshRef.current === nextMesh) {
      if (activeMeshRef.current) {
        activeMeshRef.current.visible = enabled;
      }
      return;
    }

    if (activeMeshRef.current) {
      scene.remove(activeMeshRef.current);
      activeMeshRef.current = null;
    }

    if (nextMesh) {
      configureOcclusionObject(nextMesh);
      nextMesh.visible = enabled;
      scene.add(nextMesh);
      activeMeshRef.current = nextMesh;
    }
  });

  useEffect(() => {
    return () => {
      if (activeMeshRef.current) {
        scene.remove(activeMeshRef.current);
        activeMeshRef.current = null;
      }
    };
  }, [scene]);

  return null;
}
