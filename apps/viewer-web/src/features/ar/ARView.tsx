import { XR } from "@react-three/xr";
import { Canvas } from "@react-three/fiber";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ACESFilmicToneMapping, SRGBColorSpace } from "three";
import { tokens } from "@holoim/design-tokens";
import { Chip, Dock, GlyphControl, Type, useReducedMotion } from "@holoim/ui-dom";
import {
  arCompositorFromUserAgent,
  isHeadset,
  resolveArShellNoticeState,
  scaleState,
  stageLight,
  TRUE_SCALE,
  VIEW_TARGETS,
  type ViewTarget
} from "@holoim/xr-ui-core";

import { VIEWER_CONTROL_NAMES } from "../chrome/controlNames";
import { ArCloche, ArFootRows, ArWristExit } from "./ARChrome";
import { ARHologramModel } from "./ARHologramModel";
import { isPlacementResolved } from "./arController";
import { useArController } from "./useArController";

const AR_CANVAS_DPR_MAX = 2;
const AR_XR_FRAMEBUFFER_SCALE = 1.25;
// The hologram's base light: enough to read the recording against any room.
const AR_BASE_AMBIENT_INTENSITY = 3;
// The stage light sits low and a little ahead of the hologram, so its warmth falls on the floor at its foot.
const AR_STAGE_LIGHT_HEIGHT_METERS = 0.3;
// A pinch rescales between a twentieth and four times the recorded size; near true scale it snaps back.
const AR_MIN_SCALE = 0.05;
const AR_MAX_SCALE = 4;
const AR_TRUE_SCALE_SNAP = 0.04;

/** The AR target: its compositor from the browser, a headset when the session is world-space (styleguide 9.2). */
function arTarget(session: XRSession | null | undefined): ViewTarget {
  const compositor = typeof navigator === "undefined" ? "unlisted" : arCompositorFromUserAgent(navigator.userAgent);
  if (compositor === "questPassthrough") return VIEW_TARGETS.questPassthrough;
  if (compositor === "androidChrome") return VIEW_TARGETS.androidChrome;
  return { kind: "ar", compositor, headset: session?.interactionMode === "world-space" };
}

/** Two fingers on a phone's screen rescale the hologram; the scale shows at its foot with a way back (Q13). */
function usePinchScale(enabled: boolean): [number, (factor: number) => void] {
  const [factor, setFactor] = useState(TRUE_SCALE);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef<{ distance: number; factor: number } | null>(null);
  const factorRef = useRef(factor);
  factorRef.current = factor;

  useEffect(() => {
    if (!enabled) return undefined;
    const active = touches.current;
    const spread = () => {
      const [a, b] = Array.from(active.values());
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };
    const down = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.current.size === 2) start.current = { distance: spread(), factor: factorRef.current };
    };
    const move = (event: PointerEvent) => {
      if (!touches.current.has(event.pointerId)) return;
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const from = start.current;
      if (!from || from.distance <= 0 || touches.current.size !== 2) return;
      const next = Math.min(AR_MAX_SCALE, Math.max(AR_MIN_SCALE, from.factor * (spread() / from.distance)));
      setFactor(Math.abs(next - TRUE_SCALE) < AR_TRUE_SCALE_SNAP ? TRUE_SCALE : Number(next.toFixed(3)));
    };
    const up = (event: PointerEvent) => {
      touches.current.delete(event.pointerId);
      if (touches.current.size < 2) start.current = null;
    };
    window.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      active.clear();
      start.current = null;
    };
  }, [enabled]);

  return [factor, setFactor];
}

/** A tap on the dock is the dock's alone, never also an XR select in the scene. */
function useDomOnlyTaps<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const keep = (event: Event) => event.preventDefault();
    element.addEventListener("beforexrselect", keep);
    return () => element.removeEventListener("beforexrselect", keep);
  });
  return ref;
}

