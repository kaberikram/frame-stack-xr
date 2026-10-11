import { CustomBlending, DoubleSide, MaxEquation, Matrix4, ShaderMaterial, Vector2, Vector3, Vector4, type Texture } from '@iwsdk/core';
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
    // The cone toward you: how far up it the pinched spot's colours reach (room-stretch-system.ts writeGrab).
    uTentBloom0: { value: 0 },
    uTentBloom1: { value: 0 },
    // A fingertip held close, per slot: spike centre and radius, the move of its tip, the surface normal.
    uHov0: { value: new Vector4() },
    uHovT0: { value: new Vector3() },
    uHovN0: { value: new Vector3(0, 1, 0) },
    uHov1: { value: new Vector4() },
    uHovT1: { value: new Vector3() },
    uHovN1: { value: new Vector3(0, 1, 0) },
    // A wall section pushed in by a palm (push-box.ts): the opening's centre, its axes along the wall
    // with their half sizes in w, the wall's normal toward you, and how deep it went. The room leaves
    // the opening undrawn while uBoxOn is set; the box draws into it.
    uBoxOn: { value: 0 },
    uBoxC: { value: new Vector3() },
    uBoxU: { value: new Vector4(1, 0, 0, 0) },
    uBoxV: { value: new Vector4(0, 1, 0, 0) },
    uBoxN: { value: new Vector3(0, 0, 1) },
    uBoxDepth: { value: 0 },
    // Per hand, a ball round its cut segments (hand-occluder.ts balls). Wide open until written, so the
    // cut never skips a hand it has not been told about.
    uHandBall: { value: [new Vector4(0, 0, 0, 1e4), new Vector4(0, 0, 0, 1e4)] },
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

/**
 * A pushed-in box: the room over its mapped area is not drawn, so the box shows through it, from
 * BOX_FRONT in front of the wall (the fridge, the counters, the TV unit: whatever stands against it
 * goes in, as part of the box's picture) to BOX_SKIN behind the box's back. Further out (a coffee
 * table) the room stays, hides the box behind it, and a pinch there grabs it.
 */
export const BOX_FRONT = 1;
const BOX_SKIN = 0.06;

const BOX_HOLE = /* glsl */ `
#ifdef BOX_HOLE
const float BOX_SKIN = ${BOX_SKIN.toFixed(3)};
const float BOX_FRONT = ${BOX_FRONT.toFixed(3)};
// The opening stops this far short of the box's rim, so the room overlaps it: a pixel the rim's edge
// only grazes is still the wall, never a crack.
const float BOX_LIP = 0.004;
bool inBoxOpening(vec3 rest) {
  if (uBoxOn < 0.5) return false;
  vec3 q = rest - uBoxC;
  float dn = dot(q, uBoxN);
  return dn < BOX_FRONT && dn > -max(uBoxDepth, 0.0) - BOX_SKIN &&
    abs(dot(q, uBoxU.xyz)) < uBoxU.w - BOX_LIP && abs(dot(q, uBoxV.xyz)) < uBoxV.w - BOX_LIP;
}
#endif
`;

/**
 * The real hands' cut, from the headset's depth (ENV_DEPTH only): the room, the void's black and its
 * backstop all leave passthrough's hands showing through them with it.
 */
const DEPTH_CUT = /* glsl */ `
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
/** Per hand, a ball round its cut segments (centre, radius; 0 off): a line of sight that misses both skips the loop. */
uniform vec4 uHandBall[2];

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

/** True when the line of sight from the eye to this point passes through either hand's ball. */
bool nearHand(vec3 eye, vec3 world) {
  vec3 d = world - eye;
  float dd = max(dot(d, d), 1e-8);
  for (int i = 0; i < 2; i++) {
    vec4 b = uHandBall[i];
    if (b.w <= 0.0) continue;
    float t = clamp(dot(b.xyz - eye, d) / dd, 0.0, 1.0);
    if (length(eye + d * t - b.xyz) < b.w) return true;
  }
  return false;
}

/**
 * 1 where the line of sight to this point passes through a tracked hand or forearm, 0 well clear.
 * Also returns how far in front of this eye that hand is there, and how thick it is.
 */
float handGate(vec3 world, out float handZ, out float band) {
  vec3 eye = eyePosition();
  if (!nearHand(eye, world)) {
    handZ = 0.0;
    band = 0.04;
    return 0.0;
  }
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
// \`viewZ\` is where the surface sits for the in-front test: the drawn point for the room, but the
// wall itself for a pushed-in box, which is drawn behind the real wall everywhere.
float handOcclusion(vec3 world, float viewZ, out float gate) {
  float handZ;
  float band;
  gate = handGate(world, handZ, band);
  if (gate <= 0.0 || uDepthOn < 0.5) return 0.0;
  float real = realDepth();
  float atHand = 1.0 - smoothstep(band, band + 0.02, abs(real - handZ));
  float margin = 0.01 + 0.02 * viewZ;
  return gate * atHand * smoothstep(margin, margin + 0.02, viewZ - real);
}

#endif
`;

