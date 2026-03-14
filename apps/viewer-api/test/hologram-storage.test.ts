import { describe, expect, it } from "vitest";

import { UploadValidationError, validateGlbMeta } from "../src/services/hologram-storage.js";

describe("validateGlbMeta", () => {
  it("accepts valid glb metadata", () => {
    expect(() => {
      validateGlbMeta({ filename: "avatar.glb", mimetype: "model/gltf-binary" });
    }).not.toThrow();
  });

  it("rejects invalid extension", () => {
    expect(() => {
      validateGlbMeta({ filename: "avatar.gltf", mimetype: "model/gltf-binary" });
    }).toThrowError(UploadValidationError);
  });

  it("rejects invalid mime type", () => {
    expect(() => {
      validateGlbMeta({ filename: "avatar.glb", mimetype: "application/json" });
    }).toThrowError(UploadValidationError);
  });
});
