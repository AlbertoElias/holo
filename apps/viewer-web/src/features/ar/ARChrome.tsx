// The AR route's controls in the room (styleguide 9.2; brief Q11, Q13):
// Play and the timecode at the hologram's foot on the chip, the scale label
// and its way back to true size beside them once the viewer rescales, and on
// a headset Exit on the non-dominant wrist, so it is there before placement
// and with the hologram out of view. The golden edge is a burnt ring round the
// bubble's silhouette, facing the viewer. Nothing follows the head.
import { useFrame, useThree } from "@react-three/fiber";
import { useXR } from "@react-three/xr";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Matrix4, Object3D, Raycaster } from "three";

import { tokens } from "@holoim/design-tokens";
import { BubbleEdge, HologramFootControls, WristControls, type BubbleShape, type GlyphSpec } from "@holoim/xr-ui-r3f";
import {
  DEFAULT_HANDEDNESS,
  formatRunningTime,
  isHeadset,
  nonDominantHand,
  pausedText,
  scaleState,
  type Hand,
  type ViewTarget
} from "@holoim/xr-ui-core";

import { VIEWER_CONTROL_NAMES } from "../chrome/controlNames";
import { useArSoot } from "./useArSoot";

/** The scale label sits this far below the Play row, in metres before the headset factor. */
const SCALE_ROW_DROP_METERS = 0.07;

/** The row stands just in front of the hologram's foot, towards where the viewer stood at placement. */
function footPosition(frontMeters: number, dropMeters = 0): readonly [number, number, number] {
  return [0, 0.02 - dropMeters, frontMeters];
}

/** The non-dominant wrist (or grip) pose, read straight from the frame, as an object the wrist row follows. */
function useWrist(hand: Hand, enabled: boolean): Object3D | null {
  const scene = useThree((state) => state.scene);
  const referenceSpace = useXR((state) => state.originReferenceSpace);
  const wrist = useMemo(() => {
    const object = new Object3D();
    object.name = `ar-wrist-${hand}`;
    object.matrixAutoUpdate = false;
    return object;
  }, [hand]);
  const [tracked, setTracked] = useState(false);
  const trackedRef = useRef(false);

  useEffect(() => {
    scene.add(wrist);
    return () => {
      scene.remove(wrist);
    };
  }, [scene, wrist]);

  useFrame((_state, _delta, frame?: XRFrame) => {
    let pose: XRPose | null | undefined = null;
    if (enabled && frame && referenceSpace) {
      for (const source of frame.session.inputSources) {
        if (source.handedness !== hand) continue;
        try {
          const joint = source.hand?.get("wrist");
          pose = joint && frame.getJointPose ? frame.getJointPose(joint, referenceSpace) : source.gripSpace ? frame.getPose(source.gripSpace, referenceSpace) : null;
        } catch {
          pose = null;
        }
        if (pose) break;
      }
    }
    if (pose) {
      wrist.matrix.fromArray(pose.transform.matrix);
      wrist.updateMatrixWorld(true);
    }
    const now = Boolean(pose);
    if (now !== trackedRef.current) {
      trackedRef.current = now;
      setTracked(now);
    }
  });

  return tracked ? wrist : null;
}

const rayMatrix = new Matrix4();

/**
 * Selects a chrome glyph from an XR select (a controller trigger, a pinch, or
 * a tap on a phone's screen): a ray from the input's target-ray pose, tested
 * against the glyphs' own hit meshes, which carry their accessible name.
 */
function useXrSelect(actions: ReadonlyMap<string, () => void>): void {
  const session = useXR((state) => state.session);
  const referenceSpace = useXR((state) => state.originReferenceSpace);
  const scene = useThree((state) => state.scene);
  const latest = useRef(actions);
  latest.current = actions;

  useEffect(() => {
    if (!session || !referenceSpace) return undefined;
    const raycaster = new Raycaster();
    const onSelect = (event: XRInputSourceEvent) => {
      let pose: XRPose | undefined;
      try {
        pose = event.frame.getPose(event.inputSource.targetRaySpace, referenceSpace);
      } catch {
        return;
      }
      if (!pose) return;
      rayMatrix.fromArray(pose.transform.matrix);
      raycaster.ray.origin.setFromMatrixPosition(rayMatrix);
      raycaster.ray.direction.set(0, 0, -1).transformDirection(rayMatrix);
      const hits: Object3D[] = [];
      scene.traverse((object) => {
        if (typeof object.userData.label === "string" && latest.current.has(object.userData.label)) hits.push(object);
      });
      const [nearest] = raycaster.intersectObjects(hits, false);
      const label = nearest?.object.userData.label;
      if (typeof label === "string") latest.current.get(label)?.();
    };
    session.addEventListener("select", onSelect);
    return () => session.removeEventListener("select", onSelect);
  }, [session, referenceSpace, scene]);
}

