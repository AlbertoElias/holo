import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import type { Material, Mesh, Object3D, WebXRManager } from "three";

type DepthAwareWebXRManager = WebXRManager & {
  getDepthSensingMesh?: () => Object3D | null;
  hasDepthSensing?: () => boolean;
};

// three's occlusion shader writes only gl_FragDepth. Drawing it with color
// writes on leaves the bound draw buffer without a fragment output, which
// WebGL rejects with GL_INVALID_OPERATION, so it must stay depth-only.
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
    // The plane is a full-screen pass; its vertices ignore the camera.
    mesh.frustumCulled = false;
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

// WebGLRenderer draws xr.getDepthSensingMesh() itself in every XR render once
// the session grants GPU depth sensing, so the mesh is never added to the
// scene; visibility is the only switch for whether occlusion runs.
export function ARDepthOcclusion({ enabled }: { enabled: boolean }) {
  const { gl } = useThree();
  const configuredMeshRef = useRef<Object3D | null>(null);

  useFrame(() => {
    const xrManager = gl.xr as DepthAwareWebXRManager;
    const hasDepthSensing = xrManager.isPresenting
      && typeof xrManager.hasDepthSensing === "function"
      && xrManager.hasDepthSensing();
    const mesh = hasDepthSensing && typeof xrManager.getDepthSensingMesh === "function"
      ? xrManager.getDepthSensingMesh() ?? null
      : null;

    if (mesh) {
      if (configuredMeshRef.current !== mesh) {
        configureOcclusionObject(mesh);
        configuredMeshRef.current = mesh;
      }
      mesh.visible = enabled;
    }
  });

  return null;
}
