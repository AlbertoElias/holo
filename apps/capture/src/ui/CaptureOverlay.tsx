import { useSyncExternalStore } from "react";

import { UiButton, UiNotice, UiPanel, UiPill, UiStack, uiDomTokens } from "@holoim/ui-dom";
import { createRecordingUiState, type PermissionUiState, type XrMode } from "@holoim/xr-ui-core";

import type { UiViewModel } from "../types/contracts";
import type { CaptureUiBridge } from "./captureUiBridge";

function resolveOverlayMode(mode: UiViewModel["mode"]): XrMode {
  if (mode === "vr" || mode === "mock-vr") {
    return "vr";
  }
  if (mode === "ar") {
    return "ar";
  }
  return typeof window !== "undefined" && window.innerWidth <= 768 ? "mobile" : "desktop";
}

function resolvePermissionState(viewModel: UiViewModel): PermissionUiState {
  return {
    micPermission: viewModel.micPermission
  };
}

function resolveLoadTone(loadState: UiViewModel["loadState"]): "neutral" | "warning" | "danger" | "success" {
  if (loadState === "error") {
    return "danger";
  }
  if (loadState === "warning") {
    return "warning";
  }
  if (loadState === "ready") {
    return "success";
  }
  return "neutral";
}

function resolveStatusText(state: UiViewModel): string {
  if (state.loadState === "loading") {
    return "Loading scene...";
  }

  if (state.loadState === "error") {
    return state.warning ?? "Failed to load scene/avatar assets.";
  }

  if (state.loadState === "warning") {
    return state.warning ?? "Loaded with warnings: spawn/physics setup incomplete.";
  }

  return state.warning ?? `Loaded. ${state.controls}`;
}

// The supplied object (PRD-043): one GLB, chosen before recording. It shares
// the shortcut row so the panel keeps its height on small viewports.
function ObjectPicker({ bridge, object, disabled }: { bridge: CaptureUiBridge; object: UiViewModel["object"]; disabled: boolean }) {
  const label = object.status === "ready" ? `Object: ${object.name}` : object.status === "loading" ? "Loading object…" : "Choose object…";
  const inactive = disabled || object.status === "loading";
  return (
    <label style={{ cursor: inactive ? "default" : "pointer", textDecoration: inactive ? "none" : "underline", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
      {label}
      <input
        aria-label="Choose an object (.glb)"
        type="file"
        accept=".glb,model/gltf-binary"
        disabled={inactive}
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden" }}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) bridge.loadObjectFile(file);
          event.currentTarget.value = "";
        }}
      />
    </label>
  );
}

// The prepared tray (PRD-045): up to five GLBs or images, before recording.
// Also on the shortcut row; a pick adds to the tray.
function TrayPicker({ bridge, tray, disabled }: { bridge: CaptureUiBridge; tray: UiViewModel["tray"]; disabled: boolean }) {
  const label = tray.loading ? "Loading tray…" : tray.names.length > 0 ? `Tray: ${tray.names.length}` : "Tray…";
  const inactive = disabled || tray.loading;
  return (
    <label title={tray.names.join(", ")} style={{ cursor: inactive ? "default" : "pointer", textDecoration: inactive ? "none" : "underline", whiteSpace: "nowrap" }}>
      {label}
      <input
        aria-label="Add tray items (.glb, .png, .jpg)"
        type="file"
        multiple
        accept=".glb,model/gltf-binary,.png,image/png,.jpg,.jpeg,image/jpeg"
        disabled={inactive}
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden" }}
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          if (files.length > 0) bridge.loadTrayFiles(files);
          event.currentTarget.value = "";
        }}
      />
    </label>
  );
}

export function CaptureOverlay({ bridge }: { bridge: CaptureUiBridge }) {
  const state = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot);
  const recording = createRecordingUiState(state.recordingState, state.recordingMessage);
  const permissions = resolvePermissionState(state);
  const xrMode = resolveOverlayMode(state.mode);
  const statusText = resolveStatusText(state);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 10
      }}
    >
      <div
        id="status"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          clipPath: "inset(50%)",
          whiteSpace: "nowrap"
        }}
      >
        {statusText}
      </div>
      <div
        style={{
          position: "absolute",
          top: 16,
          left: 16,
          width: "min(360px, calc(100vw - 32px))"
        }}
      >
        <UiPanel style={{ padding: "0.95rem 1rem" }}>
          <UiStack gap="0.7rem">
            <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center" }}>
              <UiPill>{xrMode}</UiPill>
              <UiPill style={{ borderColor: "rgb(121 219 192 / 36%)", color: "#c9ffef" }}>{state.loadState}</UiPill>
            </div>
            <div style={{ fontSize: "0.98rem", fontWeight: 700 }}>Capture Runtime</div>
            <UiNotice tone={resolveLoadTone(state.loadState)}>
              {statusText}
            </UiNotice>
            <UiNotice tone={permissions.micPermission === "denied" ? "warning" : "neutral"} title="Microphone">
              {permissions.micPermission === "granted"
                ? "Microphone permission granted."
                : permissions.micPermission === "denied"
                  ? "Microphone permission denied. Recording will export without audio."
                  : "Waiting for microphone permission."}
            </UiNotice>
          </UiStack>
        </UiPanel>
      </div>

      <div
        style={{
          position: "absolute",
          left: 24,
          bottom: 24,
          width: "min(320px, calc(100vw - 48px))",
          pointerEvents: "auto"
        }}
      >
        <UiPanel style={{ padding: "0.9rem", background: uiDomTokens.colorBackgroundStrong }}>
          <UiStack gap="0.65rem">
            <UiPill style={{ width: "fit-content" }}>{recording.status}</UiPill>
            <UiButton
              disabled={!recording.canToggle}
              onClick={() => bridge.toggleRecording()}
              tone={recording.status === "recording" ? "danger" : "primary"}
            >
              {recording.actionLabel}
            </UiButton>
            {state.mode === "ar" ? (
              <UiButton onClick={() => bridge.recenterAr()} tone="ghost">
                Recenter AR
              </UiButton>
            ) : null}
            {state.mode === "vr" && (
              <>
                <UiButton disabled={!state.heightFit.enabled} onClick={() => bridge.refitHeight()} tone="primary">
                  Refit height
                </UiButton>
                <div role="status" style={{ fontSize: "0.78rem", color: uiDomTokens.colorTextMuted }}>
                  {state.heightFit.pending ? "Hold your new neutral posture briefly…" : state.heightFit.eyeHeight !== null ? `Fitted eye height: ${state.heightFit.eyeHeight.toFixed(2)} m` : "Hold a neutral posture to fit your height."}
                  {!state.heightFit.enabled && recording.status !== "idle" ? " Refit is available after recording/export." : ""}
                </div>
              </>
            )}
            {state.object.status === "error" && state.object.message ? (
              <UiNotice tone="warning" title="Object">
                {state.object.message}
              </UiNotice>
            ) : null}
            {state.tray.message ? (
              <UiNotice tone="warning" title="Tray">
                {state.tray.message}
              </UiNotice>
            ) : null}
            <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", fontSize: "0.78rem", color: uiDomTokens.colorTextMuted }}>
              <span>
                Shortcut: <strong>R</strong>
              </span>
              <span style={{ display: "flex", gap: "0.75rem", minWidth: 0 }}>
                <ObjectPicker bridge={bridge} object={state.object} disabled={recording.status !== "idle"} />
                <TrayPicker bridge={bridge} tray={state.tray} disabled={recording.status !== "idle"} />
              </span>
            </div>
          </UiStack>
        </UiPanel>
      </div>
    </div>
  );
}
