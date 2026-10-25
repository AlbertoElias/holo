import { useEffect, useRef, useState, type ReactNode } from "react";

import { tokens } from "@holoim/design-tokens";
import { GlyphControl } from "@holoim/ui-dom";
import { GLYPH_VIEWBOX, formatRunningTime, glyphMetrics, pausedText, type GlyphAppearance } from "@holoim/xr-ui-core";

import { ChromeButton } from "../chrome/ChromeButton";
import { VIEWER_CONTROL_NAMES } from "../chrome/controlNames";
import type { PortalStore } from "./portalStore";
import { enableTilt } from "./usePortalTriggers";
import { usePortalValue } from "./usePortalValue";

// The controls at a card's foot, under its cloche (styleguide 1.2, 6): Play
// or Pause alone in the middle, and Return beside it while the viewer drives.
// The rest unfold from the cursor or touch and leave afterwards: the timecode
// to the left; Free, highlights, tilt, View in your room, Step inside and sound to the right.
// Play never moves as they come and go. They are the viewer's own, on the
// screen rather than in the hologram (principle 1 in what-a-hologram-is.md).

const METRICS = glyphMetrics({ headset: false });

/** A line drawing in the 16 × 16 glyph box, at the icon size and glyph stroke. */
export function LineIcon({ appearance, children }: { appearance: GlyphAppearance; children: ReactNode }) {
  return (
    <svg
      width={METRICS.iconApx}
      height={METRICS.iconApx}
      viewBox={`0 0 ${GLYPH_VIEWBOX} ${GLYPH_VIEWBOX}`}
      fill="none"
      stroke={appearance.color}
      strokeWidth={METRICS.strokeApx * (GLYPH_VIEWBOX / METRICS.iconApx)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: "block", overflow: "visible" }}
    >
      {children}
    </svg>
  );
}

function useNow(intervalMs: number, running: boolean): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => setNow(performance.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, running]);
  return now;
}

/** "Paused · 0:08" beside Play, the running time while it plays (7.2). */
function Timecode({ store, paused, active }: { store: PortalStore; paused: boolean; active: boolean }) {
  useNow(250, active && !paused);
  const ms = store.runtime.playbackSeconds * 1000;
  return (
    <span className="portal-timecode" data-portal-timecode="">
      {paused ? pausedText(ms) : formatRunningTime(ms)}
    </span>
  );
}

export type PortalControlsProps = {
  store: PortalStore;
  tiltAvailable: boolean;
  /** The card is on screen and drawing. */
  active: boolean;
  /** A cursor or touch is on the card: the reach controls show and the always-there set is at full strength. */
  reached: boolean;
  /** More reach controls, after the portal's own (View in your room, Step inside, sound). */
  children?: ReactNode;
};

export function PortalControls({ store, tiltAvailable, active, reached, children }: PortalControlsProps) {
  const paused = usePortalValue(store, (state) => state.paused);
  const mode = usePortalValue(store, (state) => state.mode);
  const tiltStatus = usePortalValue(store, (state) => state.tiltStatus);
  const highlights = usePortalValue(store, (state) => state.highlights);
  const hasHighlights = usePortalValue(store, (state) => state.hasHighlights);
  const [lastUse, setLastUse] = useState(() => performance.now());
  // A touch that lands on a reach control while it is still hidden only reveals it.
  const pressRevealsOnly = useRef(false);
  const now = useNow(tokens.glyph.idleAfter / 4, active);
  const msSinceUse = now - lastUse;
  const use = (action: () => void) => () => {
    setLastUse(performance.now());
    action();
  };

  // A touch that lands on a reach control while it is still hidden only reveals it.
  const reachGuard = {
    onPointerDownCapture: (event: React.PointerEvent) => {
      pressRevealsOnly.current = !reached && event.pointerType === "touch";
    },
    onClickCapture: (event: React.MouseEvent) => {
      if (!pressRevealsOnly.current) return;
      pressRevealsOnly.current = false;
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return (
    <div className="portal-controls" data-reach={reached ? "shown" : "hidden"} data-portal-mode={mode}>
      <div className="portal-controls-reach portal-controls-before" {...reachGuard}>
        <Timecode store={store} paused={paused} active={active} />
      </div>
      <div className="portal-controls-row">
        <GlyphControl
          glyph={paused ? "play" : "pause"}
          label={paused ? VIEWER_CONTROL_NAMES.play : VIEWER_CONTROL_NAMES.pause}
          onPress={use(() => store.togglePause())}
          msSinceUse={msSinceUse}
          approached={reached}
        />
      </div>
      <div className="portal-controls-side">
        {/* Return stays beside Play while looking around, so Play keeps the middle. */}
        {mode === "free" && (
          <GlyphControl glyph="return" label={VIEWER_CONTROL_NAMES.returnToAuthorView} onPress={use(() => store.returnToFollow())} msSinceUse={msSinceUse} approached={reached} />
        )}
        <div className="portal-controls-reach portal-controls-after" {...reachGuard}>
          {mode === "follow" && <GlyphControl glyph="free" label={VIEWER_CONTROL_NAMES.free} onPress={use(() => store.enterFree())} />}
          {hasHighlights && (
            <ChromeButton
              label={VIEWER_CONTROL_NAMES.highlights}
              pressed={highlights}
              title={highlights ? "Hide what the author points at" : "Show what the author points at"}
              onPress={() => store.toggleHighlights()}
              drawnApx={METRICS.iconApx}
            >
              {(appearance) => (
                <LineIcon appearance={appearance}>
                  <path d="M2 14l4.7-4.7" />
                  <path d="M6 6l4 .7-2 2z" />
                  <circle cx="10.7" cy="5.3" r="3.3" strokeDasharray={highlights ? undefined : "1.3 2"} />
                </LineIcon>
              )}
            </ChromeButton>
          )}
          {tiltAvailable && (
            <ChromeButton
              label={tiltStatus === "on" ? VIEWER_CONTROL_NAMES.tiltOff : VIEWER_CONTROL_NAMES.tiltOn}
              pressed={tiltStatus === "on"}
              title={tiltStatus === "denied" ? "Motion access was declined" : tiltStatus === "unsupported" ? "Motion is not available on this device" : undefined}
              disabled={tiltStatus === "unsupported"}
              onPress={() => {
                if (tiltStatus === "on") {
                  store.setTiltStatus("off");
                } else {
                  void enableTilt(store);
                }
              }}
              drawnApx={METRICS.iconApx}
            >
              {(appearance) => (
                <LineIcon appearance={appearance}>
                  <rect x="4.7" y="1.7" width="6.6" height="12.6" rx="1.3" />
                  <path d="M2 6c-.8 1.2-.8 2.8 0 4" />
                  <path d="M14 6c.8 1.2.8 2.8 0 4" />
                </LineIcon>
              )}
            </ChromeButton>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}
