import { useThree } from "@react-three/fiber";
import type { ClocheShape } from "@holoim/xr-ui-core";
import { useEffect, useMemo, useState } from "react";
import type { AnimationClip, Object3D, Vector3 } from "three";

import { PlaceLayer } from "./PlaceLayer";
import { loadPlace, type PlacedScan } from "./loadPlace";
import { warnPlaceOnce, type PlaceGate } from "./placeGate";
import { createPlaceReport } from "./placeReport";
import type { PlaceRequest, PlaceScan } from "./placeRequest";
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
  const [place, setPlace] = useState<PlacedScan | null>(null);
  const { url, flip, nudge } = request;
  const { x, y, z, yawDeg } = nudge;
  const { floorGiven } = request;

  useEffect(() => {
    let live = true;
    report.status = "loading";
    report.url = url;
    window.__HOLOIM_PLACE__ = report;
    const request: PlaceScan = { url, flip, nudge: { x, y, z, yawDeg }, floorGiven };
    const fail = (error: unknown) => {
      // One warning for the mount, whatever failed first (a timeout may have warned already).
      warnPlaceOnce(gate, `Place ${url} did not load; the card shows its recorded set.`, error);
      if (gate.status === "loading") gate.status = "failed";
      report.status = "failed";
      invalidate();
    };
    loadPlace({ url, flip }).then((loaded) => {
      if (!live) return;
      report.splatsLoaded = loaded.numSplats;
      report.floorFound = loaded.floor.found;
      report.floorFoundY = loaded.floor.floorY;
      report.loadMs = loaded.loadMs;
      let floor = loaded.floor;
      if (!floor.found) {
        // A scan without a clear floor is never placed by a guess: it fails, unless the URL names the floor's height.
        if (!floorGiven) {
          fail(new Error(`no floor found in the scan; pass placeY=<the floor's height in the scan, metres, y up> to place it`));
          return;
        }
        floor = { found: false, floorY: y, x: 0, z: 0 };
      }
      // A scan that arrives after the fit timed out is not shown late: the card
      // keeps today's look for this mount, and the dome it fitted without it.
      if (gate.status === "loading") {
        gate.status = "ready";
        report.status = "ready";
      } else {
        report.status = "timeout";
      }
      setPlace({ ...loaded, floor, request: floor.found ? request : { ...request, nudge: { x, y: 0, z, yawDeg } } });
      invalidate();
    }, (error: unknown) => {
      if (!live) return;
      fail(error);
    });
    return () => {
      live = false;
      if (window.__HOLOIM_PLACE__ === report) delete window.__HOLOIM_PLACE__;
    };
  }, [bind, flip, floorGiven, gate, invalidate, report, url, x, y, z, yawDeg]);

  // Read once, at the dome's fit: the recorded set is still the set it was.
  const takeFloorY = useMemo(() => (shape ? recordedFloorY(scene, clips) ?? shape.base.y : null), [clips, scene, shape]);
  if (!place || !shape || takeFloorY === null || gate.status !== "ready") return null;
  return <PlaceLayer place={place} shape={shape} shift={shift} takeFloorY={takeFloorY} sweep={sweep} readFeetY={readFeetY} report={report} bind={bind} />;
}