function useTimecode(paused: boolean, secondsRef: MutableRefObject<number>): string {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setSeconds(secondsRef.current), 250);
    return () => window.clearInterval(timer);
  }, [secondsRef]);
  const ms = seconds * 1000;
  return paused ? pausedText(ms) : formatRunningTime(ms);
}

export interface ArFootRowsProps {
  target: ViewTarget;
  paused: boolean;
  onTogglePause: () => void;
  playbackSecondsRef: MutableRefObject<number>;
  scaleFactor: number;
  onTrueSize: () => void;
  /** How far in front of the hologram's centre its foot row stands, metres. */
  frontMeters: number;
}

/** Mount inside the hologram's foot group (`ARHologramModel`'s children). */
// Pause and true size have no drawings yet (brief, "still to draw"): a null
// glyph is an empty ring, named by its label, until they are drawn.
export function ArFootRows({ target, paused, onTogglePause, playbackSecondsRef, scaleFactor, onTrueSize, frontMeters }: ArFootRowsProps) {
  const headset = isHeadset(target);
  const input = headset ? "ray" : "touch";
  const timecode = useTimecode(paused, playbackSecondsRef);
  const scale = scaleState(scaleFactor);
  const playLabel = paused ? VIEWER_CONTROL_NAMES.play : VIEWER_CONTROL_NAMES.pause;
  const playGlyphs: GlyphSpec[] = [{ id: paused ? "play" : null, label: playLabel, onSelect: onTogglePause }];
  const scaleGlyphs: GlyphSpec[] = [{ id: null, label: VIEWER_CONTROL_NAMES.trueSize, onSelect: onTrueSize }];

  useXrSelect(
    useMemo(
      () => new Map<string, () => void>([[playLabel, onTogglePause], [VIEWER_CONTROL_NAMES.trueSize, onTrueSize]]),
      [playLabel, onTogglePause, onTrueSize]
    )
  );

  return (
    <>
      <HologramFootControls target={target} glyphs={playGlyphs} input={input} text={timecode} position={footPosition(frontMeters)} />
      {scale.canReturn && scale.label ? (
        <HologramFootControls
          target={target}
          glyphs={scaleGlyphs}
          input={input}
          text={scale.label}
          position={footPosition(frontMeters, SCALE_ROW_DROP_METERS * (headset ? tokens.size.headsetScale : 1))}
        />
      ) : null}
    </>
  );
}

/** Exit on the non-dominant wrist, in a headset only: a phone's Exit is in the dock. */
export function ArWristExit({ target, onExit }: { target: ViewTarget; onExit: () => void }) {
  const headset = isHeadset(target);
  const hand = nonDominantHand(DEFAULT_HANDEDNESS);
  const wrist = useWrist(hand, headset);
  useXrSelect(useMemo(() => new Map([[VIEWER_CONTROL_NAMES.exitAr, onExit]]), [onExit]));
  if (!headset) return null;
  return <WristControls handedness={DEFAULT_HANDEDNESS} glyphs={[{ id: null, label: VIEWER_CONTROL_NAMES.exitAr, onSelect: onExit }]} input="ray" wrist={wrist} />;
}

/** The edge round the bubble (styleguide 9.2), its soot from the lighting estimate (3.2). */
export function ArBubbleEdge({ seed, bubble, target, reducedMotion }: { seed: string; bubble: BubbleShape; target: ViewTarget; reducedMotion: boolean }) {
  const session = useXR((state) => state.session) ?? null;
  const soot = useArSoot(session);
  return <BubbleEdge seed={seed} bubble={bubble} target={target} recording={false} inFocus={true} reducedMotion={reducedMotion} soot={soot} />;
}
