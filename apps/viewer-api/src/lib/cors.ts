const localhostOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const localNetworkOriginPattern = /^https?:\/\/192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$/i;
// Cloudflare Pages preview deploys of this project's two Pages apps: one
// label (a deploy hash or branch alias) under holoim-viewer or holoim-capture.
const pagesPreviewOriginPattern = /^https:\/\/[a-z0-9-]+\.holoim-(viewer|capture)\.pages\.dev$/i;

function matchesWildcardOrigin(requestOrigin: string, pattern: string): boolean {
  if (!pattern.includes("*.")) {
    return false;
  }
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace("\\*\\.", "[a-z0-9-]+\\.");
  return new RegExp(`^${escaped}$`, "i").test(requestOrigin);
}

export function isAllowedWebOrigin(
  requestOrigin: string | undefined,
  configuredOrigin: string,
  additionalOrigins: string[] = []
): boolean {
  if (!requestOrigin) {
    return true;
  }

  if (requestOrigin === configuredOrigin) {
    return true;
  }

  for (const allowed of additionalOrigins) {
    if (requestOrigin === allowed || matchesWildcardOrigin(requestOrigin, allowed)) {
      return true;
    }
  }

  if (pagesPreviewOriginPattern.test(requestOrigin)) {
    return true;
  }

  if (localhostOriginPattern.test(requestOrigin)) {
    return true;
  }

  // Allow requests from local network IP addresses (192.168.x.x)
  return localNetworkOriginPattern.test(requestOrigin);
}
