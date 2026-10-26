import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { tokens } from "@holoim/design-tokens";
import { Chip, Dock, GlyphControl, HandednessPicker, SideSheet, useHandedness } from "@holoim/ui-dom";
import { nearestToMiddle } from "@holoim/xr-ui-core";

import { VIEWER_CONTROL_NAMES } from "../chrome/controlNames";
import { useFlatTarget } from "../chrome/useFlatScreen";
import { resumeAudioContext } from "../hologram/useGltfAudio";
import { UploadPanel, type UploadStatus } from "../upload/UploadPanel";
import { FeedNotice, type FeedNoticeContent } from "./FeedNotice";
import { HologramCard } from "./HologramCard";
import { useFeed } from "./useFeed";

function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

/** The card nearest the middle of the feed's window (styleguide 8.2): it plays, sparks and redraws. */
function useFocusedCard(feedRef: React.RefObject<HTMLElement | null>, itemCount: number): string | null {
  const [focused, setFocused] = useState<string | null>(null);
  useEffect(() => {
    const feed = feedRef.current;
    if (!feed) return undefined;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const view = feed.getBoundingClientRect();
      const cards = Array.from(feed.querySelectorAll<HTMLElement>("[data-card-id]")).map((card) => {
        const box = card.getBoundingClientRect();
        return { id: card.dataset.cardId ?? "", centerX: box.left - view.left + box.width / 2, centerY: box.top - view.top + box.height / 2 };
      });
      const next = nearestToMiddle(cards, { width: view.width, height: view.height });
      setFocused((current) => (next === null || next === current ? current : next));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    feed.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      feed.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [feedRef, itemCount]);
  return focused;
}

function uploadNotice(status: UploadStatus): FeedNoticeContent {
  switch (status.kind) {
    case "uploading":
      return { kind: "upload", text: `Uploading “${status.name}”…` };
    case "uploaded":
      return { kind: "upload", text: `Uploaded “${status.name}”` };
    case "error":
      return { kind: "error", text: status.message };
  }
}

export function FeedPage() {
  const { items, isLoading, error, canLoadMore, nextCursor, loadMore, addToTop, retry } = useFeed();
  const target = useFlatTarget();
  const online = useOnline();
  const [audioMuted, setAudioMuted] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [handedness, setHandedness] = useHandedness();
  const [uploadStatus, setUploadStatus] = useState<UploadStatus | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const focusedId = useFocusedCard(feedRef, items.length);

  const toggleAudioMute = useCallback(() => {
    setAudioMuted((prev) => {
      const next = !prev;
      if (!next) {
        resumeAudioContext();
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !canLoadMore || !nextCursor) {
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void loadMore();
      }
    });

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [canLoadMore, loadMore, nextCursor]);

  // "Uploaded" stays as long as an unused control stays bright, then leaves.
  useEffect(() => {
    if (uploadStatus?.kind !== "uploaded") return undefined;
    const timer = window.setTimeout(() => setUploadStatus(null), tokens.glyph.idleAfter);
    return () => window.clearTimeout(timer);
  }, [uploadStatus]);

  const onUploaded = useCallback((item: Parameters<typeof addToTop>[0]) => {
    addToTop(item);
    setUploadOpen(false);
    feedRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [addToTop]);

  const resolvedFocusId = focusedId ?? items[0]?.id ?? null;
  const notice: FeedNoticeContent | null = uploadStatus
    ? uploadNotice(uploadStatus)
    : !online
      ? { kind: "offline", text: "You're offline. The feed loads again when you're back online." }
      : error
        ? { kind: "error", text: error, action: { label: VIEWER_CONTROL_NAMES.retry, onPress: () => void retry() } }
        : isLoading && items.length === 0
          ? { kind: "loading", text: "Loading holograms…" }
          : !isLoading && items.length === 0 && !uploadOpen
            ? // Upload's own sheet already answers the empty feed; the notice would sit on its title.
              { kind: "empty", text: "No holograms yet. Upload one to start the feed." }
            : null;

  const cards = useMemo(
    () =>
      items.map((item, index) => (
        <HologramCard
          key={item.id}
          item={item}
          active={item.id === resolvedFocusId}
          muted={audioMuted}
          onToggleMute={toggleAudioMute}
          preloadNextUrl={items[index + 1]?.url}
          target={target}
        />
      )),
    [items, resolvedFocusId, audioMuted, toggleAudioMute, target]
  );

  return (
    <main className="app-shell" data-flat-device={target.device}>
      <section ref={feedRef} className="feed-scroll" aria-label="Hologram feed">
        {cards}
        <div ref={sentinelRef} className="feed-sentinel" aria-hidden="true" />
      </section>
      {/* A sheet answers Upload or Settings; on a phone it covers the screen, and the dock would show through it. */}
      <Dock className="feed-dock" aria-label="Feed" ground="horizon" style={uploadOpen || settingsOpen ? { visibility: "hidden" } : undefined}>
        <GlyphControl glyph="upload" label={VIEWER_CONTROL_NAMES.openUpload} onPress={() => setUploadOpen(true)} />
      </Dock>
      {/* Settings waits in the corner its sheet unfolds from (1.2), apart from the dock's making. Its chip all but
          vanishes on the night sky and keeps the word legible over a hologram's picture. No drawing yet: the word stands in. */}
      <Chip className="feed-settings" style={uploadOpen || settingsOpen ? { visibility: "hidden" } : undefined}>
        <GlyphControl glyph={null} label={VIEWER_CONTROL_NAMES.openSettings} onPress={() => setSettingsOpen(true)} />
      </Chip>
      <SideSheet open={settingsOpen} title="Settings" onClose={() => setSettingsOpen(false)} target={target}>
        <HandednessPicker value={handedness} onChange={setHandedness} wristControl={VIEWER_CONTROL_NAMES.exitAr} />
      </SideSheet>
      <SideSheet open={uploadOpen} title="Upload a hologram" onClose={() => setUploadOpen(false)} target={target}>
        <UploadPanel onUploaded={onUploaded} onStatus={setUploadStatus} />
      </SideSheet>
      <FeedNotice notice={notice} target={target} />
    </main>
  );
}