/** Reading the frozen photos and writing premultiplied colour. Needs uFeather and uLinear declared above it. */
const PHOTO = /* glsl */ `
float frameCover(vec4 clip, out vec2 uv) {
  uv = clip.xy / max(clip.w, 1e-4) * 0.5 + 0.5;
  if (clip.w <= 1e-4 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  return smoothstep(0.0, max(uFeather, 1e-4), edge);
}

/**
 * A premultiplied photo texel in linear light. The GPU decodes sRGB per channel after premultiplying,
 * so a half-transparent edge texel of a hand cut-out came back too dark; that is undone here. Opaque
 * and empty texels need nothing.
 */
vec4 photoTexel(sampler2D tex, vec2 uv) {
  vec4 t = textureLod(tex, uv, 0.0);
  if (t.a > 0.004 && t.a < 0.996) {
    vec3 encoded = sRGBTransferOETF(vec4(t.rgb, 1.0)).rgb / t.a;
    t.rgb = sRGBTransferEOTF(vec4(encoded, 1.0)).rgb * t.a;
  }
  return t;
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
varying vec2 vTent; // how far up each grab's cone toward you this point is, 0 at its foot to 1 at its tip
varying vec2 vFold; // each cone's folds here: +1 on a ridge, -1 in a valley, 0 off the folds
varying float vViewZ; // metres in front of this eye, after the stretch

// A fingertip held close (no pinch), per slot: where the spike rises from and its radius, the move
// of its tip, and the surface's normal there.
uniform vec4 uHov0; uniform vec3 uHovT0; uniform vec3 uHovN0;
uniform vec4 uHov1; uniform vec3 uHovT1; uniform vec3 uHovN1;

const float SQUASH = 2.0;       // squeezed zones are 2 m long per metre pulled; slope stays above -0.75
const float FOLDS = 5.0;        // radial creases in a cone
const float FOLD_DEPTH = 0.12;  // their depth, as a share of the cone's rise
const float GATHER = 0.35;      // how far the cone's hem is drawn in toward the pinch, as a share of its rise
const float SPIKE_GATHER = 1.0; // and a fingertip spike's surroundings toward the point under the finger
${SHARED}

/**
 * One pinch. Slides the surface along the pull (stretched behind the pinch, rigid for A ahead,
 * then squeezed), bursts it outward in-plane for the toward-you part, ripples it, then lifts the
 * middle toward the viewer. Every part keeps the Jacobian positive. The photo lookup, streaks
 * included, is built per pixel in the fragment stage. 'hide' rises where a squeezed zone should
 * hand back to the real room.
 */
void pinch(inout vec3 p, inout float seen, inout float hide, out float own, out float tent, out float fold,
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

  // Toward you: cloth pinched between the fingers, up the line of sight through them. Its own step
  // after the slide so the two cannot fold each other. Taut, nearly straight sides from the tip down
  // to a soft hem, wider where the surface is seen at an angle (the lift then also moves it along the
  // surface, and its steepest slope stays under 1), creased by radial folds, and drawn in a little
  // toward the pinch instead of only stretching.
  vec3 q2 = p - G - D;
  float dn2 = dot(q2, n);
  vec3 in2 = q2 - n * dn2;
  float rho2 = length(in2);
  float liftIn = length(lift - n * dot(lift, n));
  float rise = max(B, 0.0);
  // Sized by the rise only: the spring's dip after release must not shrink it to nothing. Wide enough
  // that the steepest slope along the surface (1.8 at the tip, from the lift's in-plane share, plus
  // the gather) stays under 0.9, so it never folds over (room-stretch-system.ts tentSpread).
  float tentR = edge + e + max(0.6, (1.8 * liftIn + GATHER) / 0.9) * rise;
  float r = min(rho2 / tentR, 1.0);
  float flat2 = 1.0 - smoothstep(0.25, 0.75, abs(dn2));
  float cloth = pow(1.0 - r, 1.8);
  tent = cloth * flat2;
  // Folds: FOLDS creases from the tip down the sides, gone at the tip and at the hem, along the
  // surface normal so they never fold the surface over. Each pinch turns them its own way.
  vec3 t1 = normalize(cross(n, abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  float theta = atan(dot(in2, cross(n, t1)), dot(in2, t1));
  float turn = fract(dot(G, vec3(12.9898, 78.233, 37.719))) * 6.2831853;
  float crease = cos(FOLDS * theta + turn) * 4.0 * r * (1.0 - r) * flat2;
  fold = crease * min(rise * 5.0, 1.0);
  vec3 moveB = lift * (B * tent) + n * (FOLD_DEPTH * rise * crease);
  // The hem drawn in toward the pinch; zero at the tip itself, so the centre never pinches through.
  vec3 moveG = rho2 > 1e-5 ? in2 * (-GATHER * rise * cloth * flat2 / tentR) : vec3(0.0);
  p += moveB + moveG;

  own = length(moveT + moveR + moveB + moveW + moveG) + rippling;
  seen += own;
  float hideT = (1.0 - capT) * smoothstep(0.0, 0.02, length(moveT));
  float hideR = (1.0 - capR) * smoothstep(0.0, 0.02, length(moveR));
  hide = max(hide, max(hideT, hideR));
}

/**
 * A fingertip held close: the surface is sucked up toward it, a narrow neck rising out of a wide
 * base, and drawn in along the surface toward the point under the finger, so you see it pulled in
 * even from straight above. Only the surface itself, within a few centimetres of its plane.
 */
vec3 hover(vec3 p, vec4 hov, vec3 tip, vec3 n) {
  vec3 q = p - hov.xyz;
  float dn = dot(q, n);
  vec3 inPlane = q - n * dn;
  float r = min(length(inPlane) / hov.w, 1.0);
  float f = 1.0 - smoothstep(0.0, 1.0, r);
  float h = max(dot(tip, n), 0.0);
  vec3 pull = inPlane * (-SPIKE_GATHER * h * f / hov.w);
  return (tip * pow(f, 2.5) + pull) * (1.0 - smoothstep(0.03, 0.06, abs(dn)));
}

#ifdef BOX
uniform float uBoxOn; uniform vec3 uBoxC; uniform vec4 uBoxU; uniform vec4 uBoxV; uniform vec3 uBoxN; uniform float uBoxDepth;
attribute float aShade;
varying float vShade;
const float BOX_DIM = 0.25;       // the far end of a box is this much darker
const float BOX_DIM_DEPTH = 1.2;  // reached this far in, metres

void main() {
  // position: x and y across the opening (-1..1); z 0 at the wall, 1 at the back. Every point reads
  // the photo where it sat on the wall, so the back is the wall itself and each side is the rim's
  // colours drawn out along the depth.
  vec3 rest = uBoxC + uBoxU.xyz * (uBoxU.w * position.x) + uBoxV.xyz * (uBoxV.w * position.y);
  vec3 p = rest - uBoxN * (uBoxDepth * position.z);
  vMid = rest;
  vRest = rest;
  vWorld = p;
  vMask = vec2(1.0, 0.0);
  vW = vec2(1.0, 0.0);
  vTent = vec2(0.0);
  vFold = vec2(0.0);
  vShade = aShade * (1.0 - BOX_DIM * smoothstep(0.0, BOX_DIM_DEPTH, max(uBoxDepth, 0.0) * position.z));
  vec4 viewPos = viewMatrix * vec4(p, 1.0);
  vViewZ = -viewPos.z;
  // Off: every vertex outside clip space. The program stays compiled, nothing rasterises.
  gl_Position = uBoxOn > 0.5 ? projectionMatrix * viewPos : vec4(2.0, 2.0, 2.0, 1.0);
}
#else
void main() {
  vec3 rest = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 p = rest;
  float seen = 0.0;
  float hide = 0.0;
  float own0 = 0.0;
  float own1 = 0.0;
  float tent0 = 0.0;
  float tent1 = 0.0;
  float fold0 = 0.0;
  float fold1 = 0.0;
  if (uOn0 > 0.5) pinch(p, seen, hide, own0, tent0, fold0, uG0, uD0, uAxis0, uN0, uLift0, uA0, uE0, uB0, uRip0, uRamp0);
  // A later grab that began on the already-moved surface bends what you saw; two grabs that began
  // together each bend the rest surface and their moves add, so neither squeezes into the other.
  vec3 base1 = uChain1 > 0.5 ? p : rest;
  vec3 p1 = base1;
  if (uOn1 > 0.5) pinch(p1, seen, hide, own1, tent1, fold1, uG1, uD1, uAxis1, uN1, uLift1, uA1, uE1, uB1, uRip1, uRamp1);
  p += p1 - base1;
  // Fingertip spikes rise from the rest surface, each read through its own slot's photo.
  vec3 h0 = dot(uHovT0, uHovT0) > 0.0 ? hover(rest, uHov0, uHovT0, uHovN0) : vec3(0.0);
  vec3 h1 = dot(uHovT1, uHovT1) > 0.0 ? hover(rest, uHov1, uHovT1, uHovN1) : vec3(0.0);
  p += h0 + h1;
  own0 += length(h0);
  own1 += length(h1);
  seen += length(h0) + length(h1);
  vMid = base1;
  vRest = rest;
  vWorld = p;
  vMask = vec2(seen * (1.0 - smoothstep(0.6, 1.0, hide)), ease(hide));
  vW = vec2(own0, own1);
  vTent = vec2(tent0, tent1);
  vFold = vec2(fold0, fold1);
  vec4 viewPos = viewMatrix * vec4(p, 1.0);
  vViewZ = -viewPos.z;
  gl_Position = projectionMatrix * viewPos;
}
#endif
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
varying vec2 vTent;
varying vec2 vFold;
varying float vViewZ;
/** How much each grab's cone carries the pinched spot's colours up into it, 0 to 1. */
uniform float uTentBloom0;
uniform float uTentBloom1;
uniform float uBoxOn;
uniform vec3 uBoxC;
uniform vec4 uBoxU;
uniform vec4 uBoxV;
uniform vec3 uBoxN;
uniform float uBoxDepth;
#ifdef BOX
varying float vShade;
#endif
${BOX_HOLE}

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

${DEPTH_CUT}

#ifdef ENV_DEPTH
/**
 * Developer views, straight colour and alpha. ?occ=debug: the cut magenta, the gate a faint
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

${PHOTO}

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
  vec4 a = c > 0.0 ? photoTexel(own, uv) * c : vec4(0.0);
  if (cf > 0.0 && a.a < 0.999) a += photoTexel(fill, fuv) * (cf * (1.0 - a.a));
  return vec4(a.rgb * gain, a.a);
}

void main() {
#ifdef BOX
  // A box's sides keep their rest point on the rim as they run back, so the rest position spans no
  // area there: the wall's own normal stands in for the facing test.
  vec3 nr = uBoxN;
#else
  // Derivatives first: they are undefined after a non-uniform early return.
  vec3 nr = cross(dFdx(vRest), dFdy(vRest));
#ifdef BOX_HOLE
  // Only in its own program: a discard anywhere in a shader costs every pinch its early depth test.
  // Cloth pinched out of the opening draws where it went; what is still there leaves it to the box.
  if (inBoxOpening(vRest) && inBoxOpening(vWorld)) discard;
#endif
#endif

#ifdef LENS_OVERLAY
  // Alignment check: every other diagonal stripe is the live camera, projected where the surface is.
  // Edges that continue across the stripes mean the camera model matches passthrough.
  if (uLensOn > 0.5) {
    vec4 lc = uLiveToClip * vec4(vWorld, 1.0);
    vec2 luv = lc.xy / max(lc.w, 1e-4) * 0.5 + 0.5;
    bool inside = lc.w > 1e-4 && luv.x >= 0.0 && luv.y >= 0.0 && luv.x <= 1.0 && luv.y <= 1.0;
    float stripe = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / LENS_STRIPE));
    // Discarded, not drawn clear: a clear stripe would still write depth and cut what is behind it.
    // With a box pushed in that depth is wanted: it keeps the box's outside hidden behind the wall.
    if (!inside || stripe < 0.5) {
#ifdef BOX_HOLE
      if (uBoxOn > 0.5) {
        gl_FragColor = vec4(0.0);
        return;
      }
#endif
      discard;
    }
    writeColor(sRGBTransferEOTF(texture(uLive, luv)).rgb, 1.0);
    return;
  }
#endif

  // Where the photo is read. The texture rides the surface (rest position) and the streaks pull it
  // toward the grabbed column, per pixel so it is exact on any triangle.
  // Where two grabs' streaks overlap, their pulls on the lookup are averaged, each weighted by its own
  // size, not added: added, they ran past each other into a mirrored strip. Weighted by size, each
  // fades out exactly where its pull does, so the blend has no seam at either pinch.
#ifdef BOX
  // A box only ever reads the wall where its points sat.
  vec3 s = vRest;
  float st = 0.0;
#else
  float st0 = 0.0;
  float st1 = 0.0;
  vec4 o0 = uOn0 > 0.5 && uBloom0 > 0.0 && vW.x > 0.0 ? streakOffset(vRest, uG0, uD0, uAxis0, uN0, uBloom0, uRamp0, st0) : vec4(0.0);
  vec4 o1 = uOn1 > 0.5 && uBloom1 > 0.0 && vW.y > 0.0 ? streakOffset(vMid, uG1, uD1, uAxis1, uN1, uBloom1, uRamp1, st1) : vec4(0.0);
  float m0 = length(o0.xyz);
  float m1 = length(o1.xyz);
  vec3 s = vRest + (o0.xyz * m0 + o1.xyz * m1) / max(m0 + m1, 1e-5);
  // A cone pulled toward you reads, up its sides, ever closer to the pinched spot: taffy drawn out
  // of it, streaking into the tip on a long pull.
  // Only where the picture is fully shown: at the cone's rim it must still match passthrough.
  if (uOn0 > 0.5 && uTentBloom0 > 0.0) s = mix(s, uG0, uTentBloom0 * pow(vTent.x, 0.7) * smoothstep(0.02, 0.1, vW.x));
  if (uOn1 > 0.5 && uTentBloom1 > 0.0) s = mix(s, uG1, uTentBloom1 * pow(vTent.y, 0.7) * smoothstep(0.02, 0.1, vW.y));
  float st = max(st0, st1);
#endif
  // A squeezed zone reads the photo where it is drawn, which is what passthrough shows there,
  // so it fades into the real room without a seam.
  s = mix(s, vWorld, vMask.y);
  st *= 1.0 - vMask.y;
  float shown = max(smoothstep(0.002, 0.02, vMask.x), smoothstep(0.05, 0.2, st));
  // Where the surface barely moved, read the photo where it now sits too: the fade then crossfades
  // one picture with passthrough instead of two offset ones.
  vec3 sr = mix(vWorld, s, shown);
  float own = max(smoothstep(0.0, 0.01, vW.x), smoothstep(0.0, 0.01, vW.y));
#if defined(ENV_DEPTH) && !defined(LENS_OVERLAY)
  // Unmoved and unowned: nothing can show here (the alpha below is at most shown * own), so skip the
  // four projections. Most of the room is this, every frame the room is drawn.
  if (uOccDebug < 0.5 && shown * own < 0.002) {
    gl_FragColor = vec4(0.0);
    return;
  }
#endif

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
#ifdef BOX
  // A box is all photo: past both its frames it reads the nearest edge (below), never the real wall.
  float k0 = uHasPhoto0 * uFade0;
#else
  float k0 = max(c0, cf0) * uFade0;
#endif
  float k1 = max(c1, cf1) * uFade1;
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
  float occ = 0.0;
#ifdef BOX
  float refZ = -(viewMatrix * vec4(vRest, 1.0)).z;
#else
  float refZ = vViewZ;
#endif
  vec4 dbg = vec4(0.0);
  // Developer views draw wherever the room is, moved or not. Otherwise only moved points are tested.
  if (uOccDebug > 0.5) {
    occ = handOcclusion(vWorld, refZ, gate);
    dbg = occDebug(vWorld, occ, gate);
    if (alpha < 0.002 && dbg.a > 0.002) {
      writeColor(dbg.rgb, dbg.a);
      return;
    }
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
#ifdef BOX
  // Wider than its photo and its fill: the rest reads the photo's nearest edge, so it streaks out.
  if (k0 > 0.0 && p0.a < 0.999) {
    vec4 edge = photoTexel(uPhoto0, clamp(uv0, vec2(0.002), vec2(0.998)));
    p0 += vec4(edge.rgb * uGain0, edge.a) * (1.0 - p0.a);
  }
#endif
  vec4 p1 = k1 > 0.0 ? slotPicture(uPhoto1, uv1, c1, uFill1, fuv1, cf1, uGain1) : vec4(0.0);
  float w0 = uFade0 * (max(vW.x, 0.0) + OTHER_PHOTO);
  float w1 = uFade1 * (max(vW.y, 0.0) + OTHER_PHOTO);
  float cover = p0.a * w0 + p1.a * w1;
  vec3 col = (p0.rgb * w0 + p1.rgb * w1) / max(cover, 1e-7);
  alpha = shown * max(own * max(p0.a * uFade0, p1.a * uFade1), frost);
  // A cone's folds read as cloth even in a flat photo: valleys a little darker, ridges a little lighter.
  float creases = clamp((uOn0 > 0.5 ? vFold.x : 0.0) + (uOn1 > 0.5 ? vFold.y : 0.0), -1.0, 1.0);
  col *= 1.0 + 0.05 * max(creases, 0.0) - 0.18 * max(-creases, 0.0);
#ifdef ENV_DEPTH
  // Debug views paint the cut instead of cutting.
  if (uOccDebug < 0.5) {
    occ = handOcclusion(vWorld, refZ, gate);
    alpha *= 1.0 - occ;
  }
#endif
#ifdef PREVIEW
  col = cover > 1e-7 ? col : vec3(0.92);
#ifdef BOX
  col *= vShade;
#endif
  col = mix(back, col, alpha);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
#else
#ifdef BOX
  // Each face its own light, deeper darker: a flat photo still reads as a box.
  col *= vShade;
#endif
#ifdef ENV_DEPTH
  if (dbg.a > 0.0) {
    // Over the stretch, premultiplied: a debug colour over a masked hole stays its own colour.
    vec4 over = vec4(dbg.rgb * dbg.a, dbg.a) + vec4(col * alpha, alpha) * (1.0 - dbg.a);
    alpha = over.a;
    col = over.rgb / max(over.a, 1e-5);
  }
#endif
  writeColor(col, alpha);
#endif
}
`;

