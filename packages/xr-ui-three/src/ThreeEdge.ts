// The golden edge in 3D (styleguide 3): the seeded outline from xr-ui-core
// drawn as four ribbons, soot, halo, core and highlight in that order. The
// halo and the soot are soft, a gaussian of alpha across their width; the
// core and highlight are solid. All lengths are metres.
import { tokens } from "@holoim/design-tokens";
import {
  edgeOutline,
  edgePointsYUp,
  edgeStrokes,
  haloMaterialOpacity,
  type EdgeFrame,
  type EdgePoint,
  type EdgeShape,
  type EdgeStroke
} from "@holoim/xr-ui-core";
import { BufferAttribute, BufferGeometry, Float32BufferAttribute, Group, Mesh, type MeshBasicMaterial } from "three";

import { createChromeMaterial, finishChrome, setChromeOpacity } from "./chrome.js";

export interface ThreeEdgeOptions {
  /** The hologram's id (Q10), so one hologram keeps the same tears everywhere. */
  seed: string;
  /** The card's size in metres. */
  width: number;
  height: number;
  /** Default `"roundedRect"`; `"circle"` for the AR bubble (9.2). */
  shape?: EdgeShape;
  /** Render order of the soot ribbon; the others follow. Default 0. */
  baseRenderOrder?: number;
}

/** Rows across a soft ribbon: odd, so one row sits on the centre line. */
const SOFT_ROWS = 9;
const SOLID_ROWS = 2;

export type EdgeLayer = "soot" | "halo" | "core" | "highlight";
const LAYERS: readonly EdgeLayer[] = ["soot", "halo", "core", "highlight"];

/** Unit normals of a closed loop, from the neighbouring points. */
function loopNormals(points: readonly EdgePoint[]): Array<{ x: number; y: number }> {
  const count = points.length;
  return points.map((_, index) => {
    const before = points[(index + count - 1) % count]!;
    const after = points[(index + 1) % count]!;
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: dy / length, y: -dx / length };
  });
}

/**
 * Alpha across a soft stroke at distance `d` from its centre line: a gaussian
 * of the stroke's blur standard deviation, lowered so it reaches 0 at the
 * ribbon's rim (the ribbon is only as wide as the stroke) and 1 on the centre.
 */
export function softAlpha(d: number, halfWidth: number, sigma: number): number {
  const gaussian = (x: number) => Math.exp(-(x * x) / (2 * sigma * sigma));
  const rim = gaussian(halfWidth);
  return Math.max(0, (gaussian(d) - rim) / (1 - rim));
}

/** A closed triangle strip along `points`, offset by ± half `stroke.width` along the normals. */
function ribbonGeometry(points: readonly EdgePoint[], stroke: EdgeStroke): BufferGeometry {
  const soft = stroke.blur > 0;
  const rows = soft ? SOFT_ROWS : SOLID_ROWS;
  const half = stroke.width / 2;
  const normals = loopNormals(points);
  const count = points.length;
  const positions = new Float32Array(count * rows * 3);
  const colors = soft ? new Float32Array(count * rows * 4) : null;
  for (let i = 0; i < count; i += 1) {
    const point = points[i]!;
    const normal = normals[i]!;
    for (let row = 0; row < rows; row += 1) {
      const offset = -half + (stroke.width * row) / (rows - 1);
      const at = (i * rows + row) * 3;
      positions[at] = point.x + normal.x * offset;
      positions[at + 1] = point.y + normal.y * offset;
      positions[at + 2] = 0;
      if (colors) {
        const rgba = (i * rows + row) * 4;
        colors[rgba] = 1;
        colors[rgba + 1] = 1;
        colors[rgba + 2] = 1;
        colors[rgba + 3] = softAlpha(offset, half, stroke.blur);
      }
    }
  }
  const indices: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const next = (i + 1) % count;
    for (let row = 0; row < rows - 1; row += 1) {
      const a = i * rows + row;
      const b = i * rows + row + 1;
      const c = next * rows + row;
      const d = next * rows + row + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  if (colors) geometry.setAttribute("color", new BufferAttribute(colors, 4));
  geometry.setIndex(indices);
  return geometry;
}

export class ThreeEdge {
  readonly group = new Group();
  /** The outline, centred on the card, y up, in metres: `edgePointsYUp` of the core outline. */
  readonly points: EdgePoint[];
  readonly strokes: ReturnType<typeof edgeStrokes>;
  readonly meshes: Record<EdgeLayer, Mesh>;
  readonly materials: Record<EdgeLayer, MeshBasicMaterial>;

  constructor({ seed, width, height, shape, baseRenderOrder = 0 }: ThreeEdgeOptions) {
    const outline = edgeOutline({ seed, width, height, ...(shape ? { shape } : {}) });
    this.points = edgePointsYUp(outline, width, height);
    this.strokes = edgeStrokes(outline.shortSide);
    const meshes = {} as Record<EdgeLayer, Mesh>;
    const materials = {} as Record<EdgeLayer, MeshBasicMaterial>;
    LAYERS.forEach((layer, index) => {
      const stroke = this.strokes[layer];
      // Forced transparent: the layers must sort by render order, and an
      // opaque core would write depth in front of the halo drawn after it.
      const material = createChromeMaterial({ color: stroke.color, vertexColors: stroke.blur > 0, transparent: true, doubleSided: true });
      const mesh = new Mesh(ribbonGeometry(this.points, stroke), material);
      mesh.name = `edge-${layer}`;
      mesh.renderOrder = baseRenderOrder + index;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      meshes[layer] = mesh;
      materials[layer] = material;
    });
    this.meshes = meshes;
    this.materials = materials;
    this.group.name = "edge";
    // Rests at the halo's resting level until the first frame says otherwise.
    this.update({ drawn: true, glowLevel: tokens.edge.halo.level, sootOpacity: 0, coreOpacity: 1, highlightOpacity: 1, sparks: 0 });
    finishChrome(this.group);
  }

  /** What the edge draws this frame (from `edgeFrame`); `sparks` belongs to the sparks, not the ribbons. */
  update(frame: EdgeFrame): void {
    this.group.visible = frame.drawn;
    setChromeOpacity(this.materials.halo, haloMaterialOpacity(frame.glowLevel));
    setChromeOpacity(this.materials.soot, frame.sootOpacity);
    setChromeOpacity(this.materials.core, frame.coreOpacity);
    setChromeOpacity(this.materials.highlight, frame.highlightOpacity);
    finishChrome(this.group);
  }

  dispose(): void {
    for (const layer of LAYERS) {
      this.meshes[layer].geometry.dispose();
      this.materials[layer].dispose();
    }
  }
}
