import { describe, expect, it } from "vitest";

import {
  FACE_CHANNELS,
  MAX_PITCH,
  MAX_YAW,
  SOURCE_TABLES,
  TARGET_TABLES,
  arkitFromGaze,
  evaluateTarget,
  gazeFromArkit,
  normalizeMorphName,
  resolveMorphTarget,
  toCanonical,
  type FaceStandard
} from "./index.js";

describe("morph name resolution", () => {
  it("normalizes prefixes, case and separators", () => {
    expect(normalizeMorphName("blendShape1.eyeBlinkLeft")).toBe("eyeblinkleft");
    expect(normalizeMorphName("BS_jawOpen")).toBe("jawopen");
    expect(normalizeMorphName("Eye_Blink_L")).toBe("eyeblinkl");
  });

  it("resolves prefixed and differently cased names to the right standard", () => {
    const cases: [string, FaceStandard, string][] = [
      ["blendShape1.eyeBlinkLeft", "arkit", "eyeBlinkLeft"],
      ["BS_jawOpen", "arkit", "jawOpen"],
      ["viseme_aa", "oculus-viseme", "viseme_aa"],
      ["EyeBlink_L", "cc4", "eyeBlinkLeft"],
      ["Eye_Blink_L", "cc4", "eyeBlinkLeft"],
      ["EYES_CLOSED_L", "meta-fb2", "eyeBlinkLeft"],
      ["mouthOpen", "rpm-legacy", "jawOpen"],
      ["blink_l", "vrm0", "eyeBlinkLeft"]
    ];
    for (const [name, standard, channel] of cases) {
      const hit = resolveMorphTarget(name);
      expect(hit?.standard, name).toBe(standard);
      expect(hit?.formula.terms.map((t) => t.channel), name).toContain(channel);
    }
    expect(resolveMorphTarget("Fcl_EYE_Close")).toBeNull();
  });

  it("only lets single-letter keys match vrm0 and honours preferred order", () => {
    expect(resolveMorphTarget("a")?.standard).toBe("vrm0");
    expect(resolveMorphTarget("aa")?.standard).toBe("vrm1");
    expect(resolveMorphTarget("blink")?.standard).toBe("vrm1");
    expect(resolveMorphTarget("blink", ["vrm0"])?.standard).toBe("vrm0");
  });

  it("only references real canonical channels", () => {
    const valid = new Set<string>(FACE_CHANNELS);
    for (const table of Object.values(TARGET_TABLES)) {
      for (const f of Object.values(table)) for (const t of f.terms) expect(valid.has(t.channel), t.channel).toBe(true);
    }
    for (const table of Object.values(SOURCE_TABLES)) {
      for (const terms of Object.values(table)) for (const t of terms) expect(valid.has(t.channel), t.channel).toBe(true);
    }
  });
});

describe("target approximations", () => {
  const vrm1 = (n: string) => TARGET_TABLES.vrm1[n]!;
  it("evaluates VRM and RPM formulas as documented", () => {
    expect(evaluateTarget(vrm1("happy"), { mouthSmileLeft: 0.4, mouthSmileRight: 0.8 })).toBeCloseTo(0.6);
    expect(evaluateTarget(vrm1("aa"), { jawOpen: 1 })).toBeCloseTo(0.8);
    expect(evaluateTarget(vrm1("aa"), { jawOpen: 0.1, viseme_aa: 0.5 })).toBeCloseTo(0.5);
    expect(evaluateTarget(vrm1("blink"), { eyeBlinkLeft: 1, eyeBlinkRight: 0.25 })).toBeCloseTo(0.25);
    expect(evaluateTarget(vrm1("blink"), { eyeBlinkLeft: 1 })).toBe(0);
    expect(evaluateTarget(vrm1("neutral"), { jawOpen: 1 })).toBe(0);
    expect(evaluateTarget(TARGET_TABLES.vrm0.blink_l!, { eyeBlinkLeft: 1, eyeBlinkRight: 0 })).toBe(1);
    expect(evaluateTarget(TARGET_TABLES["rpm-legacy"].mouthOpen!, { viseme_aa: 1 })).toBeCloseTo(0.8);
    expect(evaluateTarget({ op: "sum", terms: [{ channel: "jawOpen", scale: 3 }] }, { jawOpen: 1 })).toBe(1);
  });

  it("maps standard weights back to canonical", () => {
    expect(toCanonical("meta-fb2", { EYES_CLOSED_L: 0.7 })).toEqual({ eyeBlinkLeft: 0.7 });
    expect(toCanonical("arkit", { jawOpen: 0.3, _neutral: 1, bogus: 1 })).toEqual({ jawOpen: 0.3 });
    expect(toCanonical("vrm1", { happy: 0.5 })).toEqual({ mouthSmileLeft: 0.5, mouthSmileRight: 0.5 });
    expect(toCanonical("vrm0", { blink_r: 1 })).toEqual({ eyeBlinkRight: 1 });
    // Meta "looking left" is out for the left eye, in for the right eye.
    expect(toCanonical("meta-fb2", { EYES_LOOK_LEFT_L: 1, EYES_LOOK_LEFT_R: 1 })).toEqual({
      eyeLookOutLeft: 1,
      eyeLookInRight: 1
    });
  });
});

describe("gaze", () => {
  it("uses +yaw toward the avatar's left and +pitch up", () => {
    const g = gazeFromArkit({ eyeLookOutLeft: 1, eyeLookInRight: 1, eyeLookUpLeft: 1, eyeLookUpRight: 1 });
    expect(g.left.yaw).toBeCloseTo(MAX_YAW);
    expect(g.right.yaw).toBeCloseTo(MAX_YAW);
    expect(g.left.pitch).toBeCloseTo(MAX_PITCH);
    const r = gazeFromArkit({ eyeLookInLeft: 1, eyeLookOutRight: 1, eyeLookDownRight: 1 });
    expect(r.left.yaw).toBeCloseTo(-MAX_YAW);
    expect(r.right.yaw).toBeCloseTo(-MAX_YAW);
    expect(r.right.pitch).toBeCloseTo(-MAX_PITCH);
  });

  it("round-trips", () => {
    const w = { eyeLookOutLeft: 0.5, eyeLookInRight: 0.25, eyeLookDownLeft: 0.4, eyeLookUpRight: 0.6 };
    const back = arkitFromGaze(gazeFromArkit(w));
    for (const [k, v] of Object.entries(w)) expect(back[k as keyof typeof w]).toBeCloseTo(v);
    expect(back.eyeLookInLeft).toBe(0);
  });
});