const DEPTH_VERTEX = /* glsl */ `
varying vec3 vRest;
void main() {
  vRest = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * vec4(vRest, 1.0);
}
`;

const DEPTH_FRAGMENT = /* glsl */ `
uniform float uBoxOn;
uniform vec3 uBoxC;
uniform vec4 uBoxU;
uniform vec4 uBoxV;
uniform vec3 uBoxN;
uniform float uBoxDepth;
varying vec3 vRest;
${BOX_HOLE}
void main() {
  if (inBoxOpening(vRest)) discard;
  gl_FragColor = vec4(0.0);
}
`;

/**
 * The room while a pushed-in box is all there is to draw: nothing moves and nothing shows, so it
 * only writes depth, for the box's rim and for whatever stands in front of it. A fraction of the
 * full program's cost, for a box that may stay in for minutes.
 */
export function roomDepthMaterial(uniforms: RubberUniformSet): ShaderMaterial {
  return new ShaderMaterial({
    uniforms,
    vertexShader: DEPTH_VERTEX,
    fragmentShader: DEPTH_FRAGMENT,
    name: 'jonze-room-depth',
    defines: { BOX_HOLE: '' },
    transparent: false,
    depthTest: true,
    depthWrite: true,
    side: DoubleSide,
    toneMapped: false,
  });
}

