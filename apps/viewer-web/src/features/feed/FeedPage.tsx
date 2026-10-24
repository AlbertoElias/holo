import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

import { HologramCard } from "./HologramCard";
import { pickActiveCard } from "./visibility";
import { useFeed } from "./useFeed";
import { UploadPanel } from "../upload/UploadPanel";
import { resumeAudioContext } from "../hologram/useGltfAudio";

export function FeedPage() {
  const { items, isLoading, error, canLoadMore, nextCursor, loadMore, addToTop } = useFeed();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [audioMuted, setAudioMuted] = useState(true);
  const feedRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Leaving an immersive view returns to the hologram that was opened.
  const focusHologramId = (useLocation().state as { focusHologramId?: string } | null)?.focusHologramId ?? null;
  const focusedOnReturn = useRef(false);

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
    if (!feedRef.current) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const id = pickActiveCard(entries);
        if (id) {
          setActiveId(id);
        }
      },
      { threshold: [0.7, 0.85, 1] }
    );

    const cards = feedRef.current.querySelectorAll<HTMLElement>("[data-card-id]");
    cards.forEach((card) => observer.observe(card));

    return () => {
      observer.disconnect();
    };
  }, [items]);

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

  useEffect(() => {
    if (!focusHologramId || focusedOnReturn.current) return;
    const card = feedRef.current?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(focusHologramId)}"]`);
    if (!card) return;
    focusedOnReturn.current = true;
    card.scrollIntoView({ block: "center" });
    setActiveId(focusHologramId);
  }, [focusHologramId, items]);

  useEffect(() => {
    if (!activeId && items[0]) {
      setActiveId(items[0].id);
    }
  }, [activeId, items]);

  const resolvedActiveId = activeId ?? items[0]?.id ?? null;

  const cards = useMemo(
    () =>
      items.map((item, index) => (
        <HologramCard
          key={item.id}
          item={item}
          active={item.id === resolvedActiveId}
          muted={audioMuted}
          onToggleMute={toggleAudioMute}
          preloadNextUrl={items[index + 1]?.url}
        />
      )),
    [items, resolvedActiveId, audioMuted, toggleAudioMute]
  );

  return (
    <main className="app-shell">
      <UploadPanel onUploaded={addToTop} />
      <section ref={feedRef} className="feed-scroll" aria-label="Hologram feed">
        {cards}
        <div ref={sentinelRef} className="feed-sentinel" aria-hidden="true" />
        {isLoading ? <p className="feed-state">Loading…</p> : null}
        {error ? <p className="feed-error">{error}</p> : null}
      </section>
    </main>
  );
}
