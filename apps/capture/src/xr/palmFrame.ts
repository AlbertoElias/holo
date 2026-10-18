import * as THREE from 'three';

const tmpAlong = new THREE.Vector3();
const tmpAcross = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();
const tmpSide = new THREE.Vector3();
const tmpBasis = new THREE.Matrix4();

// Orientation of a palm from four joint positions, built identically for the
// user's tracked hand and the avatar's hand so the two can be aligned without
// rig-specific offsets: Y runs wrist → middle knuckle, X runs pinky knuckle →
// index knuckle (made orthogonal), Z = X × Y.
export function palmFrameQuaternion(
  wrist: THREE.Vector3,
  indexKnuckle: THREE.Vector3,
  middleKnuckle: THREE.Vector3,
  pinkyKnuckle: THREE.Vector3,
  out: THREE.Quaternion
): THREE.Quaternion | undefined {
  tmpAlong.subVectors(middleKnuckle, wrist);
  tmpAcross.subVectors(indexKnuckle, pinkyKnuckle);
  if (tmpAlong.lengthSq() < 1e-10 || tmpAcross.lengthSq() < 1e-10) return undefined;
  tmpAlong.normalize();
  tmpNormal.crossVectors(tmpAcross, tmpAlong);
  if (tmpNormal.lengthSq() < 1e-10) return undefined;
  tmpNormal.normalize();
  tmpSide.crossVectors(tmpAlong, tmpNormal);
  tmpBasis.makeBasis(tmpSide, tmpAlong, tmpNormal);
  return out.setFromRotationMatrix(tmpBasis).normalize();
}
