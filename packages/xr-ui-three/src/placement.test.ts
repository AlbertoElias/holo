// Styleguide 1.2, 9.1 and brief Q11: the wrist row on the non-dominant hand,
// the status line as the only thing that follows the head, and a world panel
// that opens 1 m away or more and then stays.
import { tokens } from "@holoim/design-tokens";
import { placeControl, recordingText, VIEW_TARGETS, type Control } from "@holoim/xr-ui-core";
import { MathUtils, Object3D, PerspectiveCamera, Quaternion, Vector3 } from "three";
import { beforeAll, describe, expect, it } from "vitest";

import { ThreeHalo } from "./ThreeHalo.js";
import { ThreeMsdfLabel } from "./ThreeMsdfLabel.js";
import { ThreeStatusLine } from "./ThreeStatusLine.js";
import { ThreeWorldPanel } from "./ThreeWorldPanel.js";
import { ThreeWristGlyphs } from "./ThreeWristGlyphs.js";
import { everyDescendantIsChrome, figtree400 } from "./testing.js";

let font: Awaited<ReturnType<typeof figtree400>>;
beforeAll(async () => {
  font = await figtree400();
});

function headAt(yawDegrees: number, pitchDegrees = 0, position = new Vector3(0, 1.6, 0)): PerspectiveCamera {
  const camera = new PerspectiveCamera();
  camera.position.copy(position);
  camera.rotation.set(MathUtils.degToRad(pitchDegrees), MathUtils.degToRad(yawDegrees), 0, "YXZ");
  camera.updateMatrixWorld(true);
  return camera;
}

/** Yaw of a point around the head, degrees: 0 straight ahead (-Z), positive turning left. */
function yawOf(point: Vector3, head: Vector3): number {
  return MathUtils.radToDeg(Math.atan2(-(point.x - head.x), -(point.z - head.z)));
}

describe("ThreeWristGlyphs (9.1, brief Q11)", () => {
  it("is on the left wrist for right-handed users, and on the right for left-handed", () => {
    expect(new ThreeWristGlyphs({ handedness: "right", glyphs: ["play"], input: "poke" }).hand).toBe("left");
    expect(new ThreeWristGlyphs({ handedness: "left", glyphs: ["play"], input: "poke" }).hand).toBe("right");
  });

  it("agrees with the placement contract", () => {
    for (const handedness of ["left", "right"] as const) {
      expect(placeControl("record", VIEW_TARGETS.vr, handedness).hand).toBe(new ThreeWristGlyphs({ handedness, glyphs: ["record"], input: "poke" }).hand);
    }
  });

  it("follows the wrist: 4 cm out of its back (local +Y), with its orientation", () => {
    const row = new ThreeWristGlyphs({ handedness: "right", glyphs: ["play", "record"], input: "poke" });
    const wrist = new Object3D();
    wrist.position.set(0.2, 1.1, -0.3);
    wrist.rotation.set(0.3, 0.4, Math.PI / 2);
    wrist.updateMatrixWorld(true);
    row.update(wrist);
    const back = new Vector3(0, tokens.placement.wristOffsetM, 0).applyQuaternion(wrist.quaternion);
    expect(row.group.position.distanceTo(wrist.position.clone().add(back))).toBeLessThan(1e-9);
    expect(row.group.quaternion.angleTo(wrist.quaternion)).toBeLessThan(1e-9);
    // The glyphs face out of the back of the wrist.
    row.group.updateMatrixWorld(true);
    const facing = new Vector3(0, 0, 1).applyQuaternion(row.glyphs[0]!.group.getWorldQuaternion(new Quaternion()));
    expect(facing.distanceTo(new Vector3(0, 1, 0).applyQuaternion(wrist.quaternion))).toBeLessThan(1e-9);
  });

  it("accesses a glyph by id and turns Record into Stop", () => {
    const row = new ThreeWristGlyphs({ handedness: "right", glyphs: ["play", "record"], input: "poke" });
    expect(row.glyph("record")).toBe(row.glyphs[1]);
    expect(row.glyph("free")).toBeUndefined();
    row.setRecording(true);
    expect(row.glyph("record")!.shape!.geometry.type).toBe("ShapeGeometry");
  });
});

