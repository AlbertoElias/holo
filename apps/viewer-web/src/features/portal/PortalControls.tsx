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
// The rest unfold from the cursor or touch and leave afterwards: playback
// (the timecode and sound) to the left; the way out of the screen (View in
// your room or Step inside) to the right, with tilt in its trial variant.
// A drag, the wheel or the arrow keys look around, so no glyph does.
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

/**
 * "Paused · 0:08" beside Play, the running time while it plays (7.2). It keeps
 * the paused text's width either way, so pausing never reflows the row.
 */
function Timecode({ store, paused, active }: { store: PortalStore; paused: boolean; active: boolean }) {
  useNow(250, active && !paused);
  const ms = store.runtime.playbackSeconds * 1000;
  return (
    <span className="portal-timecode" data-portal-timecode="">
      <span>{paused ? pausedText(ms) : formatRunningTime(ms)}</span>
      <span className="portal-timecode-room" aria-hidden="true">{pausedText(ms)}</span>
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
  /** Playback reach controls after the timecode, left of Play (sound). */
  playback?: ReactNode;
  /** Reach controls right of Play: the way out of the screen (View in your room or Step inside). */
  children?: ReactNode;
};

export function PortalControls({ store, tiltAvailable, active, reached, playback, children }: PortalControlsProps) {
  const paused = usePortalValue(store, (state) => state.paused);
  const mode = usePortalValue(store, (state) => state.mode);
  const tiltStatus = usePortalValue(store, (state) => state.tiltStatus);
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
        {playback}
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
          <div className="portal-controls-after-inner">
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
    </div>
  );
}
