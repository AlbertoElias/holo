import { describe, expect, it } from "vitest";

import {
  MIXAMO_TO_VRM,
  VRM_HUMANOID_BONES,
  resolveHumanoidBone,
  validateHoloimMeaning
} from "./index.js";

// Failure modes enumerated before writing tests (reader/writer disagreement
// is what breaks export -> upload -> render):
//  1. brief example rejected          2. future version/kind/key silently accepted
//  3. NaN/Infinity/negative times     4. span end before start
//  5. bad node index / point shape    6. non-positive or >1 confidence, confidence on recorded
//  7. unknown or Mixamo-named bone stored in the record (record uses VRM names only)
//  8. empty motion bones              9. non-object input (null, array, string)
// 10. alias table: prefix variants, fingertip 4, every target a real VRM bone,
//     prototype keys ("constructor") resolving, all 55 VRM bones reachable.
const example = {
  version: 0,
  marks: [
    {
      kind: "link",
      anchor: {
        from: { bone: "rightIndexDistal", node: 41 },
        to: { node: 7, point: [0.02, 0.31, -0.1], radius: 0.15 }
      },
      span: { start: 2.84, end: 4.1 },
      provenance: { value: "inferred", confidence: 0.86 }
    },
    {
      kind: "link",
      anchor: { from: { bone: "rightIndexDistal", node: 41 }, to: { bone: "leftHand", node: 33, point: [0, 0, 0] } },
      span: { start: 5, end: 5.5 },
      provenance: { value: "recorded" }
    }
  ],
  spans: [
    {
      kind: "motion",
      bones: ["rightShoulder", "rightUpperArm", "rightLowerArm", "rightHand"],
      span: { start: 1.2, end: 2 },
      provenance: { value: "inferred" }
    }
  ]
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
const clone = <T>(v: T): T => structuredClone(v);
const mark = (m: typeof example): Loose => m.marks[0] as Loose;

describe("validateHoloimMeaning", () => {
  it("keeps confidence optional for inferred motion spans", () => {
    expect(example.spans[0]!.provenance).toEqual({ value: "inferred" });
    expect(validateHoloimMeaning(example).ok).toBe(true);
  });

  it("accepts the brief's example and an empty record", () => {
    expect(validateHoloimMeaning(example).ok).toBe(true);
    expect(validateHoloimMeaning({ version: 0, marks: [], spans: [] }).ok).toBe(true);
  });

  it.each([
    ["null", null],
    ["array", []],
    ["string", "x"],
    ["version 1", { ...example, version: 1 }],
    ["missing version", { marks: [], spans: [] }],
    ["unknown top-level key", { ...example, extra: 1 }]
  ])("rejects %s", (_n, input) => {
    expect(validateHoloimMeaning(input).ok).toBe(false);
  });

  const mutations: Array<[string, (m: typeof example) => void]> = [
    ["unknown mark kind", (m) => { mark(m).kind = "arrow"; }],
    ["unknown span kind", (m) => { (m.spans[0] as Loose).kind = "gaze"; }],
    ["inferred link without confidence", (m) => { mark(m).provenance = { value: "inferred" }; }],
    ["inferred link with zero confidence", (m) => { mark(m).provenance = { value: "inferred", confidence: 0 }; }],
    ["NaN start", (m) => { mark(m).span.start = NaN; }],
    ["Infinity end", (m) => { mark(m).span.end = Infinity; }],
    ["negative start", (m) => { mark(m).span.start = -1; }],
    ["end before start", (m) => { mark(m).span.end = 1; }],
    ["fractional node", (m) => { mark(m).anchor.from.node = 1.5; }],
    ["negative node", (m) => { mark(m).anchor.to.node = -1; }],
    ["2-element point", (m) => { mark(m).anchor.to.point = [0, 1]; }],
    ["NaN in point", (m) => { mark(m).anchor.to.point = [0, NaN, 0]; }],
    ["zero radius", (m) => { mark(m).anchor.to.radius = 0; }],
    ["confidence 0", (m) => { mark(m).provenance.confidence = 0; }],
    ["confidence > 1", (m) => { mark(m).provenance.confidence = 1.01; }],
    ["confidence on recorded", (m) => { (m.marks[1] as Loose).provenance.confidence = 1; }],
    ["unknown provenance", (m) => { mark(m).provenance.value = "guessed"; }],
    ["Mixamo bone in record", (m) => { mark(m).anchor.from.bone = "RightHandIndex4"; }],
    ["unknown bone", (m) => { mark(m).anchor.from.bone = "tail"; }],
    ["missing from.bone", (m) => { delete mark(m).anchor.from.bone; }],
    ["empty motion bones", (m) => { (m.spans[0] as Loose).bones = []; }]
  ];
  it.each(mutations)("rejects %s", (_n, mutate) => {
    const bad = clone(example);
    mutate(bad);
    const result = validateHoloimMeaning(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("humanoid bones", () => {
  it("has the 55 VRM 1.0 humanoid bones, unique", () => {
    expect(new Set(VRM_HUMANOID_BONES).size).toBe(55);
  });

  it("resolves VRM names, bare and prefixed Mixamo names", () => {
    expect(resolveHumanoidBone("rightHand")).toBe("rightHand");
    expect(resolveHumanoidBone("Hips")).toBe("hips");
    expect(resolveHumanoidBone("mixamorig:RightHandIndex1")).toBe("rightIndexProximal");
    expect(resolveHumanoidBone("mixamorigRightHandIndex3")).toBe("rightIndexDistal");
    expect(resolveHumanoidBone("mixamorig1:LeftForeArm")).toBe("leftLowerArm");
    expect(resolveHumanoidBone("RightHandIndex4")).toBe("rightIndexDistal");
    expect(resolveHumanoidBone("LeftHandPinky2")).toBe("leftLittleIntermediate");
    expect(resolveHumanoidBone("LeftToeBase")).toBe("leftToes");
  });

  it("rejects unknown and prototype names", () => {
    for (const n of ["", "constructor", "__proto__", "toString", "mixamorig:Tail", "righthand", "RightHandIndex5"]) {
      expect(resolveHumanoidBone(n)).toBeUndefined();
    }
  });

  it("maps only to real VRM bones and reaches all but eyes and jaw", () => {
    const targets = new Set(Object.values(MIXAMO_TO_VRM));
    for (const t of targets) expect(VRM_HUMANOID_BONES).toContain(t);
    const unreached = VRM_HUMANOID_BONES.filter((b) => !targets.has(b));
    expect(unreached.sort()).toEqual(["jaw", "leftEye", "rightEye"]);
  });
});
