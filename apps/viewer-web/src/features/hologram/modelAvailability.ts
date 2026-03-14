export type ModelAvailability = "ready" | "missing" | "invalid" | "unreachable";

const GLB_MAGIC = 0x46546c67;
const GLB_MIN_BYTES = 20;

function parseNumericHeaderValue(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function looksLikeValidGlbHeader(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 12) {
    return false;
  }

  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);
  if (magic !== GLB_MAGIC) {
    return false;
  }

  const totalLength = view.getUint32(8, true);
  return totalLength >= GLB_MIN_BYTES;
}

async function fetchGlbHeader(url: string): Promise<Response> {
  return fetch(url, {
    method: "GET",
    headers: { Range: "bytes=0-63" }
  });
}

export async function checkModelAvailability(url: string): Promise<ModelAvailability> {
  try {
    const headResponse = await fetch(url, { method: "HEAD" });
    if (headResponse.status === 404) {
      return "missing";
    }

    if (!headResponse.ok && headResponse.status !== 405 && headResponse.status !== 501) {
      return "unreachable";
    }

    const contentLength = parseNumericHeaderValue(headResponse.headers.get("content-length"));
    if (contentLength !== null && contentLength < GLB_MIN_BYTES) {
      return "invalid";
    }

    const headerResponse = await fetchGlbHeader(url);
    if (headerResponse.status === 404) {
      return "missing";
    }

    if (!headerResponse.ok && headerResponse.status !== 206) {
      return "unreachable";
    }

    const headerBuffer = await headerResponse.arrayBuffer();
    if (!looksLikeValidGlbHeader(headerBuffer)) {
      return "invalid";
    }

    return "ready";
  } catch {
    return "unreachable";
  }
}
