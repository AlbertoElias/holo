import { describe, expect, it } from "vitest";

import { isAllowedWebOrigin } from "../src/lib/cors.js";

describe("isAllowedWebOrigin", () => {
  const configuredOrigin = "https://localhost:3174";

  it("accepts configured origin", () => {
    expect(isAllowedWebOrigin("https://localhost:3174", configuredOrigin)).toBe(true);
  });

  it("accepts localhost on alternate ports", () => {
    expect(isAllowedWebOrigin("https://localhost:5174", configuredOrigin)).toBe(true);
    expect(isAllowedWebOrigin("https://127.0.0.1:5174", configuredOrigin)).toBe(true);
    expect(isAllowedWebOrigin("http://localhost:3001", configuredOrigin)).toBe(true);
  });

  it("rejects unknown non-localhost origins", () => {
    expect(isAllowedWebOrigin("https://example.com", configuredOrigin)).toBe(false);
  });
});
