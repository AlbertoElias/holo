import { XR, createXRStore } from "@react-three/xr";
import { Canvas } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ACESFilmicToneMapping, SRGBColorSpace } from "three";

import type { HologramDTO } from "@holoim/contracts";

import { fetchHologram, resolveMediaUrl } from "../feed/api";
import { checkModelAvailability } from "../hologram/modelAvailability";
import type { SphereClipStatus } from "../hologram/useSphereClipping";
import { ARHologramModel } from "./ARHologramModel";
import { isIOSDevice } from "./isIOSDevice";
const AR_CANVAS_DPR_MAX = 2;
const AR_XR_FRAMEBUFFER_SCALE = 1.25;

type InputSourceStateLike = {
  type: string;
};

function stripProblematicInputSources<T extends InputSourceStateLike>(inputSourceStates: readonly T[]): readonly T[] {
  return inputSourceStates.filter((inputSourceState) => (
    inputSourceState.type !== "controller" && inputSourceState.type !== "hand"
  ));
}

function ARExitButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="ar-exit-button" onClick={onClick} type="button">
      Exit AR
    </button>
  );
}

function ARRecenterButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="ar-exit-button" onClick={onClick} type="button" style={{ right: 120 }}>
      Recenter Model
    </button>
  );
}

export function ARView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [hologram, setHologram] = useState<HologramDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isModelReady, setIsModelReady] = useState(false);
  const [arError, setArError] = useState<string | null>(null);
  const [bubbleStatus, setBubbleStatus] = useState<SphereClipStatus>("enabled");
  const [placementVersion, setPlacementVersion] = useState(0);
  const enteredArRef = useRef(false);
  const activeSessionRef = useRef<XRSession | null>(null);
  const inputSanitizationLoggedRef = useRef(false);
  const store = useMemo(() => {
    const xrStore = createXRStore({
      offerSession: false,
      emulate: false,
      secondaryInputSources: false,
      controller: false,
      hand: false,
      transientPointer: false,
      gaze: false,
      screenInput: false,
      anchors: false,
      handTracking: false,
      bodyTracking: false,
      layers: false,
      meshDetection: false,
      planeDetection: false,
      hitTest: false
    });

    const originalOnBeforeFrame = xrStore.onBeforeFrame;
    xrStore.onBeforeFrame = (scene, camera, frame) => {
      try {
        originalOnBeforeFrame(scene, camera, frame);
      } catch (error) {
        const filtered = stripProblematicInputSources(xrStore.getState().inputSourceStates);
        if (filtered.length !== xrStore.getState().inputSourceStates.length) {
          xrStore.setState({ inputSourceStates: filtered });
        }
        if (import.meta.env.DEV) {
          console.warn("[AR] XR frame update threw; stripped controller/hand input sources.", error);
        }
      }
    };

    return xrStore;
  }, []);
  const [xrMode, setXrMode] = useState<XRSessionMode | null>(store.getState().mode);
  const handleBubbleStatusChange = useCallback((status: SphereClipStatus) => {
    setBubbleStatus(status);
  }, []);

  useEffect(() => {
    const onSessionEnded = (): void => {
      navigate("/", { replace: true });
    };

    const unsubscribe = store.subscribe((state, prevState) => {
      const filteredInputSourceStates = stripProblematicInputSources(state.inputSourceStates);
      if (filteredInputSourceStates.length !== state.inputSourceStates.length) {
        store.setState({ inputSourceStates: filteredInputSourceStates });
        if (import.meta.env.DEV && !inputSanitizationLoggedRef.current) {
          inputSanitizationLoggedRef.current = true;
          console.warn("[AR] Stripped simulator controller/hand input sources to avoid WebXR polyfill pose errors.");
        }
      }

      setXrMode(state.mode);

      const nextSession = state.session ?? null;
      if (activeSessionRef.current !== nextSession) {
        if (activeSessionRef.current) {
          activeSessionRef.current.removeEventListener("end", onSessionEnded);
        }
        if (nextSession) {
          nextSession.addEventListener("end", onSessionEnded);
        }
        activeSessionRef.current = nextSession;
      }

      if (state.mode === "immersive-ar") {
        enteredArRef.current = true;
      }
      if (enteredArRef.current && prevState.mode === "immersive-ar" && state.mode !== "immersive-ar") {
        navigate("/", { replace: true });
      }
    });

    return () => {
      unsubscribe();
      if (activeSessionRef.current) {
        activeSessionRef.current.removeEventListener("end", onSessionEnded);
        activeSessionRef.current = null;
      }
    };
  }, [navigate, store]);

  // Check for WebXR support — redirect iOS users back to feed (AR Quick Look is on the card)
  useEffect(() => {
    if (isIOSDevice()) {
      navigate("/", { replace: true });
      return;
    }

    if (!navigator.xr) {
      setArError("WebXR is not supported on this device. Please use a WebXR-compatible browser on Android.");
      return;
    }

    navigator.xr.isSessionSupported("immersive-ar")
      .then((supported) => {
        if (!supported) {
          setArError("AR is not supported on this browser. Please use a WebXR-compatible browser on Android.");
        }
      })
      .catch((err) => {
        console.error("WebXR check failed:", err);
        setArError("Could not check AR support. Your browser may not support WebXR.");
      });
  }, [navigate]);

  useEffect(() => {
    if (!id) {
      setError("No hologram ID provided");
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);
    setArError(null);
    setIsModelReady(false);
    setHologram(null);

    fetchHologram(id)
      .then((data) => {
        setHologram(data);
        setIsLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load hologram:", err);
        setError("Failed to load hologram");
        setIsLoading(false);
      });
  }, [id]);

  useEffect(() => {
    if (!hologram) {
      return;
    }

    const modelUrl = resolveMediaUrl(hologram.url);
    let cancelled = false;
    setIsModelReady(false);

    checkModelAvailability(modelUrl)
      .then((availability) => {
        if (cancelled) {
          return;
        }

        if (availability === "ready") {
          setIsModelReady(true);
          return;
        }

        if (availability === "missing") {
          setArError("This hologram file is missing on the server. Please re-upload it.");
          return;
        }

        if (availability === "invalid") {
          setArError("This hologram file is corrupted. Please re-upload it.");
          return;
        }

        setArError("Could not load hologram model from the server.");
      })
      .catch(() => {
        if (!cancelled) {
          setArError("Could not load hologram model from the server.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [hologram]);

  // Automatically enter AR mode when hologram is loaded
  useEffect(() => {
    if (hologram && isModelReady && !isLoading && !error && !arError) {
      // Small delay to ensure Canvas is ready
      const timer = setTimeout(() => {
        store.enterAR().catch((err) => {
          console.error("Failed to enter AR:", err);
          setArError("Failed to start AR session. Please ensure you've granted camera permissions and are using a WebXR-compatible browser.");
        });
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [hologram, isModelReady, isLoading, error, arError, store]);

  useEffect(() => {
    setBubbleStatus("enabled");
  }, [id]);

  const handleExit = () => {
    const session = store.getState().session;
    if (session) {
      void session.end().catch(() => {
        navigate("/", { replace: true });
      });
      return;
    }
    navigate("/", { replace: true });
  };

  if (isLoading || (hologram && !isModelReady && !arError)) {
    return (
      <div className="ar-view-container">
        <p className="ar-loading">{isLoading ? "Loading hologram..." : "Preparing hologram for AR..."}</p>
      </div>
    );
  }

  if (error || !hologram) {
    return (
      <div className="ar-view-container">
        <p className="ar-error">{error || "Hologram not found"}</p>
        <button className="ar-back-button" onClick={handleExit} type="button">
          Back to Feed
        </button>
      </div>
    );
  }

  if (arError) {
    return (
      <div className="ar-view-container">
        <p className="ar-error">{arError}</p>
        <button className="ar-back-button" onClick={handleExit} type="button">
          Back to Feed
        </button>
      </div>
    );
  }

  const modelUrl = resolveMediaUrl(hologram.url);
  const bubbleWarning = bubbleStatus === "missing-bubble"
    ? "Bubble effect unavailable for this hologram."
    : bubbleStatus === "error"
      ? "Bubble effect disabled for stability."
      : null;

  return (
    <div className="ar-view-container">
      {xrMode === "immersive-ar" ? (
        <>
          <ARExitButton onClick={handleExit} />
          <ARRecenterButton onClick={() => setPlacementVersion((version) => version + 1)} />
          {bubbleWarning ? (
            <div className="ar-info ar-bubble-warning">
              <h2>Bubble Effect</h2>
              <p>{bubbleWarning}</p>
            </div>
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
          {/* Very bright lighting to ensure visibility */}
          <ambientLight intensity={3} />
          <pointLight position={[0, 2, 0]} intensity={2} />
          <pointLight position={[1, 1, 1]} intensity={2} />
          <pointLight position={[-1, 1, -1]} intensity={2} />
          <ARHologramModel
            url={modelUrl}
            placementVersion={placementVersion}
            onBubbleStatusChange={handleBubbleStatusChange}
          />
        </XR>
      </Canvas>
    </div>
  );
}
