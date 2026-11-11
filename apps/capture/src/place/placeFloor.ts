import * as THREE from 'three';

// The set a scanned place stands on (docs/features/splat-capture.md, Scope):
// a disc at set-frame y = 0, the scan's floor, wide enough that no author
// walks off it. Every consumer of the set (feet, the motor, camera collision,
// props, the Record gate) reads it as it reads any set. It draws nothing over
// the scan, where the splats are the floor, and fades in to the stage's
// ground colour past the scan's edge, so where the scan ends is visible.

/** The live disc's radius, metres: no author on a flat screen walks past it. */
export const PLACE_FLOOR_RADIUS = 200;
/** The fade from the scan's edge to the plain floor, metres. */
export const PLACE_FLOOR_FADE = 1.5;
export const PLACE_FLOOR_NAME = 'PlaceFloor';
const FLOOR_COLOR = 0x1b1d22;
const FLOOR_ALPHA = 0.92;

export function createPlaceFloor(scanRadius: number): THREE.Mesh {
  const geometry = new THREE.CircleGeometry(PLACE_FLOOR_RADIUS, 96);
  // Rotated in the geometry, not the mesh: its normals are the ground's own +y for every cast and the trimesh.
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      color: { value: new THREE.Color(FLOOR_COLOR) },
      inner: { value: scanRadius },
      fade: { value: PLACE_FLOOR_FADE },
      alpha: { value: FLOOR_ALPHA }
    },
    vertexShader: /* glsl */ `
      varying vec2 vLocal;
      void main() {
        vLocal = position.xz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      uniform float inner;
      uniform float fade;
      uniform float alpha;
      varying vec2 vLocal;
      void main() {
        float t = smoothstep(inner, inner + fade, length(vLocal));
        if (t <= 0.0) discard;
        gl_FragColor = vec4(color, alpha * t);
        #include <colorspace_fragment>
      }`
  });
  const floor = new THREE.Mesh(geometry, material);
  floor.name = PLACE_FLOOR_NAME;
  // Drawn after the splats' own floor, so it never hides it where they overlap at the edge.
  floor.renderOrder = 1;
  return floor;
}

/** The disc the export stores as the set: the take's reach plus a margin (Q7), opaque, for readers without the place. */
export function createExportFloor(center: { x: number; z: number }, radius: number): THREE.Mesh {
  const geometry = new THREE.CircleGeometry(radius, 64);
  geometry.rotateX(-Math.PI / 2);
  const floor = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: FLOOR_COLOR, roughness: 0.95, metalness: 0 }));
  floor.name = 'RecordedPlaceFloor';
  floor.position.set(center.x, 0, center.z);
  return floor;
}
