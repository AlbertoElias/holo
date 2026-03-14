import { describe, expect, it } from "vitest";

import { isAllowedWebOrigin } from "../src/lib/cors.js";

describe("isAllowedWebOrigin", () => {
  const configuredOrigin = "http://localhost:5173";

  it("accepts configured origin", () => {
    expect(isAllowedWebOrigin("http://localhost:5173", configuredOrigin)).toBe(true);
  });

  it("accepts localhost on alternate ports", () => {
    expect(isAllowedWebOrigin("http://localhost:5174", configuredOrigin)).toBe(true);
    expect(isAllowedWebOrigin("http://127.0.0.1:5174", configuredOrigin)).toBe(true);
  });

  it("rejects unknown non-localhost origins", () => {
    expect(isAllowedWebOrigin("https://example.com", configuredOrigin)).toBe(false);
  });
});