describe("only the status line follows the head (1.2)", () => {
  it("is the one placement that follows the head in a headset", () => {
    const controls: Control[] = ["play", "free", "return", "timecode", "caption", "scale", "record", "ink", "undo", "exitAr", "placingHint", "upload", "signIn", "halo", "settings", "library", "longText", "status", "markEditor", "menu"];
    const following = controls.filter((control) => placeControl(control, VIEW_TARGETS.vr, "right").followsHead);
    expect(following).toEqual(["status"]);
  });

  it("moves with the head; the wrist row, world panel and Halo stay where they were put", () => {
    const line = new ThreeStatusLine({ text: recordingText(12_000), font, texture: null, chip: true });
    const panel = new ThreeWorldPanel();
    const row = new ThreeWristGlyphs({ handedness: "right", glyphs: ["record"], input: "poke" });
    const halo = new ThreeHalo({ actions: ["record"], distanceM: 1 });
    expect(line.followsHead).toBe(true);
    for (const other of [panel, row, halo]) expect("followsHead" in other).toBe(false);

    const head = headAt(0);
    panel.place(head);
    const wrist = new Object3D();
    wrist.position.set(-0.2, 1.1, -0.3);
    wrist.updateMatrixWorld(true);
    row.update(wrist);
    const panelAt = panel.group.position.clone();
    const rowAt = row.group.position.clone();
    const haloAt = halo.group.position.clone();

    line.update(head, 16);
    const lineAt = line.group.position.clone();
    const turned = headAt(90);
    for (let t = 0; t < 3000; t += 16) line.update(turned, 16);
    expect(line.group.position.distanceTo(lineAt)).toBeGreaterThan(1);
    expect(panel.group.position).toEqual(panelAt);
    expect(row.group.position).toEqual(rowAt);
    expect(halo.group.position).toEqual(haloAt);
  });
});

describe("ThreeStatusLine (9.1, 8.5)", () => {
  it("starts 20 degrees above the line of sight, 1.5 m out, facing the head", () => {
    const line = new ThreeStatusLine({ text: "Recording 0:12", font, texture: null, chip: false });
    const head = headAt(0);
    line.update(head, 16);
    const offset = line.group.position.clone().sub(head.position);
    expect(offset.length()).toBeCloseTo(tokens.placement.statusLine.distanceM, 9);
    expect(MathUtils.radToDeg(Math.asin(offset.y / offset.length()))).toBeCloseTo(tokens.placement.statusLine.elevationDegrees, 6);
    expect(Math.abs(yawOf(line.group.position, head.position))).toBeLessThan(1e-6);
    const facing = new Vector3(0, 0, 1).applyQuaternion(line.group.quaternion);
    expect(facing.distanceTo(offset.clone().negate().normalize())).toBeLessThan(1e-6);
  });

  it("stays put for a small turn, follows a large one, and settles within 1 degree", () => {
    const line = new ThreeStatusLine({ text: "x", font, texture: null, chip: false });
    const home = new Vector3(0, 1.6, 0);
    line.update(headAt(0), 16);
    const start = line.group.position.clone();
    for (let t = 0; t < 1000; t += 16) line.update(headAt(10), 16);
    expect(line.group.position.distanceTo(start)).toBeLessThan(1e-9);
    for (let t = 0; t < 5000; t += 16) line.update(headAt(60), 16);
    expect(Math.abs(yawOf(line.group.position, home) - 60)).toBeLessThanOrEqual(tokens.placement.statusLine.settleDegrees + 1e-6);
  });

  it("builds the chip only when asked, and fits it to the text", () => {
    const bare = new ThreeStatusLine({ text: "Recording 0:12", font, texture: null, chip: false });
    expect(bare.chip).toBeNull();
    const chipped = new ThreeStatusLine({ text: "Recording 0:12", font, texture: null, chip: true });
    expect(chipped.chip).not.toBeNull();
    expect(chipped.chip!.widthM).toBeCloseTo(chipped.label.widthM + 2 * chipped.chip!.paddingInlineM, 9);
    chipped.setText("Recording 0:12 and more");
    expect(chipped.chip!.widthM).toBeCloseTo(chipped.label.widthM + 2 * chipped.chip!.paddingInlineM, 9);
  });

  it("fades the VR chip in only while the background asks (8.4)", () => {
    const line = new ThreeStatusLine({ text: "x", font, texture: null, chip: true });
    const head = headAt(0);
    for (let t = 0; t < 400; t += 16) line.update(head, 16, false);
    expect(line.chip!.presence).toBe(0);
    for (let t = 0; t < 400; t += 16) line.update(head, 16, true);
    expect(line.chip!.presence).toBe(1);
  });

  it("is chrome on every object, after setText too", () => {
    const line = new ThreeStatusLine({ text: "x", font, texture: null, chip: true });
    line.setText(recordingText(5000));
    expect(everyDescendantIsChrome(line.group)).toBe(true);
  });

  it("is not for flat screens", () => {
    expect(() => new ThreeStatusLine({ text: "x", font, texture: null, chip: false, target: VIEW_TARGETS.phone })).toThrow();
  });
});

