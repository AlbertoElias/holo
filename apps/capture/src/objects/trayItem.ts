import * as THREE from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { type LoadedSuppliedObject, MAX_SUPPLIED_OBJECT_BYTES, parseSuppliedObject, type SuppliedObjectInput, SuppliedObjectError } from './suppliedObject';

/** An image card's longer side, in meters. */
export const IMAGE_CARD_SIZE_M = 0.3;
const IMAGE_CARD_DEPTH_M = 0.004;
const MAX_IMAGE_SIDE_PX = 4096;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

export type TrayItemKind = 'model' | 'image';

function startsWith(bytes: ArrayBuffer, magic: number[]): boolean {
  const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, magic.length));
  return magic.every((value, i) => head[i] === value);
}

export function trayItemKind(bytes: ArrayBuffer): TrayItemKind | null {
  if (startsWith(bytes, PNG_MAGIC) || startsWith(bytes, JPEG_MAGIC)) return 'image';
  if (bytes.byteLength >= 4 && new DataView(bytes).getUint32(0, true) === 0x46546c67) return 'model';
  return null;
}

/**
 * A tray item: a GLB under PRD-043's rules, or a PNG/JPEG shown as a thin
 * double-sided card with the image's aspect, `IMAGE_CARD_SIZE_M` on its
 * longer side. The card is a box so it reads from the side, and its texture
 * exports with the take like any other object's.
 */
export async function parseTrayItem(loader: GLTFLoader, input: SuppliedObjectInput): Promise<LoadedSuppliedObject & { kind: TrayItemKind }> {
  const kind = trayItemKind(input.bytes);
  if (kind === 'model') return { ...(await parseSuppliedObject(loader, input)), kind };
  if (kind !== 'image') throw new SuppliedObjectError(`${input.name}: a tray item must be a .glb, .png or .jpg file.`);
  if (input.bytes.byteLength > MAX_SUPPLIED_OBJECT_BYTES) {
    throw new SuppliedObjectError(`${input.name} is ${(input.bytes.byteLength / 1048576).toFixed(1)} MB; the limit is ${MAX_SUPPLIED_OBJECT_BYTES / 1048576} MB.`);
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([input.bytes]), { imageOrientation: 'flipY' });
  } catch {
    throw new SuppliedObjectError(`${input.name} could not be decoded as an image.`);
  }
  if (bitmap.width > MAX_IMAGE_SIDE_PX || bitmap.height > MAX_IMAGE_SIDE_PX) {
    bitmap.close();
    throw new SuppliedObjectError(`${input.name} is ${bitmap.width}×${bitmap.height} px; the limit is ${MAX_IMAGE_SIDE_PX} px on a side.`);
  }
  const texture = new THREE.Texture(bitmap);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.needsUpdate = true;
  const aspect = bitmap.width / bitmap.height;
  const width = aspect >= 1 ? IMAGE_CARD_SIZE_M : IMAGE_CARD_SIZE_M * aspect;
  const height = aspect >= 1 ? IMAGE_CARD_SIZE_M / aspect : IMAGE_CARD_SIZE_M;
  const face = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.8 });
  const edge = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.9 });
  // BoxGeometry groups: +x, −x, +y, −y, +z (front), −z (back).
  const card = new THREE.Mesh(new THREE.BoxGeometry(width, height, IMAGE_CARD_DEPTH_M), [edge, edge, edge, edge, face, face]);
  card.name = 'ImageCard';
  const model = new THREE.Group();
  model.name = input.name;
  model.add(card);
  const sha256 = await sha256Hex(input.bytes);
  return { model, source: sha256 ? { name: input.name, sha256 } : { name: input.name }, kind };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle) return undefined;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
