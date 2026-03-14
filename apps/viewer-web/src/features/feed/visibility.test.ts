import { describe, expect, it } from "vitest";

import { pickActiveCard } from "./visibility";

function createEntry(id: string, ratio: number, isIntersecting: boolean): IntersectionObserverEntry {
  const target = document.createElement("article");
  target.setAttribute("data-card-id", id);

  return {
    boundingClientRect: target.getBoundingClientRect(),
    intersectionRatio: ratio,
    intersectionRect: target.getBoundingClientRect(),
    isIntersecting,
    rootBounds: null,
    target,
    time: 0
  } satisfies IntersectionObserverEntry;
}

describe("pickActiveCard", () => {
  it("picks entry with highest intersection ratio", () => {
    const result = pickActiveCard([
      createEntry("a", 0.7, true),
      createEntry("b", 0.9, true),
      createEntry("c", 0.3, true)
    ]);

    expect(result).toBe("b");
  });

  it("returns null if no entry intersects", () => {
    const result = pickActiveCard([createEntry("a", 0.9, false)]);

    expect(result).toBeNull();
  });
});
