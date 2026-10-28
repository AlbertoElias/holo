import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// The tray's slot rings (docs/features/tray-everywhere.md): a solid ring for a
// filled slot, a dashed one for an empty slot. Flat in the XY plane, centred
// on the origin, in whatever unit `outer` is given (metres in a headset, apx
// in a UIKit slot). Shared by the headset signifiers and the phone AR row.

const RING_SEGMENTS = 64;
const DASHES = 12;
/** The share of each dash's step that is drawn. */
const DASH_FILL = 0.55;

/** A ring of outer radius `outer` and a stroke `stroke` wide. */
export function ringGeometry(outer: number, stroke: number): THREE.BufferGeometry {
  return new THREE.RingGeometry(Math.max(outer - stroke, 0), outer, RING_SEGMENTS);
}

/** The same ring broken into dashes: the empty slot's. */
export function dashedRingGeometry(outer: number, stroke: number): THREE.BufferGeometry {
  const step = (Math.PI * 2) / DASHES;
  const dashes: THREE.BufferGeometry[] = [];
  for (let i = 0; i < DASHES; i += 1) dashes.push(new THREE.RingGeometry(Math.max(outer - stroke, 0), outer, 6, 1, i * step, step * DASH_FILL));
  return mergeGeometries(dashes)!;
}

/** A flat, unlit, see-through ring material: tray rings are chrome, never lit by the scene. */
export function ringMaterial(color: string): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, toneMapped: false, depthWrite: false, side: THREE.DoubleSide });
}
