import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { AvatarRig } from '../avatar/AvatarRig';
import { CharacterMotor } from './CharacterMotor';

function floorRig(flipped: boolean): AvatarRig {
  const geometry = new THREE.PlaneGeometry(40, 40, 1, 1);
  geometry.rotateX(-Math.PI / 2); // normals point +Y
  if (flipped && geometry.index) {
    // Optimizers (e.g. the production GLB optimizer) may emit triangles
    // whose winding opposes the vertex normals. Rapier reads winding, so
    // such a floor behaves like a ceiling without reorientation.
    const index = geometry.index.array;
    for (let i = 0; i + 2 < index.length; i += 3) {
      const a = index[i + 1] ?? 0;
      const b = index[i + 2] ?? 0;
      index[i + 1] = b;
      index[i + 2] = a;
    }
    geometry.index.needsUpdate = true;
  }
  const worldModel = new THREE.Group();
  worldModel.add(new THREE.Mesh(geometry));

  return {
    worldModel,
    avatarHeight: 1.8,
    avatarMinLocalY: 0,
    sampleTerrainYAt: () => 0.01
  } as unknown as AvatarRig;
}

describe('CharacterMotor ground collision', () => {
  it.each([false, true])('keeps the capsule on the floor (flipped winding: %s)', async (flipped) => {
    const motor = new CharacterMotor();
    const spawned = await motor.init(floorRig(flipped));
    expect(spawned).toBe(true);

    const position = new THREE.Vector3();
    motor.getCharacterBodyPosition(position);
    const startY = position.y;

    const idle = { forward: false, back: false, left: false, right: false };
    for (let i = 0; i < 180; i += 1) {
      motor.update(1 / 60, 0, idle, false);
    }

    motor.getCharacterBodyPosition(position);
    expect(motor.getSnapshot().grounded).toBe(true);
    expect(Math.abs(position.y - startY)).toBeLessThan(0.05);
  });
});