/** `hole` cuts a pushed-in box's opening out of the room; `box` is the box itself (push-box.ts). */
export type RubberVariant = 'room' | 'hole' | 'box';

/**
 * The scanned room, deformed in world space. Opaque on purpose: it writes premultiplied colour and
 * depth with blending off, so the nearest surface wins and alpha 0 shows passthrough.
 * `preview` adds the webcam backdrop for the desk stand-in; the headset program never samples video.
 */
export function rubberMaterial(uniforms: RubberUniformSet, preview = false, lensOverlay = false, variant: RubberVariant = 'room'): ShaderMaterial {
  const defines: Record<string, string> = {};
  if (preview) defines.PREVIEW = '';
  else defines.ENV_DEPTH = '';
  if (lensOverlay) defines.LENS_OVERLAY = '';
  if (variant === 'hole') defines.BOX_HOLE = '';
  if (variant === 'box') defines.BOX = '';
  const name = variant === 'box' ? 'jonze-push-box' : variant === 'hole' ? 'jonze-stretch-hole' : 'jonze-stretch';
  return new ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    name: preview ? `${name}-preview` : name,
    defines,
    transparent: false,
    depthTest: true,
    depthWrite: true,
    side: DoubleSide,
    toneMapped: false,
  });
}

/** Photos the void's shards can read: the most the bank has room for, picked to cover the room. */
export const VOID_VIEWS = 6;

