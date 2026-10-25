import { useGLTF } from "@react-three/drei";
import { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import type { HologramDTO } from "@holoim/contracts";
import { readXrCapabilities } from "@holoim/xr-runtime";

import { isIOSDevice } from "../ar/isIOSDevice";
import { ARQuickLookLink } from "../ar/ARQuickLookLink";
import { checkModelAvailability } from "../hologram/modelAvailability";
import type { ModelAvailability } from "../hologram/modelAvailability";
import { PortalControls } from "../portal/PortalControls";
import { createPortalStore } from "../portal/portalStore";
import { PORTAL_VARIANTS, readPortalVariant } from "../portal/portalVariant";
import { usePortalTriggers } from "../portal/usePortalTriggers";
import { usePortalValue } from "../portal/usePortalValue";
import { supportsImmersiveVr, XR_ENTRY_LABEL, type XrFeedState } from "../xr/xrSupport";
import { resolveMediaUrl } from "./api";
import { HologramCardCanvas, type HologramRenderInfo } from "./HologramCardCanvas";

type HologramCardProps = {
  item: HologramDTO;
  active: boolean;
  muted: boolean;
  onToggleMute: () => void;
  preloadNextUrl?: string | undefined;
  /** The loaded feed and its cursor, carried into XR for the gallery. */
  xrFeed?: () => NonNullable<XrFeedState["feed"]>;
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

export function HologramCard({ item, active, muted, onToggleMute, preloadNextUrl, xrFeed }: HologramCardProps) {
  const modelUrl = resolveMediaUrl(item.url);
  const colorAccurateMode = COLOR_ACCURATE_MODE;
  const navigate = useNavigate();
  const [arSupported, setArSupported] = useState<boolean>(false);
  const [vrSupported, setVrSupported] = useState<boolean>(false);
  const isIOS = useMemo(() => isIOSDevice(), []);
  const forcedArSupport = useMemo(() => {
    if (typeof window === "undefined") {
      return undefined;
    }
    return (window as Window & { __HOLOIM_AR_SUPPORTED_OVERRIDE__?: boolean }).__HOLOIM_AR_SUPPORTED_OVERRIDE__;
  }, []);
  const [modelAvailability, setModelAvailability] = useState<CardModelAvailability>("checking");
  const [modelRenderFailed, setModelRenderFailed] = useState(false);
  const [renderInfo, setRenderInfo] = useState<HologramRenderInfo | null>(null);
  const [hasAudio, setHasAudio] = useState(false);
  const onHasAudio = useCallback((value: boolean) => setHasAudio(value), []);
  const cardRef = useRef<HTMLElement>(null);
  const portal = useMemo(() => createPortalStore(), []);
  const portalVariant = useMemo(() => readPortalVariant(), []);
  const portalTriggers = PORTAL_VARIANTS[portalVariant];
  const portalMode = usePortalValue(portal, (state) => state.mode);
  const portalPaused = usePortalValue(portal, (state) => state.paused);
  // How far the view has gone inside: 0 in Follow or fully zoomed out, 1 at eye level.
  const portalOpen = usePortalValue(portal, (state) => (state.mode === "free" ? Math.round((1 - state.zoom) * 100) / 100 : 0));

  useEffect(() => {
    let cancelled = false;
    setModelAvailability("checking");
    setModelRenderFailed(false);
    setRenderInfo(null);

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
  usePortalTriggers(cardRef, portal, portalTriggers, active && canRenderModel);

  // A card scrolled away starts over in Follow, playing, when it comes back.
  useEffect(() => {
    if (!active) portal.reset();
  }, [active, portal]);
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

    void readXrCapabilities()
      .then((capabilities) => {
        setArSupported(capabilities.supportsImmersiveAr);
      })
      .catch(() => {
        setArSupported(false);
      });
  }, [forcedArSupport]);

  useEffect(() => {
    void supportsImmersiveVr().then(setVrSupported);
  }, []);

  const handleEnterAR = () => {
    // Opting the feed into the IWSDK AR shell carries over to its AR route.
    const shell = new URLSearchParams(window.location.search).get("shell");
    const state: XrFeedState | undefined = xrFeed ? { feed: xrFeed() } : undefined;
    navigate(shell === "iwsdk" ? `/ar/${item.id}?shell=iwsdk` : `/ar/${item.id}`, { state });
  };
  const handleEnterVR = () => {
    const state: XrFeedState | undefined = xrFeed ? { feed: xrFeed() } : undefined;
    navigate(`/vr/${item.id}`, { state });
  };
  const shouldShowVrTrigger = vrSupported && canRenderModel;
  const shouldShowArTrigger = typeof forcedArSupport === "boolean"
    ? forcedArSupport
    : arSupported && !isIOS && canRenderModel;
  const shouldShowQuickLook = item.quickLookEnabled
    && (typeof forcedArSupport === "boolean" ? !forcedArSupport : isIOS && canRenderModel);

  return (
    <article
      ref={cardRef}
      className={portalPaused && !portalTriggers.scrollWhilePaused ? "feed-card portal-captured" : "feed-card"}
      style={{ "--portal-open": portalOpen } as CSSProperties}
      data-card-id={item.id}
      data-portal-variant={portalVariant}
      data-portal-mode={portalMode}
      data-portal-paused={portalPaused ? "true" : "false"}
      data-model-state={modelRenderFailed ? "failed" : renderInfo ? "rendered" : modelAvailability}
      data-model-animations={renderInfo ? String(renderInfo.animationCount) : undefined}
      data-model-bubble={renderInfo ? (renderInfo.bubbleActive ? "active" : "missing") : undefined}
    >
      <div
        className="feed-card-bubble-shell"
        tabIndex={canRenderModel ? 0 : -1}
        role="group"
        aria-roledescription="hologram portal"
        aria-label={`${item.hologramName}. Space pauses, arrow keys look around, plus and minus zoom, Escape returns.`}
      >
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
                onRendered={setRenderInfo}
                colorAccurateMode={colorAccurateMode}
                portal={portal}
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
        {shouldShowVrTrigger && (
          <button
            className={shouldShowArTrigger ? "vr-trigger-button vr-trigger-beside" : "vr-trigger-button"}
            onClick={handleEnterVR}
            type="button"
            title={XR_ENTRY_LABEL.vr}
            aria-label={XR_ENTRY_LABEL.vr}
          >
            {/* Styleguide section 6: a door frame on a threshold, a figure standing in it. */}
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3.5 14.5V3a1.5 1.5 0 0 1 1.5-1.5h6A1.5 1.5 0 0 1 12.5 3v11.5M1.5 14.5h13M7.1 5.2a.9.9 0 1 0 1.8 0a.9.9 0 1 0-1.8 0M8 7v3.5M8 10.5l-1.3 3M8 10.5l1.3 3M6.5 8.5h3" />
            </svg>
          </button>
        )}
        {shouldShowArTrigger && (
          <button
            className="ar-trigger-button"
            onClick={handleEnterAR}
            type="button"
            title={XR_ENTRY_LABEL.ar}
            aria-label={XR_ENTRY_LABEL.ar}
          >
            {/* Styleguide section 6: a cube in viewfinder brackets. */}
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M1.5 4.5v-3h3M11.5 1.5h3v3M14.5 11.5v3h-3M4.5 14.5h-3v-3M8 4.8l3 1.7v3.3L8 11.5 5 9.8V6.5zM5 6.5l3 1.7 3-1.7M8 8.2v3.3" />
            </svg>
          </button>
        )}
        {shouldShowQuickLook && (
          <ARQuickLookLink item={item} />
        )}
        {canRenderModel && (
          <PortalControls store={portal} tiltAvailable={portalTriggers.tilt} />
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
