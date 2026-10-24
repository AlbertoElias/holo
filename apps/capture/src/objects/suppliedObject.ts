import type * as THREE from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import type { ObjectSource } from '@holoim/objects';

/**
 * Refusal limits for a supplied model. Exported textures are re-encoded as
 * PNG, so a heavy model can push a take past the 25 MB upload limit; capture
 * has no Draco, meshopt or KTX2 decoders; a skinned model would export as a
 * second skeleton.
 */
export const MAX_SUPPLIED_OBJECT_BYTES = 8 * 1024 * 1024;
const UNSUPPORTED_EXTENSIONS: Record<string, string> = {
  KHR_draco_mesh_compression: 'Draco-compressed meshes',
  EXT_meshopt_compression: 'meshopt-compressed meshes',
  KHR_mesh_quantization: 'quantized meshes',
  KHR_texture_basisu: 'KTX2 textures'
};
const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;

export interface SuppliedObjectInput {
  /** Display name stored in the export (never a URL). */
  name: string;
  bytes: ArrayBuffer;
}

export interface LoadedSuppliedObject {
  model: THREE.Object3D;
  source: ObjectSource;
}

export class SuppliedObjectError extends Error {}

/** The display name of a URL: its last path segment, without query or hash. */
export function nameFromUrl(url: string): string {
  try {
    const segment = new URL(url, window.location.href).pathname.split('/').filter(Boolean).at(-1);
    return decodeURIComponent(segment ?? 'object');
  } catch {
    return 'object';
  }
}

export async function fetchSuppliedObject(url: string): Promise<SuppliedObjectInput> {
  const response = await fetch(url);
  if (!response.ok) throw new SuppliedObjectError(`Could not load the object (${response.status}).`);
  return { name: nameFromUrl(url), bytes: await response.arrayBuffer() };
}

export async function readSuppliedObjectFile(file: File): Promise<SuppliedObjectInput> {
  return { name: file.name, bytes: await file.arrayBuffer() };
}

/** Checks the GLB before parsing it; throws a `SuppliedObjectError` the overlay shows. */
export function checkSuppliedGlb(bytes: ArrayBuffer): void {
  if (bytes.byteLength > MAX_SUPPLIED_OBJECT_BYTES) {
    throw new SuppliedObjectError(`The object is ${(bytes.byteLength / 1048576).toFixed(1)} MB; the limit is ${MAX_SUPPLIED_OBJECT_BYTES / 1048576} MB.`);
  }
  const view = new DataView(bytes);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(16, true) !== JSON_CHUNK) {
    throw new SuppliedObjectError('The object must be a binary glTF (.glb) file.');
  }
  const jsonLength = view.getUint32(12, true);
  let json: { extensionsUsed?: string[]; extensionsRequired?: string[]; skins?: unknown[] };
  try {
    json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, jsonLength))) as typeof json;
  } catch {
    throw new SuppliedObjectError('The object file is not valid glTF.');
  }
  const used = new Set([...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])]);
  const unsupported = [...used].filter((name) => name in UNSUPPORTED_EXTENSIONS).map((name) => UNSUPPORTED_EXTENSIONS[name]);
  if (unsupported.length > 0) throw new SuppliedObjectError(`Unsupported in objects: ${unsupported.join(', ')}.`);
  if ((json.skins?.length ?? 0) > 0) throw new SuppliedObjectError('Skinned (rigged) models are not supported as objects.');
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string | undefined> {
  // crypto.subtle exists only in secure contexts; the hash is optional.
  if (!globalThis.crypto?.subtle) return undefined;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function parseSuppliedObject(loader: GLTFLoader, input: SuppliedObjectInput): Promise<LoadedSuppliedObject> {
  checkSuppliedGlb(input.bytes);
  let gltf;
  try {
    gltf = await loader.parseAsync(input.bytes, '');
  } catch (error) {
    throw new SuppliedObjectError(`The object could not be parsed: ${(error as Error).message}`);
  }
  const sha256 = await sha256Hex(input.bytes);
  return { model: gltf.scene, source: sha256 ? { name: input.name, sha256 } : { name: input.name } };
}
