import { useThree } from "@react-three/fiber";
import type { ClocheShape } from "@holoim/xr-ui-core";
import { useEffect, useMemo, useState } from "react";
import type { AnimationClip, Object3D, Vector3 } from "three";

import { PlaceLayer } from "./PlaceLayer";
import { loadPlace, type LoadedPlace } from "./loadPlace";
import type { PlaceGate } from "./placeGate";
import { createPlaceReport } from "./placeReport";
import type { PlaceRequest } from "./placeRequest";
import { recordedFloorY } from "./takeFloor";

/**
 * Loads the scan for a card and, once the card's cloche is fitted and the card
 * has chosen to show it, draws it. This module and everything under it is the
 * card's only door to Spark, reached by a dynamic import behind `testHooks`.
 */
export default function PlaceMount({ request, gate, shape, shift, scene, clips, sweep, readFeetY }: {
  request: PlaceRequest;
  gate: PlaceGate;
  /** The fitted dome, null until the card has fitted it. */
  shape: ClocheShape | null;
  shift: Vector3;
  /** The take, for the floor its author stands on, and its clips. */
  scene: Object3D;
  clips: readonly AnimationClip[];
  sweep: { min: Vector3; max: Vector3 };
  readFeetY: () => number;
}) {
  const invalidate = useThree((state) => state.invalidate);
  const { report, bind } = useMemo(createPlaceReport, []);
  const [place, setPlace] = useState<LoadedPlace | null>(null);
  const { url, flip, nudge } = request;
  const { x, y, z, yawDeg } = nudge;

  useEffect(() => {
    let live = true;
    report.status = "loading";
    report.url = url;
    window.__HOLOIM_PLACE__ = report;
    loadPlace({ url, flip, nudge: { x, y, z, yawDeg } }).then((loaded) => {
      if (!live) return;
      report.splatsLoaded = loaded.numSplats;
      report.floorFound = loaded.floor.found;
      report.floorFoundY = loaded.floor.floorY;
      report.loadMs = loaded.loadMs;
      if (gate.status === "loading") {
        gate.status = "ready";
        report.status = "ready";
      } else {
        report.status = "timeout";
      }
      setPlace({ ...loaded, request: { url, flip, nudge: { x, y, z, yawDeg } } });
      invalidate();
    }, () => {
      if (!live) return;
      if (gate.status === "loading") gate.status = "failed";
      report.status = "failed";
      invalidate();
    });
    return () => {
      live = false;
      if (window.__HOLOIM_PLACE__ === report) delete window.__HOLOIM_PLACE__;
    };
  }, [bind, flip, gate, invalidate, report, url, x, y, z, yawDeg]);

  // Read once, at the dome's fit: the recorded set is still the set it was.
  const takeFloorY = useMemo(() => (shape ? recordedFloorY(scene, clips) ?? shape.base.y : null), [clips, scene, shape]);
  if (!place || !shape || takeFloorY === null || gate.status !== "ready") return null;
  return <PlaceLayer place={place} shape={shape} shift={shift} takeFloorY={takeFloorY} sweep={sweep} readFeetY={readFeetY} report={report} bind={bind} />;
}
