// Helpers for the contract tests; not part of the package's surface.
import { loadMsdfAtlas } from "@holoim/design-tokens/msdf";
import { isChrome } from "@holoim/xr-ui-core";
import { useThree } from "@react-three/fiber";
import { create, ReactThreeTest } from "@react-three/test-renderer";
import { useEffect, type ReactNode } from "react";
import { type Camera, type Color, type Material, Mesh, type Object3D, SRGBColorSpace, type ShaderMaterial } from "three";

import type { LabelFont } from "./internal.js";

/** The real figtree-400 atlas metrics; the PNG is not decoded in tests. */
export async function testFont(): Promise<LabelFont> {
  return { font: (await loadMsdfAtlas("figtree-400")).font, texture: null };
}

export function meshesOf(root: Object3D): Mesh[] {
  const meshes: Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof Mesh) meshes.push(object);
  });
  return meshes;
}

export function named(root: Object3D, name: string): Object3D {
  const found = root.getObjectByName(name);
  if (!found) throw new Error(`no object named "${name}"`);
  return found;
}

/** A material's colour as the sRGB hex a token holds: what a viewer sees, read back. */
export function hexOf(material: Material): string {
  const shader = material as ShaderMaterial;
  const color = shader.isShaderMaterial ? (shader.uniforms.color!.value as Color) : (material as unknown as { color: Color }).color;
  return `#${color.getHexString(SRGBColorSpace)}`;
}

/** Every object under (and including) the root that is not chrome. */
export function nonChrome(root: Object3D): string[] {
  const missing: string[] = [];
  root.traverse((object) => {
    if (!isChrome(object)) missing.push(`${object.type}:${object.name}`);
  });
  return missing;
}

/** The glyph hit meshes under a root, by accessible name. */
export function hitByLabel(root: Object3D, label: string): Mesh {
  const hit = meshesOf(root).find((mesh) => mesh.userData.label === label);
  if (!hit) throw new Error(`no hit mesh labelled "${label}"`);
  return hit;
}

/** Fills `into.camera` with the scene's camera, so a test can move the head. */
export function CameraProbe({ into }: { into: { camera?: Camera } }) {
  const camera = useThree((state) => state.camera);
  useEffect(() => {
    into.camera = camera;
  }, [camera, into]);
  return null;
}

/** The test instance of an object a component mounted, to fire r3f events at (the renderer cannot walk native children). */
export function instanceOf(object: Object3D): ReactThreeTest.ReactThreeTestInstance {
  // r3f gave the object its `__r3f` record when it mounted the primitive.
  return new ReactThreeTest.ReactThreeTestInstance(object as never);
}

/** Listens for three's `dispose` event on a geometry or material. */
export function watchDispose(resource: { addEventListener: (type: "dispose", listener: () => void) => void }): { disposed: boolean } {
  const watch = { disposed: false };
  resource.addEventListener("dispose", () => {
    watch.disposed = true;
  });
  return watch;
}

/**
 * `create` from the test renderer, with its mock WebGL context answering `null`
 * for the extensions it has no mock of: three 0.181 reads `undefined` as
 * "OCULUS_multiview is available" and fails at `MAX_VIEWS_OVR`.
 */
export function mount(element: ReactNode) {
  return create(element, {
    beforeReturn: (canvas) => {
      const getContext = canvas.getContext.bind(canvas) as (id: string, ...rest: unknown[]) => unknown;
      (canvas as { getContext: unknown }).getContext = (id: string, ...rest: unknown[]) => {
        const context = getContext(id, ...rest) as { getExtension?: (name: string) => unknown } | null;
        if (context?.getExtension) {
          const original = context.getExtension.bind(context);
          context.getExtension = (name: string) => original(name) ?? null;
        }
        return context;
      };
    }
  });
}

export type TestRenderer = Awaited<ReturnType<typeof mount>>;
