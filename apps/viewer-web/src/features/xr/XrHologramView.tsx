import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { UiButton, UiNotice, UiStack } from "@holoim/ui-dom";
import type { HologramDTO } from "@holoim/contracts";

import { fetchHologram, fetchHolograms, resolveMediaUrl } from "../feed/api";
import type { GalleryFeed } from "./gallerySystem";
import { createViewerWorld, type ViewerWorld } from "./viewerWorld";
import type { XrViewMode } from "./viewerContext";
import { XR_ENTRY_LABEL, type XrFeedState } from "./xrSupport";

type ViewState = "loading" | "ready" | "immersive" | "error";

/** The IWSDK AR shell is opt-in (`?shell=iwsdk`); leaving it keeps the feed opted in. */
const feedPath = (mode: XrViewMode): string => (mode === "ar" ? "/?shell=iwsdk" : "/");

const galleryItems = (items: readonly HologramDTO[]): GalleryFeed["items"] =>
  items.map((item) => ({ id: item.id, title: item.hologramName, url: resolveMediaUrl(item.url) }));

/** The feed the card was opened from (router state), or its first page on a deep link. */
async function loadFeed(state: XrFeedState | null): Promise<GalleryFeed> {
  if (state?.feed) return { items: galleryItems(state.feed.items), nextCursor: state.feed.nextCursor };
  try {
    const page = await fetchHolograms();
    return { items: galleryItems(page.items), nextCursor: page.nextCursor };
  } catch (error) {
    // The opened hologram still shows; the gallery stays empty.
    console.warn("[xr-viewer] Failed to load the feed for the gallery.", error);
    return { items: [], nextCursor: null };
  }
}

/** `/vr/:id` and `/ar/:id`: one IWSDK World per visit, destroyed on leave. */
export function XrHologramView({ mode }: { mode: XrViewMode }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // Read once per visit: the World keeps paging from here.
  const feedState = useRef((useLocation().state as XrFeedState | null) ?? null).current;
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<ViewerWorld | null>(null);
  const [state, setState] = useState<ViewState>("loading");
  const [title, setTitle] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!id || !container) {
      setError("Hologram not found");
      setState("error");
      return;
    }
    let cancelled = false;
    let viewer: ViewerWorld | null = null;
    // Exit returns to the feed at the last focused hologram.
    const backToFeed = (focusedId: string | null): void =>
      void navigate(feedPath(mode), { replace: true, state: { focusHologramId: focusedId ?? id } });

    void (async () => {
      try {
        const [hologram, feed] = await Promise.all([fetchHologram(id), loadFeed(feedState)]);
        if (cancelled) return;
        setTitle(hologram.hologramName);
        viewer = await createViewerWorld(container, {
          mode,
          initial: { id: hologram.id, url: resolveMediaUrl(hologram.url) },
          feed,
          loadMore: async (cursor) => {
            const page = await fetchHolograms(cursor);
            return { items: galleryItems(page.items), nextCursor: page.nextCursor };
          },
          onSessionEnd: backToFeed
        });
        if (cancelled) {
          viewer.destroy();
          return;
        }
        viewerRef.current = viewer;
        viewer.world.renderer.xr.addEventListener("sessionstart", () => setState("immersive"));
        setState("ready");
        // Still inside the feed tap's activation window: enter straight away.
        if (navigator.userActivation?.isActive) viewer.enter();
      } catch (loadError) {
        if (cancelled) return;
        console.error("[xr-viewer] Failed to open hologram.", loadError);
        setError("This hologram could not be opened.");
        setState("error");
      }
    })();

    return () => {
      cancelled = true;
      viewerRef.current = null;
      viewer?.destroy();
    };
  }, [id, mode, navigate, feedState]);

  return (
    <div className="xr-view-container" data-xr-mode={mode} data-xr-state={state}>
      <div ref={containerRef} className="xr-view-scene" />
      {state !== "immersive" ? (
        <div className="xr-view-entry">
          <UiStack gap="0.75rem" style={{ width: "min(360px, calc(100vw - 32px))" }}>
            {state === "error" ? (
              <UiNotice title="Hologram" tone="danger">{error}</UiNotice>
            ) : (
              <UiNotice title={title || "Hologram"}>
                {state === "loading" ? "Loading hologram…" : "Ready at life size."}
              </UiNotice>
            )}
            {state === "ready" ? (
              <UiButton type="button" onClick={() => viewerRef.current?.enter()}>
                {XR_ENTRY_LABEL[mode]}
              </UiButton>
            ) : null}
            <UiButton type="button" tone="ghost" onClick={() => void navigate(feedPath(mode), { state: { focusHologramId: id } })}>
              Back to feed
            </UiButton>
          </UiStack>
        </div>
      ) : null}
    </div>
  );
}
