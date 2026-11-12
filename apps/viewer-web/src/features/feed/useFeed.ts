import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { paginatedHologramsSchema, type HologramDTO, type PaginatedHolograms } from "@holoim/contracts";

import { fetchHolograms, fetchSharedHologram, type FeedFilter } from "./api";

declare global {
  interface Window {
    /** The first page as the edge last saw it (functions/index.ts); the API's answer replaces it. */
    __HOLOIM_FEED__?: unknown;
  }
}

function readEdgeSnapshot(): PaginatedHolograms | null {
  if (typeof window === "undefined") return null;
  const parsed = paginatedHologramsSchema.safeParse(window.__HOLOIM_FEED__);
  return parsed.success ? parsed.data : null;
}

/** What the feed lists: everything, a search, one creator's, or the single hologram a shared link names. */
export type FeedSource =
  | { kind: "all" }
  | { kind: "search"; q: string }
  | { kind: "creator"; ownerId: string }
  | { kind: "one"; id: string };

function filterOf(source: FeedSource): FeedFilter {
  return source.kind === "search" ? { q: source.q } : source.kind === "creator" ? { ownerId: source.ownerId } : {};
}

/** A feed belongs to one source: a page showing another source mounts a new one (key it). */
export function useFeed(source: FeedSource = { kind: "all" }) {
  // The edge's snapshot is the unfiltered first page, so only the plain feed may start from it.
  const [snapshot] = useState(source.kind === "all" ? readEdgeSnapshot : () => null);
  // False until the first answer (or snapshot) is in, so a page does not say "nothing here" before it has asked.
  const [loaded, setLoaded] = useState(snapshot !== null);
  const [items, setItems] = useState<HologramDTO[]>(() => snapshot?.items ?? []);
  const [nextCursor, setNextCursor] = useState<string | null>(() => snapshot?.nextCursor ?? null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initializedRef = useRef(false);

  const load = useCallback(
    async (cursor?: string) => {
      if (isLoading) {
        return;
      }

      setIsLoading(true);
      try {
        if (source.kind === "one") {
          const item = await fetchSharedHologram(source.id);
          setItems(item ? [item] : []);
          setNextCursor(null);
        } else {
          const response = await fetchHolograms(cursor, undefined, filterOf(source));
          setItems((prev) => (cursor ? [...prev, ...response.items] : response.items));
          setNextCursor(response.nextCursor);
        }
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Failed to load feed");
      } finally {
        setIsLoading(false);
        setLoaded(true);
      }
    },
    // The source is fixed for the life of a feed (see FeedSource).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isLoading]
  );

  // The snapshot is the newest page as of the page load: once used, a later visit to the feed must ask the API.
  useEffect(() => {
    if (source.kind === "all") delete window.__HOLOIM_FEED__;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      void load();
    }
  }, [load]);

  const addToTop = useCallback((item: HologramDTO) => {
    setItems((prev) => [item, ...prev.filter((existing) => existing.id !== item.id)]);
  }, []);

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const removeItem = useCallback((id: string) => {
    const remaining = itemsRef.current.filter((existing) => existing.id !== id);
    setItems(remaining);
    // The paging cursor is the last item loaded; deleting that one moves it up, or the list past it is lost.
    setNextCursor((cursor) => (cursor === id ? remaining[remaining.length - 1]?.id ?? null : cursor));
  }, []);

  const canLoadMore = useMemo(() => nextCursor !== null, [nextCursor]);

  return {
    items,
    isLoading: isLoading || (!loaded && error === null),
    error,
    canLoadMore,
    nextCursor,
    addToTop,
    removeItem,
    /** Loads the first page again, after an error. */
    retry: async () => {
      await load();
    },
    loadMore: async () => {
      if (nextCursor) {
        await load(nextCursor);
      }
    }
  };
}
