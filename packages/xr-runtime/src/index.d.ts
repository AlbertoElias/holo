/// <reference path="./webxr.d.ts" />

export type XrTestMode = "iwer" | "off";

export type IwerPoseSnapshot = {
  position: {
    x: number;
    y: number;
    z: number;
  };
  quaternion: {
    x: number;
    y: number;
    z: number;
    w: number;
  };
};

export type IwerTrackedPlane = {
  orientation?: string;
  planeSpace?: XRSpace;
};

export type IwerEnvironmentSnapshot = {
  available: boolean;
  pose: IwerPoseSnapshot | null;
  hasSem: boolean;
  trackedPlanes: ReadonlySet<IwerTrackedPlane> | null;
  trackedPlanesCount: number;
  trackedMeshesCount: number;
};

export type XrCapabilities = {
  hasNavigatorXr: boolean;
  supportsImmersiveAr: boolean;
  hasIwerRuntime: boolean;
  isNativeRuntime: boolean;
  shouldRequestDepthSensing: boolean;
  depthSensingEnabled: boolean;
  sessionMode: XRSessionMode | null;
  sessionEnvironmentBlendMode: string | null;
  enabledFeatures: string[];
};

export function resolveXrTestMode(rawMode?: string): XrTestMode;
export function readIwerRuntime(target?: typeof globalThis): IwerEnvironmentSnapshot;
export function readXrCapabilities(options?: {
  forceImmersiveArSupport?: boolean | null;
  session?: XRSession | null;
  sessionMode?: XRSessionMode | null;
  target?: typeof globalThis;
}): Promise<XrCapabilities>;