/**
 * The fist's black hole (room-void.ts): where it opened, where the fist is now, the tear front and
 * its timeline, and the photos the flying shards wear. The hand cut is the room's own, shared.
 */
export function createVoidUniforms(room: RubberUniformSet) {
  return {
    /** 0 collapses every shard: off, or the two frames that only upload a new set. */
    uVoidOn: { value: 0 },
    /** Where the fist first closed: the front's centre. */
    uVoidO: { value: new Vector3() },
    /** The hole, inside the fist: where every shard flies to. */
    uHole: { value: new Vector3() },
    uHead: { value: new Vector3() },
    /** The spiral's axis, from the hole toward your head when the fist closed. */
    uSpin: { value: new Vector3(0, 0, 1) },
    // The tear front and its timeline (room-stretch-system.ts stepVoid).
    uRip: { value: 0 },
    uMark: { value: 0 },
    uDone: { value: 0 },
    uDrain: { value: 0 },
    /** The black past the scan, 0 to 1, once the last shard has gone. */
    uBackFade: { value: 0 },
    uView0: { value: null as Texture | null },
    uView1: { value: null as Texture | null },
    uView2: { value: null as Texture | null },
    uView3: { value: null as Texture | null },
    uView4: { value: null as Texture | null },
    uView5: { value: null as Texture | null },
    uViewToClip: { value: Array.from({ length: VOID_VIEWS }, () => new Matrix4()) },
    /** 1 for a view that is chosen and uploaded. */
    uViewOn: { value: new Array<number>(VOID_VIEWS).fill(0) },
    /** Each view's mean colour, linear: what a shard past its frame darkens toward. */
    uViewMean: { value: Array.from({ length: VOID_VIEWS }, () => new Vector3(0.2, 0.2, 0.2)) },
    uViewGain: { value: new Vector3(1, 1, 1) },
    /** `?voidcover=1`: photo red, fallback blue. */
    uCoverDebug: { value: 0 },
    uFeather: room.uFeather,
    uLinear: room.uLinear,
    uEnvDepth: room.uEnvDepth,
    uDepthOn: room.uDepthOn,
    uDepthRaw: room.uDepthRaw,
    uDepthNear: room.uDepthNear,
    uEyeSize: room.uEyeSize,
    uNormDepth0: room.uNormDepth0,
    uNormDepth1: room.uNormDepth1,
    uSegA: room.uSegA,
    uSegB: room.uSegB,
    uOccDebug: room.uOccDebug,
    uHandBall: room.uHandBall,
  };
}

