import { useGLTF } from "@react-three/drei";
import { Component, useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import type { HologramDTO } from "@holoim/contracts";

import { isIOSDevice } from "../ar/isIOSDevice";
import { ARQuickLookLink } from "../ar/ARQuickLookLink";
import { checkModelAvailability } from "../hologram/modelAvailability";
import type { ModelAvailability } from "../hologram/modelAvailability";
import { resolveMediaUrl } from "./api";
import { HologramCardCanvas } from "./HologramCardCanvas";

type HologramCardProps = {
  item: HologramDTO;
  active: boolean;
  muted: boolean;
  onToggleMute: () => void;
  preloadNextUrl?: string | undefined;
};

type CardModelAvailability = ModelAvailability | "checking";

const COLOR_ACCURATE_MODE = true;

type ModelRenderBoundaryProps = {
  children: ReactNode;
  fallback: ReactNode;
  resetKey: string;
  onError?: (error: unknown) => void;
};

type ModelRenderBoundaryState = {
  hasError: boolean;
};

class ModelRenderBoundary extends Component<ModelRenderBoundaryProps, ModelRenderBoundaryState> {
  state: ModelRenderBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ModelRenderBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    this.props.onError?.(error);
  }

  componentDidUpdate(prevProps: Readonly<ModelRenderBoundaryProps>): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback;
    }

    return this.props.children;
  }
}

export function HologramCard({ item, active, muted, onToggleMute, preloadNextUrl }: HologramCardProps) {
  const modelUrl = resolveMediaUrl(item.url);
  const colorAccurateMode = COLOR_ACCURATE_MODE;
  const navigate = useNavigate();
  const [arSupported, setArSupported] = useState<boolean>(false);
  const isIOS = useMemo(() => isIOSDevice(), []);
  const forcedArSupport = useMemo(() => {
    if (typeof window === "undefined") {
      return undefined;
    }
    return (window as Window & { __HOLOIM_AR_SUPPORTED_OVERRIDE__?: boolean }).__HOLOIM_AR_SUPPORTED_OVERRIDE__;
  }, []);
  const [modelAvailability, setModelAvailability] = useState<CardModelAvailability>("checking");
  const [modelRenderFailed, setModelRenderFailed] = useState(false);
  const [hasAudio, setHasAudio] = useState(false);
  const onHasAudio = useCallback((value: boolean) => setHasAudio(value), []);

  useEffect(() => {
    let cancelled = false;
    setModelAvailability("checking");
    setModelRenderFailed(false);

    checkModelAvailability(modelUrl)
      .then((availability) => {
        if (!cancelled) {
          setModelAvailability(availability);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setModelAvailability("unreachable");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [modelUrl]);

  const canRenderModel = modelAvailability === "ready" && !modelRenderFailed;
  const unavailableMessage = modelRenderFailed
    ? "Hologram failed to load"
    : modelAvailability === "checking"
      ? "Loading hologram..."
      : modelAvailability === "missing"
        ? "Hologram file missing"
        : modelAvailability === "invalid"
          ? "Hologram file corrupted"
          : "Hologram unavailable";

  useEffect(() => {
    if (!canRenderModel) {
      setHasAudio(false);
      return;
    }

    useGLTF.preload(modelUrl);
    if (preloadNextUrl) {
      const preloadUrl = resolveMediaUrl(preloadNextUrl);
      void checkModelAvailability(preloadUrl).then((availability) => {
        if (availability === "ready") {
          useGLTF.preload(preloadUrl);
        }
      });
    }
  }, [canRenderModel, modelUrl, preloadNextUrl]);

  useEffect(() => {
    if (typeof forcedArSupport === "boolean") {
      setArSupported(forcedArSupport);
      return;
    }

    if (!navigator.xr) {
      setArSupported(false);
      return;
    }

    navigator.xr.isSessionSupported("immersive-ar")
      .then((supported) => {
        setArSupported(supported);
      })
      .catch(() => {
        setArSupported(false);
      });
  }, [forcedArSupport]);

  const handleEnterAR = () => {
    navigate(`/ar/${item.id}`);
  };
  const shouldShowArTrigger = typeof forcedArSupport === "boolean"
    ? forcedArSupport
    : arSupported && !isIOS && canRenderModel;
  const shouldShowQuickLook = typeof forcedArSupport === "boolean"
    ? !forcedArSupport
    : isIOS && canRenderModel;

  return (
    <article className="feed-card" data-card-id={item.id}>
      <div className="feed-card-bubble-shell">
        <div className="feed-card-bubble-glow" aria-hidden="true" />
        <div className="feed-card-bubble-aura" aria-hidden="true" />
        <div className="feed-card-bubble">
          {canRenderModel ? (
            <ModelRenderBoundary
              resetKey={modelUrl}
              onError={(error) => {
                console.error("Failed to render hologram card model.", error);
                setModelRenderFailed(true);
                setHasAudio(false);
              }}
              fallback={(
                <div className="feed-card-model-unavailable">
                  <p>Hologram failed to load</p>
                </div>
              )}
            >
              <HologramCardCanvas
                modelUrl={modelUrl}
                active={active}
                muted={muted}
                onHasAudio={onHasAudio}
                colorAccurateMode={colorAccurateMode}
              />
            </ModelRenderBoundary>
          ) : (
            <div className="feed-card-model-unavailable">
              <p>{unavailableMessage}</p>
            </div>
          )}
        </div>
        <div className="feed-card-bubble-rim" aria-hidden="true" />
      </div>
      <div className="feed-card-bubble-base" aria-hidden="true" />

      <div className="feed-card-overlay">
        <span className="feed-card-badge">Hologram</span>
        {shouldShowArTrigger && (
          <button
            className="ar-trigger-button"
            onClick={handleEnterAR}
            type="button"
            title="View in Augmented Reality"
            aria-label="View in AR"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 7V4a2 2 0 0 1 2-2h3" />
              <path d="M22 7V4a2 2 0 0 0-2-2h-3" />
              <path d="M2 17v3a2 2 0 0 0 2 2h3" />
              <path d="M22 17v3a2 2 0 0 1-2 2h-3" />
              <text x="12" y="15" fontSize="9" fontWeight="bold" textAnchor="middle" fill="currentColor" stroke="none">AR</text>
            </svg>
          </button>
        )}
        {shouldShowQuickLook && (
          <ARQuickLookLink hologramId={item.id} />
        )}
        {hasAudio && (
          <button
            className="audio-mute-button"
            onClick={onToggleMute}
            type="button"
            title={muted ? "Unmute" : "Mute"}
            aria-label={muted ? "Unmute audio" : "Mute audio"}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              {muted ? (
                <>
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </>
              ) : (
                <>
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                </>
              )}
            </svg>
          </button>
        )}
        <div className="feed-card-meta">
          <h2>{item.hologramName}</h2>
          <p>{`By ${item.submittedBy} - ${new Date(item.createdAt).toLocaleString()}`}</p>
        </div>
      </div>
    </article>
  );
}
