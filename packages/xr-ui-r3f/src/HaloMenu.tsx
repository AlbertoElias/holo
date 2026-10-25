// The Halo in 3D (styleguide 6.2; brief Q20, Q21): eight directions that never
// change. A held press draws the ring after 300 ms; a flick commits without
// drawing. The app feeds it the press, the movement and the release; it draws
// and reports the commit.
import type { HitInput } from "@holoim/design-tokens";
import type { HaloAction, HaloCommit, HaloEvent, HaloStep } from "@holoim/xr-ui-core";
import { ThreeHalo } from "@holoim/xr-ui-three";
import { useThree } from "@react-three/fiber";
import { forwardRef, useEffect, useImperativeHandle, useMemo } from "react";

import { useLatest, useStable } from "./internal.js";

export interface HaloMenuHandle {
  /** One event of the hold. Draws the ring after the hold delay, highlights the slot pointed at, and calls `onCommit` on a release that has an action. */
  handle(event: HaloEvent): HaloStep;
  /** Converts a movement in metres (y up, in the Halo's plane) to the apx a `HaloEvent` takes. */
  apxFromMetres(metres: number): number;
}

export interface HaloMenuProps {
  /** The actions this app has (`CAPTURE_HALO_ACTIONS`); other directions stay reserved and empty (Q20). */
  actions: readonly HaloAction[];
  /** The viewing distance sizes are made for, metres. */
  distanceM: number;
  /** The input pointing at the slots: sets their hit areas (6.1). Default `ray`. */
  input?: HitInput;
  /** Called with a release's commit, only when it has an action. */
  onCommit: (commit: HaloCommit & { action: HaloAction }) => void;
  position?: readonly [number, number, number];
}

export const HaloMenu = forwardRef<HaloMenuHandle, HaloMenuProps>(function HaloMenu({ actions: actionsProp, distanceM, input = "ray", onCommit, position }, ref) {
  const actions = useStable(actionsProp);
  const halo = useMemo(() => new ThreeHalo({ actions, distanceM, input }), [actions, distanceM, input]);
  useEffect(() => () => halo.dispose(), [halo]);
  const invalidate = useThree((state) => state.invalidate);
  const commit = useLatest(onCommit);

  useImperativeHandle(
    ref,
    () => ({
      handle(event) {
        const step = halo.handle(event);
        invalidate();
        const { commit: result } = step;
        if (result && result.action !== null) commit.current({ ...result, action: result.action });
        return step;
      },
      apxFromMetres: (metres) => halo.apxFromMetres(metres)
    }),
    [halo, invalidate, commit]
  );

  return <primitive key={halo.group.uuid} object={halo.group} {...(position ? { position } : {})} />;
});
