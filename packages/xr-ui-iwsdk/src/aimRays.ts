import type { World } from "@iwsdk/core";
import { BufferAttribute, BufferGeometry, Group, Line, LineBasicMaterial, Quaternion, Vector3, type Object3D } from "three";

import { multiPointer, type XrHand } from "./pointers.js";
import { COLOR } from "./tokens.js";

// The aim ray (the user, 2026-10-25: capture's gold line in both apps): a
// gold line from each hand's target ray, cut short where IWSDK's ray pointer
// rests on something and brightened to the cream highlight there (§6
// states). IWSDK's own ray and cursor are hidden (`configureXrPointers`).

/** An idle ray reaches this far. */
const IDLE_LENGTH_M = 1.4;
/** Over a target, the line never shrinks below this. */
const MIN_LENGTH_M = 0.05;
/** Above the scene and the chrome, so a ray is never hidden behind what it points at. */
const RAY_RENDER_ORDER = 998;

export interface AimRayProbe {
  hand: XrHand;
  visible: boolean;
  /** What IWSDK's ray pointer rests on, or null. */
  hit: Object3D | null;
  origin: [number, number, number];
}

/** Decides whether a hand's line shows, given what its ray rests on. */
export type AimRayPolicy = (hand: XrHand, hit: Object3D | null) => boolean;

interface Ray {
  hand: XrHand;
  line: Line<BufferGeometry, LineBasicMaterial>;
  hit: Object3D | null;
}

const origin = new Vector3();
const direction = new Vector3();
const rotation = new Quaternion();

export class AimRays {
  readonly group = new Group();
  private readonly rays: Ray[];

  constructor(private readonly world: World) {
    this.group.name = "AimRays";
    this.rays = (["left", "right"] as const).map((hand) => {
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(new Float32Array(6), 3));
      const line = new Line(geometry, new LineBasicMaterial({ color: COLOR.gold, transparent: true, depthTest: false, toneMapped: false }));
      line.name = `aim-ray-${hand}`;
      line.renderOrder = RAY_RENDER_ORDER;
      line.frustumCulled = false;
      line.visible = false;
      line.raycast = () => undefined;
      this.group.add(line);
      return { hand, line, hit: null };
    });
  }

  /**
   * Draws each hand's line after IWSDK's pointers updated. A hand shows a
   * line while its ray pointer is enabled (connected) and `policy` allows it.
   */
  update(policy: AimRayPolicy = () => true): void {
    for (const ray of this.rays) {
      const pointer = multiPointer(this.world, ray.hand).ray.pointer;
      const space = this.world.player.raySpaces[ray.hand];
      const intersection = pointer.getEnabled() ? pointer.getIntersection() : undefined;
      ray.hit = intersection && !intersection.object.isVoidObject ? intersection.object : null;
      ray.line.visible = pointer.getEnabled() && policy(ray.hand, ray.hit);
      if (!ray.line.visible) continue;
      space.updateWorldMatrix(true, false);
      space.getWorldPosition(origin);
      direction.set(0, 0, -1).applyQuaternion(space.getWorldQuaternion(rotation)).normalize();
      const length = ray.hit ? Math.max(MIN_LENGTH_M, intersection!.distance) : IDLE_LENGTH_M;
      const parent = this.group.parent;
      const start = origin.clone();
      const end = origin.clone().addScaledVector(direction, length);
      if (parent) {
        parent.updateWorldMatrix(true, false);
        parent.worldToLocal(start);
        parent.worldToLocal(end);
      }
      const positions = ray.line.geometry.getAttribute("position") as BufferAttribute;
      positions.setXYZ(0, start.x, start.y, start.z);
      positions.setXYZ(1, end.x, end.y, end.z);
      positions.needsUpdate = true;
      ray.line.material.color.set(ray.hit ? COLOR.highlight : COLOR.gold);
    }
  }

  probe(): AimRayProbe[] {
    return this.rays.map((ray) => {
      const positions = ray.line.geometry.getAttribute("position") as BufferAttribute;
      const start = new Vector3(positions.getX(0), positions.getY(0), positions.getZ(0));
      this.group.parent?.localToWorld(start);
      return { hand: ray.hand, visible: ray.line.visible, hit: ray.line.visible ? ray.hit : null, origin: start.toArray() as [number, number, number] };
    });
  }

  dispose(): void {
    for (const ray of this.rays) {
      ray.line.geometry.dispose();
      ray.line.material.dispose();
    }
    this.group.removeFromParent();
  }
}
