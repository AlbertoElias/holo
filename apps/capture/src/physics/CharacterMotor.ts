import * as THREE from 'three';

import { isThreeMesh } from '../shared/threeTypeGuards';
import RAPIER from '@dimforge/rapier3d-compat';
import { clamp } from '../shared/math';
import type { CharacterSnapshot } from '../types/contracts';
import type { MoveState } from '../input/InputController';
import type { AvatarRig } from '../avatar/AvatarRig';

const gravity = -9.81;
const groundedStickVelocity = -0.5;
const CROUCH_TERRAIN_GUARD_CLEARANCE = 0.02;
const CROUCH_TERRAIN_GUARD_SAMPLE_RADIUS_RATIO = 0.04;
const CROUCH_TERRAIN_GUARD_OFFSETS: readonly Readonly<[number, number]>[] = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [0.7, 0.7],
  [-0.7, 0.7],
  [0.7, -0.7],
  [-0.7, -0.7]
];

interface CharacterMotorUpdateOptions {
  moveSpeedMultiplier?: number;
  allowJump?: boolean;
  stickToTerrain?: boolean;
  // World-space horizontal displacement applied this step on top of input
  // movement (room-scale VR: the body following the tracked head). It goes
  // through the character controller, so walls and slopes still apply.
  externalDisplacement?: { x: number; z: number };
}

export class CharacterMotor {
  private rapierWorld: import('@dimforge/rapier3d-compat').World | undefined;
  private characterBody: import('@dimforge/rapier3d-compat').RigidBody | undefined;
  private characterCollider: import('@dimforge/rapier3d-compat').Collider | undefined;
  private characterController: import('@dimforge/rapier3d-compat').KinematicCharacterController | undefined;
  private avatarRigRef: AvatarRig | undefined;

  private capsuleRadius = 0.3;
  private capsuleHalfHeight = 0.6;
  private avatarVisualOffsetY = 0;
  private velocityY = 0;
  private jumpSpeed = 5;
  private moveSpeed = 3.2;
  private avatarHeight = 1.8;
  private grounded = false;
  private horizontalSpeed = 0;
  private targetHorizontalSpeed = 0;
  private spawnResolved = false;
  private invalidMovementLogged = false;

  private readonly raycaster = new THREE.Raycaster();
  private readonly tmpBox = new THREE.Box3();
  private readonly tmpForward = new THREE.Vector3();
  private readonly tmpRight = new THREE.Vector3();
  private readonly tmpMove = new THREE.Vector3();
  private readonly tmpBody = new THREE.Vector3();
  private readonly lastInputMovement = new THREE.Vector3();

  async init(avatarRig: AvatarRig): Promise<boolean> {
    await RAPIER.init();
    if (!avatarRig.worldModel) return false;

    const trimesh = this.buildWorldTrimeshData(avatarRig.worldModel);
    if (!trimesh) return false;

    this.rapierWorld = new RAPIER.World({ x: 0, y: gravity, z: 0 });
    this.rapierWorld.createCollider(RAPIER.ColliderDesc.trimesh(trimesh.vertices, trimesh.indices));

    this.avatarHeight = avatarRig.avatarHeight;
    this.capsuleRadius = avatarRig.avatarHeight * 0.18;
    this.capsuleHalfHeight = avatarRig.avatarHeight * 0.32;
    this.avatarVisualOffsetY = -(this.capsuleHalfHeight + this.capsuleRadius) - avatarRig.avatarMinLocalY;
    this.jumpSpeed = Math.sqrt(2 * Math.abs(gravity) * avatarRig.avatarHeight * 1.2);
    this.moveSpeed = avatarRig.avatarHeight * 1.8;
    this.avatarRigRef = avatarRig;

    this.characterBody = this.rapierWorld.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());

    const charDesc = RAPIER.ColliderDesc.capsule(this.capsuleHalfHeight, this.capsuleRadius);
    charDesc.setFriction(0.1);
    charDesc.setRestitution(0);
    this.characterCollider = this.rapierWorld.createCollider(charDesc, this.characterBody);

    this.rebuildCharacterController();

    this.velocityY = 0;
    this.grounded = false;
    this.horizontalSpeed = 0;
    this.targetHorizontalSpeed = this.moveSpeed;
    this.spawnResolved = false;

