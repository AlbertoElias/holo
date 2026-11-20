import { tokens } from '@holoim/design-tokens';
import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';

// The headset mirror (docs/features/your-look.md, slice 2): in VR the author
// is inside the avatar and its head is hidden in first person, so the look
// step stands a mirror beside the look panel. It stands on the floor, 1.5 m
// from the head, with the chip's radius at its corners and a plain deep-sea
// back: no rim, no gold (styleguide 2.3, 10). It renders only while it shows,
// and its pass draws only the avatar and the lights (a layer of its own):
// no world, no chrome. The head shows for that pass alone.

export const MIRROR_WIDTH_M = 0.7;
export const MIRROR_HEIGHT_M = 1.9;
/** The mirror's own layer: the avatar's meshes and the lights join it while it shows. */
const MIRROR_LAYER = 7;
const DISTANCE_M = tokens.placement.worldPanelDefaultM;
// Linear 0.5 is the identity of the reflector's overlay blend; three's default
// grey (sRGB 0x7f7f7f, linear 0.21) darkens every colour it shows.
const OVERLAY = new THREE.Color().setRGB(0.5, 0.5, 0.5, THREE.LinearSRGBColorSpace);
const GROUND = new THREE.Color(tokens.color.deepSea);

export interface VrMirrorProbe {
  visible: boolean;
  worldPosition: number[];
  /** The mirror's passes since it was built, and those in which the head was shown. */
  renders: number;
  headShownRenders: number;
  /** Width and height in metres, for the overlap check. */
  sizeM: [number, number];
}

export interface VrMirrorOptions {
  getAvatarRoot(): THREE.Object3D | null;
  /** Runs a draw with the first-person head shown; returns how many meshes it showed. */
  withHeadShown(draw: () => void): number;
}

const headPosition = new THREE.Vector3();
const headQuaternion = new THREE.Quaternion();
const headScale = new THREE.Vector3();
const level = new THREE.Euler();
const scratch = new THREE.Vector3();

export class VrMirror {
  readonly group = new THREE.Group();
  private readonly reflector: Reflector;
  private readonly back: THREE.Mesh;
  private renders = 0;
  private headShownRenders = 0;

  constructor(private readonly options: VrMirrorOptions) {
    this.group.name = 'look-mirror';
    const shape = roundedRect(MIRROR_WIDTH_M, MIRROR_HEIGHT_M, 0.04);
    this.reflector = new Reflector(new THREE.ShapeGeometry(shape, 6), { color: OVERLAY, textureWidth: 512, textureHeight: 1024, multisample: 0 });
    this.reflector.name = 'look-mirror-glass';
    this.reflector.camera.layers.set(MIRROR_LAYER);
    // Pointing passes through the mirror (it is not a control).
    this.reflector.raycast = () => undefined;
    const draw = this.reflector.onBeforeRender.bind(this.reflector);
    this.reflector.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
      // In passthrough there is no world behind the avatar: its ground is deep sea, not the camera's clear.
      const background = scene.background;
      if (!background) scene.background = GROUND;
      const shown = this.options.withHeadShown(() => draw(renderer, scene, camera, geometry, material, group));
      scene.background = background;
      this.renders += 1;
      if (shown > 0) this.headShownRenders += 1;
    };
    this.back = new THREE.Mesh(new THREE.ShapeGeometry(shape, 6), new THREE.MeshBasicMaterial({ color: tokens.color.deepSea, side: THREE.BackSide, toneMapped: false }));
    this.back.name = 'look-mirror-back';
    this.back.position.z = -0.004;
    this.back.raycast = () => undefined;
    this.group.add(this.reflector, this.back);
    this.group.visible = false;
  }

  /**
   * Stands on the floor under the avatar, 1.5 m from the head at `yawOffset`
   * radians left of straight ahead, turned to face the head.
   */
  place(headObject: THREE.Object3D, yawOffset: number): void {
    headObject.updateWorldMatrix(true, false);
    headObject.matrixWorld.decompose(headPosition, headQuaternion, headScale);
    level.setFromQuaternion(headQuaternion, 'YXZ');
    const yaw = level.y + yawOffset;
    const at = scratch.copy(headPosition).add(new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)).multiplyScalar(DISTANCE_M));
    const floorY = this.options.getAvatarRoot()?.getWorldPosition(new THREE.Vector3()).y ?? 0;
    at.y = floorY + MIRROR_HEIGHT_M / 2;
    const parent = this.group.parent;
    parent?.updateWorldMatrix(true, false);
    this.group.position.copy(parent ? parent.worldToLocal(at.clone()) : at);
    // Upright: it turns about the vertical only, so it stands on the floor.
    this.group.lookAt(headPosition.x, at.y, headPosition.z);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  /** While it shows: the avatar's meshes (new after each look change) and the lights join the mirror's layer. */
  update(scene: THREE.Scene): void {
    if (!this.group.visible) return;
    this.options.getAvatarRoot()?.traverse((object) => object.layers.enable(MIRROR_LAYER));
    scene.traverse((object) => {
      if ((object as THREE.Light).isLight) object.layers.enable(MIRROR_LAYER);
    });
  }

  isShown(): boolean {
    for (let node: THREE.Object3D | null = this.group; node; node = node.parent) if (!node.visible) return false;
    return true;
  }

  probe(): VrMirrorProbe {
    return {
      visible: this.isShown(),
      worldPosition: this.group.getWorldPosition(new THREE.Vector3()).toArray(),
      renders: this.renders,
      headShownRenders: this.headShownRenders,
      sizeM: [MIRROR_WIDTH_M, MIRROR_HEIGHT_M]
    };
  }

  dispose(): void {
    this.group.removeFromParent();
    this.reflector.dispose();
    this.back.geometry.dispose();
    (this.back.material as THREE.Material).dispose();
  }
}

function roundedRect(width: number, height: number, radius: number): THREE.Shape {
  const x = -width / 2;
  const y = -height / 2;
  const shape = new THREE.Shape();
  shape.moveTo(x + radius, y);
  shape.lineTo(x + width - radius, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + radius);
  shape.lineTo(x + width, y + height - radius);
  shape.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  shape.lineTo(x + radius, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - radius);
  shape.lineTo(x, y + radius);
  shape.quadraticCurveTo(x, y, x + radius, y);
  return shape;
}
