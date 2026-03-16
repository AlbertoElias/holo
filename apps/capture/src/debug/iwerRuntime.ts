import type { MockVrPoseInput, QuatLike, Vec3Like, VrHandSide } from '../types/contracts';

const IWER_STANDING_HEAD_Y = 1.6;

interface IwerVector3 extends Vec3Like {
  set: (x: number, y: number, z: number) => unknown;
}

interface IwerQuaternion extends QuatLike {
  set: (x: number, y: number, z: number, w: number) => unknown;
  normalize?: () => unknown;
}

interface IwerTrackedHandInput {
  connected: boolean;
  position: IwerVector3;
  quaternion: IwerQuaternion;
}

interface IwerDevice {
  position: IwerVector3;
  quaternion: IwerQuaternion;
  hands: Partial<Record<VrHandSide, IwerTrackedHandInput>>;
  primaryInputMode: 'controller' | 'hand';
  activeSession?: XRSession;
}

declare global {
  interface Window {
    IWER_DEVICE?: IwerDevice;
  }
}

function normalizeQuaternion(quaternion: QuatLike): QuatLike {
  const length = Math.hypot(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  if (length < 1e-8) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  return {
    x: quaternion.x / length,
    y: quaternion.y / length,
    z: quaternion.z / length,
    w: quaternion.w / length
  };
}

function multiplyQuaternion(a: QuatLike, b: QuatLike): QuatLike {
  return normalizeQuaternion({
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  });
}

function rotateVector(vector: Vec3Like, quaternion: QuatLike): Vec3Like {
  const q = normalizeQuaternion(quaternion);
  const uvx = q.y * vector.z - q.z * vector.y;
  const uvy = q.z * vector.x - q.x * vector.z;
  const uvz = q.x * vector.y - q.y * vector.x;
  const uuvx = q.y * uvz - q.z * uvy;
  const uuvy = q.z * uvx - q.x * uvz;
  const uuvz = q.x * uvy - q.y * uvx;
  const scale = 2 * q.w;

  return {
    x: vector.x + uvx * scale + uuvx * 2,
    y: vector.y + uvy * scale + uuvy * 2,
    z: vector.z + uvz * scale + uuvz * 2
  };
}

function getHeadRelativePosition(device: IwerDevice): Vec3Like {
  return {
    x: device.position.x,
    y: device.position.y - IWER_STANDING_HEAD_Y,
    z: device.position.z
  };
}

function getHeadQuaternion(device: IwerDevice): QuatLike {
  return normalizeQuaternion(device.quaternion);
}

export function applyIwerMockVrPoseInput(payload: MockVrPoseInput): boolean {
  const device = window.IWER_DEVICE;
  if (!device) {
    return false;
  }

  if (typeof payload.enabled === 'boolean' && !payload.enabled) {
    for (const side of ['left', 'right'] as const) {
      const hand = device.hands[side];
      if (hand) {
        hand.connected = false;
      }
    }
    return true;
  }

  const headPosition = payload.head?.position ?? getHeadRelativePosition(device);
  const headQuaternion = payload.head?.quaternion ?? getHeadQuaternion(device);
  const worldHeadPosition = {
    x: headPosition.x,
    y: IWER_STANDING_HEAD_Y + headPosition.y,
    z: headPosition.z
  };

  device.position.set(worldHeadPosition.x, worldHeadPosition.y, worldHeadPosition.z);
  device.quaternion.set(headQuaternion.x, headQuaternion.y, headQuaternion.z, headQuaternion.w);
  device.quaternion.normalize?.();

  if (!payload.hands) {
    return true;
  }

  device.primaryInputMode = 'hand';

  for (const side of ['left', 'right'] as const) {
    const nextHand = payload.hands[side];
    const hand = device.hands[side];
    if (!nextHand || !hand) {
      continue;
    }

    if (typeof nextHand.tracked === 'boolean') {
      hand.connected = nextHand.tracked;
    }

    if (nextHand.position) {
      const rotatedHandPosition = rotateVector(nextHand.position, headQuaternion);
      hand.position.set(
        worldHeadPosition.x + rotatedHandPosition.x,
        worldHeadPosition.y + rotatedHandPosition.y,
        worldHeadPosition.z + rotatedHandPosition.z
      );
    }

    if (nextHand.quaternion) {
      const worldHandQuaternion = multiplyQuaternion(headQuaternion, nextHand.quaternion);
      hand.quaternion.set(
        worldHandQuaternion.x,
        worldHandQuaternion.y,
        worldHandQuaternion.z,
        worldHandQuaternion.w
      );
      hand.quaternion.normalize?.();
    }
  }

  return true;
}
