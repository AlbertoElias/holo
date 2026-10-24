import { useGLTF } from "@react-three/drei";
import { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import type { HologramDTO } from "@holoim/contracts";
import { tokens } from "@holoim/design-tokens";
import { Chip, GlyphControl, Shade, Type, useReducedMotion } from "@holoim/ui-dom";
import { edgeOutline, edgePathData, type ViewTarget } from "@holoim/xr-ui-core";
import { readXrCapabilities } from "@holoim/xr-runtime";

import { isIOSDevice } from "../ar/isIOSDevice";
import { ARQuickLookLink } from "../ar/ARQuickLookLink";
import { ChromeButton } from "../chrome/ChromeButton";
import { VIEWER_CONTROL_NAMES } from "../chrome/controlNames";
import { useElementBox } from "../chrome/useFlatScreen";
import { checkModelAvailability } from "../hologram/modelAvailability";
import type { ModelAvailability } from "../hologram/modelAvailability";
import { PortalControls } from "../portal/PortalControls";
import { createPortalStore } from "../portal/portalStore";
import { PORTAL_VARIANTS, readPortalVariant } from "../portal/portalVariant";
import { usePortalTriggers } from "../portal/usePortalTriggers";
import { usePortalValue } from "../portal/usePortalValue";
import { resolveMediaUrl } from "./api";
import { HologramCardCanvas, type HologramRenderInfo } from "./HologramCardCanvas";
import { PortalEdge } from "./PortalEdge";

type HologramCardProps = {
  item: HologramDTO;
  /** The card nearest the middle of the screen: it plays, sparks and redraws (8.2). */
  active: boolean;
  muted: boolean;
  onToggleMute: () => void;
  preloadNextUrl?: string | undefined;
  target: ViewTarget & { kind: "flat" };
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

/**
 * A cursor or touch on the card (1.2): the reach controls show while it
 * moves there and for the idle time after, and leave with the mouse.
 */
function useReach(cardRef: React.RefObject<HTMLElement | null>): boolean {
  const [reached, setReached] = useState(false);
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return undefined;
    let timer = 0;
    const reach = () => {
      setReached(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setReached(false), tokens.glyph.idleAfter);
    };
    const leave = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      window.clearTimeout(timer);
      setReached(false);
    };
    card.addEventListener("pointermove", reach);
    card.addEventListener("pointerdown", reach);
    card.addEventListener("focusin", reach);
    card.addEventListener("pointerleave", leave);
    return () => {
      window.clearTimeout(timer);
      card.removeEventListener("pointermove", reach);
      card.removeEventListener("pointerdown", reach);
      card.removeEventListener("focusin", reach);
      card.removeEventListener("pointerleave", leave);
    };
  }, [cardRef]);
  return reached;
}

