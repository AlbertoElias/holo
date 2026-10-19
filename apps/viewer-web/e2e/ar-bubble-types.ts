import type * as Three from "three";
import type { AnimationAction, Object3D, Scene, WebGLRenderer } from "three";
export type Probe = {
  camera?: Three.Camera;
  mixer: Three.AnimationMixer;
  renderer: WebGLRenderer;
  scene: Scene;
  model: Object3D;
  bubble: { active: boolean; radius: number; center: { x: number; y: number; z: number } };
  actions: Record<string, AnimationAction>;
};
