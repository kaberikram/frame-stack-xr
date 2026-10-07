import { DoubleSide, Matrix4, ShaderMaterial, Vector3, type Texture } from '@iwsdk/core';

/**
 * Two grabs, in world space. The room mesh bends by both, then each grab reads its own photo.
 * Slot 0 is the earlier grab; slot 1 bends what slot 0 left, so you grab what you see.
 */
export function createRubberUniforms() {
  return {
    uG0: { value: new Vector3() },
    uD0: { value: new Vector3() },
    uAxis0: { value: new Vector3(1, 0, 0) },
    uN0: { value: new Vector3(0, 0, 1) },
    uLift0: { value: new Vector3(0, 0, 1) },
    uA0: { value: 0.3 },
    uE0: { value: 0 },
    uB0: { value: 0 },
    uRip0: { value: 10 },
    uOn0: { value: 0 },
    uSk0: { value: 1 },
    uG1: { value: new Vector3() },
    uD1: { value: new Vector3() },
    uAxis1: { value: new Vector3(1, 0, 0) },
    uN1: { value: new Vector3(0, 0, 1) },
    uLift1: { value: new Vector3(0, 0, 1) },
    uA1: { value: 0.3 },
    uE1: { value: 0 },
    uB1: { value: 0 },
    uRip1: { value: 10 },
    uOn1: { value: 0 },
    uSk1: { value: 1 },
    uReach: { value: 0.45 },
    uRamp: { value: 0.35 },
    uStripes: { value: 0.2 },
    uFeather: { value: 0.12 },
    uWobble: { value: 0.035 },
    uWaveK: { value: 1 / 0.45 },
    uWaveSpeed: { value: 7 },
    uTime: { value: 0 },
    uCore: { value: 0.12 },
    uRing: { value: 0.35 },
    uRipple: { value: 0.015 },
    uRippleK: { value: (2 * Math.PI) / 0.15 },
    uRippleSpeed: { value: 0.9 },
    uPhoto0: { value: null as Texture | null },
    uPhoto1: { value: null as Texture | null },
    uWorldToClip0: { value: new Matrix4() },
    uWorldToClip1: { value: new Matrix4() },
    uCamPos0: { value: new Vector3() },
    uCamPos1: { value: new Vector3() },
    uGain0: { value: new Vector3(1, 1, 1) },
    uGain1: { value: new Vector3(1, 1, 1) },
    uHasPhoto0: { value: 0 },
    uHasPhoto1: { value: 0 },
    uFade0: { value: 0 },
    uFade1: { value: 0 },
    /** 1 while a camera feeds photos. Without one, moved surfaces get a faint frost instead. */
    uAnyPhoto: { value: 0 },
    uLinear: { value: 1 },
    uCalibrate: { value: 0 },
    // Desk preview only: the webcam stands in for passthrough on unmoved surfaces.
    uLive: { value: null as Texture | null },
    uLiveToClip: { value: new Matrix4() },
    uHasLive: { value: 0 },
  };
}

export type RubberUniformSet = ReturnType<typeof createRubberUniforms>;

