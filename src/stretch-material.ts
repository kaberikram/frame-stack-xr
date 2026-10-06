import { BackSide, Color, FrontSide, Matrix4, NormalBlending, ShaderMaterial, Vector3, type Texture } from '@iwsdk/core';
// three compiles these as GLSL ES 3.00 with its own defines, which also keeps its
// multiview prefix (one draw for both eyes) working on the headset.

export interface StretchUniforms {
  [name: string]: { value: unknown };
}

/** Uniforms shared between the slab and its outline. */
export function createStretchUniforms(photo: Texture) {
  return {
    uSize: { value: new Vector3(1, 1, 1) },
    uAxis: { value: new Vector3(1, 0, 0) },
    uDir: { value: 1 },
    uBand: { value: 1 },
    uStretch: { value: 0 },
    uWobble: { value: 0 },
    uWaveK: { value: 1 / 0.45 },
    uWaveSpeed: { value: 7 },
    uTime: { value: 0 },
    uRings: { value: 0 },
    uRingSpacing: { value: 0.22 },
    uRingSpeed: { value: 0.5 },
    uGlow: { value: 0.8 },
    uGrain: { value: 16 },
    uReveal: { value: 0 },
    uColor: { value: new Color('#2A2F3A') },
    uRingColor: { value: new Color('#9FC2FF') },
    uHasPhoto: { value: 0 },
    uMeshToClip: { value: new Matrix4() },
    uCamMesh: { value: new Vector3() },
    uPhoto: { value: photo },
  };
}
export type StretchUniformSet = ReturnType<typeof createStretchUniforms>;

/**
 * Stretch, in the object's own space.
 *
 * The whole covered length elongates away from the anchored end, and the snapshot
 * stays pinned to the rest pose, so every column of the photo widens into a stripe.
 * `uBand` is how much of that length takes the extra distance (1 = the whole mesh).
 * A travelling wave shoves the cross-section sideways, strongest at the end you're
 * pulling. Light rings run along the new length, and only show where the photo missed.
 */
const COMMON = /* glsl */ `
uniform vec3 uSize;
uniform vec3 uAxis;
uniform float uDir;
uniform float uBand;
uniform float uStretch;
uniform float uWobble;
uniform float uWaveK;
uniform float uWaveSpeed;
uniform float uTime;
uniform float uHasPhoto;
uniform mat4 uMeshToClip;
uniform vec3 uCamMesh;

varying vec2 vGrainUv;
varying float vAlong;
varying float vSmear;
varying vec3 vNormalW;
varying vec3 vViewW;
varying vec2 vPhotoUv;
varying float vPhoto;

void stretchPoint(in vec3 unit, in vec3 nrm, out vec3 posL, out vec3 normalL) {
  vec3 p = unit * uSize;
  float len = max(dot(uSize, abs(uAxis)), 1e-4);
  float s = dot(p, uAxis);
  float along01 = s / len + 0.5;                      // 0..1 along +axis
  float uu = uDir > 0.0 ? along01 : 1.0 - along01;    // 0 at the anchored end
  float cover = clamp(uBand, 0.02, 1.0);
  float hold = 1.0 - cover;
  float moved;                                        // metres from the anchored end
  float smear = 0.0;
  if (uu <= hold) {
    moved = uu * len;
  } else {
    float k = (uu - hold) / max(cover, 1e-5);
    moved = hold * len + k * (cover * len + uStretch);
    smear = 1.0;
  }
  float sNew = uDir > 0.0 ? moved - len * 0.5 : len * 0.5 - moved;
  vec3 sampleP = p;                                   // rest pose: the photo widens instead of sliding
  p += uAxis * (sNew - s);

  // The snapshot was taken in the unstretched pose. Faces the camera couldn't
  // see keep the grain, so the back of a wardrobe doesn't wear the front's pixels.
  vec4 clip = uMeshToClip * vec4(sampleP, 1.0);
  float ok = uHasPhoto;
  vec2 uv = clip.xy / max(clip.w, 1e-4) * 0.5 + 0.5;
  if (clip.w <= 1e-4) ok = 0.0;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ok = 0.0;
  if (dot(nrm, uCamMesh - sampleP) <= 0.0) ok = 0.0;
  vPhotoUv = uv;
  vPhoto = ok;

  // sideways wobble, growing toward the end being pulled
  vec3 side = normalize(abs(uAxis.y) < 0.9 ? cross(uAxis, vec3(0.0, 1.0, 0.0)) : cross(uAxis, vec3(1.0, 0.0, 0.0)));
  vec3 side2 = cross(uAxis, side);
  float phase = moved * uWaveK * 6.2831853 - uTime * uWaveSpeed;
  float ramp = smoothstep(0.0, 1.0, uu);
  p += (side * sin(phase) + side2 * sin(phase * 0.83 + 1.7)) * uWobble * ramp;

  posL = p;
  normalL = nrm;
  vGrainUv = vec2(uu * len, dot(unit, side2) * dot(uSize, abs(side2)));
  vAlong = moved;
  vSmear = smear;
}
`;

