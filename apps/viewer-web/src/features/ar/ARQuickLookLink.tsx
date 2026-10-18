import { useEffect, useState } from "react";

import type { HologramDTO } from "@holoim/contracts";

import { fetchHologram, resolveMediaUrl } from "../feed/api";

type ARQuickLookLinkProps = {
  item: HologramDTO;
};

const MAX_POLLS = 24; // ~2 minutes at 5s intervals

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
        aria-label="View in AR"
        title="View in Augmented Reality"
      >
        <img
          src={transparentPixel}
          alt=""
          aria-hidden="true"
          width={1}
          height={1}
          style={{ position: "absolute", opacity: 0, pointerEvents: "none" }}
        />
        View in AR
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
      title={label}
      disabled
    >
      {label}
    </button>
  );
}
