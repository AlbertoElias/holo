import type { Material, Mesh, Object3D, WebGLRenderer, WebXRManager } from "three";

// Depth occlusion in plain three: shared by the R3F view (`ARDepthOcclusion`)
// and the IWSDK shells.

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

/**
 * WebGLRenderer draws xr.getDepthSensingMesh() itself in every XR render once
 * the session grants GPU depth sensing, so the mesh is never added to the
 * scene; visibility is the only switch for whether occlusion runs. Call every
 * frame. Returns whether occlusion is drawing this frame.
 */
export class DepthOcclusion {
  private configured: Object3D | null = null;

  update(renderer: WebGLRenderer, enabled: boolean): boolean {
    const xrManager = renderer.xr as DepthAwareWebXRManager;
    const hasDepthSensing = xrManager.isPresenting
      && typeof xrManager.hasDepthSensing === "function"
      && xrManager.hasDepthSensing();
    const mesh = hasDepthSensing && typeof xrManager.getDepthSensingMesh === "function"
      ? xrManager.getDepthSensingMesh() ?? null
      : null;
    if (!mesh) return false;
    if (this.configured !== mesh) {
      configureOcclusionObject(mesh);
      this.configured = mesh;
    }
    mesh.visible = enabled;
    return enabled;
  }
}
