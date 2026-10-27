import { describe, expect, it } from "vitest";

import {
  MIXAMO_TO_VRM,
  VRM_HUMANOID_BONES,
  resolveHumanoidBone,
  encodeHoloimMeaning,
  isCameraFrom,
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
// v1 (camera `from`) adds, each a way the shared contract could break:
// 11. a v0 bone file stops validating     12. a v0 file with a `camera` key validates
// 13. a v1 camera `from` is rejected      14. `camera: false`, or `camera` beside `bone`, validates
// 15. version 2 or a missing version validates
// 16. a camera link with `inferred` provenance validates
// 17. the reader changes a v0 record's content
// 18. the writer writes v1 for a record the v0 schema accepts, or v0 for one with a camera `from`
// 19. v1 stops accepting a bone `from` (or its inferred provenance)
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
    ["version 2", { ...example, version: 2 }],
    ["string version", { ...example, version: "0" }],
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

const cameraLink = {
  kind: "link",
  anchor: { from: { camera: true, node: 31 }, to: { node: 7, point: [0, 0.5, 0] } },
  span: { start: 1, end: 2 },
  provenance: { value: "recorded" }
};
const v1Camera = { version: 1, marks: [cameraLink], spans: [] };

describe("HOLOIM_meaning v1", () => {
  it("still validates a v0 bone file, returning it deep-equal", () => {
    const result = validateHoloimMeaning(example);
    expect(result).toEqual({ ok: true, value: example });
  });

  it("rejects a v0 file with a camera from", () => {
    expect(validateHoloimMeaning({ ...v1Camera, version: 0 }).ok).toBe(false);
  });

  it("validates a v1 camera from and narrows it with isCameraFrom", () => {
    const result = validateHoloimMeaning(v1Camera);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const from = result.value.marks[0]!.anchor.from;
    expect(isCameraFrom(from)).toBe(true);
    expect(from).toEqual({ camera: true, node: 31 });
  });

  it("validates a v1 file with a bone from and inferred provenance", () => {
    expect(validateHoloimMeaning({ ...example, version: 1 }).ok).toBe(true);
  });

  it.each([
    ["camera false", { camera: false, node: 31 }],
    ["camera beside bone", { camera: true, bone: "rightHand", node: 31 }],
    ["camera without node", { camera: true }],
    ["unknown from key", { camera: true, node: 31, lens: 1 }]
  ])("rejects %s", (_n, from) => {
    const bad = clone(v1Camera) as Loose;
    bad.marks[0].anchor.from = from;
    expect(validateHoloimMeaning(bad).ok).toBe(false);
  });

  it("rejects a camera link with inferred provenance", () => {
    const bad = clone(v1Camera) as Loose;
    bad.marks[0].provenance = { value: "inferred", confidence: 0.9 };
    const result = validateHoloimMeaning(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("recorded provenance");
  });

  it.each([
    ["version 2", { ...v1Camera, version: 2 }],
    ["missing version", { marks: [cameraLink], spans: [] }]
  ])("rejects %s, naming the unsupported version", (_n, input) => {
    const result = validateHoloimMeaning(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("unsupported");
  });

  it("writes v0 for a bone-only record and v1 for one with a camera from", () => {
    const bone = encodeHoloimMeaning({ marks: example.marks as never, spans: example.spans as never });
    expect(bone.version).toBe(0);
    expect(bone).toEqual(example);
    const camera = encodeHoloimMeaning({ marks: [cameraLink] as never, spans: [] });
    expect(camera.version).toBe(1);
    expect(camera).toEqual(v1Camera);
  });

  it("throws when no version accepts the record", () => {
    const bad = clone(cameraLink) as Loose;
    bad.provenance = { value: "inferred", confidence: 0.5 };
    expect(() => encodeHoloimMeaning({ marks: [bad as never], spans: [] })).toThrow(/recorded provenance/);
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
