import { Color, DoubleSide, Matrix4, ShaderMaterial, Vector3, type Texture } from '@iwsdk/core';

export interface RubberUniforms {
  [name: string]: { value: unknown };
}

/** Two grabs, in world space. The room mesh bends by both, then the photo is looked up. */
export function createRubberUniforms(photo: Texture) {
  return {
    uG0: { value: new Vector3() },
    uD0: { value: new Vector3() },
    uAxis0: { value: new Vector3(0, 1, 0) },
    uA0: { value: 0.1 },
    uOn0: { value: 0 },
    uG1: { value: new Vector3() },
    uD1: { value: new Vector3() },
    uAxis1: { value: new Vector3(0, 1, 0) },
    uA1: { value: 0.1 },
    uOn1: { value: 0 },
    uReach: { value: 0.45 },
    uRamp: { value: 0.35 },
    uStripes: { value: 0.5 },
    uFeather: { value: 0.06 },
    uWobble: { value: 0.04 },
    uWaveK: { value: 1 / 0.45 },
    uWaveSpeed: { value: 7 },
    uTime: { value: 0 },
    uReveal: { value: 0 },
    uMeshTint: { value: 0.85 },
    uHasPhoto: { value: 0 },
    uHasLive: { value: 0 },
    uWorldToClip: { value: new Matrix4() },
    uLiveToClip: { value: new Matrix4() },
    uCamPos: { value: new Vector3() },
    uPhoto: { value: photo },
    uLive: { value: photo },
    uTint: { value: new Color('#73B4E8') },
  };
}

export type RubberUniformSet = ReturnType<typeof createRubberUniforms>;

const VERTEX = /* glsl */ `
uniform vec3 uG0;
uniform vec3 uD0;
uniform vec3 uAxis0;
uniform float uA0;
uniform float uOn0;
uniform vec3 uG1;
uniform vec3 uD1;
uniform vec3 uAxis1;
uniform float uA1;
uniform float uOn1;
uniform float uReach;
uniform float uRamp;
uniform float uWobble;
uniform float uWaveK;
uniform float uWaveSpeed;
uniform float uTime;

varying vec3 vWorld;
varying vec3 vRest;

vec3 bendSide(vec3 axis) {
  vec3 side = cross(axis, vec3(0.0, 1.0, 0.0));
  if (dot(side, side) < 1e-6) side = cross(axis, vec3(1.0, 0.0, 0.0));
  return normalize(side);
}

vec3 rubber(vec3 p, vec3 G, vec3 D, vec3 axis, float A, float on) {
  if (on < 0.5) return vec3(0.0);
  float t = dot(p - G, axis);
  vec3 radial = p - G - axis * t;
  float side = 1.0 - smoothstep(0.4 * uReach, max(uReach, 1e-3), length(radial));
  float fade = 0.15 + length(D) * 0.45;
  float along = t < 0.0
    ? 1.0 - smoothstep(0.0, max(uRamp, 1e-3), -t)
    : 1.0 - smoothstep(A, A + fade, t);
  return D * side * along;
}

void main() {
  vec3 rest = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 d0 = rubber(rest, uG0, uD0, uAxis0, uA0, uOn0);
  vec3 d1 = rubber(rest, uG1, uD1, uAxis1, uA1, uOn1);
  vec3 p = rest + d0 + d1;
  float pull = length(d0) + length(d1);
  vec3 axis = uOn0 > 0.5 ? uAxis0 : uAxis1;
  float wave = sin(dot(rest, axis) * uWaveK + uTime * uWaveSpeed);
  p += bendSide(axis) * wave * uWobble * min(pull * 4.0, 1.0);
  vRest = rest;
  vWorld = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uG0;
uniform vec3 uD0;
uniform vec3 uAxis0;
uniform float uOn0;
uniform vec3 uG1;
uniform vec3 uD1;
uniform vec3 uAxis1;
uniform float uOn1;
uniform float uReach;
uniform float uRamp;
uniform float uStripes;
uniform float uFeather;
uniform float uReveal;
uniform float uMeshTint;
uniform float uHasPhoto;
uniform float uHasLive;
uniform mat4 uWorldToClip;
uniform mat4 uLiveToClip;
uniform vec3 uCamPos;
uniform sampler2D uPhoto;
uniform sampler2D uLive;
uniform vec3 uTint;

varying vec3 vWorld;
varying vec3 vRest;

float grabStretch(vec3 rest, vec3 G, vec3 D, vec3 axis, float on) {
  if (on < 0.5) return 0.0;
  float t = dot(rest - G, axis);
  float ramp = max(uRamp, 1e-3);
  if (t >= 0.0 || t <= -ramp) return 0.0;
  float r = length(rest - G - axis * t);
  float side = 1.0 - smoothstep(0.4 * uReach, max(uReach, 1e-3), r);
  float u = clamp(-t / ramp, 0.0, 1.0);
  float slope = 6.0 * u * (1.0 - u) / ramp;
  return length(D) * side * slope;
}

vec3 grabSample(vec3 rest, vec3 G, vec3 axis, float stretch) {
  float t = dot(rest - G, axis);
  float s = smoothstep(uStripes, uStripes + 1.1, stretch);
  return rest - axis * t * s;
}

float frameCover(vec2 uv, float w) {
  float inside = step(1e-4, w);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) inside = 0.0;
  float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  return inside * smoothstep(0.0, max(uFeather, 1e-4), edge);
}

void main() {
  float stretch0 = grabStretch(vRest, uG0, uD0, uAxis0, uOn0);
  float stretch1 = grabStretch(vRest, uG1, uD1, uAxis1, uOn1);
  vec3 sample0 = grabSample(vRest, uG0, uAxis0, stretch0);
  vec3 sample1 = grabSample(vRest, uG1, uAxis1, stretch1);
  float weight = stretch0 + stretch1;
  vec3 samplePos = weight < 1e-4 ? vRest : (sample0 * stretch0 + sample1 * stretch1) / weight;

  vec3 bare = uTint;
  vec4 liveClip = uLiveToClip * vec4(vRest, 1.0);
  vec2 liveUv = liveClip.xy / max(liveClip.w, 1e-4) * 0.5 + 0.5;
  float liveCover = uHasLive * frameCover(liveUv, liveClip.w);
  vec3 liveSrc = texture(uLive, liveUv).rgb;
  vec3 liveTint = vec3(liveSrc.r * 0.72, liveSrc.g * 0.94, min(1.0, liveSrc.b * 1.16 + 0.05));
  vec3 idle = mix(bare, liveTint, liveCover);

  vec4 clip = uWorldToClip * vec4(samplePos, 1.0);
  vec2 uv = clip.xy / max(clip.w, 1e-4) * 0.5 + 0.5;
  float cover = uHasPhoto * frameCover(uv, clip.w);
  vec3 n = cross(dFdx(vWorld), dFdy(vWorld));
  if (dot(n, uCamPos - samplePos) < 0.0) cover = 0.0;
  vec3 photo = texture(uPhoto, uv).rgb;
  vec3 pulled = mix(bare, photo, cover);
  vec3 col = mix(idle, pulled, uReveal);

  float alpha = mix(uMeshTint * mix(0.55, 0.92, liveCover), mix(0.78, 0.96, cover), uReveal);
  if (alpha < 0.02) discard;
  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
}
`;

/** The scanned room, deformed in world space. Depth writes so a hand occluder can punch through. */
export function rubberMaterial(uniforms: RubberUniformSet): ShaderMaterial {
  return new ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthTest: true,
    depthWrite: true,
    side: DoubleSide,
    toneMapped: false,
  });
}
