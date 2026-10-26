import type { SootInput } from "@holoim/xr-ui-core";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";

import { ArSoot } from "./arSoot";

/** AR soot from the lighting estimate (`ArSoot`), as React state. */
export function useArSoot(session: XRSession | null): SootInput {
  const soot = useMemo(() => new ArSoot(), []);
  const [sootOn, setSootOn] = useState<boolean | null>(null);

  useEffect(() => {
    soot.attach(session);
    setSootOn(soot.sootOn);
    return () => soot.attach(null);
  }, [session, soot]);

  useFrame((_state, _delta, frame?: XRFrame) => {
    if (soot.update(frame)) setSootOn(soot.sootOn);
  });

  return { arSootOn: sootOn };
}
