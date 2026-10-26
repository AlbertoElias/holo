import { createXRStore } from "@react-three/xr";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import type { HologramDTO } from "@holoim/contracts";
import { readIwerRuntime, readXrCapabilities, type XrCapabilities } from "@holoim/xr-runtime";

import { fetchHologram, resolveMediaUrl } from "../feed/api";
import { checkModelAvailability } from "../hologram/modelAvailability";
import type { SphereClipStatus } from "../hologram/useSphereClipping";
import type { ArPlacementStatus } from "./ARHologramModel";
import { arSessionInit } from "./arSessionInit";
import {
  isPlacementResolved,
  resolveArSupportMessage,
  resolveDepthOcclusionStatus,
  resolvePlacementPreviewStatus,
  shouldRetryArSessionEntry,
  stripProblematicInputSources
} from "./arController";
import { isIOSDevice } from "./isIOSDevice";

const AR_SESSION_CONNECTIVITY_RETRY_DELAY_MS = 100;
// IWSDK's larger development bundle can keep the R3F canvas disconnected while
// Vite completes a cold dependency optimization. Keep retrying long enough for
// that one-time startup without changing how non-connectivity errors surface.
const AR_SESSION_CONNECTIVITY_RETRY_MAX_ATTEMPTS = 100;

type ArStore = ReturnType<typeof createXRStore>;

export type UseArControllerResult = {
  arError: string | null;
  bubbleStatus: SphereClipStatus;
  depthOcclusionStatus: ReturnType<typeof resolveDepthOcclusionStatus>;
  error: string | null;
  handleBubbleStatusChange: (status: SphereClipStatus) => void;
  handleExit: () => void;
  handlePlacementStatusChange: (status: ArPlacementStatus) => void;
  handleRecenter: () => void;
  hologram: HologramDTO | null;
  isLoading: boolean;
  isModelReady: boolean;
  modelUrl: string | null;
  placementStatus: ArPlacementStatus | null;
  placementVersion: number;
  store: ArStore;
  xrCapabilities: XrCapabilities | null;
  xrMode: XRSessionMode | null;
};

function readForcedArSupportOverride(): boolean | null {
  if (typeof window === "undefined") {
    return null;
  }

  const override = (window as Window & { __HOLOIM_AR_SUPPORTED_OVERRIDE__?: boolean }).__HOLOIM_AR_SUPPORTED_OVERRIDE__;
  return typeof override === "boolean" ? override : null;
}

