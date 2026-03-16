import { describe, expect, it } from "vitest";

import { loadRuntimeConfig } from "./runtimeConfig";

describe("loadRuntimeConfig", () => {
  it("uses expected defaults", () => {
    const config = loadRuntimeConfig("");
    expect(config.sceneUrl).toBe("/gltf/models/scene.glb");
    expect(config.avatarUrl).toBe("/gltf/models/avatar.glb");
    expect(config.sceneSpanAvatars).toBe(72);
    expect(config.mockVrEnabledFromQuery).toBe(false);
    expect(config.handRetargetMode).toBe("hybrid");
  });

  it("parses query overrides and mock VR flag", () => {
    const config = loadRuntimeConfig(
      "?scene=/gltf/models/custom-scene.glb&avatar=/gltf/models/custom-avatar.glb&avatarScale=1.5&mockVr=1&handRetargetMode=legacy"
    );
    expect(config.sceneUrl).toBe("/gltf/models/custom-scene.glb");
    expect(config.avatarUrl).toBe("/gltf/models/custom-avatar.glb");
    expect(config.avatarScaleMultiplier).toBeCloseTo(1.5, 6);
    expect(config.mockVrEnabledFromQuery).toBe(true);
    expect(config.handRetargetMode).toBe("legacy");
  });
});