function formatByline(item: HologramDTO): string {
  return `By ${item.submittedBy} · ${new Date(item.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
}

export function HologramCard({ item, active, muted, onToggleMute, preloadNextUrl, target }: HologramCardProps) {
  const modelUrl = resolveMediaUrl(item.url);
  const colorAccurateMode = COLOR_ACCURATE_MODE;
  const navigate = useNavigate();
  const reducedMotion = useReducedMotion();
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
  const [renderInfo, setRenderInfo] = useState<HologramRenderInfo | null>(null);
  const [hasAudio, setHasAudio] = useState(false);
  const onHasAudio = useCallback((value: boolean) => setHasAudio(value), []);
  const cardRef = useRef<HTMLElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);
  const portalBox = useElementBox(portalRef);
  const reached = useReach(cardRef);
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
      ? "Loading hologram…"
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

  const handleEnterAR = () => {
    navigate(`/ar/${item.id}`);
  };
  const shouldShowArTrigger = typeof forcedArSupport === "boolean"
    ? forcedArSupport
    : arSupported && !isIOS && canRenderModel;
  const shouldShowQuickLook = item.quickLookEnabled
    && (typeof forcedArSupport === "boolean" ? !forcedArSupport : isIOS && canRenderModel);

  // The portal's burnt outline (3.1), seeded by the hologram's id (Q10): the
  // picture is cut to it while the portal is closed, and the edge is drawn on it.
  const outline = useMemo(
    () => (portalBox ? edgeOutline({ seed: item.id, width: portalBox.width, height: portalBox.height }) : null),
    [item.id, portalBox]
  );
  const clipPath = outline && portalOpen === 0 ? `path("${edgePathData(outline.points)}")` : undefined;
  const cardHeight = cardRef.current?.offsetHeight ?? 0;
  // Each card fills the screen when it is in view, so its foot's share of the card is its share of the screen.
  const groundFraction = portalBox && cardHeight > 0 ? (portalBox.top + portalBox.height) / cardHeight : 1;
  const portalStyle = {
    "--portal-open": portalOpen,
    "--portal-x": `${portalBox?.left ?? 0}px`,
    "--portal-y": `${portalBox?.top ?? 0}px`,
    "--portal-inset": `${outline?.inset ?? 0}px`,
    "--portal-radius": `${(outline?.shortSide ?? 0) * tokens.edge.radius}px`
  } as CSSProperties;

  const controls = canRenderModel ? (
    <PortalControls store={portal} tiltAvailable={portalTriggers.tilt} active={active} reached={reached}>
      {shouldShowArTrigger && (
        <span className="ar-trigger-button">
          <GlyphControl glyph="viewInAr" label={VIEWER_CONTROL_NAMES.viewInAr} onPress={handleEnterAR} showLabel />
        </span>
      )}
      {shouldShowQuickLook && <ARQuickLookLink item={item} />}
      {hasAudio && (
        <ChromeButton
          className="audio-mute-button"
          label={muted ? VIEWER_CONTROL_NAMES.soundOn : VIEWER_CONTROL_NAMES.soundOff}
          word={muted ? "Unmute" : "Mute"}
          onPress={onToggleMute}
        />
      )}
    </PortalControls>
  ) : null;

  return (
    <article
      ref={cardRef}
      className={portalPaused && !portalTriggers.scrollWhilePaused ? "feed-card portal-captured" : "feed-card"}
      style={portalStyle}
      data-card-id={item.id}
      data-card-focus={active ? "true" : "false"}
      data-portal-variant={portalVariant}
      data-portal-mode={portalMode}
      data-portal-paused={portalPaused ? "true" : "false"}
      data-model-state={modelRenderFailed ? "failed" : renderInfo ? "rendered" : modelAvailability}
      data-model-animations={renderInfo ? String(renderInfo.animationCount) : undefined}
      data-model-bubble={renderInfo ? (renderInfo.bubbleActive ? "active" : "missing") : undefined}
    >
      <header className="feed-card-meta">
        <Type variant={target.device === "phone" ? "titlePhoneCard" : "titleDesktop"} as="h2" className="feed-card-title">
          {item.hologramName}
        </Type>
        <Type variant="byline" as="p">
          {formatByline(item)}
        </Type>
      </header>

      <div ref={portalRef} className="feed-card-portal">
        <div
          className="feed-card-bubble-shell"
          tabIndex={canRenderModel ? 0 : -1}
          role="group"
          aria-roledescription="hologram portal"
          aria-label={`${item.hologramName}. Space pauses, arrow keys look around, plus and minus zoom, Escape returns.`}
          style={clipPath ? { clipPath } : undefined}
        >
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
                    <Type variant="captionUnderCard" as="p">Hologram failed to load</Type>
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
                  target={target}
                  reducedMotion={reducedMotion}
                />
              </ModelRenderBoundary>
            ) : (
              <div className="feed-card-model-unavailable">
                <Type variant="captionUnderCard" as="p">{unavailableMessage}</Type>
              </div>
            )}
          </div>
        </div>
        {portalBox && portalBox.width > 0 && portalBox.height > 0 && (
          <div className="feed-card-edge-layer">
            <PortalEdge
              seed={item.id}
              width={portalBox.width}
              height={portalBox.height}
              target={target}
              inFocus={active && portalOpen === 0}
              reducedMotion={reducedMotion}
              groundFraction={groundFraction}
            />
          </div>
        )}
        <Shade device={target.device} className="feed-card-shade">
          {portalOpen > 0 ? (
            // Over the hologram's own picture, text always takes the chip (5.2).
            <Chip target={target} overPicture controlRow>{controls}</Chip>
          ) : controls}
        </Shade>
      </div>
    </article>
  );
}
