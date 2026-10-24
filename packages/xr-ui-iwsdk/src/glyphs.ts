import { UIKit } from "@iwsdk/core";
import type { BufferGeometry} from "three";
import { Color, DoubleSide, Mesh, MeshBasicMaterial, ShapeGeometry, Vector3 } from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";

import { GLYPH } from "./tokens.js";

// Thin gold line glyphs (styleguide §6), drawn as meshes inside a UIKit
// Content element so UIKit lays them out. UIKit's own Svg element fills paths
// and ignores strokes, so strokes are tessellated here with round caps and
// joins. Paths are on the styleguide's 16 × 16 viewBox.

export interface GlyphDrawing {
  d: string;
  /** Filled shape (Play triangle, record shapes); otherwise a line. */
  fill?: boolean;
}

/**
 * Styleguide §6 glyphs, path for path; the two must change together.
 */
export const GLYPHS = {
  play: { d: "M4 2.5v11l9-5.5z", fill: true },
  // Two filled bars, the Play triangle's weight.
  pause: { d: "M4.5 3h2.4v10H4.5zM9.1 3h2.4v10H9.1z", fill: true },
  // A back-to-start bar and an open triangle.
  restart: { d: "M3.5 3v10M12.5 3.2 6 8l6.5 4.8z" },
  // A ring with four ticks, "put it back in front of me".
  recenter: { d: "M8 1.5v2.5M8 12v2.5M1.5 8H4M12 8h2.5M8 5a3 3 0 1 0 0 6a3 3 0 1 0 0-6" },
  // An open door frame with an arrow leaving it.
  exit: { d: "M9 2.5H4.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H9M7 8h7.5M12 5.5 14.5 8 12 10.5" },
  // Record (§6): filled rose circle idle, rose rounded square while recording.
  recordIdle: { d: "M8 1a7 7 0 1 0 0 14a7 7 0 1 0 0-14z", fill: true },
  recordStop: { d: "M4.5 1.5h7a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-7a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3z", fill: true }
} as const satisfies Record<string, GlyphDrawing>;

export type GlyphName = keyof typeof GLYPHS;

const VIEWBOX = 16;

function parsePath(d: string) {
  return new SVGLoader().parse(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}"><path d="${d}"/></svg>`).paths;
}

/** Geometry on the 16 × 16 viewBox (y down, as SVG), stroked at `strokeWidth` viewBox units. */
export function glyphGeometries(drawing: GlyphDrawing, strokeWidth: number): BufferGeometry[] {
  const geometries: BufferGeometry[] = [];
  for (const path of parsePath(drawing.d)) {
    if (drawing.fill) {
      for (const shape of SVGLoader.createShapes(path)) geometries.push(new ShapeGeometry(shape));
      continue;
    }
    const style = SVGLoader.getStrokeStyle(strokeWidth, "#fff", "round", "round", 4);
    for (const subPath of path.subPaths) {
      const geometry = SVGLoader.pointsToStroke(subPath.getPoints(), style);
      if (geometry) geometries.push(geometry);
    }
  }
  return geometries;
}

/** A ring of `diameter` viewBox units with a centred stroke, as Play's and Record's (§6). */
function ringGeometry(diameter: number, strokeWidth: number): BufferGeometry {
  const r = diameter / 2 - strokeWidth / 2;
  const c = diameter / 2;
  const [path] = new SVGLoader().parse(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${diameter} ${diameter}"><path d="M${c} ${c - r}a${r} ${r} 0 1 0 0 ${2 * r}a${r} ${r} 0 1 0 0 ${-2 * r}"/></svg>`
  ).paths;
  return SVGLoader.pointsToStroke(path!.subPaths[0]!.getPoints(64), SVGLoader.getStrokeStyle(strokeWidth, "#fff", "round", "round", 4))!;
}

export interface GlyphElement {
  element: InstanceType<typeof UIKit.Content>;
  materials: MeshBasicMaterial[];
  setDrawing(name: GlyphName): void;
  setColor(color: string): void;
  setOpacity(opacity: number): void;
  dispose(): void;
}

/**
 * A glyph as a UIKit Content element of `size` apx. With `ring`, it is drawn
 * inside the 36 apx gold ring at `innerSize` apx, as Play and Record are.
 */
export function createGlyph(name: GlyphName, options: { size: number; color: string; ring?: { innerSize: number; color?: string } }): GlyphElement {
  const materials: MeshBasicMaterial[] = [];
  const meshes: Mesh[] = [];
  const box = options.ring ? GLYPH.ring : GLYPH.icon;
  const element = new UIKit.Content({ width: options.size, height: options.size, keepAspectRatio: true, depthAlign: "center" });
  // Content fits its children's box into its layout size: the box is the viewBox.
  (element.boundingBox as { value: unknown }).value = { center: new Vector3(box / 2, -box / 2, 0), size: new Vector3(box, box, 0.00001) };

  const addMesh = (geometry: BufferGeometry, color: string, offset: number, scale: number): void => {
    const material = new MeshBasicMaterial({ color: new Color(color), transparent: true, toneMapped: false, depthWrite: false, side: DoubleSide });
    const mesh = new Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    mesh.position.set(offset, -offset, 0);
    mesh.scale.set(scale, -scale, 1);
    mesh.updateMatrix();
    materials.push(material);
    meshes.push(mesh);
    (element as unknown as { addUnsafe(...objects: Mesh[]): void }).addUnsafe(mesh);
  };

  let drawingMeshes: Mesh[] = [];
  let drawing: GlyphName | null = null;
  const draw = (glyph: GlyphName): void => {
    if (glyph === drawing) return;
    drawing = glyph;
    for (const mesh of drawingMeshes) {
      element.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as MeshBasicMaterial).dispose();
      materials.splice(materials.indexOf(mesh.material as MeshBasicMaterial), 1);
      meshes.splice(meshes.indexOf(mesh), 1);
    }
    const before = meshes.length;
    const inner = options.ring?.innerSize ?? GLYPH.icon;
    const scale = inner / GLYPH.icon;
    const offset = (box - inner) / 2;
    // Stroke width stays GLYPH.stroke apx whatever the glyph's drawn size.
    for (const geometry of glyphGeometries(GLYPHS[glyph], GLYPH.stroke / scale)) addMesh(geometry, currentColor, offset, scale);
    drawingMeshes = meshes.slice(before);
    for (const material of materials) material.opacity = currentOpacity;
  };

  let currentColor = options.color;
  let currentOpacity = 1;
  if (options.ring) addMesh(ringGeometry(GLYPH.ring, GLYPH.stroke), options.ring.color ?? options.color, 0, 1);
  const ringMesh = options.ring ? meshes[0] : undefined;
  draw(name);

  return {
    element,
    materials,
    setDrawing: draw,
    setColor(color) {
      if (color === currentColor) return;
      currentColor = color;
      for (const mesh of drawingMeshes) (mesh.material as MeshBasicMaterial).color.set(color);
      // The ring brightens with its glyph on hover (§6 states), unless it has its own colour.
      if (ringMesh && !options.ring?.color) (ringMesh.material as MeshBasicMaterial).color.set(color);
    },
    setOpacity(opacity) {
      if (opacity === currentOpacity) return;
      currentOpacity = opacity;
      for (const material of materials) material.opacity = opacity;
    },
    dispose() {
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        (mesh.material as MeshBasicMaterial).dispose();
      }
    }
  };
}
