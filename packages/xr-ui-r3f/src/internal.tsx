// Shared by the components of this package; not exported from the index.
// Every formula lives in xr-ui-core and every three.js object is built by
// xr-ui-three: this file only mounts them in React Three Fiber.
import type { BmFont } from "@holoim/design-tokens/msdf";
import type { GlyphId } from "@holoim/xr-ui-core";
import { loadLabelAtlas, type ThreeGlyph } from "@holoim/xr-ui-three";
import type { ThreeEvent } from "@react-three/fiber";
import { useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Mesh, Object3D, Texture } from "three";

/** A glyph in a row of controls. Its `label` is its accessible name. */
export interface GlyphSpec {
  /** null for an action with no drawing yet (brief, "still to draw"): an empty glyph ring, named by `label`. */
  id: GlyphId | null;
  /** The accessible name: kept on the hit mesh's `name` and `userData.label`. */
  label: string;
  onSelect: () => void;
  /** Record becomes Stop (8.5). */
  recording?: boolean;
}

/** A baked MSDF atlas: the font metrics and the image (null lays out without drawing, for tests). */
export interface LabelFont {
  font: BmFont;
  texture: Texture | null;
}

/**
 * Returns the previous value while the new one is structurally equal, so a
 * target or an id list written inline in JSX does not rebuild three.js
 * objects on every render.
 */
export function useStable<T>(value: T): T {
  const ref = useRef(value);
  if (ref.current !== value && JSON.stringify(ref.current) !== JSON.stringify(value)) ref.current = value;
  return ref.current;
}

/** The latest value of a prop, readable from `useFrame` and event handlers without re-subscribing. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** The atlas a label draws with: the one passed in, else the timecode role's, loaded once. Null until it arrives or when no label is wanted. */
export function useLabelFont(font: LabelFont | undefined, wanted: boolean): LabelFont | null {
  const [loaded, setLoaded] = useState<LabelFont | null>(null);
  // An atlas written inline in JSX is the same atlas while its font and texture are.
  const kept = useRef(font);
  if (font && (kept.current?.font !== font.font || kept.current.texture !== font.texture)) kept.current = font;
  const given = font ? kept.current : undefined;
  const hasGiven = given !== undefined;
  useEffect(() => {
    if (hasGiven || !wanted) return;
    let cancelled = false;
    loadLabelAtlas("timecode").then(
      (atlas) => {
        if (!cancelled) setLoaded(atlas);
      },
      () => {
        // Without the atlas the glyphs still work; the label stays absent.
      }
    );
    return () => {
      cancelled = true;
    };
  }, [hasGiven, wanted]);
  return wanted ? (given ?? loaded) : null;
}

let counter = 0;
/** A number that is new for each call: the React key of a rebuilt three.js object. */
export function nextBuildId(): number {
  counter += 1;
  return counter;
}

/**
 * r3f `attach` that leaves an object where it is. A glyph's hit mesh already
 * sits inside its glyph group; mounting it as a child must not move it to the
 * parent, which would lose its place in the row.
 */
const stayInPlace = () => undefined;

function inTree(object: Object3D): boolean {
  for (let node: Object3D | null = object; node; node = node.parent) if (!node.visible) return false;
  return true;
}

/** Hidden chrome keeps no hit areas: r3f raycasts ignore `visible`, which would leave ghost controls at the origin. */
export function setHitEnabled(hit: Mesh, enabled: boolean): void {
  if (enabled) hit.layers.set(0);
  else hit.layers.disableAll();
}

export interface GlyphHitProps {
  glyph: ThreeGlyph;
  label: string;
  onSelect: () => void;
}

/**
 * The r3f events of one glyph: hover and press drive the glyph's states
 * (6), and a click selects. They sit on the glyph's own hit mesh, never on
 * the drawing, so the hit area is the input's minimum (6.1).
 */
export function GlyphHit({ glyph, label, onSelect }: GlyphHitProps) {
  const invalidate = useThree((state) => state.invalidate);
  const state = useRef({ hovered: false, pressed: false });
  const hit = glyph.hitTarget;

  useLayoutEffect(() => {
    hit.name = label;
    hit.userData.label = label;
  }, [hit, label]);

  const set = (next: Partial<typeof state.current>) => {
    state.current = { ...state.current, ...next };
    glyph.setState(state.current);
    invalidate();
  };
  const live = (event: ThreeEvent<PointerEvent | MouseEvent>) => {
    // Chrome never lets a pointer through to what is behind it.
    event.stopPropagation();
    return inTree(hit);
  };

  return (
    <primitive
      object={hit}
      attach={stayInPlace}
      onPointerOver={(event: ThreeEvent<PointerEvent>) => live(event) && set({ hovered: true })}
      onPointerOut={(event: ThreeEvent<PointerEvent>) => live(event) && set({ hovered: false, pressed: false })}
      onPointerDown={(event: ThreeEvent<PointerEvent>) => live(event) && set({ pressed: true })}
      onPointerUp={(event: ThreeEvent<PointerEvent>) => live(event) && set({ pressed: false })}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        if (live(event)) onSelect();
      }}
    />
  );
}
