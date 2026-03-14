import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HologramDTO } from "@holoim/contracts";

import { fetchHolograms } from "./api";

export function useFeed() {
  const [items, setItems] = useState<HologramDTO[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
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

  const canLoadMore = useMemo(() => nextCursor !== null, [nextCursor]);

  return {
    items,
    isLoading,
    error,
    canLoadMore,
    nextCursor,
    addToTop,
    loadMore: async () => {
      if (nextCursor) {
        await load(nextCursor);
      }
    }
  };
}
