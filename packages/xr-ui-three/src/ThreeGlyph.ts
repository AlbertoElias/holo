// A glyph control in 3D (styleguide 6): a thin gold line drawing, a gold ring
// around Play and Record, the rose record shapes, the hover, focus and
// pressed states, and a hit area per input (6.1) that is never scaled. All
// lengths are metres at a distance; the headset's 2.5× is applied once, by
// `apxToMeters`, to unscaled apx.
import { apxToMeters, hitAreaMeters, tokens, type HitInput } from "@holoim/design-tokens";
import {
  drawnSizeApx,
  glyphAppearance,
  glyphDrawing,
  glyphMetrics,
  type GlyphDrawing,
  type GlyphId,
  type GlyphInteraction
} from "@holoim/xr-ui-core";
import {
  BufferGeometry,
  CircleGeometry,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  type MeshBasicMaterial,
  PlaneGeometry,
  RingGeometry,
  Shape,
  ShapeGeometry,
  type Vector2
} from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";

import { createChromeMaterial, finishChrome, setChromeColor, setChromeOpacity } from "./chrome.js";

export interface ThreeGlyphOptions {
  /** A drawn glyph or Record; null is an empty ring of the glyph size (Halo slots with no drawing yet). */
  id: GlyphId | null;
  /** The input that will point at it: sets the hit area. */
  input: HitInput;
  distanceM: number;
  /** True in VR and Quest AR: drawn sizes take the headset's 2.5×; hit areas never do. */
  headset: boolean;
  /** Record shows its stop shape. */
  recording?: boolean;
  /** Draws the gold ring around a line glyph too (each Halo slot is a glyph ring). */
  ringed?: boolean;
}

const RING_SEGMENTS = 64;
const ARC_DIVISIONS = 12;
/** SVG's default `stroke-miterlimit`; the glyph tokens decide the join, not the limit. */
const SVG_MITER_LIMIT = 4;

/** A rounded square of the given side, centred, as a ShapeGeometry. */
function roundedSquare(side: number, radius: number): BufferGeometry {
  const half = side / 2;
  const r = Math.min(radius, half);
  const shape = new Shape();
  shape.moveTo(-half + r, -half);
  shape.lineTo(half - r, -half);
  shape.absarc(half - r, -half + r, r, -Math.PI / 2, 0, false);
  shape.lineTo(half, half - r);
  shape.absarc(half - r, half - r, r, 0, Math.PI / 2, false);
  shape.lineTo(-half + r, half);
  shape.absarc(-half + r, half - r, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(-half, -half + r);
  shape.absarc(-half + r, -half + r, r, Math.PI, Math.PI * 1.5, false);
  return new ShapeGeometry(shape, ARC_DIVISIONS);
}

/** The glyph's path, from the 16 box (y down) to a centred y-up geometry `sizeM` wide. */
function pathGeometry(drawing: Extract<GlyphDrawing, { kind: "path" }>, sizeM: number, strokeM: number, viewbox: number): BufferGeometry | null {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewbox} ${viewbox}"><path d="${drawing.d}"/></svg>`;
  const { paths } = new SVGLoader().parse(svg);
  const scale = sizeM / viewbox;
  const toMetres = new Matrix4().makeScale(scale, -scale, 1).multiply(new Matrix4().makeTranslation(-viewbox / 2, -viewbox / 2, 0));
  const parts: BufferGeometry[] = [];
  for (const path of paths) {
    if (drawing.fill) {
      const shapes = SVGLoader.createShapes(path);
      if (shapes.length > 0) parts.push(new ShapeGeometry(shapes));
    } else {
      // The stroke is a drawn length in metres; the geometry is still in box units.
      const style = SVGLoader.getStrokeStyle(strokeM / scale, "#fff", drawing.linejoin, "round", SVG_MITER_LIMIT);
      for (const subPath of path.subPaths) {
        const points: Vector2[] = subPath.getPoints(ARC_DIVISIONS);
        if (points.length < 2) continue;
        parts.push(SVGLoader.pointsToStroke(points, style, ARC_DIVISIONS, 0.001));
      }
    }
  }
  if (parts.length === 0) return null;
  const merged = mergeGeometries(parts);
  merged.applyMatrix4(toMetres);
  for (const part of parts) part.dispose();
  return merged;
}

