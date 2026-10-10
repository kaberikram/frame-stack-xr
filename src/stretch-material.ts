import { DoubleSide, Matrix4, ShaderMaterial, Vector2, Vector3, Vector4, type Texture } from '@iwsdk/core';
import { SEGMENTS } from './hand-occluder.js';

/**
 * Two grabs, in world space. The room mesh bends by both, then each grab reads its own photo first.
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
    /** 0 until `stripes` m of pull, 1 by STREAK_SPAN more: how far the column behind the pinch streaks. */
    uBloom0: { value: 0 },
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
    uBloom1: { value: 0 },
    uReach: { value: 0.45 },
    /** Each grab's ramp: the stretch runs this far back from the pinch, longer for far surfaces. */
    uRamp0: { value: 0.35 },
    uRamp1: { value: 0.35 },
    /** 1 when the later grab began on the surface the earlier one had already moved: it bends what you see. */
    uChain1: { value: 0 },
    uFeather: { value: 0.07 },
    uWobble: { value: 0.035 },
    uWaveK: { value: 1 / 0.45 },
    uWaveSpeed: { value: 7 },
    uTime: { value: 0 },
    uCore: { value: 0.12 },
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
    // Each slot's fill: a second photo read where the slot's own is masked (hands) or off its frame.
    uFill0: { value: null as Texture | null },
    uFill1: { value: null as Texture | null },
    uFillToClip0: { value: new Matrix4() },
    uFillToClip1: { value: new Matrix4() },
    uFillCam0: { value: new Vector3() },
    uFillCam1: { value: new Vector3() },
    uHasFill0: { value: 0 },
    uHasFill1: { value: 0 },
    uFade0: { value: 0 },
    uFade1: { value: 0 },
    /** 1 while a camera feeds photos. Without one the desk preview frosts moved surfaces; a headset draws nothing. */
    uAnyPhoto: { value: 0 },
    uLinear: { value: 1 },
    // Desk preview: the webcam stands in for passthrough on unmoved surfaces.
    // `?lens=overlay` on a headset: the live camera in stripes over the room, to check alignment.
    uLive: { value: null as Texture | null },
    uLiveToClip: { value: new Matrix4() },
    uHasLive: { value: 0 },
    uLensOn: { value: 0 },
    // Headset depth of the real room: cuts the real hands and arms out of the stretch.
    uEnvDepth: { value: null as Texture | null },
    uDepthOn: { value: 0 },
    uDepthRaw: { value: 1 },
    uDepthNear: { value: 0.1 },
    uEyeSize: { value: new Vector2(1, 1) },
    uNormDepth0: { value: new Matrix4() },
    uNormDepth1: { value: new Matrix4() },
    /** Per hand, three hand segments then the forearm: start xyz and kind (0 off, 1 hand, 2 arm), end xyz and reach. */
    uSegA: { value: Array.from({ length: SEGMENTS }, () => new Vector4()) },
    uSegB: { value: Array.from({ length: SEGMENTS }, () => new Vector4()) },
    /** 0 off, 1 `?occ=debug` (cut magenta, gate cyan), 2 `?occ=delta` (real depth against the room). */
    uOccDebug: { value: 0 },
  };
}

export type RubberUniformSet = ReturnType<typeof createRubberUniforms>;

/**
 * The taffy band, shared by both stages so the streaks always sit exactly where the mesh stretched.
 * Needs uReach declared above it.
 */