describe("ThreeWorldPanel (1.2, 7.3)", () => {
  it("opens at 1 m when asked for 0.4 m, straight ahead, facing the head", () => {
    const panel = new ThreeWorldPanel();
    const head = headAt(30, 0);
    panel.place(head, 0.4);
    expect(panel.group.position.distanceTo(head.position)).toBeCloseTo(1, 9);
    expect(panel.distanceM).toBe(1);
    const ahead = new Vector3(0, 0, -1).applyQuaternion(head.quaternion);
    const toPanel = panel.group.position.clone().sub(head.position).normalize();
    expect(toPanel.distanceTo(ahead)).toBeLessThan(1e-9);
    const facing = new Vector3(0, 0, 1).applyQuaternion(panel.group.quaternion);
    expect(facing.distanceTo(toPanel.clone().negate())).toBeLessThan(1e-9);
  });

  it("opens at 1.5 m by default and keeps a larger request", () => {
    const head = headAt(0);
    const panel = new ThreeWorldPanel();
    panel.place(head);
    expect(panel.group.position.distanceTo(head.position)).toBeCloseTo(1.5, 9);
    panel.place(head, 2.2);
    expect(panel.group.position.distanceTo(head.position)).toBeCloseTo(2.2, 9);
  });

  it("stays in the world after it is placed: the head moving does not move it", () => {
    const panel = new ThreeWorldPanel();
    panel.place(headAt(0));
    const at = panel.group.position.clone();
    const quaternion = panel.group.quaternion.clone();
    headAt(120, 10, new Vector3(2, 1.6, 1));
    expect(panel.group.position).toEqual(at);
    expect(panel.group.quaternion.equals(quaternion)).toBe(true);
  });

  it("lays rows out top-down inside the chip's padding", () => {
    const panel = new ThreeWorldPanel();
    const rows = ["Settings", "Left-handed", "Library"].map((text) => new ThreeMsdfLabel({ text, role: "controlLabel", headset: true, distanceM: panel.distanceM, font, texture: null }));
    rows.forEach((row) => panel.addRow(row));
    const ys = rows.map((row) => row.group.position.y);
    expect(ys[0]!).toBeGreaterThan(ys[1]!);
    expect(ys[1]!).toBeGreaterThan(ys[2]!);
    expect(ys[0]! - ys[1]!).toBeCloseTo(rows[0]!.heightM, 9);
    const widest = Math.max(...rows.map((row) => row.widthM));
    expect(panel.chip.widthM).toBeCloseTo(widest + 2 * panel.chip.paddingInlineM, 9);
    expect(panel.chip.heightM).toBeCloseTo(rows.reduce((sum, row) => sum + row.heightM, 0) + 2 * panel.chip.paddingBlockM, 9);
    expect(panel.chip.presence).toBe(1);
    expect(everyDescendantIsChrome(panel.group)).toBe(true);
  });

  it("shows its rows' text at its distance (never within 1 m)", () => {
    const panel = new ThreeWorldPanel();
    const row = new ThreeMsdfLabel({ text: "Settings", role: "controlLabel", headset: true, distanceM: panel.distanceM, font, texture: null });
    panel.addRow(row);
    panel.place(headAt(0), 0.4);
    expect(row.group.visible).toBe(true);
  });
});
