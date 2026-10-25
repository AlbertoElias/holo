import { useGLTF } from "@react-three/drei";
import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import type { HologramDTO } from "@holoim/contracts";
import { tokens } from "@holoim/design-tokens";
import { Chip, GlyphControl, Type, useReducedMotion } from "@holoim/ui-dom";
import { controlRowPaddingApx, flatGroundColorAt, relativeLuminance, type ViewTarget } from "@holoim/xr-ui-core";
import { readXrCapabilities } from "@holoim/xr-runtime";

import { isIOSDevice } from "../ar/isIOSDevice";
import { ARQuickLookLink } from "../ar/ARQuickLookLink";
import { VIEWER_CONTROL_NAMES } from "../chrome/controlNames";
import { useElementBox } from "../chrome/useFlatScreen";
import { checkModelAvailability } from "../hologram/modelAvailability";
import type { ModelAvailability } from "../hologram/modelAvailability";
import { PortalControls } from "../portal/PortalControls";
import { createPortalStore } from "../portal/portalStore";
import { PORTAL_VARIANTS, readPortalVariant } from "../portal/portalVariant";
import { usePortalTriggers } from "../portal/usePortalTriggers";
import { usePortalValue } from "../portal/usePortalValue";
import { supportsImmersiveVr, type XrFeedState } from "../xr/xrSupport";
import { resolveMediaUrl } from "./api";
import { HologramCardCanvas, type FrameRect, type HologramRenderInfo } from "./HologramCardCanvas";