const SHARED = /* glsl */ `
const float SIDE_GROW = 0.5;    // the band widens 0.5 m per metre pulled, so small triangles never flip
const float FLAT_BURST = 0.3;   // the burst only moves surfaces this close to the grabbed plane
const float FLAT_TAFFY = 0.2;   // the slide too, so pulling the floor leaves the wall base alone

float ease(float x) { x = clamp(x, 0.0, 1.0); return x * x * (3.0 - 2.0 * x); }

/** 1 on the pull's column, fading out sideways; the band widens as the pull grows. */
float taffySide(vec3 q, float t, vec3 axis, float len) {
  float r0 = 0.4 * uReach;
  return 1.0 - smoothstep(r0, r0 + 0.6 * uReach + SIDE_GROW * len, length(q - axis * t));
}

/** 1 on the grabbed surface, 0 a little off it. */
float taffyFlat(float dn) {
  return 1.0 - smoothstep(0.5 * FLAT_TAFFY, FLAT_TAFFY, abs(dn));
}

/** Behind the pinch (t < 0): 1 at the pinch, easing to 0 at the anchor one ramp back. */
float taffyBehind(float t, float ramp) {
  return 1.0 - ease(min(-t / max(ramp, 1e-3), 1.0));
}
`;

const VERTEX = /* glsl */ `
uniform vec3 uG0; uniform vec3 uD0; uniform vec3 uAxis0; uniform vec3 uN0; uniform vec3 uLift0;
uniform float uA0; uniform float uE0; uniform float uB0; uniform float uRip0; uniform float uOn0;
uniform vec3 uG1; uniform vec3 uD1; uniform vec3 uAxis1; uniform vec3 uN1; uniform vec3 uLift1;
uniform float uA1; uniform float uE1; uniform float uB1; uniform float uRip1; uniform float uOn1;
uniform float uReach;
uniform float uRamp0;
uniform float uRamp1;
uniform float uChain1;
uniform float uWobble;
uniform float uWaveK;
uniform float uWaveSpeed;
uniform float uTime;
uniform float uCore;
uniform float uRipple;
uniform float uRippleK;
uniform float uRippleSpeed;

varying vec3 vRest;
varying vec3 vWorld;
varying vec3 vMid;  // after the first grab: where the second grab measures its column from
varying vec2 vMask; // x: visible displacement (m), y: how much a squeezed zone hands back to the room
varying vec2 vW;    // how much each grab moved this point
varying float vViewZ; // metres in front of this eye, after the stretch

const float SQUASH = 2.0;       // squeezed zones are 2 m long per metre pulled; slope stays above -0.75
${SHARED}

/**
 * One pinch. Slides the surface along the pull (stretched behind the pinch, rigid for A ahead,
 * then squeezed), bursts it outward in-plane for the toward-you part, ripples it, then lifts the
 * middle toward the viewer. Every part keeps the Jacobian positive. The photo lookup, streaks
 * included, is built per pixel in the fragment stage. 'hide' rises where a squeezed zone should
 * hand back to the real room.
 */
void pinch(inout vec3 p, inout float seen, inout float hide, out float own,
           vec3 G, vec3 D, vec3 axis, vec3 n, vec3 lift, float A, float E, float B, float rip, float ramp) {
  vec3 q = p - G;
  float len = length(D);
  float e = max(E, 0.0);
  float squash = 0.15 + SQUASH * (len + e);
  float dn = dot(q, n);
  vec3 inPlane = q - n * dn;
  float rho = length(inPlane);
  vec3 dir = rho > 1e-5 ? inPlane / rho : vec3(0.0);
  float onBurst = 1.0 - smoothstep(0.5 * FLAT_BURST, FLAT_BURST, abs(dn));
  float onTaffy = taffyFlat(dn);

  // taffy along the pull
  float t = dot(q, axis);
  float side = taffySide(q, t, axis, len);
  float along;
  float belly = 0.0;
  if (t < 0.0) {
    along = taffyBehind(t, ramp);
    belly = sin(3.14159265 * min(-t / max(ramp, 1e-3), 1.0));
  } else {
    along = 1.0 - smoothstep(A, A + squash, t);
  }
  float w = side * along * onTaffy;
  float sway = uWobble * min(len * 4.0, 1.0) * belly * side * onTaffy * sin(t * uWaveK + uTime * uWaveSpeed);
  vec3 moveT = D * w + cross(n, axis) * sway;
  float capT = t < A ? 1.0 : 1.0 - smoothstep(A, A + 0.25 + 0.2 * len, t);

  // straight off the surface: outward from the pinch, in the surface plane
  float core = uCore + 0.35 * e;
  float edge = core + 0.1 + 0.2 * e;
  float push = e * onBurst * ease(rho / core) * (1.0 - smoothstep(core, core + squash, rho));
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

  own = length(moveT + moveR + moveB + moveW) + rippling;
  seen += own;
  float hideT = (1.0 - capT) * smoothstep(0.0, 0.02, length(moveT));
  float hideR = (1.0 - capR) * smoothstep(0.0, 0.02, length(moveR));
  hide = max(hide, max(hideT, hideR));
}

void main() {
  vec3 rest = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 p = rest;
  float seen = 0.0;
  float hide = 0.0;
  float own0 = 0.0;
  float own1 = 0.0;
  if (uOn0 > 0.5) pinch(p, seen, hide, own0, uG0, uD0, uAxis0, uN0, uLift0, uA0, uE0, uB0, uRip0, uRamp0);
  // A later grab that began on the already-moved surface bends what you saw; two grabs that began
  // together each bend the rest surface and their moves add, so neither squeezes into the other.
  vec3 base1 = uChain1 > 0.5 ? p : rest;
  vec3 p1 = base1;
  if (uOn1 > 0.5) pinch(p1, seen, hide, own1, uG1, uD1, uAxis1, uN1, uLift1, uA1, uE1, uB1, uRip1, uRamp1);
  p += p1 - base1;
  vMid = base1;
  vRest = rest;
  vWorld = p;
  vMask = vec2(seen * (1.0 - smoothstep(0.6, 1.0, hide)), ease(hide));
  vW = vec2(own0, own1);
  vec4 viewPos = viewMatrix * vec4(p, 1.0);
  vViewZ = -viewPos.z;
  gl_Position = projectionMatrix * viewPos;
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uPhoto0;
uniform sampler2D uPhoto1;
uniform mat4 uWorldToClip0;
uniform mat4 uWorldToClip1;
uniform vec3 uCamPos0;
uniform vec3 uCamPos1;
uniform vec3 uGain0;
uniform vec3 uGain1;
uniform float uHasPhoto0;
uniform float uHasPhoto1;
uniform sampler2D uFill0;
uniform sampler2D uFill1;
uniform mat4 uFillToClip0;
uniform mat4 uFillToClip1;
uniform vec3 uFillCam0;
uniform vec3 uFillCam1;
uniform float uHasFill0;
uniform float uHasFill1;
uniform float uFade0;
uniform float uFade1;
uniform float uAnyPhoto;
uniform float uFeather;
uniform float uLinear;
uniform vec3 uG0; uniform vec3 uD0; uniform vec3 uAxis0; uniform vec3 uN0; uniform float uOn0; uniform float uBloom0;
uniform vec3 uG1; uniform vec3 uD1; uniform vec3 uAxis1; uniform vec3 uN1; uniform float uOn1; uniform float uBloom1;
uniform float uReach;
uniform float uRamp0;
uniform float uRamp1;
#if defined(PREVIEW) || defined(LENS_OVERLAY)
uniform sampler2D uLive;
uniform mat4 uLiveToClip;
uniform float uHasLive;
#endif
#ifdef ENV_DEPTH
uniform highp sampler2DArray uEnvDepth;
uniform float uDepthOn;
uniform float uDepthRaw;
uniform float uDepthNear;
uniform vec2 uEyeSize;
uniform mat4 uNormDepth0;
uniform mat4 uNormDepth1;
uniform vec4 uSegA[${SEGMENTS}];
uniform vec4 uSegB[${SEGMENTS}];
uniform float uOccDebug;
/** The gate fades out over this much beyond a segment's reach. */
const float GATE_SOFT = 0.015;
/** Depth nearer than this is a hole in the depth map, not a hand. */
const float DEPTH_MIN = 0.12;
#endif
#ifdef LENS_OVERLAY
uniform float uLensOn;
/** Stripe period in pixels: 48 px of camera, 48 px of passthrough. */
const float LENS_STRIPE = 96.0;
#endif

varying vec3 vRest;
varying vec3 vWorld;
varying vec3 vMid;
varying vec2 vMask;
varying vec2 vW;
varying float vViewZ;

${SHARED}

/** How much a moved point leans on the other grab's photo where its own covers it too. */
const float OTHER_PHOTO = 0.02;

/** Full streaks squeeze the photo 16x toward the pinch: long stripes that still vary, never one texel row. */
const float STREAK_LOG2 = 4.0;

/**
 * How far to move the photo lookup toward the grabbed column for the part of the band behind the
 * pinch, by how far this grab's streaks have bloomed. Squeezing by 'keep' (0 < keep <= 1) never
 * folds the picture. xyz is the offset, w the band weight it was made at.
 */
vec4 streakOffset(vec3 base, vec3 G, vec3 D, vec3 axis, vec3 n, float bloom, float ramp, out float streak) {
  streak = 0.0;
  vec3 q = base - G;
  float t = dot(q, axis);
  if (t >= 0.0) return vec4(0.0);
  float w = taffySide(q, t, axis, length(D)) * taffyBehind(t, ramp) * taffyFlat(dot(q, n));
  float keep = exp2(-STREAK_LOG2 * bloom * ease(2.0 * w));
  streak = 1.0 - keep;
  return vec4(-axis * (t * streak), w);
}

#ifdef ENV_DEPTH
/** Closest distance between segments p0-p1 and q0-q1; the closest point on q0-q1 goes to 'onQ'. */
float segmentClosest(vec3 p0, vec3 p1, vec3 q0, vec3 q1, out vec3 onQ) {
  vec3 d1 = p1 - p0;
  vec3 d2 = q1 - q0;
  vec3 r = p0 - q0;
  float a = max(dot(d1, d1), 1e-8);
  float e = max(dot(d2, d2), 1e-8);
  float b = dot(d1, d2);
  float c = dot(d1, r);
  float f = dot(d2, r);
  float denom = a * e - b * b;
  float s = denom > 1e-8 ? clamp((b * f - c * e) / denom, 0.0, 1.0) : 0.0;
  float t = (b * s + f) / e;
  if (t < 0.0) {
    t = 0.0;
    s = clamp(-c / a, 0.0, 1.0);
  } else if (t > 1.0) {
    t = 1.0;
    s = clamp((b - c) / a, 0.0, 1.0);
  }
  onQ = q0 + d2 * t;
  return length(p0 + d1 * s - onQ);
}

/** This eye's position. Under multiview viewMatrix is per eye; cameraPosition is the pair's midpoint. */
vec3 eyePosition() {
  return -(transpose(mat3(viewMatrix)) * viewMatrix[3].xyz);
}

/**
 * 1 where the line of sight to this point passes through a tracked hand or forearm, 0 well clear.
 * Also returns how far in front of this eye that hand is there, and how thick it is.
 */
float handGate(vec3 world, out float handZ, out float band) {
  vec3 eye = eyePosition();
  float g = 0.0;
  float nearest = 1e9;
  vec3 at = world;
  band = 0.04;
  for (int i = 0; i < ${SEGMENTS}; i++) {
    float kind = uSegA[i].w;
    if (kind < 0.5) continue;
    vec3 onSeg;
    float d = segmentClosest(eye, world, uSegA[i].xyz, uSegB[i].xyz, onSeg);
    float gi = 1.0 - smoothstep(uSegB[i].w, uSegB[i].w + GATE_SOFT, d);
    if (gi > g || (gi == g && gi > 0.0 && d < nearest)) {
      g = gi;
      nearest = d;
      at = onSeg;
      band = kind > 1.5 ? 0.04 : 0.045;
    }
  }
  handZ = -(viewMatrix * vec4(at, 1.0)).z;
  return g;
}

float envMeters(vec2 uv, float layer) {
  float t = textureLod(uEnvDepth, vec3(uv, layer), 0.0).r;
  float m = uDepthRaw * uDepthNear / max(1.0 - t, 1e-5);
  return m < DEPTH_MIN ? 1e4 : m;
}

/** The headset's depth of the real room at this pixel, metres; 1e4 where it has none. */
float realDepth() {
#ifdef VIEW_ID
  float eye = float(VIEW_ID);
  vec2 fc = gl_FragCoord.xy;
#else
  float eye = step(uEyeSize.x, gl_FragCoord.x);
  vec2 fc = gl_FragCoord.xy - vec2(eye * uEyeSize.x, 0.0);
#endif
  vec2 uv = ((eye < 0.5 ? uNormDepth0 : uNormDepth1) * vec4(fc / uEyeSize, 0.0, 1.0)).xy;
  // The nearest of five taps half a texel apart: covers the hand's edge without dilating it a texel.
  vec2 texel = 0.5 / vec2(textureSize(uEnvDepth, 0).xy);
  float real = envMeters(uv, eye);
  real = min(real, envMeters(uv + vec2(texel.x, 0.0), eye));
  real = min(real, envMeters(uv - vec2(texel.x, 0.0), eye));
  real = min(real, envMeters(uv + vec2(0.0, texel.y), eye));
  real = min(real, envMeters(uv - vec2(0.0, texel.y), eye));
  return real;
}

/**
 * How much a real hand or arm stands in front of this point of the stretch, from the headset's
 * depth: 1 shows passthrough's real hand, 0 keeps the stretch. Only along the line of sight to a
 * tracked hand, and only where the real surface is at that hand's depth: a mug or a lamp beside
 * the hand is in front of the room too, but it is not the hand.
 */
float handOcclusion(vec3 world, out float gate) {
  float handZ;
  float band;
  gate = handGate(world, handZ, band);
  if (gate <= 0.0 || uDepthOn < 0.5) return 0.0;
  float real = realDepth();
  float atHand = 1.0 - smoothstep(band, band + 0.02, abs(real - handZ));
  float margin = 0.01 + 0.02 * vViewZ;
  return gate * atHand * smoothstep(margin, margin + 0.02, vViewZ - real);
}

/**
 * Developer views, premultiplied colour and alpha. ?occ=debug: the cut magenta, the gate a faint
 * cyan. ?occ=delta: real depth minus the room's, red where the real surface is nearer, blue where
 * it is farther, white where they agree, over a +-8 cm range.
 */
vec4 occDebug(vec3 world, float occ, float gate) {
  if (uOccDebug > 1.5) {
    if (uDepthOn < 0.5) return vec4(0.0);
    float real = realDepth();
    if (real > 1e3) return vec4(0.0);
    float d = clamp((vViewZ - real) / 0.08, -1.0, 1.0);
    vec3 c = d > 0.0 ? mix(vec3(1.0), vec3(1.0, 0.1, 0.1), d) : mix(vec3(1.0), vec3(0.1, 0.3, 1.0), -d);
    return vec4(c, 0.6);
  }
  vec3 c = occ > 0.01 ? vec3(1.0, 0.0, 1.0) : vec3(0.0, 1.0, 1.0);
  return vec4(c, max(occ, 0.2 * gate));
}
#endif

float frameCover(vec4 clip, out vec2 uv) {
  uv = clip.xy / max(clip.w, 1e-4) * 0.5 + 0.5;
  if (clip.w <= 1e-4 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  return smoothstep(0.0, max(uFeather, 1e-4), edge);
}

/**
 * How much of a photo covers this point: inside its frame, and seen from the camera's side of the
 * surface. Streaks read the grabbed column, so they skip the facing test for surfaces seen edge-on.
 */
float photoCover(mat4 toClip, vec3 cam, float has, vec3 p, vec3 nr, float streaked, out vec2 uv) {
  float c = has * frameCover(toClip * vec4(p, 1.0), uv);
  return c * max(step(0.0, dot(nr, cam - vRest)), streaked);
}

/**
 * One slot's picture: its own photo, then its fill wherever the first is masked or off its frame.
 * The photos are premultiplied SRGB8_ALPHA8, so the sampler returns linear light times alpha
 * (decoding again crushed every photo to a flat grey). Returns gain * rgb premultiplied, and
 * coverage in alpha. textureLod needs no derivatives.
 */
vec4 slotPicture(sampler2D own, vec2 uv, float c, sampler2D fill, vec2 fuv, float cf, vec3 gain) {
  vec4 a = c > 0.0 ? textureLod(own, uv, 0.0) * c : vec4(0.0);
  if (cf > 0.0 && a.a < 0.999) a += textureLod(fill, fuv, 0.0) * (cf * (1.0 - a.a));
  return vec4(a.rgb * gain, a.a);
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

#ifdef LENS_OVERLAY
  // Alignment check: every other diagonal stripe is the live camera, projected where the surface is.
  // Edges that continue across the stripes mean the camera model matches passthrough.
  if (uLensOn > 0.5) {
    vec4 lc = uLiveToClip * vec4(vWorld, 1.0);
    vec2 luv = lc.xy / max(lc.w, 1e-4) * 0.5 + 0.5;
    bool inside = lc.w > 1e-4 && luv.x >= 0.0 && luv.y >= 0.0 && luv.x <= 1.0 && luv.y <= 1.0;
    float stripe = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / LENS_STRIPE));
    // Discarded, not drawn clear: a clear stripe would still write depth and cut what is behind it.
    if (!inside || stripe < 0.5) discard;
    writeColor(sRGBTransferEOTF(texture(uLive, luv)).rgb, 1.0);
    return;
  }
#endif

  // Where the photo is read. The texture rides the surface (rest position) and the streaks pull it
  // toward the grabbed column, per pixel so it is exact on any triangle.
  // Where two grabs' streaks overlap, their pulls on the lookup are averaged by band weight, not
  // added: added, they ran past each other into a mirrored strip.
  float st0 = 0.0;
  float st1 = 0.0;
  vec4 o0 = uOn0 > 0.5 && uBloom0 > 0.0 && vW.x > 0.0 ? streakOffset(vRest, uG0, uD0, uAxis0, uN0, uBloom0, uRamp0, st0) : vec4(0.0);
  vec4 o1 = uOn1 > 0.5 && uBloom1 > 0.0 && vW.y > 0.0 ? streakOffset(vMid, uG1, uD1, uAxis1, uN1, uBloom1, uRamp1, st1) : vec4(0.0);
  vec3 s = vRest + (o0.xyz * o0.w + o1.xyz * o1.w) / max(o0.w + o1.w, 1e-4);
  float st = max(st0, st1);
  // A squeezed zone reads the photo where it is drawn, which is what passthrough shows there,
  // so it fades into the real room without a seam.
  s = mix(s, vWorld, vMask.y);
  st *= 1.0 - vMask.y;
  float shown = max(smoothstep(0.002, 0.02, vMask.x), smoothstep(0.05, 0.2, st));
  // Where the surface barely moved, read the photo where it now sits too: the fade then crossfades
  // one picture with passthrough instead of two offset ones.
  vec3 sr = mix(vWorld, s, shown);

  float streaked = step(0.5, st);
  vec2 uv0;
  vec2 uv1;
  vec2 fuv0;
  vec2 fuv1;
  float c0 = photoCover(uWorldToClip0, uCamPos0, uHasPhoto0, sr, nr, streaked, uv0);
  float c1 = photoCover(uWorldToClip1, uCamPos1, uHasPhoto1, sr, nr, streaked, uv1);
  float cf0 = photoCover(uFillToClip0, uFillCam0, uHasFill0, sr, nr, streaked, fuv0);
  float cf1 = photoCover(uFillToClip1, uFillCam1, uHasFill1, sr, nr, streaked, fuv1);

  // Both slots are pictures of the same still room, so a moved point may read either one.
  // Its own grab's photo leads; the other takes over where the first is masked or runs off its frame.
  // Coverage before masks bounds the alpha, so unmoved surfaces leave before any texture is read.
  float k0 = max(c0, cf0) * uFade0;
  float k1 = max(c1, cf1) * uFade1;
  float own = max(smoothstep(0.0, 0.01, vW.x), smoothstep(0.0, 0.01, vW.y));
#ifdef PREVIEW
  // Desk without a webcam: a faint frost keeps the demo visible.
  float frost = (1.0 - uAnyPhoto) * 0.25;
#else
  // Headset: no photo, nothing drawn. Passthrough stays.
  const float frost = 0.0;
#endif
  float alpha = shown * max(own * max(k0, k1), frost);

#ifdef PREVIEW
  vec3 back = vec3(0.16) * (0.65 + 0.35 * abs(normalize(nr).y));
  if (uHasLive > 0.5) {
    // Where the surface is drawn now, as passthrough would show it.
    vec4 lc = uLiveToClip * vec4(vWorld, 1.0);
    vec2 luv = lc.xy / max(lc.w, 1e-4) * 0.5 + 0.5;
    if (lc.w > 1e-4 && luv.x >= 0.0 && luv.y >= 0.0 && luv.x <= 1.0 && luv.y <= 1.0) {
      back = sRGBTransferEOTF(texture(uLive, luv)).rgb;
    }
  }
#else
#ifdef ENV_DEPTH
  float gate = 0.0;
  float occ = handOcclusion(vWorld, gate);
  // Developer views draw wherever the room is, moved or not.
  vec4 dbg = uOccDebug > 0.5 ? occDebug(vWorld, occ, gate) : vec4(0.0);
  if (alpha < 0.002 && dbg.a > 0.002) {
    writeColor(dbg.rgb, dbg.a);
    return;
  }
#endif
  // Unmoved surfaces stay real. Depth is still written so a nearer surface wins.
  if (alpha < 0.002) {
    gl_FragColor = vec4(0.0);
    return;
  }
#endif

  // Masked texels carry alpha 0: they drop out of both the colour and the alpha, never smear.
  vec4 p0 = k0 > 0.0 ? slotPicture(uPhoto0, uv0, c0, uFill0, fuv0, cf0, uGain0) : vec4(0.0);
  vec4 p1 = k1 > 0.0 ? slotPicture(uPhoto1, uv1, c1, uFill1, fuv1, cf1, uGain1) : vec4(0.0);
  float w0 = uFade0 * (max(vW.x, 0.0) + OTHER_PHOTO);
  float w1 = uFade1 * (max(vW.y, 0.0) + OTHER_PHOTO);
  float cover = p0.a * w0 + p1.a * w1;
  vec3 col = (p0.rgb * w0 + p1.rgb * w1) / max(cover, 1e-7);
  alpha = shown * max(own * max(p0.a * uFade0, p1.a * uFade1), frost);
#ifdef ENV_DEPTH
  // Debug views paint the cut instead of cutting.
  if (uOccDebug < 0.5) alpha *= 1.0 - occ;
#endif
#ifdef PREVIEW
  col = cover > 1e-7 ? col : vec3(0.92);
  col = mix(back, col, alpha);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
#else
#ifdef ENV_DEPTH
  if (dbg.a > 0.0) {
    col = mix(col, dbg.rgb, dbg.a);
    alpha = max(alpha, dbg.a);
  }
#endif
  writeColor(col, alpha);
#endif
}
`;

/**
 * The scanned room, deformed in world space. Opaque on purpose: it writes premultiplied colour and
 * depth with blending off, so the nearest surface wins and alpha 0 shows passthrough.
 * `preview` adds the webcam backdrop for the desk stand-in; the headset program never samples video.
 */
export function rubberMaterial(uniforms: RubberUniformSet, preview = false, lensOverlay = false): ShaderMaterial {
  const defines: Record<string, string> = {};
  if (preview) defines.PREVIEW = '';
  else defines.ENV_DEPTH = '';
  if (lensOverlay) defines.LENS_OVERLAY = '';
  return new ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    name: preview ? 'jonze-stretch-preview' : 'jonze-stretch',
    defines,
    transparent: false,
    depthTest: true,
    depthWrite: true,
    side: DoubleSide,
    toneMapped: false,
  });
}
