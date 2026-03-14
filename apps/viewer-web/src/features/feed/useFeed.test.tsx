import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useFeed } from "./useFeed";

const payload = {
  items: [
    {
      id: "1",
      url: "/uploads/1.glb",
      usdzUrl: null,
      createdAt: "2026-02-10T00:00:00.000Z",
      sizeBytes: 120,
      filenameOriginal: "avatar.glb",
      hologramName: "Avatar",
      submittedBy: "Alice"
    }
  ],
  nextCursor: null
};

describe("useFeed", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => payload
      }))
    );
  });

  it("loads holograms on mount", async () => {
    const { result } = renderHook(() => useFeed());

    await waitFor(() => {
      expect(result.current.items).toHaveLength(1);
    });

    expect(result.current.items[0]?.id).toBe("1");
  });

  it("prepends uploaded item", async () => {
    const { result } = renderHook(() => useFeed());

    await waitFor(() => {
      expect(result.current.items).toHaveLength(1);
    });

    act(() => {
      result.current.addToTop({
        id: "2",
        url: "/uploads/2.glb",
        usdzUrl: null,
        createdAt: "2026-02-11T00:00:00.000Z",
        sizeBytes: 140,
        filenameOriginal: "new.glb",
        hologramName: "New",
        submittedBy: "Bob"
      });
    });

    expect(result.current.items[0]?.id).toBe("2");
  });
});