/** Loading and errors before a session: the ground, and the notice on the chip. */
function FlatNotice({ text, action, alert = false }: { text: string; action?: ReactNode; alert?: boolean }) {
  return (
    <div className="ar-view-container" data-ar-flat="">
      <div className="ar-flat-notice" role={alert ? "alert" : "status"}>
        <Chip target={VIEW_TARGETS.phone} className="feed-notice-chip">
          <Type variant="captionUnderCard" as="p" className="feed-notice-text">
            {text}
          </Type>
          {action}
        </Chip>
      </div>
    </div>
  );
}

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
  const reducedMotion = useReducedMotion();
  const immersive = xrMode === "immersive-ar";
  const target = arTarget(immersive ? store.getState().session : null);
  const headset = isHeadset(target);
  const [paused, setPaused] = useState(false);
  // Phones pinch on the screen; a headset sends no touches, so it stays at true scale.
  const [scaleFactor, setScaleFactor] = usePinchScale(immersive);
  const playbackSecondsRef = useRef(0);
  const dockRef = useDomOnlyTaps<HTMLDivElement>();
  const togglePause = useCallback(() => setPaused((value) => !value), []);
  const returnToTrueSize = useCallback(() => setScaleFactor(TRUE_SCALE), [setScaleFactor]);
  const backToFeed = <GlyphControl glyph={null} label={VIEWER_CONTROL_NAMES.backToFeed} onPress={handleExit} />;

  if (isLoading || (hologram && !isModelReady && !arError)) {
    return <FlatNotice text={isLoading ? "Loading the hologram…" : "Getting the hologram ready for AR…"} />;
  }

  if (error || !hologram) {
    return <FlatNotice alert text={error || "This hologram isn't here any more."} action={backToFeed} />;
  }

  if (arError) {
    return <FlatNotice alert text={arError} action={backToFeed} />;
  }

  if (!modelUrl) {
    return null;
  }

  const shellNotices = resolveArShellNoticeState({
    bubbleStatus,
    depthOcclusionEnabled: depthOcclusionStatus.enabled,
    isNativeRuntime: Boolean(xrCapabilities?.isNativeRuntime)
  });
  const placing = !isPlacementResolved(placementStatus);
  const notice = placing
    ? "Looking for the floor. Point the camera at it."
    : shellNotices.bubbleWarning ?? shellNotices.depthOcclusionWarning ?? null;

  return (
    <div
      className="ar-view-container"
      data-xr-mode={xrMode ?? ""}
      data-ar-target={headset ? "headset" : "handheld"}
      data-ar-scale={String(scaleFactor)}
      data-ar-scale-label={scaleState(scaleFactor).label ?? ""}
      data-ar-paused={paused ? "true" : "false"}
      data-placement-anchored={placementStatus?.anchored ? "true" : "false"}
      data-placement-mode={placementStatus?.mode ?? ""}
      data-placement-reason={placementStatus?.reason ?? ""}
      data-placement-sequence={String(placementStatus?.sequence ?? 0)}
      data-placement-stage={placementStatus?.stage ?? ""}
      data-placement-position={placementStatus?.position?.map((value) => value.toFixed(3)).join(",") ?? ""}
      data-depth-occlusion={depthOcclusionStatus.enabled ? "enabled" : "disabled"}
      data-depth-occlusion-reason={depthOcclusionStatus.reason}
    >
      {immersive ? (
        <>
          {/* On a phone the page lies over the camera (dom-overlay): notices on the
              chip at the top, actions in the dock. A headset shows no page; its
              Exit is on the wrist. */}
          {notice ? (
            <div className="feed-notice" role="status" data-notice={placing ? "placing" : "ar"}>
              <Chip target={target} className="feed-notice-chip">
                <Type variant="captionUnderCard" as="p" className="feed-notice-text">
                  {notice}
                </Type>
              </Chip>
            </div>
          ) : null}
          <div ref={dockRef} className="ar-dock">
            <Dock className="ar-dock-bar" aria-label="AR">
              <GlyphControl glyph={null} label={VIEWER_CONTROL_NAMES.recenter} word="Recenter" onPress={handleRecenter} />
              <GlyphControl glyph={null} label={VIEWER_CONTROL_NAMES.exitAr} onPress={handleExit} />
            </Dock>
          </div>
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
          <ambientLight intensity={AR_BASE_AMBIENT_INTENSITY} />
          {immersive ? <ArWristExit target={target} onExit={handleExit} /> : null}
          <ARHologramModel
            url={modelUrl}
            enableDepthOcclusion={depthOcclusionStatus.enabled}
            placementVersion={placementVersion}
            onBubbleStatusChange={handleBubbleStatusChange}
            onPlacementStatusChange={handlePlacementStatusChange}
            scaleFactor={scaleFactor}
            paused={paused}
            playbackSecondsRef={playbackSecondsRef}
            clocheChrome={(shape) =>
              immersive ? <ArCloche seed={hologram.id} shape={shape} target={target} reducedMotion={reducedMotion} /> : null
            }
          >
            {({ frontMeters }) => (
              <>
                {/* The stage light is steady in a room: it falls on real surfaces (8.1). */}
                <pointLight
                  name="ar-stage-light"
                  color={tokens.color.glow}
                  decay={2}
                  intensity={stageLight(target, 0, { reducedMotion }) ?? 0}
                  position={[0, AR_STAGE_LIGHT_HEIGHT_METERS, frontMeters / 2]}
                />
                {immersive ? (
                  <ArFootRows
                    target={target}
                    paused={paused}
                    onTogglePause={togglePause}
                    playbackSecondsRef={playbackSecondsRef}
                    scaleFactor={scaleFactor}
                    onTrueSize={returnToTrueSize}
                    frontMeters={frontMeters}
                  />
                ) : null}
              </>
            )}
          </ARHologramModel>
        </XR>
      </Canvas>
    </div>
  );
}
