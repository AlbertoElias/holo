// @ts-check

const PUBLIC_XR_TEST_MODES = new Set(["iwer", "off"]);
const XR_TEST_MODE_ALIASES = new Map([
  ["polyfill", "iwer"],
  ["shim", "iwer"]
]);

/**
 * @typedef {"iwer" | "off"} XrTestMode
 */

/**
 * @typedef {{ x: number; y: number; z: number }} IwerVector3
 */

/**
 * @typedef {{ x: number; y: number; z: number; w: number }} IwerQuaternion
 */

/**
 * @typedef {{ position: IwerVector3; quaternion: IwerQuaternion }} IwerPoseSnapshot
 */

/**
 * @typedef {{ orientation?: string; planeSpace?: XRSpace }} IwerTrackedPlane
 */

/**
 * @typedef {{
 *   position?: { x?: unknown; y?: unknown; z?: unknown };
 *   quaternion?: { x?: unknown; y?: unknown; z?: unknown; w?: unknown };
 *   sem?: {
 *     trackedPlanes?: ReadonlySet<IwerTrackedPlane>;
 *     trackedMeshes?: ReadonlySet<unknown>;
 *   };
 * }} IwerDeviceLike
 */

/**
 * @typedef {{
 *   available: boolean;
 *   pose: IwerPoseSnapshot | null;
 *   hasSem: boolean;
 *   trackedPlanes: ReadonlySet<IwerTrackedPlane> | null;
 *   trackedPlanesCount: number;
 *   trackedMeshesCount: number;
 * }} IwerEnvironmentSnapshot
 */

/**
 * @typedef {{
 *   hasNavigatorXr: boolean;
 *   supportsImmersiveAr: boolean;
 *   hasIwerRuntime: boolean;
 *   isNativeRuntime: boolean;
 *   shouldRequestDepthSensing: boolean;
 *   depthSensingEnabled: boolean;
 *   sessionMode: XRSessionMode | null;
 *   sessionEnvironmentBlendMode: string | null;
 *   enabledFeatures: string[];
 * }} XrCapabilities
 */

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {IwerDeviceLike["position"]} vector
 * @returns {vector is IwerVector3}
 */
function hasFiniteVector3(vector) {
  return isFiniteNumber(vector?.x)
    && isFiniteNumber(vector?.y)
    && isFiniteNumber(vector?.z);
}

/**
 * @param {IwerDeviceLike["quaternion"]} quaternion
 * @returns {quaternion is IwerQuaternion}
 */
function hasFiniteQuaternion(quaternion) {
  return isFiniteNumber(quaternion?.x)
    && isFiniteNumber(quaternion?.y)
    && isFiniteNumber(quaternion?.z)
    && isFiniteNumber(quaternion?.w);
}

/**
 * @param {typeof globalThis} target
 * @returns {IwerDeviceLike | null}
 */
function readIwerDevice(target) {
  return /** @type {{ IWER_DEVICE?: IwerDeviceLike }} */ (target).IWER_DEVICE ?? null;
}

/**
 * @param {string | undefined} rawMode
 * @returns {XrTestMode}
 */
export function resolveXrTestMode(rawMode = /** @type {{ env?: { XR_TEST_MODE?: string } } | undefined} */ (globalThis.process)?.env?.XR_TEST_MODE) {
  const normalized = String(rawMode ?? "iwer").toLowerCase();
  if (PUBLIC_XR_TEST_MODES.has(normalized)) {
    return /** @type {XrTestMode} */ (normalized);
  }

  const aliasedMode = XR_TEST_MODE_ALIASES.get(normalized);
  return /** @type {XrTestMode} */ (aliasedMode ?? "iwer");
}

/**
 * @param {typeof globalThis} [target]
 * @returns {IwerEnvironmentSnapshot}
 */
export function readIwerRuntime(target = globalThis) {
  const device = readIwerDevice(target);
  const position = device?.position;
  const quaternion = device?.quaternion;
  const trackedPlanes = device?.sem?.trackedPlanes;
  const trackedMeshes = device?.sem?.trackedMeshes;

  return {
    available: device != null,
    pose: hasFiniteVector3(position) && hasFiniteQuaternion(quaternion)
      ? {
        position: { x: position.x, y: position.y, z: position.z },
        quaternion: {
          x: quaternion.x,
          y: quaternion.y,
          z: quaternion.z,
          w: quaternion.w
        }
      }
      : null,
    hasSem: device?.sem != null,
    trackedPlanes: trackedPlanes ?? null,
    trackedPlanesCount: trackedPlanes?.size ?? 0,
    trackedMeshesCount: trackedMeshes?.size ?? 0
  };
}

/**
 * @param {XRSession | null | undefined} session
 * @returns {string[]}
 */
function readEnabledFeatures(session) {
  const enabledFeatures = /** @type {{ enabledFeatures?: Iterable<string> | string[] } | null | undefined} */ (session)?.enabledFeatures;
  if (Array.isArray(enabledFeatures)) {
    return [...enabledFeatures];
  }

  if (enabledFeatures == null) {
    return [];
  }

  return Array.from(enabledFeatures);
}

/**
 * @param {{
 *   forceImmersiveArSupport?: boolean | null;
 *   session?: XRSession | null;
 *   sessionMode?: XRSessionMode | null;
 *   target?: typeof globalThis;
 * }} [options]
 * @returns {Promise<XrCapabilities>}
 */
export async function readXrCapabilities(options = {}) {
  const target = options.target ?? globalThis;
  const runtime = readIwerRuntime(target);
  const session = options.session ?? null;
  const sessionWithDepth = /** @type {(XRSession & {
    depthDataFormat?: string | null;
    depthUsage?: string | null;
    enabledFeatures?: Iterable<string> | string[];
  }) | null} */ (session);
  const navigatorLike = /** @type {{ xr?: { isSessionSupported?: (mode: string) => Promise<boolean> } }} */ (target.navigator ?? {});
  const xr = navigatorLike.xr;

  let supportsImmersiveAr = false;
  if (typeof options.forceImmersiveArSupport === "boolean") {
    supportsImmersiveAr = options.forceImmersiveArSupport;
  } else if (typeof xr?.isSessionSupported === "function") {
    try {
      supportsImmersiveAr = await xr.isSessionSupported("immersive-ar");
    } catch {
      supportsImmersiveAr = false;
    }
  }

  const enabledFeatures = readEnabledFeatures(session);
  const depthSensingEnabled = !runtime.available
    && (enabledFeatures.includes("depth-sensing")
      || sessionWithDepth?.depthUsage != null
      || sessionWithDepth?.depthDataFormat != null);

  return {
    hasNavigatorXr: typeof xr !== "undefined",
    supportsImmersiveAr,
    hasIwerRuntime: runtime.available,
    isNativeRuntime: supportsImmersiveAr && !runtime.available,
    shouldRequestDepthSensing: supportsImmersiveAr && !runtime.available,
    depthSensingEnabled,
    sessionMode: options.sessionMode ?? null,
    sessionEnvironmentBlendMode: sessionWithDepth?.environmentBlendMode ?? null,
    enabledFeatures
  };
}
