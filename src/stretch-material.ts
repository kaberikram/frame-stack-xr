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
    uRamp: { value: 0.35 },
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
  };
}

export type RubberUniformSet = ReturnType<typeof createRubberUniforms>;

/**
 * The taffy band, shared by both stages so the streaks always sit exactly where the mesh stretched.
 * Needs uReach and uRamp declared above it.
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
float taffyBehind(float t) {
  return 1.0 - ease(min(-t / max(uRamp, 1e-3), 1.0));
}
`;

const VERTEX = /* glsl */ `
uniform vec3 uG0; uniform vec3 uD0; uniform vec3 uAxis0; uniform vec3 uN0; uniform vec3 uLift0;
uniform float uA0; uniform float uE0; uniform float uB0; uniform float uRip0; uniform float uOn0;
uniform vec3 uG1; uniform vec3 uD1; uniform vec3 uAxis1; uniform vec3 uN1; uniform vec3 uLift1;
uniform float uA1; uniform float uE1; uniform float uB1; uniform float uRip1; uniform float uOn1;
uniform float uReach;
uniform float uRamp;
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
           vec3 G, vec3 D, vec3 axis, vec3 n, vec3 lift, float A, float E, float B, float rip) {
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
    along = taffyBehind(t);
    belly = sin(3.14159265 * min(-t / max(uRamp, 1e-3), 1.0));
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
  if (uOn0 > 0.5) pinch(p, seen, hide, own0, uG0, uD0, uAxis0, uN0, uLift0, uA0, uE0, uB0, uRip0);
  vMid = p;
  if (uOn1 > 0.5) pinch(p, seen, hide, own1, uG1, uD1, uAxis1, uN1, uLift1, uA1, uE1, uB1, uRip1);
  vRest = rest;
  vWorld = p;
  vMask = vec2(seen * (1.0 - smoothstep(0.6, 1.0, hide)), ease(hide));
  vW = vec2(own0, own1);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
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
uniform float uFade0;
uniform float uFade1;
uniform float uAnyPhoto;
uniform float uFeather;
uniform float uLinear;
uniform vec3 uG0; uniform vec3 uD0; uniform vec3 uAxis0; uniform vec3 uN0; uniform float uOn0; uniform float uBloom0;
uniform vec3 uG1; uniform vec3 uD1; uniform vec3 uAxis1; uniform vec3 uN1; uniform float uOn1; uniform float uBloom1;
uniform float uReach;
uniform float uRamp;
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

${SHARED}

/** How much a moved point leans on the other grab's photo where its own covers it too. */
const float OTHER_PHOTO = 0.02;

/** Full streaks squeeze the photo 16x toward the pinch: long stripes that still vary, never one texel row. */
const float STREAK_LOG2 = 4.0;

/**
 * Moves the photo lookup 's' toward the grabbed column for the part of the band behind the pinch,
 * by how far this grab's streaks have bloomed. Squeezing by 'keep' (0 < keep <= 1) never folds the
 * picture. Returns how streaked this point is.
 */
float streakTo(inout vec3 s, vec3 base, vec3 G, vec3 D, vec3 axis, vec3 n, float bloom) {
  vec3 q = base - G;
  float t = dot(q, axis);
  if (t >= 0.0) return 0.0;
  float w = taffySide(q, t, axis, length(D)) * taffyBehind(t) * taffyFlat(dot(q, n));
  float keep = exp2(-STREAK_LOG2 * bloom * ease(2.0 * w));
  s -= axis * (t * (1.0 - keep));
  return 1.0 - keep;
}

float frameCover(vec4 clip, out vec2 uv) {
  uv = clip.xy / max(clip.w, 1e-4) * 0.5 + 0.5;
  if (clip.w <= 1e-4 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  return smoothstep(0.0, max(uFeather, 1e-4), edge);
}

/**
 * The photos are SRGBColorSpace textures, stored as SRGB8_ALPHA8, so the sampler already returns
 * linear light. Decoding again crushed every photo to a flat grey. textureLod needs no derivatives.
 */
vec3 photo(sampler2D tex, vec2 uv, vec3 gain) {
  return textureLod(tex, uv, 0.0).rgb * gain;
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
    if (!inside || stripe < 0.5) {
      gl_FragColor = vec4(0.0);
      return;
    }
    writeColor(sRGBTransferEOTF(texture(uLive, luv)).rgb, 1.0);
    return;
  }
#endif

  // Where the photo is read. The texture rides the surface (rest position) and the streaks pull it
  // toward the grabbed column, per pixel so it is exact on any triangle.
  vec3 s = vRest;
  float st = 0.0;
  if (uOn0 > 0.5 && uBloom0 > 0.0 && vW.x > 0.0) st = streakTo(s, vRest, uG0, uD0, uAxis0, uN0, uBloom0);
  if (uOn1 > 0.5 && uBloom1 > 0.0 && vW.y > 0.0) st = max(st, streakTo(s, vMid, uG1, uD1, uAxis1, uN1, uBloom1));
  // A squeezed zone reads the photo where it is drawn, which is what passthrough shows there,
  // so it fades into the real room without a seam.
  s = mix(s, vWorld, vMask.y);
  st *= 1.0 - vMask.y;
  float shown = max(smoothstep(0.003, 0.03, vMask.x), smoothstep(0.05, 0.2, st));
  // Where the surface barely moved, read the photo where it now sits too: the fade then crossfades
  // one picture with passthrough instead of two offset ones.
  vec3 sr = mix(vWorld, s, shown);

  vec2 uv0;
  vec2 uv1;
  float c0 = uHasPhoto0 * frameCover(uWorldToClip0 * vec4(sr, 1.0), uv0);
  float c1 = uHasPhoto1 * frameCover(uWorldToClip1 * vec4(sr, 1.0), uv1);
  // Streaks read the grabbed column, so they skip the test for surfaces the camera saw edge-on.
  float streaked = step(0.5, st);
  c0 *= max(step(0.0, dot(nr, uCamPos0 - vRest)), streaked);
  c1 *= max(step(0.0, dot(nr, uCamPos1 - vRest)), streaked);

  // Both frozen photos are pictures of the same still room, so a moved point may read either one.
  // Its own grab's photo leads; the other takes over where the first runs off its frame.
  float k0 = c0 * uFade0;
  float k1 = c1 * uFade1;
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
  // Unmoved surfaces stay real. Depth is still written so a nearer surface wins.
  if (alpha < 0.002) {
    gl_FragColor = vec4(0.0);
    return;
  }
#endif

  float w0 = k0 * (max(vW.x, 0.0) + OTHER_PHOTO);
  float w1 = k1 * (max(vW.y, 0.0) + OTHER_PHOTO);
  vec3 col = vec3(0.0);
  if (w0 > 0.0) col += photo(uPhoto0, uv0, uGain0) * w0;
  if (w1 > 0.0) col += photo(uPhoto1, uv1, uGain1) * w1;
#ifdef PREVIEW
  col = w0 + w1 > 1e-7 ? col / (w0 + w1) : vec3(0.92);
  col = mix(back, col, alpha);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
#else
  writeColor(col / max(w0 + w1, 1e-7), alpha);
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