/** Concatenates position-only geometries (every part is flat, at z = 0). */
function mergeGeometries(parts: readonly BufferGeometry[]): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const part of parts) {
    const offset = positions.length / 3;
    const attribute = part.getAttribute("position");
    for (let i = 0; i < attribute.count; i += 1) positions.push(attribute.getX(i), attribute.getY(i), 0);
    const index = part.getIndex();
    if (index) for (let i = 0; i < index.count; i += 1) indices.push(index.getX(i) + offset);
    else for (let i = 0; i < attribute.count; i += 1) indices.push(i + offset);
  }
  const merged = new BufferGeometry();
  merged.setAttribute("position", new Float32BufferAttribute(positions, 3));
  merged.setIndex(indices);
  return merged;
}

export class ThreeGlyph {
  private renderOrder = 0;
  readonly group = new Group();
  readonly id: GlyphId | null;
  readonly input: HitInput;
  readonly distanceM: number;
  readonly headset: boolean;
  /** The invisible, still raycastable square of side `hitSizeM`. */
  readonly hitTarget: Mesh;
  /** Side of the hit area in metres: the larger of the drawn size and the input's minimum, never scaled. */
  readonly hitSizeM: number;
  /** The drawn size in metres: the ring's diameter for ringed glyphs, the icon's side otherwise. */
  readonly drawnSizeM: number;
  /** The gold ring of Play, Record and empty slots. */
  readonly ring: Mesh | null;
  /** The extra ring keyboard or ray focus draws; hidden until `focusRing` is set. */
  readonly focusRing: Mesh;
  /** The line drawing or the record shape; null for an empty ring. */
  shape: Mesh | null = null;
  private recording: boolean;
  private interaction: GlyphInteraction = {};
  private readonly lineMaterials: MeshBasicMaterial[] = [];
  private readonly recordMaterials: MeshBasicMaterial[] = [];
  private readonly focusMaterial: MeshBasicMaterial;

  constructor({ id, input, distanceM, headset, recording = false, ringed: ringAround = false }: ThreeGlyphOptions) {
    this.id = id;
    this.input = input;
    this.distanceM = distanceM;
    this.headset = headset;
    this.recording = recording;
    const unscaled = glyphMetrics({ headset: false });
    const drawing = id === null ? null : glyphDrawing(id, { recording });
    const ringed = drawing === null || drawing.ringed || ringAround;
    const drawnApx = drawing === null || ringAround ? Math.max(unscaled.ringApx, drawing ? drawnSizeApx(drawing, { headset: false }) : 0) : drawnSizeApx(drawing, { headset: false });
    this.drawnSizeM = apxToMeters(drawnApx, distanceM, { headset });
    this.hitSizeM = hitAreaMeters(input, drawnApx, distanceM, { headset });

    if (ringed) {
      const outer = apxToMeters(unscaled.ringApx, distanceM, { headset }) / 2;
      const inner = outer - apxToMeters(unscaled.strokeApx, distanceM, { headset });
      const material = createChromeMaterial({ color: tokens.glyph.color });
      this.lineMaterials.push(material);
      this.ring = new Mesh(new RingGeometry(inner, outer, RING_SEGMENTS), material);
      this.ring.name = "glyph-ring";
      this.group.add(this.ring);
    } else {
      this.ring = null;
    }

    // Focus ring: its width and offset already carry the headset scale.
    const focus = glyphAppearance({ focusVisible: true }, { headset }).focusRing!;
    const around = ringed ? apxToMeters(unscaled.ringApx, distanceM, { headset }) / 2 : this.drawnSizeM / 2;
    const focusInner = around + apxToMeters(focus.offset, distanceM, { headset: false });
    this.focusMaterial = createChromeMaterial({ color: focus.color });
    this.focusRing = new Mesh(new RingGeometry(focusInner, focusInner + apxToMeters(focus.width, distanceM, { headset: false }), RING_SEGMENTS), this.focusMaterial);
    this.focusRing.name = "glyph-focus-ring";
    this.focusRing.visible = false;
    this.group.add(this.focusRing);

    const hitMaterial = createChromeMaterial({ color: tokens.glyph.color, visible: false, doubleSided: true });
    this.hitTarget = new Mesh(new PlaneGeometry(this.hitSizeM, this.hitSizeM), hitMaterial);
    this.hitTarget.name = "glyph-hit";
    this.group.add(this.hitTarget);

    this.buildShape();
    this.group.name = `glyph-${id ?? "empty"}`;
    this.setState({});
    finishChrome(this.group);
  }