    return this.resolveSpawn(avatarRig);
  }

  update(deltaSec: number, lookYaw: number, moveState: MoveState, jumpQueued: boolean, options?: CharacterMotorUpdateOptions): void {
    if (!this.characterBody || !this.characterCollider || !this.characterController || !this.rapierWorld || !this.spawnResolved) {
      this.horizontalSpeed = 0;
      this.targetHorizontalSpeed = 0;
      return;
    }

    const moveSpeedMultiplier = clamp(options?.moveSpeedMultiplier ?? 1, 0, 1.5);
    const allowJump = options?.allowJump ?? true;
    const stickToTerrain = options?.stickToTerrain ?? false;
    this.targetHorizontalSpeed = this.moveSpeed * moveSpeedMultiplier;

    this.tmpForward.set(-Math.sin(lookYaw), 0, -Math.cos(lookYaw)).normalize();
    this.tmpRight.crossVectors(new THREE.Vector3(0, -1, 0), this.tmpForward).normalize();

    this.tmpMove.set(0, 0, 0);
    if (moveState.forward) this.tmpMove.add(this.tmpForward);
    if (moveState.back) this.tmpMove.sub(this.tmpForward);
    if (moveState.right) this.tmpMove.add(this.tmpRight);
    if (moveState.left) this.tmpMove.sub(this.tmpRight);

    if (this.tmpMove.lengthSq() > 0) {
      this.tmpMove.normalize().multiplyScalar(this.targetHorizontalSpeed * deltaSec);
    }
    const wasGrounded = this.grounded;
    if (allowJump && jumpQueued && this.grounded) {
      this.velocityY = this.jumpSpeed;
      this.grounded = false;
    }

    this.velocityY += gravity * deltaSec;
    if (this.grounded && this.velocityY < groundedStickVelocity) {
      this.velocityY = groundedStickVelocity;
    }

    // Sensors (the hand spheres) must never block the body: they move with
    // the avatar's hands and sat in the capsule's path when walking in VR.
    this.characterController.computeColliderMovement(this.characterCollider, {
      x: this.tmpMove.x,
      y: this.velocityY * deltaSec,
      z: this.tmpMove.z
    }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
    const corrected = this.characterController.computedMovement();
    if (!Number.isFinite(corrected.x) || !Number.isFinite(corrected.y) || !Number.isFinite(corrected.z)) {
      this.horizontalSpeed = 0;
      this.lastInputMovement.set(0, 0, 0);
      if (!this.invalidMovementLogged) {
        console.warn('Skipping invalid character movement correction.', corrected);
        this.invalidMovementLogged = true;
      }
      return;
    }
    // A grounded character with no movement stands still: the controller
    // would otherwise slide the gravity step down a walkable slope a few
    // millimetres a second (the hand sensors used to hide this by blocking
    // the capsule).
    const hasInput = this.tmpMove.x !== 0 || this.tmpMove.z !== 0;
    const external = options?.externalDisplacement;
    const hasExternal = Boolean(external && (external.x !== 0 || external.z !== 0));
    const correctedX = hasInput || !wasGrounded ? corrected.x : 0;
    const correctedZ = hasInput || !wasGrounded ? corrected.z : 0;
    // Horizontal correction of a gravity-only move is not input movement.
    this.lastInputMovement.set(hasInput ? correctedX : 0, corrected.y, hasInput ? correctedZ : 0);
    const current = this.characterBody.translation();
    const total = this.tmpBody.set(correctedX, corrected.y, correctedZ);

    // External displacement moves separately from where input left the
    // capsule, so callers can tell the two apart (the VR rig follows input
    // movement only).
    if (external && hasExternal && Number.isFinite(external.x) && Number.isFinite(external.z)) {
      this.characterBody.setTranslation({ x: current.x + total.x, y: current.y + total.y, z: current.z + total.z }, false);
      this.rapierWorld.propagateModifiedBodyPositionsToColliders();
      this.characterController.computeColliderMovement(this.characterCollider, { x: external.x, y: 0, z: external.z }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
      const externalCorrected = this.characterController.computedMovement();
      if (Number.isFinite(externalCorrected.x) && Number.isFinite(externalCorrected.y) && Number.isFinite(externalCorrected.z)) {
        total.x += externalCorrected.x;
        total.y += externalCorrected.y;
        total.z += externalCorrected.z;
      }
      this.characterBody.setTranslation(current, false);
      this.rapierWorld.propagateModifiedBodyPositionsToColliders();
    }
    this.horizontalSpeed = Math.hypot(total.x, total.z) / Math.max(deltaSec, 1e-6);

    this.characterBody.setNextKinematicTranslation({
      x: current.x + total.x,
      y: current.y + total.y,
      z: current.z + total.z
    });

    this.rapierWorld.timestep = clamp(deltaSec, 1 / 120, 1 / 20);
    this.rapierWorld.step();

    this.grounded = this.characterController.computedGrounded();
    if (stickToTerrain && this.enforceTerrainClearance()) {
      this.grounded = true;
    }
    if (this.grounded && this.velocityY < 0) {
      this.velocityY = groundedStickVelocity;
    }
  }

  getCharacterBodyPosition(out: THREE.Vector3): THREE.Vector3 {
    if (!this.characterBody) {
      out.set(0, 0, 0);
      return out;
    }
    const p = this.characterBody.translation();
    out.set(p.x, p.y, p.z);
    return out;
  }

  // Collision-corrected movement from input and gravity in the last update,
  // excluding any external displacement.
  getLastInputMovement(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.lastInputMovement);
  }

  getAvatarVisualOffsetY(): number {
    return this.avatarVisualOffsetY;
  }

  getWorld(): import('@dimforge/rapier3d-compat').World | undefined {
    return this.rapierWorld;
  }

  respawn(): boolean {
    if (!this.avatarRigRef || !this.rapierWorld) return false;
    const respawned = this.resolveSpawn(this.avatarRigRef);
    if (respawned) this.rebuildCharacterController();
    return respawned;
  }

  hasSpawnResolved(): boolean {
    return this.spawnResolved;
  }

  getSnapshot(): CharacterSnapshot {
    const p = this.characterBody?.translation() ?? { x: 0, y: 0, z: 0 };
    return {
      position: { x: p.x, y: p.y, z: p.z },
      velocityY: this.velocityY,
      grounded: this.grounded,
      horizontalSpeed: this.horizontalSpeed,
      targetHorizontalSpeed: this.targetHorizontalSpeed,
      jumpQueued: false,
      avatarVisualOffsetY: this.avatarVisualOffsetY
    };
  }

  onXrExited(avatarRig: AvatarRig): void {
    if (!this.characterBody || !this.characterCollider || !this.characterController || !this.rapierWorld || !this.spawnResolved) return;

    const current = this.characterBody.translation();
    const nearbyGrounds = this.findNearbyRecoveryGroundPoints(avatarRig, current.x, current.z);
    const bestNearbyBody = this.findBestNearbyRecoveryBodyPosition(nearbyGrounds, current.y);
    if (bestNearbyBody) {
      this.setCharacterBodyPosition(bestNearbyBody);
      this.rebuildCharacterController();
      this.velocityY = groundedStickVelocity;
      this.grounded = true;
      this.horizontalSpeed = 0;
      return;
    }

    // Final fallback for pathological positions with no nearby valid terrain.
    const respawned = this.resolveSpawn(avatarRig);
    if (respawned) {
      this.rebuildCharacterController();
      this.velocityY = groundedStickVelocity;
      this.grounded = true;
      this.horizontalSpeed = 0;
      return;
    }

    const lift = Math.max(0.08, this.capsuleRadius * 0.35);
    this.setCharacterBodyPosition(new THREE.Vector3(current.x, current.y + lift, current.z));
    this.velocityY = groundedStickVelocity;
    this.grounded = true;
    this.horizontalSpeed = 0;
  }

  private setCharacterBodyPosition(position: THREE.Vector3): void {
    if (!this.characterBody || !this.rapierWorld) return;

    this.characterBody.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    this.characterBody.setNextKinematicTranslation({ x: position.x, y: position.y, z: position.z });
    this.rapierWorld.propagateModifiedBodyPositionsToColliders();
  }

  private rebuildCharacterController(): void {
    if (!this.rapierWorld) return;
    this.characterController = this.rapierWorld.createCharacterController(Math.max(0.01, this.avatarHeight * 0.02));
    this.characterController.setUp({ x: 0, y: 1, z: 0 });
    this.characterController.setSlideEnabled(true);
    this.characterController.setMaxSlopeClimbAngle(THREE.MathUtils.degToRad(40));
    this.characterController.setMinSlopeSlideAngle(THREE.MathUtils.degToRad(45));
    this.characterController.enableAutostep(Math.max(0.08, this.avatarHeight * 0.2), Math.max(0.04, this.avatarHeight * 0.1), true);
    // Keep ground snap conservative; large snap distances can cause sticky horizontal motion.
    this.characterController.enableSnapToGround(Math.max(0.03, this.avatarHeight * 0.08));
  }

  private resolveSpawn(avatarRig: AvatarRig): boolean {
    if (!this.characterBody || !avatarRig.worldModel) return false;

    const spawnGround = this.findSpawnGroundPoint(avatarRig);
    if (!spawnGround) {
      return false;
    }

    const bodyY = spawnGround.y + this.capsuleHalfHeight + this.capsuleRadius + 0.02;
    this.setCharacterBodyPosition(new THREE.Vector3(spawnGround.x, bodyY, spawnGround.z));

    this.velocityY = 0;
    this.grounded = true;
    this.horizontalSpeed = 0;
    this.spawnResolved = true;
    return true;
  }

  private findSpawnGroundPoint(avatarRig: AvatarRig): THREE.Vector3 | undefined {
    if (!avatarRig.worldModel) return undefined;

    this.tmpBox.setFromObject(avatarRig.worldModel);
    const centerX = (this.tmpBox.min.x + this.tmpBox.max.x) * 0.5;
    const centerZ = (this.tmpBox.min.z + this.tmpBox.max.z) * 0.5;

    const ringCount = 8;
    const samplesPerRing = 14;
    const radiusStep = avatarRig.avatarHeight * 0.7;

    for (let ring = 0; ring <= ringCount; ring += 1) {
      const radius = ring * radiusStep;
      const samples = ring === 0 ? 1 : samplesPerRing;
      for (let i = 0; i < samples; i += 1) {
        const angle = (i / samples) * Math.PI * 2;
        const x = centerX + Math.cos(angle) * radius;
        const z = centerZ + Math.sin(angle) * radius;
        const groundY = this.sampleStableGroundYAt(avatarRig, x, z);
        if (groundY !== undefined) {
          return new THREE.Vector3(x, groundY, z);
        }
      }
    }

    return undefined;
  }

  private findNearbyRecoveryGroundPoints(avatarRig: AvatarRig, centerX: number, centerZ: number): THREE.Vector3[] {
    const candidates: THREE.Vector3[] = [];
    const base = this.sampleStableGroundYAt(avatarRig, centerX, centerZ);
    if (base !== undefined) {
      candidates.push(new THREE.Vector3(centerX, base, centerZ));
    }

    const ringCount = 6;
    const samplesPerRing = 12;
    const radiusStep = Math.max(this.capsuleRadius * 1.2, avatarRig.avatarHeight * 0.2);
    for (let ring = 1; ring <= ringCount; ring += 1) {
      const radius = ring * radiusStep;
      for (let i = 0; i < samplesPerRing; i += 1) {
        const angle = (i / samplesPerRing) * Math.PI * 2;
        const x = centerX + Math.cos(angle) * radius;
        const z = centerZ + Math.sin(angle) * radius;
        const y = this.sampleStableGroundYAt(avatarRig, x, z);
        if (y !== undefined) {
          candidates.push(new THREE.Vector3(x, y, z));
        }
      }
    }

    return candidates;
  }

  private findBestNearbyRecoveryBodyPosition(groundCandidates: THREE.Vector3[], currentBodyY: number): THREE.Vector3 | undefined {
    if (!this.characterBody) return undefined;
    if (groundCandidates.length === 0) return undefined;

    const original = this.characterBody.translation();
    const originalPos = new THREE.Vector3(original.x, original.y, original.z);
    let bestPos: THREE.Vector3 | undefined;
    let bestScore = -Infinity;

    for (const ground of groundCandidates) {
      const desiredBodyY = ground.y + this.capsuleHalfHeight + this.capsuleRadius + 0.04;
      const safeBodyY = Math.max(currentBodyY, desiredBodyY);
      const candidate = new THREE.Vector3(ground.x, safeBodyY, ground.z);
      const score = this.evaluateRecoveryMobilityScore(candidate);
      if (score > bestScore) {
        bestScore = score;
        bestPos = candidate;
      }
    }

    this.setCharacterBodyPosition(originalPos);
    return bestPos;
  }

  private evaluateRecoveryMobilityScore(candidateBodyPos: THREE.Vector3): number {
    if (!this.characterController || !this.characterCollider) return -Infinity;
    this.setCharacterBodyPosition(candidateBodyPos);

    const step = Math.max(0.05, this.capsuleRadius * 0.45);
    const directions: ReadonlyArray<[number, number]> = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [0.707, 0.707],
      [0.707, -0.707],
      [-0.707, 0.707],
      [-0.707, -0.707]
    ];

    let score = 0;
    for (const [dx, dz] of directions) {
      this.characterController.computeColliderMovement(this.characterCollider, {
        x: dx * step,
        y: 0,
        z: dz * step
      }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
      const corrected = this.characterController.computedMovement();
      if (!Number.isFinite(corrected.x) || !Number.isFinite(corrected.z)) continue;
      score += Math.hypot(corrected.x, corrected.z);
    }

    return score;
  }

  private enforceTerrainClearance(): boolean {
    if (!this.avatarRigRef || !this.characterBody) return false;
    const current = this.characterBody.translation();
    const groundY = this.sampleStableGroundYAt(this.avatarRigRef, current.x, current.z);
    if (groundY === undefined) return false;

    const minBodyY = groundY + this.capsuleHalfHeight + this.capsuleRadius + CROUCH_TERRAIN_GUARD_CLEARANCE;
    if (current.y + 1e-4 >= minBodyY) return false;

    this.tmpBody.set(current.x, minBodyY, current.z);
    this.setCharacterBodyPosition(this.tmpBody);
    this.velocityY = groundedStickVelocity;
    return true;
  }

  private sampleStableGroundYAt(avatarRig: AvatarRig, x: number, z: number): number | undefined {
    const sampleRadius = Math.max(this.capsuleRadius * 0.35, avatarRig.avatarHeight * CROUCH_TERRAIN_GUARD_SAMPLE_RADIUS_RATIO);
    let bestY: number | undefined;
    for (const [offsetX, offsetZ] of CROUCH_TERRAIN_GUARD_OFFSETS) {
      const sampleY = avatarRig.sampleTerrainYAt(x + offsetX * sampleRadius, z + offsetZ * sampleRadius, this.raycaster);
      if (sampleY === undefined) continue;
      if (bestY === undefined || sampleY > bestY) {
        bestY = sampleY;
      }
    }
    return bestY;
  }

  private buildWorldTrimeshData(root: THREE.Object3D): { vertices: Float32Array; indices: Uint32Array } | undefined {
    const tmpMatrix = new THREE.Matrix4();
    root.updateWorldMatrix(true, true);

    const vertices: number[] = [];
    const indices: number[] = [];
    let vertexOffset = 0;

    root.traverse((obj) => {
      if (!isThreeMesh(obj)) return;

      const geometry = obj.geometry as THREE.BufferGeometry;
      const position = geometry.getAttribute('position');
      if (!position) return;

      tmpMatrix.copy(obj.matrixWorld);
      const transformed = geometry.clone();
      transformed.applyMatrix4(tmpMatrix);

      const transformedPos = transformed.getAttribute('position');
      if (!transformedPos) {
        transformed.dispose();
        return;
      }

      for (let i = 0; i < transformedPos.count; i += 1) {
        vertices.push(transformedPos.getX(i), transformedPos.getY(i), transformedPos.getZ(i));
      }

      if (transformed.index) {
        const indexArray = transformed.index.array;
        for (let i = 0; i < indexArray.length; i += 1) {
          indices.push(Number(indexArray[i]) + vertexOffset);
        }
      } else {
        for (let i = 0; i < transformedPos.count; i += 1) {
          indices.push(i + vertexOffset);
        }
      }

      vertexOffset += transformedPos.count;
      transformed.dispose();
    });

    if (vertices.length === 0 || indices.length === 0) {
      return undefined;
    }

    return {
      vertices: new Float32Array(vertices),
      indices: new Uint32Array(indices)
    };
  }
}
