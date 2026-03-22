declare global {
  type XRSessionMode = "inline" | "immersive-vr" | "immersive-ar";

  interface XRSpace {}

  interface XRSession {
    depthDataFormat?: string | null;
    depthUsage?: string | null;
    enabledFeatures?: Iterable<string> | string[];
    environmentBlendMode?: string | null;
  }
}

export {};
