import { useEffect, useState } from "react";

import type { HologramDTO } from "@holoim/contracts";
import { tokens } from "@holoim/design-tokens";
import { glyphAppearance } from "@holoim/xr-ui-core";

import { VIEWER_CONTROL_NAMES } from "../chrome/controlNames";
import { LineIcon } from "../portal/PortalControls";

import { fetchHologram, resolveMediaUrl } from "../feed/api";

type ARQuickLookLinkProps = {
  item: HologramDTO;
};

const MAX_POLLS = 24; // ~2 minutes at 5s intervals
const REST = glyphAppearance({}, { headset: false });

/** The cube in viewfinder brackets (styleguide 6, 9.5), drawn in the link's current colour. */
function CubeGlyph() {
  return (
    <LineIcon appearance={{ ...REST, color: "currentColor" }}>
      <path d={tokens.glyph.path.viewInAr.d} />
    </LineIcon>
  );
}

export function ARQuickLookLink({ item }: ARQuickLookLinkProps) {
  const [current, setCurrent] = useState(item);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    setCurrent(item);
    setTimedOut(false);
  }, [item]);

  useEffect(() => {
    if (current.usdzStatus !== "pending" && current.usdzStatus !== "processing") {
      return;
    }
    let polls = 0;
    let cancelled = false;
    const timer = setInterval(() => {
      polls += 1;
      if (polls > MAX_POLLS) {
        if (!cancelled) setTimedOut(true);
        clearInterval(timer);
        return;
      }
      void fetchHologram(current.id)
        .then((fresh) => {
          if (!cancelled) setCurrent(fresh);
        })
        .catch(() => undefined);
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [current.id, current.usdzStatus]);

  const transparentPixel = "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=";

  if (current.usdzStatus === "ready" && current.usdzUrl) {
    return (
      <a
        rel="ar"
        href={resolveMediaUrl(current.usdzUrl)}
        className="ar-trigger-button ar-quicklook-link"
        aria-label={VIEWER_CONTROL_NAMES.viewInAr}
      >
        <img
          src={transparentPixel}
          alt=""
          aria-hidden="true"
          width={1}
          height={1}
          style={{ position: "absolute", opacity: 0, pointerEvents: "none" }}
        />
        <CubeGlyph />
        <span>{VIEWER_CONTROL_NAMES.viewInAr}</span>
      </a>
    );
  }

  const label =
    current.usdzStatus === "failed" || timedOut
      ? "Preview unavailable"
      : "Preparing preview…";

  return (
    <button
      type="button"
      className="ar-trigger-button ar-quicklook-link"
      aria-label={label}
      disabled
    >
      <CubeGlyph />
      <span>{label}</span>
    </button>
  );
}
