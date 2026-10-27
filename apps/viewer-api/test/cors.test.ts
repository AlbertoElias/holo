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

describe("CORS on the built app", () => {
  // Production's configured origin; env is read when app.js first loads.
  process.env.WEB_ORIGIN = "https://holoim-viewer.pages.dev";
  // The origins a browser could send, and whether the API must answer them.
  const allowed = [
    "https://holoim-viewer.pages.dev",
    "https://bug-glb-probe-cache.holoim-viewer.pages.dev",
    "https://3f9c2a1b.holoim-viewer.pages.dev",
    "https://feature-ar-recording.holoim-capture.pages.dev",
    "https://localhost:5174"
  ];
  const rejected = [
    "https://evil.pages.dev",
    "https://holoim-viewer.pages.dev.evil.com",
    "https://evil-holoim-viewer.pages.dev",
    "https://evilholoim-viewer.pages.dev",
    "https://a.b.holoim-viewer.pages.dev",
    "https://x.holoim-viewer-x.pages.dev",
    "http://bug-glb-probe-cache.holoim-viewer.pages.dev",
    "https://bug-glb-probe-cache.holoim-viewer.pages.dev:8443",
    "https://x.holoim.pages.dev",
    "https://example.com"
  ];

  async function corsHeaders(origin: string, method: "GET" | "OPTIONS") {
    const { buildApp } = await import("../src/app.js");
    const app = buildApp({ logger: false });
    await app.ready();
    try {
      const response = await app.inject({
        method,
        url: "/healthz",
        headers:
          method === "OPTIONS"
            ? { origin, "access-control-request-method": "GET" }
            : { origin }
      });
      return response.headers;
    } finally {
      await app.close();
    }
  }

  it.each(allowed)("answers %s on simple and preflight requests", async (origin) => {
    expect((await corsHeaders(origin, "GET"))["access-control-allow-origin"]).toBe(origin);
    expect((await corsHeaders(origin, "OPTIONS"))["access-control-allow-origin"]).toBe(origin);
  });

  it.each(rejected)("gives %s no CORS headers", async (origin) => {
    expect((await corsHeaders(origin, "GET"))["access-control-allow-origin"]).toBeUndefined();
    expect((await corsHeaders(origin, "OPTIONS"))["access-control-allow-origin"]).toBeUndefined();
  });
});