export type VoidUniformSet = ReturnType<typeof createVoidUniforms>;

/** One photo of the six by index; a sampler can't be picked by a variable, so branch. */
const VIEW_SAMPLERS = /* glsl */ `
uniform sampler2D uView0;
uniform sampler2D uView1;
uniform sampler2D uView2;
uniform sampler2D uView3;
uniform sampler2D uView4;
uniform sampler2D uView5;
uniform mat4 uViewToClip[${VOID_VIEWS}];
uniform float uViewOn[${VOID_VIEWS}];
uniform vec3 uViewMean[${VOID_VIEWS}];
uniform vec3 uViewGain;
vec4 viewLod(int i, vec2 uv) {
  if (i == 0) return textureLod(uView0, uv, 0.0);
  if (i == 1) return textureLod(uView1, uv, 0.0);
  if (i == 2) return textureLod(uView2, uv, 0.0);
  if (i == 3) return textureLod(uView3, uv, 0.0);
  if (i == 4) return textureLod(uView4, uv, 0.0);
  return textureLod(uView5, uv, 0.0);
}
`;

const VOID_VERTEX = /* glsl */ `
attribute vec4 aShard;
uniform float uVoidOn;
uniform vec3 uVoidO;
uniform vec3 uHole;
uniform vec3 uHead;
uniform vec3 uSpin;
uniform float uRip;
uniform float uMark;
uniform float uDone;
uniform float uDrain;
uniform float uBackFade;
varying vec3 vRest;
varying float vViewZ;
#ifdef VOID_FLY
${VIEW_SAMPLERS}
varying vec4 vClipA;
varying vec4 vClipB;
/** The best view, the second (-1 for none), and how far along its trip the shard is. */
varying vec3 vPick;
/** The shard's own colour, linear: what it fades to as it flies fast and small. */
varying vec3 vFlat;
varying float vLight;
#endif

/** The front is ragged: each shard tears up to this much later than its distance says. */
const float JAG = 0.5;
/** Shards stay this far from your eyes: nothing flies through your face. */
const float HEAD_CLEAR = 0.35;

/**
 * How far along its trip a shard is: -1 untouched, 0 to 1 flying, 1 gone. Only the shard's centre,
 * seed and the uniforms go in, so all three corners of every triangle agree.
 */
float tripOf(vec4 shard) {
  float d = distance(shard.xyz, uVoidO) + shard.w * JAG;
  float span = 0.6 + 0.35 * d;
  if (d < uDone) return 1.0;
  if (d < uMark) return clamp((uMark - d) / span + uDrain, 0.0, 1.0);
  if (d < uRip) return clamp((uRip - d) / span, 0.0, 1.0);
  return -1.0;
}

vec3 turn(vec3 v, vec3 axis, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}

void main() {
#ifdef BACKSTOP
  // Fullscreen, at the far plane: only where nothing nearer was drawn (scan gaps, windows), and never
  // over the hands, whose occluders wrote depth first.
  vec4 clip = vec4(position.xy, 0.9999, 1.0);
  vec4 far = inverse(projectionMatrix * viewMatrix) * clip;
  vRest = far.xyz / far.w;
  vViewZ = -(viewMatrix * vec4(vRest, 1.0)).z;
  gl_Position = uBackFade > 0.0 ? clip : vec4(2.0, 2.0, 2.0, 1.0);
#else
  float trip = uVoidOn > 0.5 ? tripOf(aShard) : -2.0;
#if defined(VOID_REST)
#ifdef PREVIEW
  // The desk's stand-in room draws the untouched part itself.
  bool on = false;
#else
  bool on = trip > -1.5 && trip < 0.0;
#endif
#elif defined(VOID_TORN)
  bool on = trip >= 0.0;
#else
  bool on = trip >= 0.0 && trip < 1.0;
#endif
  vRest = position;
  if (!on) {
    vViewZ = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 world = position;
#ifdef VOID_FLY
  vec3 c = aShard.xyz;
  float seed = aShard.w;
  vec3 toHole = uHole - c;
  float span = length(toHole);
  vec3 dir = span > 1e-4 ? toHole / span : uSpin;
  // A peel first: it lifts off toward the hole (5 mm at once, so it never fights its own black),
  // then accelerates in along a spiral round the hole, closing as it goes.
  float run = clamp((trip - 0.1) / 0.9, 0.0, 1.0);
  float closing = run * run;
  vec3 lift = dir * (0.005 + 0.04 * smoothstep(0.0, 0.1, trip));
  vec3 q = uHole + turn((c + lift - uHole) * (1.0 - closing), uSpin, closing * (2.0 + 3.0 * seed) * 3.14159);
  vec3 fromHead = q - uHead;
  float headGap = length(fromHead);
  if (headGap < HEAD_CLEAR) q = uHead + (headGap > 1e-4 ? fromHead / headGap : -dir) * HEAD_CLEAR;
  // A shard nearing your head shrinks, so none fills your view; one nearing the hole shrinks into it.
  float nearer = clamp(length(q - uHead) / max(length(c - uHead), 1e-3), 0.0, 1.0);
  vec3 toGo = uHole - q;
  float left = length(toGo);
  vec3 heading = left > 1e-4 ? toGo / left : dir;
  float size = smoothstep(0.02, 0.25, left) * pow(nearer, 0.6);
  // Tumbling once it is clear of the wall, and drawn out along its flight as it speeds up.
  vec3 axis = normalize(fract(sin(vec3(seed * 91.3, seed * 47.7, seed * 13.1) + 1.0) * 43758.5453) - 0.5 + 1e-3);
  vec3 off = turn(position - c, axis, smoothstep(0.1, 0.3, trip) * trip * (4.0 + 8.0 * seed));
  off += heading * dot(off, heading) * (2.0 * trip);
  world = q + off * size;

  // Which photo it wears: the one whose frame holds the shard's centre deepest, and the runner-up.
  float best = -1.0;
  float bestM = -1e9;
  float second = -1.0;
  float secondM = -1e9;
  for (int k = 0; k < ${VOID_VIEWS}; k++) {
    if (uViewOn[k] < 0.5) continue;
    vec4 cc = uViewToClip[k] * vec4(c, 1.0);
    if (cc.w <= 1e-4) continue;
    vec2 uv = cc.xy / cc.w * 0.5 + 0.5;
    float m = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    if (m > bestM) {
      second = best;
      secondM = bestM;
      best = float(k);
      bestM = m;
    } else if (m > secondM) {
      second = float(k);
      secondM = m;
    }
  }
  vPick = vec3(best, second, trip);
  vClipA = vec4(0.0, 0.0, 0.0, -1.0);
  vClipB = vec4(0.0, 0.0, 0.0, -1.0);
  vLight = 0.9 + 0.2 * fract(seed * 7.13);
  vFlat = vec3(0.2) * (0.85 + 0.3 * fract(seed * 3.7));
  if (best > -0.5) {
    int ib = int(best + 0.5);
    vClipA = uViewToClip[ib] * vec4(position, 1.0);
    vec4 cc = uViewToClip[ib] * vec4(c, 1.0);
    vec4 t = viewLod(ib, clamp(cc.xy / cc.w * 0.5 + 0.5, vec2(0.002), vec2(0.998)));
    vFlat = t.rgb * uViewGain + uViewMean[ib] * 0.7 * (1.0 - t.a);
  }
  if (second > -0.5) vClipB = uViewToClip[int(second + 0.5)] * vec4(position, 1.0);
#endif
  vec4 viewPos = viewMatrix * vec4(world, 1.0);
  vViewZ = -viewPos.z;
  gl_Position = projectionMatrix * viewPos;
#endif
}
`;

