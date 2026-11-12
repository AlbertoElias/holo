import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { tokens } from "@holoim/design-tokens";
import { Chip, Dock, GlyphControl, HandednessPicker, SettingsSection, SideSheet, Type, useHandedness } from "@holoim/ui-dom";
import { nearestToMiddle } from "@holoim/xr-ui-core";

import { VIEWER_CONTROL_NAMES } from "../chrome/controlNames";
import { useFlatTarget } from "../chrome/useFlatScreen";
import { resumeAudioContext } from "../hologram/useGltfAudio";
import type { HologramDTO } from "@holoim/contracts";

import { AuthPanel } from "../auth/AuthPanel";
import { SignInForm } from "../auth/SignInForm";
import { useCurrentUser } from "../auth/useCurrentUser";
import { UploadPanel, type UploadStatus } from "../upload/UploadPanel";
import { deleteHologram, fetchCreator } from "./api";
import { FeedNotice, type FeedNoticeContent } from "./FeedNotice";
import { HologramCard } from "./HologramCard";
import { nearFocus, nextModelLoads } from "./modelLoadOrder";
import { useFeed, type FeedSource } from "./useFeed";

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

/** A creator's name, for the page that lists their holograms. `missing` is a 404 from the API. */
function useCreatorName(source: FeedSource): { name: string | null; missing: boolean } {
  const ownerId = source.kind === "creator" ? source.ownerId : null;
  const [creator, setCreator] = useState<{ name: string | null; missing: boolean }>({ name: null, missing: false });
  useEffect(() => {
    if (!ownerId) return undefined;
    let cancelled = false;
    fetchCreator(ownerId)
      .then((found) => {
        if (!cancelled) setCreator({ name: found?.displayName ?? null, missing: found === null });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ownerId]);
  return creator;
}

/** What the feed says when it has nothing to show, by what it was asked for. */
function emptyText(source: FeedSource, creatorName: string | null, creatorMissing: boolean): string {
  switch (source.kind) {
    case "search":
      return `Nothing matches “${source.q}”.`;
    case "creator":
      return creatorMissing ? "This creator does not exist." : `${creatorName ?? "This creator"} has no holograms yet.`;
    case "one":
      return "This hologram is not here any more. It may have been deleted.";
    default:
      return "No holograms yet. Upload one to start the feed.";
  }
}

/** The URL a shared hologram opens at. */
function hologramLink(id: string): string {
  return new URL(`/h/${id}`, window.location.origin).toString();
}

/** The word that names where the feed is narrowed to, shown top left; null on the plain feed. */
function contextLabel(source: FeedSource, creatorName: string | null): string | null {
  if (source.kind === "search") return `“${source.q}”`;
  if (source.kind === "creator") return creatorName;
  return null;
}

export function FeedPage({ source = { kind: "all" } }: { source?: FeedSource }) {
  const { items, isLoading, error, canLoadMore, nextCursor, loadMore, addToTop, removeItem, retry } = useFeed(source);
  const { user, isLoading: isUserLoading, logout } = useCurrentUser();
  const userId = user?.id ?? null;
  const navigate = useNavigate();
  const location = useLocation();
  const creator = useCreatorName(source);
  const [flash, setFlash] = useState<FeedNoticeContent | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");

  useEffect(() => {
    // Reload so ownedByViewer flags match the signed-in state.
    void retry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const handleDelete = useCallback(
    async (item: HologramDTO) => {
      try {
        await deleteHologram(item.id);
      } catch (caught) {
        setFlash({ kind: "error", text: caught instanceof Error ? caught.message : "Could not delete the hologram." });
        return;
      }
      removeItem(item.id);
      // The page of a deleted hologram has nothing left to show: go to the feed.
      if (source.kind === "one") navigate("/", { replace: true });
    },
    [removeItem, source.kind, navigate]
  );
  // The link to the hologram's own page: the phone's share sheet where it has one, else the clipboard.
  const handleShare = useCallback(async (item: HologramDTO) => {
    const url = hologramLink(item.id);
    try {
      if (typeof navigator.share === "function" && window.matchMedia("(pointer: coarse)").matches) {
        await navigator.share({ title: item.hologramName, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setFlash({ kind: "upload", text: "Link copied" });
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return; // the share sheet was closed
      // Clipboard refused (a browser setting, an insecure origin): show the link to copy by hand.
      setFlash({ kind: "error", text: url });
    }
  }, []);
  useEffect(() => {
    if (!flash) return undefined;
    // An error here is a link to copy by hand, so it stays longer than a confirmation.
    const timer = window.setTimeout(() => setFlash(null), tokens.glyph.idleAfter * (flash.kind === "error" ? 3 : 1));
    return () => window.clearTimeout(timer);
  }, [flash]);
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
  const focusHologramId = (location.state as { focusHologramId?: string } | null)?.focusHologramId ?? null;
  const focusedOnReturn = useRef(false);
  // Entering XR carries the loaded feed and its cursor to the gallery (router state).
  const returnTo = `${location.pathname}${location.search}`;
  const filter = source.kind === "search" ? { q: source.q } : source.kind === "creator" ? { ownerId: source.ownerId } : undefined;
  const feedSnapshot = useRef({ items, nextCursor: nextCursor ?? null, ...(filter ? { filter } : {}), returnTo });
  feedSnapshot.current = { items, nextCursor: nextCursor ?? null, ...(filter ? { filter } : {}), returnTo };
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
    // A new hologram joins the list only where it belongs: the plain feed, or its creator's own page.
    if (source.kind === "all" || (source.kind === "creator" && item.ownerId === source.ownerId)) addToTop(item);
    setUploadOpen(false);
    feedRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [addToTop, source]);

  const resolvedFocusId = focusedId ?? items[0]?.id ?? null;
  const sheetOpen = uploadOpen || settingsOpen || searchOpen;
  const context = contextLabel(source, creator.name ?? items[0]?.submittedBy ?? null);
  const openSearch = useCallback(() => {
    setSearchText(source.kind === "search" ? source.q : "");
    setSearchOpen(true);
  }, [source]);
  // An empty search goes back to the plain feed; a word goes to its result page.
  const submitSearch = useCallback(
    (event?: { preventDefault: () => void }) => {
      event?.preventDefault();
      const text = searchText.trim();
      setSearchOpen(false);
      navigate(text ? `/?q=${encodeURIComponent(text)}` : "/");
    },
    [searchText, navigate]
  );

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
  const emptyMessage = emptyText(source, creator.name, creator.missing);
  const notice: FeedNoticeContent | null = uploadStatus
    ? uploadNotice(uploadStatus)
    : flash
      ? flash
      : !online
      ? { kind: "offline", text: "You're offline. The feed loads again when you're back online." }
      : error
        ? { kind: "error", text: error, action: { label: VIEWER_CONTROL_NAMES.retry, onPress: () => void retry() } }
        : // A search page can come back empty with a cursor (the server read its share of rows); more is on the way.
          (isLoading || canLoadMore) && items.length === 0
          ? { kind: "loading", text: "Loading holograms…" }
          : items.length === 0 && !uploadOpen && !settingsOpen && !searchOpen
            ? // A sheet already answers the empty feed; the notice would sit on its title.
              { kind: "empty", text: emptyMessage }
            : null;

  const cards = useMemo(
    () =>
      items.map((item, index) => (
        <HologramCard
          key={item.id}
          first={index === 0}
          item={item}
          active={item.id === resolvedFocusId}
          muted={audioMuted}
          onToggleMute={toggleAudioMute}
          onDelete={handleDelete}
          onShare={handleShare}
          linkTitle={source.kind !== "one"}
          loadTurn={loadsStarted.has(item.id) ? "load" : loadsNear.has(item.id) ? "check" : "wait"}
          onModelSettled={onModelSettled}
          target={target}
          xrFeed={xrFeed}
        />
      )),
    [items, resolvedFocusId, audioMuted, toggleAudioMute, handleDelete, handleShare, source.kind, loadsStarted, loadsNear, onModelSettled, target, xrFeed]
  );

  return (
    <main className="app-shell" data-flat-device={target.device} data-narrowed={context ? "" : undefined}>
      <section ref={feedRef} className="feed-scroll" aria-label="Hologram feed">
        {cards}
        <div ref={sentinelRef} className="feed-sentinel" aria-hidden="true" />
      </section>
      {/* A sheet answers Upload or Settings; on a phone it covers the screen, and the dock would show through it. */}
      <Dock className="feed-dock" aria-label="Feed" ground="horizon" style={sheetOpen ? { visibility: "hidden" } : undefined}>
        <GlyphControl glyph="upload" label={VIEWER_CONTROL_NAMES.openUpload} onPress={() => setUploadOpen(true)} />
        <GlyphControl glyph="search" label={VIEWER_CONTROL_NAMES.openSearch} onPress={openSearch} />
      </Dock>
      {/* Where the feed is narrowed to: a creator's name or the search words. The word closes the narrowing. */}
      {context ? (
        <Chip className="feed-context" style={sheetOpen ? { visibility: "hidden" } : undefined}>
          <Type variant="captionUnderCard" as="p" className="feed-context-text">{context}</Type>
          <GlyphControl glyph="close" label={VIEWER_CONTROL_NAMES.clearFilter} onPress={() => navigate("/")} />
        </Chip>
      ) : null}
      {/* Settings waits in the corner its sheet unfolds from (1.2), apart from the dock's making. Its chip all but
          vanishes on the night sky and keeps the word legible over a hologram's picture. No drawing yet: the word stands in. */}
      <Chip className="feed-settings" style={sheetOpen ? { visibility: "hidden" } : undefined}>
        <GlyphControl glyph={null} label={VIEWER_CONTROL_NAMES.openSettings} onPress={() => setSettingsOpen(true)} />
      </Chip>
      <SideSheet open={settingsOpen} title="Settings" onClose={() => setSettingsOpen(false)} target={target}>
        <SettingsSection title="Hand">
          <HandednessPicker value={handedness} onChange={setHandedness} />
        </SettingsSection>
        <SettingsSection title="Account">
          <AuthPanel user={user} onSignOut={logout} />
        </SettingsSection>
      </SideSheet>
      <SideSheet open={uploadOpen} title="Upload a hologram" onClose={() => setUploadOpen(false)} target={target}>
        {user ? (
          <UploadPanel onUploaded={onUploaded} onStatus={setUploadStatus} currentUser={user} />
        ) : isUserLoading ? null : (
          <SignInForm intro="Sign in to upload. Your holograms are credited to your name, and only you can delete them." />
        )}
      </SideSheet>
      <SideSheet open={searchOpen} title="Search" onClose={() => setSearchOpen(false)} target={target}>
        <form className="upload-form" role="search" onSubmit={submitSearch}>
          <label className="upload-field">
            <Type variant="byline">A title or a creator</Type>
            <input
              className="upload-input"
              type="search"
              autoFocus
              autoComplete="off"
              enterKeyHint="search"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              maxLength={100}
            />
          </label>
          <div className="upload-actions">
            <GlyphControl glyph={null} showLabel label={VIEWER_CONTROL_NAMES.runSearch} word={VIEWER_CONTROL_NAMES.runSearch} onPress={() => submitSearch()} />
          </div>
        </form>
      </SideSheet>
      <FeedNotice notice={notice} target={target} />
    </main>
  );
}