type HologramCardProps = {
  item: HologramDTO;
  /** The card nearest the middle of the screen: it plays, sparks and redraws (8.2). */
  active: boolean;
  muted: boolean;
  onToggleMute: () => void;
  preloadNextUrl?: string | undefined;
  target: ViewTarget & { kind: "flat" };
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

type ReachRow = "beside" | "stacked";

/**
 * Whether the reach controls fit beside Play at the input's hit size (1.2,
 * 6.1), or unfold above it on a chip of their own: on a touch phone a take
 * with sound already runs into the back-swipe edge. Play holds the middle
 * and never moves either way.
 */
function useReachRow(footRef: React.RefObject<HTMLElement | null>): ReachRow {
  const [row, setRow] = useState<ReachRow>("beside");
  useLayoutEffect(() => {
    const foot = footRef.current;
    if (!foot || typeof ResizeObserver === "undefined") return undefined;
    const resized = new ResizeObserver(() => measure());
    const measure = () => {
      const play = foot.querySelector<HTMLElement>(".portal-controls-row");
      const side = foot.querySelector<HTMLElement>(".portal-controls-side");
      const reach = foot.querySelector<HTMLElement>(".portal-controls-after-inner");
      if (!play || !side || !reach) return;
      resized.observe(reach);
      const gap = parseFloat(getComputedStyle(side).columnGap) || 0;
      // Return stays beside Play in Free; the reach controls follow it.
      const alwaysBeside = [...side.children].filter((child) => !child.classList.contains("portal-controls-after"));
      const needed = alwaysBeside.reduce((width, child) => width + child.getBoundingClientRect().width + gap, 0) + reach.scrollWidth;
      const chip = play.closest<HTMLElement>(".feed-card-foot-chip");
      const chipEnd = chip ? parseFloat(getComputedStyle(chip).paddingInlineEnd) || 0 : 0;
      const room = foot.clientWidth / 2 - play.getBoundingClientRect().width / 2 - gap - chipEnd;
      setRow(needed > room ? "stacked" : "beside");
    };
    // The controls mount once the model can render, and Return, sound and AR come and go.
    const mutated = new MutationObserver(measure);
    resized.observe(foot);
    mutated.observe(foot, { childList: true, subtree: true });
    measure();
    return () => {
      resized.disconnect();
      mutated.disconnect();
    };
  }, [footRef]);
  return row;
}

function formatByline(item: HologramDTO): string {
  return `By ${item.submittedBy} · ${new Date(item.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
}

export function HologramCard({ item, active, muted, onToggleMute, preloadNextUrl, target, xrFeed }: HologramCardProps) {
  const modelUrl = resolveMediaUrl(item.url);
  const colorAccurateMode = COLOR_ACCURATE_MODE;
  const navigate = useNavigate();
  const reducedMotion = useReducedMotion();
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
  const portalRef = useRef<HTMLDivElement>(null);
  const portalBox = useElementBox(portalRef);
  const reached = useReach(cardRef);
  const footRef = useRef<HTMLDivElement>(null);
  const reachRow = useReachRow(footRef);
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

  // The viewing box: the canvas covers the whole card and Follow frames the
  // cloche (3.4) in this box, between the title and the controls.
  const frameRect = useMemo<FrameRect | null>(
    () => (portalBox && portalBox.width > 0 && portalBox.height > 0 ? { left: portalBox.left, top: portalBox.top, width: portalBox.width, height: portalBox.height } : null),
    [portalBox]
  );
  const cardHeight = cardRef.current?.offsetHeight ?? 0;
  // Each card fills the screen when it is in view; the cloche's foot sits near
  // the bottom of the viewing box, and the char reads the ground behind it (3.2).
  const footFraction = portalBox && cardHeight > 0 ? (portalBox.top + portalBox.height * (1 + tokens.edge.cloche.frameShare) / 2) / cardHeight : 1;
  const soot = useMemo(() => ({ groundLuminance: relativeLuminance(flatGroundColorAt(Math.min(Math.max(footFraction, 0), 1))) }), [footFraction]);
  const portalStyle = { "--portal-open": portalOpen } as CSSProperties;

  const controls = canRenderModel ? (
    <PortalControls store={portal} tiltAvailable={portalTriggers.tilt} active={active} reached={reached}>
      {shouldShowArTrigger && (
        <span className="ar-trigger-button">
          <GlyphControl glyph="viewInAr" label={VIEWER_CONTROL_NAMES.viewInAr} onPress={handleEnterAR} />
        </span>
      )}
      {shouldShowVrTrigger && (
        <span className="vr-trigger-button">
          <GlyphControl glyph="stepInside" label={VIEWER_CONTROL_NAMES.stepInside} onPress={handleEnterVR} />
        </span>
      )}
      {shouldShowQuickLook && <ARQuickLookLink item={item} />}
      {hasAudio && (
        <span className="audio-mute-button">
          <GlyphControl glyph={muted ? "soundOff" : "soundOn"} label={muted ? VIEWER_CONTROL_NAMES.soundOn : VIEWER_CONTROL_NAMES.soundOff} onPress={onToggleMute} />
        </span>
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
      <div
        className="feed-card-bubble-shell"
        tabIndex={canRenderModel ? 0 : -1}
        role="group"
        aria-roledescription="hologram portal"
        aria-label={`${item.hologramName}. Space pauses, arrow keys look around, plus and minus zoom, Escape returns.`}
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
                seed={item.id}
                frameRect={frameRect}
                soot={soot}
              />
            </ModelRenderBoundary>
          ) : (
            <div className="feed-card-model-unavailable">
              <Type variant="captionUnderCard" as="p">{unavailableMessage}</Type>
            </div>
          )}
        </div>
      </div>

      <header className="feed-card-meta">
        <Type variant={target.device === "phone" ? "titlePhoneCard" : "titleDesktop"} as="h2" className="feed-card-title">
          {item.hologramName}
        </Type>
        <Type variant="byline" as="p">
          {formatByline(item)}
        </Type>
      </header>

      <div ref={portalRef} className="feed-card-portal" aria-hidden="true" />

      <div ref={footRef} className="feed-card-foot" data-reach-row={reachRow}>
        {portalOpen > 0 ? (
          // Over the hologram's own picture, text always takes the chip (5.2).
          // Play holds the middle of the row, so the chip pads both ends alike (the row's own padding is for Play at the start).
          <Chip className="feed-card-foot-chip" target={target} overPicture controlRow style={{ paddingInlineStart: controlRowPaddingApx(target).end }}>{controls}</Chip>
        ) : controls}
      </div>
    </article>
  );
}
