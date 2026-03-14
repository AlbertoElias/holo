const localhostOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const localNetworkOriginPattern = /^https?:\/\/192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$/i;

export function isAllowedWebOrigin(requestOrigin: string | undefined, configuredOrigin: string): boolean {
  if (!requestOrigin) {
    return true;
  }

  if (requestOrigin === configuredOrigin) {
    return true;
  }

  if (localhostOriginPattern.test(requestOrigin)) {
    return true;
  }

  // Allow requests from local network IP addresses (192.168.x.x)
  return localNetworkOriginPattern.test(requestOrigin);
}
