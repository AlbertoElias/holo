import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { VRM_HUMANOID_BONES } from '@holoim/meaning';

import type { AvatarRig } from '../avatar/AvatarRig';
import { HumanoidSkeleton } from '../avatar/HumanoidSkeleton';
import type { AvatarPoseSample } from '../runtime/automationHooks';
import { LOCOMOTION_STATES, LocomotionAnimator } from './LocomotionAnimator';
import { retargetClips } from './retargetClips';

export interface AttachLocomotionInput {
  readonly animator: LocomotionAnimator;
  /** The avatar root, at rest (before any system poses it). */
  readonly avatar: THREE.Object3D;
  readonly ownClips: THREE.AnimationClip[];
  readonly humanoid: HumanoidSkeleton | undefined;
  /** The library, already requested (in parallel with the avatar when it is not the shipped one), or fetched here when needed. */
  readonly library: () => Promise<GLTF>;
}

/**
 * Attaches the avatar's locomotion clips, retargeting the library's onto any
 * avatar without usable clips of its own (docs/features/locomotion-retarget.md). A failed load or retarget leaves those
 * states without a clip, reported, and the avatar loads as before.
 */
export async function attachLocomotion({ animator, avatar, ownClips, humanoid, library: loadLibrary }: AttachLocomotionInput): Promise<void> {
  let retargeted: THREE.AnimationClip[] = [];
  let restCorrectionDeg = {};
  if (humanoid && !LocomotionAnimator.usesOwnClips(ownClips, humanoid)) {
    if (!humanoid.has('hips', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot')) {
      humanoid.disableFeature('locomotion', 'needs hips and both upper legs, lower legs and feet');
    } else {
      try {
        const library = await loadLibrary();
        const source = HumanoidSkeleton.bind(library.scene, { json: library.parser.json, associations: library.parser.associations });
        source.normalizeFacing(library.scene);
        const result = retargetClips({ root: library.scene, humanoid: source }, library.animations, { root: avatar, humanoid });
        retargeted = result.clips;
        restCorrectionDeg = result.correctionDeg;
      } catch (error) {
        humanoid.disableFeature('locomotion', `clip library failed to load or retarget (${String(error)})`);
      }
    }
  }
  animator.attachClips(avatar, ownClips, humanoid, retargeted);
  const clips = animator.getClipSources();
  if (humanoid && LOCOMOTION_STATES.every((state) => clips[state] === 'none') && !humanoid.report().disabledFeatures.locomotion) {
    humanoid.disableFeature('locomotion', 'no clip for any state');
  }
  humanoid?.setLocomotion({ clips: { ...clips }, restCorrectionDeg });
}

/** Every canonical bone and finger end site, in the avatar root's frame (position and turn, not scale) (automation). */
export function sampleAvatarPose(rig: AvatarRig, animator: LocomotionAnimator): AvatarPoseSample {
  rig.avatarRoot.updateWorldMatrix(true, true);
  const root = rig.avatarRoot.getWorldPosition(new THREE.Vector3());
  const unturn = rig.avatarRoot.getWorldQuaternion(new THREE.Quaternion()).invert();
  const bones: AvatarPoseSample['bones'] = {};
  const put = (key: string, obj: THREE.Object3D | undefined) => {
    if (!obj) return;
    const p = obj.getWorldPosition(new THREE.Vector3()).sub(root).applyQuaternion(unturn);
    bones[key] = [p.x, p.y, p.z];
  };
  for (const bone of VRM_HUMANOID_BONES) {
    put(bone, rig.humanoid?.bone(bone));
    if (/Distal$/.test(bone)) put(`${bone}Tip`, rig.humanoid?.tip(bone));
  }
  return { bones, locomotion: { state: animator.getState(), profile: animator.getActiveProfile(), clip: animator.getClipSnapshot()?.name ?? null } };
}
