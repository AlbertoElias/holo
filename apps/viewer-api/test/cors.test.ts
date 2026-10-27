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

  it("accepts one subdomain level for a wildcard entry and nothing else", () => {
    const extra = ["https://*.holoim-capture.pages.dev"];
    expect(isAllowedWebOrigin("https://feature-x.holoim-capture.pages.dev", configuredOrigin, extra)).toBe(true);
    expect(isAllowedWebOrigin("https://a.b.holoim-capture.pages.dev", configuredOrigin, extra)).toBe(false);
    expect(isAllowedWebOrigin("https://xholoim-capture.pages.dev", configuredOrigin, extra)).toBe(false);
    expect(isAllowedWebOrigin("https://feature-x.holoim-capture.pages.dev.evil.com", configuredOrigin, extra)).toBe(false);
  });
});
