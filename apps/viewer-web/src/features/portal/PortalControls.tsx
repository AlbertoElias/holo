import { CONTROL_NAMES } from "@holoim/xr-ui-core";

import type { PortalStore } from "./portalStore";
import { enableTilt } from "./usePortalTriggers";
import { usePortalValue } from "./usePortalValue";

// On-screen controls: the viewer's own, so they live on the screen rather
// than in the hologram (principle 1 in what-a-hologram-is.md).

export function PortalControls({ store, tiltAvailable }: { store: PortalStore; tiltAvailable: boolean }) {
  const paused = usePortalValue(store, (state) => state.paused);
  const mode = usePortalValue(store, (state) => state.mode);
  const tiltStatus = usePortalValue(store, (state) => state.tiltStatus);
  const highlights = usePortalValue(store, (state) => state.highlights);
  const hasHighlights = usePortalValue(store, (state) => state.hasHighlights);

  return (
    <div className="portal-controls">
      {tiltAvailable && (
        <button
          type="button"
          className="portal-control"
          aria-pressed={tiltStatus === "on"}
          aria-label={tiltStatus === "on" ? "Stop looking around by tilting" : "Look around by tilting the phone"}
          title={tiltStatus === "denied" ? "Motion access was declined" : tiltStatus === "unsupported" ? "Motion is not available on this device" : undefined}
          disabled={tiltStatus === "unsupported"}
          onClick={() => {
            if (tiltStatus === "on") {
              store.setTiltStatus("off");
            } else {
              void enableTilt(store);
            }
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="7" y="2.5" width="10" height="19" rx="2" />
            <path d="M3 9c-1.2 1.8-1.2 4.2 0 6" />
            <path d="M21 9c1.2 1.8 1.2 4.2 0 6" />
          </svg>
        </button>
      )}
      {hasHighlights && (
        <button
          type="button"
          className="portal-control"
          aria-pressed={highlights}
          aria-label="Highlight what the author points at"
          title={highlights ? "Hide what the author points at" : "Show what the author points at"}
          onClick={() => store.toggleHighlights()}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 21l7-7" />
            <path d="M9 9l6 1-3 3z" />
            <circle cx="16" cy="8" r="5" strokeDasharray={highlights ? undefined : "2 3"} />
          </svg>
        </button>
      )}
      {mode === "free" && (
        <button
          type="button"
          className="portal-control"
          aria-label={CONTROL_NAMES.returnToAuthorView}
          title={CONTROL_NAMES.returnToAuthorView}
          onClick={() => store.returnToFollow()}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <path d="M3 3v6h6" />
            <circle cx="12" cy="12" r="2" />
          </svg>
        </button>
      )}
      <button
        type="button"
        className="portal-control portal-control-primary"
        aria-label={paused ? CONTROL_NAMES.play : CONTROL_NAMES.pause}
        title={paused ? CONTROL_NAMES.play : CONTROL_NAMES.pause}
        onClick={() => store.togglePause()}
      >
        {paused ? (
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M8 5v14l11-7z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        )}
      </button>
    </div>
  );
}
