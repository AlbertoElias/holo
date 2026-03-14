/**
 * Shader material for the hologram bubble shell.
 *
 * Lightweight look tuned for "camera-inside-bubble" framing:
 * - renders only the interior/back surface (no front tint over avatar)
 * - keeps a subtle fresnel rim and slow holographic wave
 */

import { BackSide, ShaderMaterial } from "three";
import type { Material } from "three";

const BUBBLE_VERTEX = /* glsl */ `
varying vec3 vNormal;
varying vec3 vViewDir;
varying vec3 vWorldPos;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vViewDir = normalize(cameraPosition - worldPos.xyz);
  vWorldPos = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const BUBBLE_FRAGMENT = /* glsl */ `
uniform float u_time;

varying vec3 vNormal;
varying vec3 vViewDir;
varying vec3 vWorldPos;

void main() {
  vec3 normal = normalize(vNormal);
  vec3 viewDir = normalize(vViewDir);

  float facing = clamp(abs(dot(viewDir, normal)), 0.0, 1.0);
  float fresnel = 1.0 - facing;
  float rimSoft = pow(fresnel, 2.2);
  float rimHard = pow(fresnel, 7.5);

  float wave = clamp((normal.y * 0.5) + 0.5, 0.0, 1.0);
  vec3 base = mix(vec3(0.04, 0.12, 0.24), vec3(0.20, 0.56, 0.95), rimSoft);
  vec3 accent = mix(vec3(0.33, 0.78, 1.0), vec3(0.74, 0.54, 1.0), wave);
  vec3 colour = base + (accent * (0.06 + (0.2 * rimSoft) + (0.12 * rimHard)));

  float alpha = 0.004;
  alpha += rimSoft * 0.18;
  alpha += rimHard * 0.42;
  alpha += wave * (0.025 + (0.045 * rimSoft));
  alpha = clamp(alpha, 0.0, 0.74);

  gl_FragColor = vec4(colour, alpha);
}
`;

type BubbleGlassShaderMaterial = ShaderMaterial & {
  uniforms: ShaderMaterial["uniforms"] & {
    u_time: { value: number };
  };
};

export function createBubbleGlassMaterial(): BubbleGlassShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      u_time: { value: 0 }
    },
    vertexShader: BUBBLE_VERTEX,
    fragmentShader: BUBBLE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: BackSide,
    toneMapped: false
  }) as BubbleGlassShaderMaterial;
}

export function isBubbleGlassMaterial(material: Material | undefined): material is BubbleGlassShaderMaterial {
  if (!(material instanceof ShaderMaterial)) {
    return false;
  }

  return Boolean(material.uniforms && "u_time" in material.uniforms);
}
