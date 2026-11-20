import type * as THREE from 'three';

/** What the house base writes in its scene extras (`packages/avatar-look`, dress.ts and finish.ts). */
export interface HouseAvatarRecord {
  name: 'house-base';
  finish?: string;
  build?: string;
  card?: unknown;
}

/** The house base record on a loaded avatar root, or null for any other avatar. */
export function readHouseAvatar(avatar: THREE.Object3D | undefined): HouseAvatarRecord | null {
  const raw: unknown = avatar?.userData?.holoimAvatar;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  return (value as { name?: unknown }).name === 'house-base' ? (value as HouseAvatarRecord) : null;
}