const VERTEX = /* glsl */ `
uniform vec3 uG0; uniform vec3 uD0; uniform vec3 uAxis0; uniform vec3 uN0; uniform vec3 uLift0;
uniform float uA0; uniform float uE0; uniform float uB0; uniform float uRip0; uniform float uOn0; uniform float uSk0;
uniform vec3 uG1; uniform vec3 uD1; uniform vec3 uAxis1; uniform vec3 uN1; uniform vec3 uLift1;
uniform float uA1; uniform float uE1; uniform float uB1; uniform float uRip1; uniform float uOn1; uniform float uSk1;
uniform float uReach;
uniform float uRamp;
uniform float uStripes;
uniform float uWobble;
uniform float uWaveK;
uniform float uWaveSpeed;
uniform float uTime;
uniform float uCore;
uniform float uRing;
uniform float uRipple;
uniform float uRippleK;
uniform float uRippleSpeed;
uniform mat4 uWorldToClip0;
uniform mat4 uWorldToClip1;

varying vec4 vPhoto0;
varying vec4 vPhoto1;
varying vec3 vRest;
varying vec2 vMask; // x: visible displacement (m), y: how streaked
varying vec2 vW;    // how much each grab moved this point

const float STRIPE_WIDTH = 0.6; // stretch range over which streaks fade in
const float SIDE_GROW = 0.5;    // the band widens 0.5 m per metre pulled, so small triangles never flip
const float SQUASH = 2.0;       // squeezed zones are 2 m long per metre pulled; slope stays above -0.75
const float FLAT_BURST = 0.3;   // the burst only moves surfaces this close to the grabbed plane
const float FLAT_TAFFY = 0.2;   // the slide too, so pulling the floor leaves the wall base alone
const float RING_MIN = 0.18;    // radial streaks read a ring outside the pinching hand

float ease(float x) { x = clamp(x, 0.0, 1.0); return x * x * (3.0 - 2.0 * x); }

/**
 * One pinch. Slides the surface along the pull (stretched behind the pinch, rigid for A ahead,
 * then squeezed), bursts it outward in-plane for the toward-you part, ripples it, then lifts the
 * middle toward the viewer. Every part keeps the Jacobian positive. 's' is where the photo is read:
 * pulled onto the column (taffy) or ring (burst) through the pinch where the surface stretched.
 * 'hide' rises where a squeezed zone should hand back to the real room.
 */
void pinch(inout vec3 p, inout vec3 s, inout float seen, inout float streak, inout float hide, out float own,
           vec3 G, vec3 D, vec3 axis, vec3 n, vec3 lift, float A, float E, float B, float rip, float sk) {
  vec3 q = p - G;
  float len = length(D);
  float e = max(E, 0.0);
  float squash = 0.15 + SQUASH * (len + e);
  float dn = dot(q, n);
  vec3 inPlane = q - n * dn;
  float rho = length(inPlane);
  vec3 dir = rho > 1e-5 ? inPlane / rho : vec3(0.0);
  float onBurst = 1.0 - smoothstep(0.5 * FLAT_BURST, FLAT_BURST, abs(dn));
  float onTaffy = 1.0 - smoothstep(0.5 * FLAT_TAFFY, FLAT_TAFFY, abs(dn));

  // taffy along the pull
  float t = dot(q, axis);
  float r = length(q - axis * t);
  float r0 = 0.4 * uReach;
  float side = 1.0 - smoothstep(r0, r0 + 0.6 * uReach + SIDE_GROW * len, r);
  float ramp = max(uRamp, 1e-3);
  float along;
  float belly = 0.0;
  if (t < 0.0) {
    float u = min(-t / ramp, 1.0);
    along = 1.0 - ease(u);
    belly = sin(3.14159265 * u);
  } else {
    along = 1.0 - smoothstep(A, A + squash, t);
  }
  float w = side * along * onTaffy;
  float streakT = t < 0.0
    ? smoothstep(uStripes, uStripes + STRIPE_WIDTH, 1.5 * len * sk / ramp) * ease(2.0 * w)
    : 0.0;
  float sway = uWobble * min(len * 4.0, 1.0) * belly * side * onTaffy * sin(t * uWaveK + uTime * uWaveSpeed);
  vec3 moveT = D * w + cross(n, axis) * sway;
  float capT = t < A ? 1.0 : 1.0 - smoothstep(A, A + 0.25 + 0.2 * len, t);

  // toward you: outward from the pinch, in the surface plane
  float core = uCore + 0.35 * e;
  float edge = core + 0.1 + 0.2 * e;
  float push = e * onBurst * ease(rho / core) * (1.0 - smoothstep(core, core + squash, rho));
  float streakR = smoothstep(uStripes, uStripes + STRIPE_WIDTH, 1.5 * e / core)
                * (1.0 - smoothstep(edge - 0.06, edge, rho)) * onBurst;
  vec3 moveR = dir * push;
  float capR = 1.0 - smoothstep(core, edge, rho);

  // ripple at the pinch, in the plane
  vec3 moveW = vec3(0.0);
  float rippling = 0.0;
  if (rip < 0.8) {
    float a = uRipple * exp(-4.0 * rip) * (1.0 - smoothstep(0.5, 0.8, rip));
    float front = uRippleSpeed * rip;
    float env = smoothstep(0.0, 0.06, rho) * (1.0 - smoothstep(0.5 * uReach, uReach, rho))
              * (1.0 - smoothstep(front - 0.04, front + 0.04, rho)) * onBurst;
    moveW = dir * (a * env * sin(uRippleK * (rho - front)));
    rippling = 2.0 * a * env;
  }
  p += moveT + moveR + moveW;

  // lift toward the viewer: its own step after the slide, so the two cannot fold each other
  vec3 q2 = p - G - D;
  float dn2 = dot(q2, n);
  float rho2 = length(q2 - n * dn2);
  vec3 moveB = lift * (B * (1.0 - smoothstep(0.0, edge + e, rho2)) * (1.0 - smoothstep(0.25, 0.75, abs(dn2))));
  p += moveB;

  float ringR = max(uRing * core, RING_MIN);
  s += dir * ((min(rho, ringR) - rho) * streakR) - axis * (t * streakT);
  own = length(moveT + moveR + moveB + moveW) + rippling;
  seen += own;
  streak = max(streak, max(streakT, streakR));
  float hideT = (1.0 - capT) * smoothstep(0.0, 0.02, length(moveT));
  float hideR = (1.0 - capR) * smoothstep(0.0, 0.02, length(moveR));
  hide = max(hide, max(hideT, hideR));
}

void main() {
  vec3 rest = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 p = rest;
  vec3 s = rest;
  float seen = 0.0;
  float streak = 0.0;
  float hide = 0.0;
  float own0 = 0.0;
  float own1 = 0.0;
  if (uOn0 > 0.5) pinch(p, s, seen, streak, hide, own0, uG0, uD0, uAxis0, uN0, uLift0, uA0, uE0, uB0, uRip0, uSk0);
  if (uOn1 > 0.5) pinch(p, s, seen, streak, hide, own1, uG1, uD1, uAxis1, uN1, uLift1, uA1, uE1, uB1, uRip1, uSk1);
  // A squeezed zone reads the photo where it now sits, which is what passthrough shows there,
  // so it can fade into the real room without a seam.
  float h = ease(hide);
  s = mix(s, p, h);
  vRest = rest;
  vPhoto0 = uWorldToClip0 * vec4(s, 1.0);
  vPhoto1 = uWorldToClip1 * vec4(s, 1.0);
  vMask = vec2(seen * (1.0 - smoothstep(0.6, 1.0, hide)), streak * (1.0 - h));
  vW = vec2(own0, own1);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uPhoto0;
uniform sampler2D uPhoto1;
uniform vec3 uCamPos0;
uniform vec3 uCamPos1;
uniform vec3 uGain0;
uniform vec3 uGain1;
uniform float uHasPhoto0;
uniform float uHasPhoto1;
uniform float uFade0;
uniform float uFade1;
uniform float uAnyPhoto;
uniform float uFeather;
uniform float uLinear;
uniform float uCalibrate;
#ifdef PREVIEW
uniform sampler2D uLive;
uniform mat4 uLiveToClip;
uniform float uHasLive;
#endif

varying vec4 vPhoto0;
varying vec4 vPhoto1;
varying vec3 vRest;
varying vec2 vMask;
varying vec2 vW;

float frameCover(vec4 clip, out vec2 uv) {
  uv = clip.xy / max(clip.w, 1e-4) * 0.5 + 0.5;
  if (clip.w <= 1e-4 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  return smoothstep(0.0, max(uFeather, 1e-4), edge);
}

/**
 * Premultiplied output. The XR compositor reads the layer as sRGB and blends in linear light,
 * so alpha has to be applied before the encode or every soft edge darkens into a rim.
 */
void writeColor(vec3 lin, float alpha) {
  if (uLinear > 0.5) {
    gl_FragColor = vec4(lin * alpha, alpha);
    #include <colorspace_fragment>
  } else {
    gl_FragColor = vec4(lin, 1.0);
    #include <colorspace_fragment>
    gl_FragColor = vec4(gl_FragColor.rgb * alpha, alpha);
  }
}

void main() {
  // Derivatives first: they are undefined after a non-uniform early return.
  vec3 nr = cross(dFdx(vRest), dFdy(vRest));
  vec2 uv0;
  vec2 uv1;
  float c0 = uHasPhoto0 * frameCover(vPhoto0, uv0);
  float c1 = uHasPhoto1 * frameCover(vPhoto1, uv1);
  // Streaks read the grabbed column, so they skip the test for surfaces the camera saw edge-on.
  float streaked = step(0.5, vMask.y);
  c0 *= max(step(0.0, dot(nr, uCamPos0 - vRest)), streaked);
  c1 *= max(step(0.0, dot(nr, uCamPos1 - vRest)), streaked);

  if (uCalibrate > 0.5) {
    float cell = mod(floor(vRest.x * 4.0) + floor(vRest.y * 4.0) + floor(vRest.z * 4.0), 2.0);
    float a = cell * c0;
    if (a < 0.002) {
      gl_FragColor = vec4(0.0);
      return;
    }
    writeColor(texture(uPhoto0, uv0).rgb * uGain0, a);
    return;
  }

  float shown = max(smoothstep(0.003, 0.03, vMask.x), smoothstep(0.05, 0.2, vMask.y));
  float k0 = c0 * uFade0 * smoothstep(0.0, 0.01, vW.x);
  float k1 = c1 * uFade1 * smoothstep(0.0, 0.01, vW.y);
  float frost = (1.0 - uAnyPhoto) * 0.25;
  float alpha = shown * max(max(k0, k1), frost);

#ifdef PREVIEW
  vec3 back = vec3(0.16) * (0.65 + 0.35 * abs(normalize(nr).y));
  if (uHasLive > 0.5) {
    vec4 lc = uLiveToClip * vec4(vRest, 1.0);
    vec2 luv = lc.xy / max(lc.w, 1e-4) * 0.5 + 0.5;
    if (lc.w > 1e-4 && luv.x >= 0.0 && luv.y >= 0.0 && luv.x <= 1.0 && luv.y <= 1.0) {
      back = sRGBTransferEOTF(texture(uLive, luv)).rgb;
    }
  }
#else
  // Unmoved surfaces stay real: alpha 0, but depth is still written so a nearer
  // real surface hides a stretched one behind it.
  if (alpha < 0.002) {
    gl_FragColor = vec4(0.0);
    return;
  }
#endif

  vec3 col = vec3(0.92);
  float w0 = k0 * max(vW.x, 1e-4);
  float w1 = k1 * max(vW.y, 1e-4);
  if (w0 + w1 > 1e-7) {
    vec3 a0 = texture(uPhoto0, uv0).rgb * uGain0;
    vec3 a1 = texture(uPhoto1, uv1).rgb * uGain1;
    col = (a0 * w0 + a1 * w1) / (w0 + w1);
  }

#ifdef PREVIEW
  gl_FragColor = vec4(mix(back, col, alpha), 1.0);
  #include <colorspace_fragment>
#else
  writeColor(col, alpha);
#endif
}
`;

/**
 * The scanned room, deformed in world space. Opaque on purpose: it writes premultiplied colour and
 * depth with blending off, so the nearest surface wins and alpha 0 shows passthrough.
 * `preview` adds the webcam backdrop for the desk stand-in; the headset program never samples video.
 */
export function rubberMaterial(uniforms: RubberUniformSet, preview = false): ShaderMaterial {
  return new ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    defines: preview ? { PREVIEW: '' } : {},
    transparent: false,
    depthTest: true,
    depthWrite: true,
    side: DoubleSide,
    toneMapped: false,
  });
}