  private buildShape(): void {
    if (this.shape) {
      this.group.remove(this.shape);
      this.shape.geometry.dispose();
      const old = this.shape.material as MeshBasicMaterial;
      for (const list of [this.lineMaterials, this.recordMaterials]) {
        const at = list.indexOf(old);
        if (at >= 0) list.splice(at, 1);
      }
      old.dispose();
      this.shape = null;
    }
    if (this.id === null) return;
    const drawing = glyphDrawing(this.id, { recording: this.recording });
    const { headset, distanceM } = this;
    let geometry: BufferGeometry | null;
    let material: MeshBasicMaterial;
    if (drawing.kind === "recordIdle") {
      geometry = new CircleGeometry(apxToMeters(drawing.diameterApx, distanceM, { headset }) / 2, RING_SEGMENTS);
      material = createChromeMaterial({ color: tokens.color.record });
      this.recordMaterials.push(material);
    } else if (drawing.kind === "recordStop") {
      geometry = roundedSquare(apxToMeters(drawing.sizeApx, distanceM, { headset }), apxToMeters(drawing.cornerRadiusApx, distanceM, { headset }));
      material = createChromeMaterial({ color: tokens.color.record });
      this.recordMaterials.push(material);
    } else {
      const strokeM = apxToMeters(glyphMetrics({ headset: false }).strokeApx, distanceM, { headset });
      geometry = pathGeometry(drawing, apxToMeters(drawing.drawnApx, distanceM, { headset }), strokeM, 16);
      material = createChromeMaterial({ color: tokens.glyph.color, doubleSided: true });
      this.lineMaterials.push(material);
    }
    if (!geometry) return;
    this.shape = new Mesh(geometry, material);
    this.shape.name = `glyph-${drawing.kind}`;
    this.shape.renderOrder = this.renderOrder;
    this.group.add(this.shape);
    this.applyState();
    finishChrome(this.group);
  }

  /** Applies hover, focus, pressed and idle-dim (6, 1.2) through `glyphAppearance`. */
  setState(interaction: GlyphInteraction): void {
    this.interaction = interaction;
    this.applyState();
  }

  private applyState(): void {
    const appearance = glyphAppearance(this.interaction, { headset: this.headset });
    for (const material of this.lineMaterials) {
      setChromeColor(material, appearance.color);
      setChromeOpacity(material, appearance.opacity);
    }
    if (appearance.focusRing) setChromeColor(this.focusMaterial, appearance.focusRing.color);
    for (const material of this.recordMaterials) {
      setChromeColor(material, appearance.recordColor);
      setChromeOpacity(material, appearance.opacity);
    }
    this.focusRing.visible = appearance.focusRing !== null;
  }

  /** Draw order of every mesh in the glyph, kept when Record rebuilds its shape (so it stays above a chip). */
  setRenderOrder(order: number): void {
    this.renderOrder = order;
    this.group.traverse((object) => {
      object.renderOrder = order;
    });
  }

  /** Record becomes Stop (a rose rounded square) and back; other glyphs ignore it. */
  setRecording(recording: boolean): void {
    if (this.id !== "record" || recording === this.recording) return;
    this.recording = recording;
    this.buildShape();
    finishChrome(this.group);
  }

  dispose(): void {
    this.group.traverse((object) => {
      // Structural check: three values cross package boundaries.
      const mesh = object as Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        (mesh.material as MeshBasicMaterial).dispose();
      }
    });
  }
}
