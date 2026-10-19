import type { PortalStore } from "./portalStore";
import { enableTilt } from "./usePortalTriggers";
import { usePortalValue } from "./usePortalValue";

// On-screen controls: the viewer's own, so they live on the screen rather
// than in the hologram (principle 1 in what-a-hologram-is.md).

export function PortalControls({ store, tiltAvailable }: { store: PortalStore; tiltAvailable: boolean }) {
  const paused = usePortalValue(store, (state) => state.paused);
  const mode = usePortalValue(store, (state) => state.mode);
  const tiltStatus = usePortalValue(store, (state) => state.tiltStatus);

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
      {mode === "free" && (
        <button
          type="button"
          className="portal-control"
          aria-label="Return to the author's view"
          title="Return to the author's view"
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
        aria-label={paused ? "Play" : "Pause"}
        title={paused ? "Play" : "Pause"}
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