const NOISE = /* glsl */ `
float hash12(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
    mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x),
    u.y);
}
`;

const VERTEX = /* glsl */ `
${COMMON}
void main() {
  vec3 posL;
  vec3 normalL;
  stretchPoint(position, normal, posL, normalL);
  vec4 world = modelMatrix * vec4(posL, 1.0);
  vNormalW = normalize(mat3(modelMatrix) * normalL);
  vViewW = cameraPosition - world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAGMENT = /* glsl */ `
uniform float uRings;
uniform float uRingSpacing;
uniform float uRingSpeed;
uniform float uGlow;
uniform float uGrain;
uniform float uReveal;
uniform float uTime;
uniform vec3 uColor;
uniform vec3 uRingColor;
uniform sampler2D uPhoto;

varying vec2 vGrainUv;
varying float vAlong;
varying float vSmear;
varying vec3 vNormalW;
varying vec3 vViewW;
varying vec2 vPhotoUv;
varying float vPhoto;
${NOISE}

void main() {
  // Grain stands in wherever the snapshot doesn't cover: the back of the object,
  // and the whole thing when the camera never opened.
  vec2 grainUv = vGrainUv * uGrain * vec2(1.0, 0.45);
  float g = valueNoise(grainUv);
  float fine = valueNoise(grainUv * 3.5 + 11.0);
  vec3 grain = uColor * (0.5 + 0.85 * g + 0.4 * fine);
  vec3 base = vPhoto > 0.5 ? texture(uPhoto, vPhotoUv).rgb : grain;

  vec3 n = normalize(vNormalW);
  vec3 v = normalize(vViewW);
  float lambert = 0.35 + 0.65 * clamp(dot(n, normalize(vec3(0.3, 1.0, 0.45))), 0.0, 1.0);
  // The photo already carries the room's light. A little shade keeps the box from going flat.
  vec3 col = base * (vPhoto > 0.5 ? mix(0.82, 1.0, lambert) : lambert);

  // The snapshot is the look. Rings and the rim stay on the grain fallback.
  float stylize = 1.0 - step(0.5, vPhoto);
  float rim = pow(1.0 - clamp(abs(dot(n, v)), 0.0, 1.0), 3.0);
  col += uRingColor * rim * uGlow * (0.3 + 0.7 * uRings) * stylize;

  float ring = pow(0.5 + 0.5 * cos(6.2831853 * (vAlong / max(uRingSpacing, 0.01) - uTime * uRingSpeed)), 24.0);
  col += uRingColor * ring * uRings * (0.5 + 0.9 * vSmear) * uGlow * stylize;

  if (uReveal < 0.003) discard;
  gl_FragColor = vec4(col, uReveal);
  #include <colorspace_fragment>
}
`;

/** The stretched object itself. Front faces only, so the box stays solid while it fades in. */
export function stretchMaterial(u: StretchUniformSet): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: u,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: true,
    side: FrontSide,
    blending: NormalBlending,
  });
}

/** A dark shell behind the slab so the real object never peeks out from under it. */
export function shellMaterial(u: StretchUniformSet): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: u,
    vertexShader: VERTEX,
    fragmentShader: /* glsl */ `
      uniform float uReveal;
      uniform vec3 uColor;
      varying vec2 vGrainUv;
      varying float vAlong;
      varying float vSmear;
      varying vec3 vNormalW;
      varying vec3 vViewW;
      varying vec2 vPhotoUv;
      varying float vPhoto;
      void main() {
        if (uReveal < 0.003) discard;
        gl_FragColor = vec4(uColor * 0.45, uReveal);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: true,
    side: BackSide,
    blending: NormalBlending,
  });
}
