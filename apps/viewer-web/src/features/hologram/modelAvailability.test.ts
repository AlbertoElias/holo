import { afterEach, describe, expect, it, vi } from "vitest";

import { checkModelAvailability } from "./modelAvailability";

function createValidGlbHeader(totalLength = 20): ArrayBuffer {
  const buffer = new ArrayBuffer(20);
  const view = new DataView(buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLength, true);
  return buffer;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkModelAvailability", () => {
  it("returns missing when HEAD returns 404", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 404 })
    );

    await expect(checkModelAvailability("/uploads/missing.glb")).resolves.toBe("missing");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns invalid when Content-Length is below minimal GLB size", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: { "content-length": "19" }
      })
    );

    await expect(checkModelAvailability("/uploads/short.glb")).resolves.toBe("invalid");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns invalid when header bytes are not a GLB header", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { "content-length": "64" }
        })
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([0, 1, 2, 3]).buffer, { status: 206 }));

    await expect(checkModelAvailability("/uploads/corrupt.glb")).resolves.toBe("invalid");
  });

  it("returns ready for a valid GLB header", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { "content-length": "64" }
        })
      )
      .mockResolvedValueOnce(new Response(createValidGlbHeader(64), { status: 206 }));

    await expect(checkModelAvailability("/uploads/good.glb")).resolves.toBe("ready");
  });
});
