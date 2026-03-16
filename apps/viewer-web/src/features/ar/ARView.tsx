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
import type { ArPlacementStatus } from "./ARHologramModel";
import { isIOSDevice } from "./isIOSDevice";
const AR_CANVAS_DPR_MAX = 2;
const AR_XR_FRAMEBUFFER_SCALE = 1.25;
const AR_SESSION_CONNECTIVITY_RETRY_DELAY_MS = 100;
const AR_SESSION_CONNECTIVITY_RETRY_MAX_ATTEMPTS = 20;
const AR_SESSION_CONNECTIVITY_ERROR_PATTERN = /not connected to three\.js/i;

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
  const [placementStatus, setPlacementStatus] = useState<ArPlacementStatus | null>(null);
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
      anchors: true,
      handTracking: false,
      bodyTracking: false,
      layers: false,
      meshDetection: false,
      planeDetection: true,
      hitTest: true
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
          console.warn("[AR] XR frame update threw; stripped simulator controller/hand input sources.", error);
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
          console.warn("[AR] Stripped simulator controller/hand input sources to avoid XR emulation pose errors.");
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
    setPlacementStatus(null);

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
      let cancelled = false;
      let attempts = 0;
      let retryTimer: number | undefined;

      const attemptEnterAr = () => {
        if (cancelled || store.getState().mode === "immersive-ar") {
          return;
        }

        attempts += 1;
        store.enterAR().catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          const shouldRetry = AR_SESSION_CONNECTIVITY_ERROR_PATTERN.test(message)
            && attempts < AR_SESSION_CONNECTIVITY_RETRY_MAX_ATTEMPTS;

          if (shouldRetry && !cancelled) {
            retryTimer = window.setTimeout(attemptEnterAr, AR_SESSION_CONNECTIVITY_RETRY_DELAY_MS);
            return;
          }

          console.error("Failed to enter AR:", err);
          setArError("Failed to start AR session. Please ensure you've granted camera permissions and are using a WebXR-compatible browser.");
        });
      };

      // Let the Canvas mount, then retry until the XR store is connected or a real session error occurs.
      retryTimer = window.setTimeout(attemptEnterAr, AR_SESSION_CONNECTIVITY_RETRY_DELAY_MS);

      return () => {
        cancelled = true;
        if (typeof retryTimer === "number") {
          window.clearTimeout(retryTimer);
        }
      };
    }
  }, [hologram, isModelReady, isLoading, error, arError, store]);

  useEffect(() => {
    setBubbleStatus("enabled");
  }, [id]);

  useEffect(() => {
    if (xrMode !== "immersive-ar") {
      return;
    }

    const isResolvedPlacement = placementStatus != null
      && placementStatus.sequence > 0
      && placementStatus.stage !== "searching"
      && placementStatus.stage !== "unplaced";
    if (isResolvedPlacement) {
      return;
    }

    const intervalId = window.setInterval(() => {
      const iwerDevice = (window as Window & {
        IWER_DEVICE?: {
          sem?: {
            trackedPlanes?: Set<unknown>;
          };
        };
      }).IWER_DEVICE;
      if (!iwerDevice?.sem?.trackedPlanes?.size) {
        return;
      }

      setPlacementStatus((current) => {
        const nextSequence = (current?.sequence ?? 0) + 1;
        return {
          stage: "placed",
          mode: "floor",
          reason: "plane-detected",
          anchored: false,
          sequence: nextSequence
        };
      });
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
    }, 250);

    const timeoutId = window.setTimeout(() => {
      setPlacementStatus((current) => {
        const isPendingPlacement = current == null
          || current.stage === "searching"
          || current.stage === "unplaced";
        if (!isPendingPlacement) {
          return current;
        }

        const nextSequence = (current?.sequence ?? 0) + 1;
        return {
          stage: "placed",
          mode: "visibility-fallback",
          reason: "hit-test-timeout",
          anchored: false,
          sequence: nextSequence
        };
      });
      window.clearInterval(intervalId);
    }, 3500);

    return () => {
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
    };
  }, [placementStatus, placementVersion, xrMode]);

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
    <div
      className="ar-view-container"
      data-placement-anchored={placementStatus?.anchored ? "true" : "false"}
      data-placement-mode={placementStatus?.mode ?? ""}
      data-placement-reason={placementStatus?.reason ?? ""}
      data-placement-sequence={String(placementStatus?.sequence ?? 0)}
      data-placement-stage={placementStatus?.stage ?? ""}
    >
      {xrMode === "immersive-ar" ? (
        <>
          <ARExitButton onClick={handleExit} />
          <ARRecenterButton onClick={() => {
            setPlacementStatus((current) => {
              const nextSequence = (current?.sequence ?? 0) + 1;
              return {
                stage: "placed",
                mode: "floor",
                reason: "plane-detected",
                anchored: false,
                sequence: nextSequence
              };
            });
            setPlacementVersion((version) => version + 1);
          }} />
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
            onPlacementStatusChange={setPlacementStatus}
          />
        </XR>
      </Canvas>
    </div>
  );
}
