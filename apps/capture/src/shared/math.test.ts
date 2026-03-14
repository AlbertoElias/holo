import { describe, expect, it } from "vitest";

import { clamp, isFiniteQuaternionLike, isFiniteVector3Like } from "./math";

describe("clamp", () => {
  it("constrains values to the given range", () => {
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(4, 0, 10)).toBe(4);
  });
});

describe("isFiniteVector3Like", () => {
  it("accepts finite vectors and rejects non-finite values", () => {
    expect(isFiniteVector3Like({ x: 0, y: 1, z: -2 })).toBe(true);
    expect(isFiniteVector3Like({ x: Number.NaN, y: 1, z: -2 })).toBe(false);
  });
});

describe("isFiniteQuaternionLike", () => {
  it("accepts finite quaternions and rejects invalid components", () => {
    expect(isFiniteQuaternionLike({ x: 0, y: 0, z: 0, w: 1 })).toBe(true);
    expect(isFiniteQuaternionLike({ x: 0, y: Infinity, z: 0, w: 1 })).toBe(false);
  });
});
