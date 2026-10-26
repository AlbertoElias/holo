import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { paginatedHologramsSchema, type HologramDTO, type PaginatedHolograms } from "@holoim/contracts";

import { fetchHolograms } from "./api";

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

export function useFeed() {
  const [snapshot] = useState(readEdgeSnapshot);
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
        const response = await fetchHolograms(cursor);
        setItems((prev) => (cursor ? [...prev, ...response.items] : response.items));
        setNextCursor(response.nextCursor);
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Failed to load feed");
      } finally {
        setIsLoading(false);
      }
    },
    [isLoading]
  );

  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      void load();
    }
  }, [load]);

  const addToTop = useCallback((item: HologramDTO) => {
    setItems((prev) => [item, ...prev.filter((existing) => existing.id !== item.id)]);
  }, []);

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((existing) => existing.id !== id));
  }, []);

  const canLoadMore = useMemo(() => nextCursor !== null, [nextCursor]);

  return {
    items,
    isLoading,
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
