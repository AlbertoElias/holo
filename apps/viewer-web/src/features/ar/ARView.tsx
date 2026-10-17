import { XR } from "@react-three/xr";
import { Canvas } from "@react-three/fiber";
import { ACESFilmicToneMapping, SRGBColorSpace } from "three";
import { UiActionRow, UiButton, UiFixedSurface, UiNotice, UiStack } from "@holoim/ui-dom";
import { HeadLockedActionBar } from "@holoim/xr-ui-r3f";
import { createArImmersiveActions, resolveArShellNoticeState, type PlacementUiState } from "@holoim/xr-ui-core";
import { ARHologramModel } from "./ARHologramModel";
import { useArController } from "./useArController";

const AR_CANVAS_DPR_MAX = 2;
const AR_XR_FRAMEBUFFER_SCALE = 1.25;

export function ARView() {
  const {
    arError,
    bubbleStatus,
    depthOcclusionStatus,
    error,
    handleBubbleStatusChange,
    handleExit,
    handlePlacementStatusChange,
    handleRecenter,
    hologram,
    isLoading,
    isModelReady,
    modelUrl,
    placementStatus,
    placementVersion,
    store,
    xrCapabilities,
    xrMode
  } = useArController();

  if (isLoading || (hologram && !isModelReady && !arError)) {
    return (
      <div className="ar-view-container">
        <div style={{ position: "fixed", inset: 0, display: "grid", placeItems: "center", padding: "1rem" }}>
          <UiNotice title="AR View">
            {isLoading ? "Loading hologram..." : "Preparing hologram for AR..."}
          </UiNotice>
        </div>
      </div>
    );
  }

  if (error || !hologram) {
    return (
      <div className="ar-view-container" style={{ display: "grid", placeItems: "center", padding: "1rem" }}>
        <UiStack gap="0.75rem" style={{ width: "min(360px, calc(100vw - 32px))" }}>
          <UiNotice title="AR View" tone="danger">{error || "Hologram not found"}</UiNotice>
          <UiButton onClick={handleExit} type="button" tone="ghost">
            Back to Feed
          </UiButton>
        </UiStack>
      </div>
    );
  }

  if (arError) {
    return (
      <div className="ar-view-container" style={{ display: "grid", placeItems: "center", padding: "1rem" }}>
        <UiStack gap="0.75rem" style={{ width: "min(360px, calc(100vw - 32px))" }}>
          <UiNotice title="AR Support" tone="danger">{arError}</UiNotice>
          <UiButton onClick={handleExit} type="button" tone="ghost">
            Back to Feed
          </UiButton>
        </UiStack>
      </div>
    );
  }

  if (!modelUrl) {
    return null;
  }

  const placementUiState: PlacementUiState | null = placementStatus
    ? {
      anchored: placementStatus.anchored,
      stage: placementStatus.stage,
      mode: placementStatus.mode,
      reason: placementStatus.reason,
      sequence: placementStatus.sequence
    }
    : null;
  const immersiveActions = createArImmersiveActions({
    onExit: handleExit,
    onRecenter: handleRecenter
  });
  const shellNotices = resolveArShellNoticeState({
    bubbleStatus,
    depthOcclusionEnabled: depthOcclusionStatus.enabled,
    isNativeRuntime: Boolean(xrCapabilities?.isNativeRuntime)
  });

  return (
    <div
      className="ar-view-container"
      data-placement-anchored={placementStatus?.anchored ? "true" : "false"}
      data-placement-mode={placementStatus?.mode ?? ""}
      data-placement-reason={placementStatus?.reason ?? ""}
      data-placement-sequence={String(placementStatus?.sequence ?? 0)}
      data-placement-stage={placementStatus?.stage ?? ""}
      data-placement-position={placementStatus?.position?.map((value) => value.toFixed(3)).join(",") ?? ""}
      data-depth-occlusion={depthOcclusionStatus.enabled ? "enabled" : "disabled"}
      data-depth-occlusion-reason={depthOcclusionStatus.reason}
    >
      {xrMode === "immersive-ar" ? (
        <>
          <UiFixedSurface style={{ right: 20, top: 20 }}>
            <UiActionRow style={{ justifyContent: "flex-end" }}>
              <UiButton onClick={handleRecenter} type="button" tone="ghost">
                Recenter Model
              </UiButton>
              <UiButton onClick={handleExit} type="button" tone="danger">
                Exit AR
              </UiButton>
            </UiActionRow>
          </UiFixedSurface>
          {shellNotices.bubbleWarning ? (
            <UiFixedSurface style={{ top: 20, left: 20, width: "min(320px, calc(100vw - 40px))" }}>
              <UiNotice title="Bubble Effect" tone="warning">{shellNotices.bubbleWarning}</UiNotice>
            </UiFixedSurface>
          ) : null}
          {shellNotices.depthOcclusionWarning ? (
            <UiFixedSurface style={{ top: 110, left: 20, width: "min(320px, calc(100vw - 40px))" }}>
              <UiNotice title="Depth Occlusion" tone="warning">
                {shellNotices.depthOcclusionWarning}
              </UiNotice>
            </UiFixedSurface>
          ) : null}
        </>
      ) : null}

      <Canvas
        dpr={[1, AR_CANVAS_DPR_MAX]}
        gl={{
          alpha: true,
          antialias: true,
          outputColorSpace: SRGBColorSpace,
          powerPreference: "high-performance",
          toneMapping: ACESFilmicToneMapping,
          toneMappingExposure: 1
        }}
        onCreated={({ gl }) => {
          const devicePixelRatio = window.devicePixelRatio || 1;
          gl.setPixelRatio(Math.min(devicePixelRatio, AR_CANVAS_DPR_MAX));
          if (typeof gl.xr.setFramebufferScaleFactor === "function") {
            gl.xr.setFramebufferScaleFactor(AR_XR_FRAMEBUFFER_SCALE);
          }
        }}
        style={{ position: "fixed", inset: 0 }}
        camera={{ position: [0, 0, 0], fov: 75 }}
      >
        <XR store={store}>
          {xrMode === "immersive-ar" ? (
            <HeadLockedActionBar actions={immersiveActions} placement={placementUiState} />
          ) : null}
          {/* Very bright lighting to ensure visibility */}
          <ambientLight intensity={3} />
          <pointLight position={[0, 2, 0]} intensity={2} />
          <pointLight position={[1, 1, 1]} intensity={2} />
          <pointLight position={[-1, 1, -1]} intensity={2} />
          <ARHologramModel
            url={modelUrl}
            enableDepthOcclusion={depthOcclusionStatus.enabled}
            enableIwerPlacementAssist={Boolean(xrCapabilities?.hasIwerRuntime)}
            placementVersion={placementVersion}
            onBubbleStatusChange={handleBubbleStatusChange}
            onPlacementStatusChange={handlePlacementStatusChange}
          />
        </XR>
      </Canvas>
    </div>
  );
}
