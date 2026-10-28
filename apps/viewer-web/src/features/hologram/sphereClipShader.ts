/**
 * GLSL injection snippets for sphere-based clipping.
 *
 * Injected via `material.onBeforeCompile` so that every standard Three.js
 * material (MeshStandardMaterial, MeshPhysicalMaterial, etc.) can discard
 * fragments that fall outside a world-space sphere.
 *
 * The vertex shader forwards world position through a varying, and the
 * fragment shader performs a smooth distance fade + hard discard at the
 * sphere boundary.
 */

import { CLOCHE_RIM_GLSL } from "@holoim/xr-ui-core";

/* ------------------------------------------------------------------ */
/*  Vertex shader                                                      */
/* ------------------------------------------------------------------ */

/** Declare the varying that carries world position to the fragment stage. */
export const SPHERE_CLIP_VERTEX_PARS = /* glsl */ `
varying vec3 v_sphereClipWorldPos;
`;

/**
 * Compute world position from the (potentially skinned) `transformed`
 * local-space vertex.  Three.js applies skinning *before* this chunk
 * runs, so `transformed` already incorporates bone transforms.
 *
 * Injected after `#include <project_vertex>` which is the last include
 * that writes `gl_Position`.
 */
export const SPHERE_CLIP_VERTEX_MAIN = /* glsl */ `
v_sphereClipWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

/* ------------------------------------------------------------------ */
/*  Fragment shader                                                    */
/* ------------------------------------------------------------------ */

/** Uniforms + varying declaration for the fragment stage. */
export const SPHERE_CLIP_FRAGMENT_PARS = /* glsl */ `
uniform vec3  u_sphereCenter;
uniform float u_sphereRadius;
uniform float u_sphereFalloff;
varying vec3  v_sphereClipWorldPos;
`;

/**
 * Distance-based fade & discard.
 *
 * `smoothstep` produces a 0 → 1 ramp across the falloff zone just inside
 * the sphere surface, which we invert so that fragments near/outside the
 * boundary fade to zero alpha.  A hard `discard` avoids rendering fully
 * transparent fragments (saves fill-rate and prevents z-fighting ghosts).
 */
export const SPHERE_CLIP_FRAGMENT_MAIN = /* glsl */ `
{
  float sphereDist   = length(v_sphereClipWorldPos - u_sphereCenter);
  float innerEdge    = u_sphereRadius - u_sphereFalloff;
  float sphereAlpha  = 1.0 - smoothstep(innerEdge, u_sphereRadius, sphereDist);
  float edgeBand     = smoothstep(innerEdge - (u_sphereFalloff * 0.45), innerEdge, sphereDist);
  if (sphereAlpha < 0.001) discard;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * 0.82 + vec3(0.05, 0.20, 0.35), edgeBand * 0.24);
  gl_FragColor.a *= sphereAlpha;
}
`;

/* ------------------------------------------------------------------ */
/*  Dome clip (feed only)                                              */
/* ------------------------------------------------------------------ */

/**
 * The feed's clip by the cloche's bent dome (styleguide 3.4): once a take's
 * rim lifts, its scene is cut with a hard edge at the glass instead of the
 * sphere's fade. Exempt materials (the avatar) are never cut. Off, the
 * sphere clip runs as before. XR, IWSDK and AR never inject it.
 */
export const DOME_CLIP_FRAGMENT_PARS = /* glsl */ `
uniform float u_domeOn;
uniform float u_domeExempt;
uniform vec3 u_domeBase;
uniform vec3 u_domeRadii;
uniform float u_domeExponent;
uniform sampler2D u_domeRim;
${CLOCHE_RIM_GLSL}
`;

export const DOME_CLIP_FRAGMENT_MAIN = /* glsl */ `
if (u_domeOn > 0.5) {
  if (u_domeExempt < 0.5 && !clocheBentInside(u_domeRim, u_domeRadii, u_domeExponent, v_sphereClipWorldPos - u_domeBase)) discard;
} else
${SPHERE_CLIP_FRAGMENT_MAIN}`;
