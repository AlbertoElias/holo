import { useFrame, useThree } from "@react-three/fiber";
import type { ClocheShape } from "@holoim/xr-ui-core";
import { useEffect, useRef, useState } from "react";
import { Vector3 } from "three";
import type { Object3D } from "three";
import type { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

import type { LoadedPlace } from "./loadPlace";
import { PLACE_CLIP_GLSL, SPLAT_EXTENT_SIGMA, extentLeavesDome, placeClipFade, type DomeShape } from "./placeClip";
import type { PlaceReadings, PlaceReport } from "./placeReport";
import { FLOOR_BAND_METERS } from "./placeAnalysis";
import { cropToSweep, placeOnFloor } from "./placeSplats";

/** The shader's dome follows the card's dome by at least this much, metres; a finer move is not worth a regeneration. */
const CLIP_EPSILON_METERS = 0.001;
/** Draws before the glass, traces and highlights, which all sit at render order 0 and above. */
const PLACE_RENDER_ORDER = -100;

type Built = { spark: SparkRenderer; mesh: SplatMesh };

/**
 * The scan as Spark draws it in the card: placed on the take's floor, cut by
 * the cloche's dome in Spark's shader from the dome's own shape and shift each
 * frame, redrawn on demand when a sort or a regeneration lands.
 */
export function PlaceLayer({ place, shape, shift, takeFloorY, sweep, readFeetY, report, bind }: {
  place: LoadedPlace;
  shape: ClocheShape;
  /** The dome's shift since the fit, set each frame before this runs. */
  shift: Vector3;
  takeFloorY: number;
  /** The range the bubble's centre covers over the take, relative to the fit: the crop's box. */
  sweep: { min: Vector3; max: Vector3 };
  readFeetY: () => number;
  report: PlaceReport;
  bind: (readings: PlaceReadings | null) => void;
}) {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  const [built, setBuilt] = useState<Built | null>(null);
  const clip = useRef<{ base: Vector3; radii: Vector3; exponent: number; applied: DomeShape; pushed: number; generated: number } | null>(null);

  useEffect(() => {
    const S = place.spark;
    const dome: DomeShape = { base: { ...shape.base }, radii: { ...shape.radii }, exponent: shape.exponent };
    const placement = placeOnFloor(place, dome, takeFloorY);
    const cropped = cropToSweep(place, placement, dome, sweep);
    const base = S.dyno.dynoVec3(new Vector3(shape.base.x, shape.base.y, shape.base.z).add(shift));
    const radii = S.dyno.dynoVec3(new Vector3(shape.radii.x, shape.radii.y, shape.radii.z));
    const exponent = S.dyno.dynoFloat(shape.exponent);
    const modifier = S.dyno.dynoBlock({ gsplat: S.dyno.Gsplat }, { gsplat: S.dyno.Gsplat }, ({ gsplat }) => {
      if (!gsplat) throw new Error("no gsplat input");
      const cut = new S.dyno.Dyno({
        inTypes: { gsplat: S.dyno.Gsplat, base: "vec3", radii: "vec3", exponent: "float" },
        outTypes: { gsplat: S.dyno.Gsplat },
        inputs: { gsplat, base, radii, exponent },
        globals: () => [S.dyno.defineGsplat, PLACE_CLIP_GLSL],
        statements: ({ inputs, outputs }) => S.dyno.unindentLines(`
          ${outputs.gsplat} = ${inputs.gsplat};
          {
            float fade = place_clip_fade(${inputs.gsplat}.center, ${inputs.gsplat}.scales, ${inputs.base}, ${inputs.radii}, ${inputs.exponent});
            ${outputs.gsplat}.rgba.a *= fade;
            if (fade <= 0.0) ${outputs.gsplat}.flags = 0u;
          }
        `)
      });
      return { gsplat: cut.outputs.gsplat };
    });
    const packedSplats = new S.PackedSplats({ packedArray: cropped.packedArray, numSplats: cropped.numSplats, splatEncoding: place.encoding });
    const state = { base: base.value, radii: radii.value, exponent: shape.exponent, applied: { base: { x: base.value.x, y: base.value.y, z: base.value.z }, radii: { ...dome.radii }, exponent: dome.exponent }, pushed: 0, generated: 0 };
    clip.current = state;
    const mesh = new S.SplatMesh({
      packedSplats,
      worldModifier: modifier,
      // Spark updates the mesh just before it regenerates: the generation reads the dome pushed so far.
      onFrame: () => { state.generated = state.pushed; }
    });
    mesh.position.copy(placement.position);
    mesh.quaternion.copy(placement.rotation);
    const spark = new S.SparkRenderer({
      renderer: gl,
      maxStdDev: SPLAT_EXTENT_SIGMA,
      enableLod: false,
      onDirty: () => {
        report.dirtyFrames += 1;
        invalidate();
      }
    });
    spark.renderOrder = PLACE_RENDER_ORDER;
    report.splatsKept = cropped.numSplats;
    const band: number[] = [];
    for (let i = 0; i < cropped.numSplats; i += 1) if (Math.abs(cropped.centers[i * 3 + 1]! - placement.at.y) < FLOOR_BAND_METERS) band.push(cropped.centers[i * 3 + 1]!);
    band.sort((a, b) => a - b);
    report.floorBandY = band.length > 0 ? band[Math.floor(band.length / 2)]! : Number.NaN;
    report.scanFloor = placement.at.y;
    report.takeFloor = takeFloorY;
    const domeNow = (): DomeShape => state.applied;
    bind({
      feetY: readFeetY,
      sorted: () => spark.orderingTexture !== null && !spark.sorting && !spark.sortDirty,
      clipStale: () => state.generated !== state.pushed,
      outside: () => {
        const now = domeNow();
        let shown = 0;
        let outside = 0;
        const point = { x: 0, y: 0, z: 0 };
        for (let i = 0; i < cropped.numSplats; i += 1) {
          point.x = cropped.centers[i * 3]!;
          point.y = cropped.centers[i * 3 + 1]!;
          point.z = cropped.centers[i * 3 + 2]!;
          if (placeClipFade(now, point, cropped.scale[i]!) <= 0.001) continue;
          shown += 1;
          if (extentLeavesDome(now, point, cropped.scale[i]!)) outside += 1;
        }
        return { outside, shown };
      }
    });
    setBuilt({ spark, mesh });
    return () => {
      setBuilt(null);
      mesh.dispose();
      spark.dispose();
      bind(null);
      clip.current = null;
    };
    // The place is placed once, against the dome as it was fitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place, gl]);

  useFrame(() => {
    const state = clip.current;
    const current = built;
    if (!state || !current) return;
    const x = shape.base.x + shift.x;
    const y = shape.base.y + shift.y;
    const z = shape.base.z + shift.z;
    if (Math.hypot(x - state.base.x, y - state.base.y, z - state.base.z) < CLIP_EPSILON_METERS) return;
    state.base.set(x, y, z);
    state.applied = { base: { x, y, z }, radii: state.applied.radii, exponent: state.applied.exponent };
    state.pushed += 1;
    current.mesh.updateVersion();
    invalidate();
  });

  return built ? (
    <>
      <primitive object={built.spark as unknown as Object3D} />
      <primitive object={built.mesh as unknown as Object3D} />
    </>
  ) : null;
}