const VOID_FRAGMENT = /* glsl */ `
uniform float uFeather;
uniform float uLinear;
uniform float uBackFade;
uniform float uCoverDebug;
varying vec3 vRest;
varying float vViewZ;
${DEPTH_CUT}
${PHOTO}
#ifdef VOID_FLY
${VIEW_SAMPLERS}
varying vec4 vClipA;
varying vec4 vClipB;
varying vec3 vPick;
varying vec3 vFlat;
varying float vLight;

vec4 viewTexel(int i, vec2 uv) {
  if (i == 0) return photoTexel(uView0, uv);
  if (i == 1) return photoTexel(uView1, uv);
  if (i == 2) return photoTexel(uView2, uv);
  if (i == 3) return photoTexel(uView3, uv);
  if (i == 4) return photoTexel(uView4, uv);
  return photoTexel(uView5, uv);
}
#endif

void main() {
#if defined(VOID_REST)
  // Untouched: passthrough shows, but the depth stays, so a wall not torn yet still hides what flies behind it.
  gl_FragColor = vec4(0.0);
#elif defined(VOID_FLY)
  vec3 col = vFlat;
  float covered = 0.0;
  if (vPick.x > -0.5) {
    int ia = int(vPick.x + 0.5);
    vec2 uv;
    float c = frameCover(vClipA, uv);
    vec4 a = c > 0.0 ? viewTexel(ia, uv) * c : vec4(0.0);
    if (a.a < 0.999 && vPick.y > -0.5) {
      vec2 uv2;
      float c2 = frameCover(vClipB, uv2);
      if (c2 > 0.0) a += viewTexel(int(vPick.y + 0.5), uv2) * (c2 * (1.0 - a.a));
    }
    covered = a.a;
    // Past every frame, or where a hand was masked out: the nearest photo's edge smeared on, over
    // its mean colour, so it streaks rather than showing a hole of real room.
    vec3 under = uViewMean[ia] * 0.7;
    if (a.a < 0.999 && vClipA.w > 1e-4) {
      vec4 edge = viewTexel(ia, clamp(vClipA.xy / vClipA.w * 0.5 + 0.5, vec2(0.002), vec2(0.998)));
      under = edge.rgb * uViewGain + under * (1.0 - edge.a);
    }
    col = a.rgb * uViewGain + under * (1.0 - a.a);
  }
  if (uCoverDebug > 0.5) col = mix(col, covered > 0.5 ? vec3(1.0, 0.1, 0.1) : vec3(0.1, 0.2, 1.0), 0.5);
  float trip = vPick.z;
  // Fast and small, a shard is its own colour (the photos have no mips to shimmer from), and it
  // darkens into the hole.
  col = mix(col, vFlat, smoothstep(0.4, 0.8, trip));
  col *= vLight * mix(1.0, 0.12, smoothstep(0.45, 1.0, trip));
#ifdef PREVIEW
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
#else
  // Always opaque: with blending off, any alpha under 1 would show the real room through the void.
  writeColor(col, 1.0);
#endif
#else
  // Torn, or the backstop: pitch black, except where a real hand stands in front.
#ifdef PREVIEW
#ifdef BACKSTOP
  if (uBackFade <= 0.0) discard;
#endif
  gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
#else
  float alpha = 1.0;
#ifdef BACKSTOP
  alpha = uBackFade;
#endif
  float gate = 0.0;
  float occ = handOcclusion(vRest, vViewZ, gate);
  writeColor(vec3(0.0), alpha * (1.0 - occ));
#endif
#endif
}
`;

