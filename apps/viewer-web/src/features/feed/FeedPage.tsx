import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

import { tokens } from "@holoim/design-tokens";
import { Chip, Dock, GlyphControl, HandednessPicker, SideSheet, useHandedness } from "@holoim/ui-dom";
import { nearestToMiddle } from "@holoim/xr-ui-core";

import { VIEWER_CONTROL_NAMES } from "../chrome/controlNames";
import { useFlatTarget } from "../chrome/useFlatScreen";
import { resumeAudioContext } from "../hologram/useGltfAudio";
import type { HologramDTO } from "@holoim/contracts";

import { AuthPanel } from "../auth/AuthPanel";
import { useCurrentUser } from "../auth/useCurrentUser";
import { UploadPanel, type UploadStatus } from "../upload/UploadPanel";
import { deleteHologram } from "./api";
import { FeedNotice, type FeedNoticeContent } from "./FeedNotice";
import { HologramCard } from "./HologramCard";
import { nearFocus, nextModelLoads } from "./modelLoadOrder";
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

/**
 * Newer holograms arriving above the top card (the API's list replacing the
 * edge snapshot) leave a reader at the top on the newest. Scroll snapping
 * would otherwise hold the card they were on, now further down the feed.
 */
function useStayOnNewest(feedRef: React.RefObject<HTMLElement | null>, firstId: string | null): void {
  const atTop = useRef(true);
  const shownFirst = useRef(firstId);
  useEffect(() => {
    const feed = feedRef.current;
    if (!feed) return undefined;
    const update = () => {
      atTop.current = feed.scrollTop < 1;
    };
    feed.addEventListener("scroll", update, { passive: true });
    return () => feed.removeEventListener("scroll", update);
  }, [feedRef]);
  useLayoutEffect(() => {
    if (firstId === shownFirst.current) return;
    shownFirst.current = firstId;
    if (atTop.current) feedRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [feedRef, firstId]);
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
  const { items, isLoading, error, canLoadMore, nextCursor, loadMore, addToTop, removeItem, retry } = useFeed();
  const { user, logout } = useCurrentUser();
  const userId = user?.id ?? null;

  useEffect(() => {
    // Reload so ownedByViewer flags match the signed-in state.
    void retry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const handleDelete = useCallback(
    async (item: HologramDTO) => {
      await deleteHologram(item.id);
      removeItem(item.id);
    },
    [removeItem]
  );
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
  useStayOnNewest(feedRef, items[0]?.id ?? null);
  // Leaving an immersive view returns to the hologram that was opened.
  const focusHologramId = (useLocation().state as { focusHologramId?: string } | null)?.focusHologramId ?? null;
  const focusedOnReturn = useRef(false);
  // Entering XR carries the loaded feed and its cursor to the gallery (router state).
  const feedSnapshot = useRef({ items, nextCursor: nextCursor ?? null });
  feedSnapshot.current = { items, nextCursor: nextCursor ?? null };
  const xrFeed = useCallback(() => feedSnapshot.current, []);

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

  useEffect(() => {
    if (!focusHologramId || focusedOnReturn.current) return;
    const card = feedRef.current?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(focusHologramId)}"]`);
    if (!card) return;
    focusedOnReturn.current = true;
    // Focus follows the card nearest the middle, so scrolling to it focuses it.
    card.scrollIntoView({ block: "center" });
  }, [focusHologramId, items]);

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

  // Holograms download in feed order rather than all at once (modelLoadOrder.ts).
  const [loadsStarted, setLoadsStarted] = useState<ReadonlySet<string>>(() => new Set());
  const [loadsSettled, setLoadsSettled] = useState<ReadonlySet<string>>(() => new Set());
  const itemIds = useMemo(() => items.map((item) => item.id), [items]);
  useEffect(() => {
    const next = nextModelLoads(itemIds, resolvedFocusId, loadsStarted, loadsSettled);
    if (next.length > 0) setLoadsStarted((current) => new Set([...current, ...next]));
  }, [itemIds, resolvedFocusId, loadsStarted, loadsSettled]);
  // The cards next in line check their file early, so a download starts as soon as its turn comes.
  const loadsNear = useMemo(() => new Set(nearFocus(itemIds, resolvedFocusId)), [itemIds, resolvedFocusId]);
  const onModelSettled = useCallback((id: string) => {
    setLoadsSettled((current) => (current.has(id) ? current : new Set([...current, id])));
  }, []);
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
      items.map((item) => (
        <HologramCard
          key={item.id}
          item={item}
          active={item.id === resolvedFocusId}
          muted={audioMuted}
          onToggleMute={toggleAudioMute}
          onDelete={handleDelete}
          loadTurn={loadsStarted.has(item.id) ? "load" : loadsNear.has(item.id) ? "check" : "wait"}
          onModelSettled={onModelSettled}
          target={target}
          xrFeed={xrFeed}
        />
      )),
    [items, resolvedFocusId, audioMuted, toggleAudioMute, handleDelete, loadsStarted, loadsNear, onModelSettled, target, xrFeed]
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
        <AuthPanel user={user} onSignOut={logout} />
      </SideSheet>
      <SideSheet open={uploadOpen} title="Upload a hologram" onClose={() => setUploadOpen(false)} target={target}>
        <UploadPanel onUploaded={onUploaded} onStatus={setUploadStatus} currentUser={user} />
      </SideSheet>
      <FeedNotice notice={notice} target={target} />
    </main>
  );
}