export function useArController(): UseArControllerResult {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [hologram, setHologram] = useState<HologramDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isModelReady, setIsModelReady] = useState(false);
  const [supportError, setSupportError] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [bubbleStatus, setBubbleStatus] = useState<SphereClipStatus>("enabled");
  const [placementStatus, setPlacementStatus] = useState<ArPlacementStatus | null>(null);
  const [placementVersion, setPlacementVersion] = useState(0);
  const [xrCapabilities, setXrCapabilities] = useState<XrCapabilities | null>(null);
  const [activeSession, setActiveSession] = useState<XRSession | null>(null);
  const enteredArRef = useRef(false);
  const activeSessionRef = useRef<XRSession | null>(null);
  const inputSanitizationLoggedRef = useRef(false);
  const forcedArSupport = useMemo(() => readForcedArSupportOverride(), []);

  const store = useMemo(() => {
    // Depth occlusion is disabled under the IWER emulator (see
    // resolveDepthOcclusionStatus), and IWER computes emulated depth with a
    // synchronous GPU readback every frame that stalls software-GL runners.
    const depthSensing = !readIwerRuntime().available;
    const domOverlay = typeof document === "undefined" ? undefined : document.createElement("div");
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
      hitTest: true,
      depthSensing,
      ...(domOverlay ? { domOverlay, customSessionInit: arSessionInit(domOverlay, depthSensing) } : {})
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

  const refreshCapabilities = useCallback((session: XRSession | null, sessionMode: XRSessionMode | null): void => {
    void readXrCapabilities({
      forceImmersiveArSupport: forcedArSupport,
      session,
      sessionMode
    })
      .then((capabilities) => {
        setXrCapabilities(capabilities);
        setSupportError(resolveArSupportMessage(isIOSDevice(), capabilities));
      })
      .catch((err) => {
        console.error("WebXR capability check failed:", err);
        setSupportError("Could not check AR support. Your browser may not support WebXR.");
      });
  }, [forcedArSupport]);

  const handleBubbleStatusChange = useCallback((status: SphereClipStatus) => {
    setBubbleStatus(status);
  }, []);

  const handlePlacementStatusChange = useCallback((status: ArPlacementStatus) => {
    setPlacementStatus(status);
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
        setActiveSession(nextSession);
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

  useEffect(() => {
    if (isIOSDevice()) {
      navigate("/", { replace: true });
      return;
    }

    refreshCapabilities(activeSession, xrMode);
  }, [activeSession, navigate, refreshCapabilities, xrMode]);

  useEffect(() => {
    if (!id) {
      setError("No hologram ID provided");
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);
    setRuntimeError(null);
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
          setRuntimeError("This hologram file is missing on the server. Please re-upload it.");
          return;
        }

        if (availability === "invalid") {
          setRuntimeError("This hologram file is corrupted. Please re-upload it.");
          return;
        }

        setRuntimeError("Could not load hologram model from the server.");
      })
      .catch(() => {
        if (!cancelled) {
          setRuntimeError("Could not load hologram model from the server.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [hologram]);

  useEffect(() => {
    if (hologram && isModelReady && !isLoading && !error && !runtimeError && !supportError) {
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
          if (shouldRetryArSessionEntry(message, attempts, AR_SESSION_CONNECTIVITY_RETRY_MAX_ATTEMPTS) && !cancelled) {
            retryTimer = window.setTimeout(attemptEnterAr, AR_SESSION_CONNECTIVITY_RETRY_DELAY_MS);
            return;
          }

          console.error("Failed to enter AR:", err);
          setRuntimeError("Failed to start AR session. Please ensure you've granted camera permissions and are using a WebXR-compatible browser.");
        });
      };

      retryTimer = window.setTimeout(attemptEnterAr, AR_SESSION_CONNECTIVITY_RETRY_DELAY_MS);

      return () => {
        cancelled = true;
        if (typeof retryTimer === "number") {
          window.clearTimeout(retryTimer);
        }
      };
    }
  }, [error, hologram, isLoading, isModelReady, runtimeError, store, supportError]);

  useEffect(() => {
    setBubbleStatus("enabled");
  }, [id]);

  useEffect(() => {
    if (xrMode !== "immersive-ar" || isPlacementResolved(placementStatus)) {
      return;
    }

    const intervalId = window.setInterval(() => {
      const runtime = readIwerRuntime();
      if (!resolvePlacementPreviewStatus(placementStatus, runtime, false)) {
        return;
      }

      // Re-resolve against the latest status: the model's own placement may be
      // queued but not yet committed (slow software-GL frames), and this
      // closure's status would overwrite it with a position-less preview.
      setPlacementStatus((current) => resolvePlacementPreviewStatus(current, runtime, false) ?? current);
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
    }, 250);

    const timeoutId = window.setTimeout(() => {
      setPlacementStatus((current) => resolvePlacementPreviewStatus(current, readIwerRuntime(), true) ?? current);
      window.clearInterval(intervalId);
    }, 3500);

    return () => {
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
    };
  }, [placementStatus, xrMode]);

  const handleExit = useCallback(() => {
    const session = store.getState().session;
    if (session) {
      void session.end().catch(() => {
        navigate("/", { replace: true });
      });
      return;
    }
    navigate("/", { replace: true });
  }, [navigate, store]);

  const handleRecenter = useCallback(() => {
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
  }, []);

  const arError = runtimeError ?? supportError;
  const modelUrl = hologram ? resolveMediaUrl(hologram.url) : null;
  const depthOcclusionStatus = resolveDepthOcclusionStatus(xrCapabilities);

  return {
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
  };
}