/**
 * The void's four draws (room-void.ts). `rest`: untouched shards, depth only. `torn`: black where a
 * shard has left, depth test only so flying shards are never clipped by it. `fly`: the shards on
 * their way, opaque. `backstop`: black past the scan once the room has gone.
 */
export type VoidRole = 'rest' | 'torn' | 'fly' | 'backstop';

export function voidMaterial(uniforms: VoidUniformSet, preview: boolean, role: VoidRole): ShaderMaterial {
  const defines: Record<string, string> = {};
  if (preview) defines.PREVIEW = '';
  else if (role === 'torn' || role === 'backstop') defines.ENV_DEPTH = '';
  if (role === 'rest') defines.VOID_REST = '';
  if (role === 'torn' || role === 'backstop') defines.VOID_TORN = '';
  if (role === 'backstop') defines.BACKSTOP = '';
  if (role === 'fly') defines.VOID_FLY = '';
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: VOID_VERTEX,
    fragmentShader: VOID_FRAGMENT,
    name: `jonze-void-${role}${preview ? '-preview' : ''}`,
    defines,
    transparent: false,
    depthTest: true,
    depthWrite: role === 'rest' || role === 'fly',
    side: DoubleSide,
    toneMapped: false,
  });
  if (preview && role === 'torn') {
    // On the desk the stand-in room sits exactly where the black does.
    material.polygonOffset = true;
    material.polygonOffsetFactor = -1;
    material.polygonOffsetUnits = -4;
  } else if (!preview && (role === 'torn' || role === 'backstop')) {
    // Black layers that write no depth stack up: the most opaque one wins. A torn floor behind a torn
    // desk then can't cut the desk's hand-ring open, and the backstop fading in can only add black.
    // Still drawn with the opaque pass, in its render order.
    material.blending = CustomBlending;
    material.blendEquation = MaxEquation;
    material.blendEquationAlpha = MaxEquation;
  }
  return material;
}
