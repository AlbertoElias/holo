// Grades a reference human motion-capture clip (BVH) with the motion-quality
// instrument: the human anchor for the feet and pop targets in
// docs/features/natural-avatar-motion.md. The clips are not committed; fetch
// CMU walks 02_01 and 07_01 into ignored output/mocap/ from
// https://raw.githubusercontent.com/una-dinosauria/cmu-mocap/master/data/<subject>/<clip>.bvh
// Usage: node --import tsx scripts/mocap-reference-report.ts output/mocap/07_01.bvh
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';
import { measureMotion, judgeMotion, type MotionFrame, type JointName, type Vec3 } from './lib/motion-quality';
const file = process.argv[2];
if (!file) throw new Error('usage: mocap-reference-report.ts <clip.bvh>');
const { skeleton, clip } = new BVHLoader().parse(readFileSync(file, 'utf8'));
const root = skeleton.bones[0]!;
const group = new THREE.Group(); group.add(root);
const mixer = new THREE.AnimationMixer(group);
mixer.clipAction(clip).play();
const map: Record<string, JointName> = { Hips: 'hips', Head: 'head', Neck: 'neck', Spine1: 'chest', LeftArm: 'leftShoulder', RightArm: 'rightShoulder', LeftForeArm: 'leftElbow', RightForeArm: 'rightElbow', LeftHand: 'leftWrist', RightHand: 'rightWrist', LeftUpLeg: 'leftHip', RightUpLeg: 'rightHip', LeftLeg: 'leftKnee', RightLeg: 'rightKnee', LeftFoot: 'leftAnkle', RightFoot: 'rightAnkle', LeftToeBase: 'leftToe', RightToeBase: 'rightToe' };
const dt = 1 / 30; const raw: Array<Partial<Record<JointName, THREE.Vector3>>> = [];
for (let t = 0; t < clip.duration; t += dt) {
  mixer.setTime(t); group.updateMatrixWorld(true);
  const j: Partial<Record<JointName, THREE.Vector3>> = {};
  for (const b of skeleton.bones) { const name = map[b.name]; if (name) j[name] = b.getWorldPosition(new THREE.Vector3()); }
  raw.push(j);
}
const top = Math.max(...raw.map((j) => j.head!.y)); const low = Math.min(...raw.map((j) => Math.min(j.leftToe!.y, j.rightToe!.y, j.leftAnkle!.y, j.rightAnkle!.y)));
const scale = 1.65 / (top - low); // head joint ~1.65 m for a 1.75 m person
const frames: MotionFrame[] = raw.map((j, i) => ({ timeSec: i * dt, joints: Object.fromEntries(Object.entries(j).map(([k, v]) => [k, [v.x * scale, (v.y - low) * scale, v.z * scale] as Vec3])), ground: { left: 0, right: 0 } }));
const m = measureMotion(frames, { soleOffset: 'take' });
console.log(file.split('/').pop(), `${clip.duration.toFixed(1)}s scale ${scale.toFixed(4)}`, JSON.stringify(m));
for (const v of judgeMotion(m, 'desktop')) if (!v.pass && v.value !== null) console.log('  MISS', v.metric, v.value);
