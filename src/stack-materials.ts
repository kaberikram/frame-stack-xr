import { Color, DoubleSide, NormalBlending, ShaderMaterial, Vector2, type Texture } from '@iwsdk/core';
// three compiles these as GLSL ES 3.00 with its WebGL1-style defines (varying, gl_FragColor),
// which also keeps its multiview prefix working for the headset.
import { UNIT } from './layout.js';

// Soft rectangular mask: each side dissolves independently so corners go first, like a dream vignette.
const FEATHER = /* glsl */ `
float edgeFeather(vec2 u, float w) {
  if (w <= 1e-4) return 1.0;
  float fx = smoothstep(0.0, w, min(u.x, 1.0 - u.x));
  float fy = smoothstep(0.0, w, min(u.y, 1.0 - u.y));
  return pow(fx * fy, 0.65);
}
`;

/** Uniform objects shared by reference across the stack's materials. */
export function createStackUniforms(frames: Texture) {
  return {
    frames: { value: frames },
    n: { value: 1 },
    loaded: { value: 0 },
    split: { value: 0 },
    z0: { value: 0 },
    spacing: { value: 0 },
    cur: { value: 0 },
    focus: { value: 0 },
    ghost: { value: 0 },
    peak: { value: 0.5 },
    spread: { value: 4 },
    lift: { value: 0 },
    feather: { value: 0.16 },
    glow: { value: 0.65 },
    haloColor: { value: new Color() },
    haloStrength: { value: 0 },
    haloHalf: { value: new Vector2(1, 1) },
    haloReach: { value: 0.018 },
    half: { value: new Vector2(1, 1) },
    floorR: { value: 1 },
  };
}
export type StackUniforms = ReturnType<typeof createStackUniforms>;

/**
 * Every slice in one instanced draw. Each side of the viewer is drawn from the
 * far end inward, so the two halves never paint over the middle. Opacity is the
 * same on both sides: ghost plus the trail around the current frame.
 */
export function ghostMaterial(u: StackUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uFrames: u.frames,
      uN: u.n,
      uSplit: u.split,
      uZ0: u.z0,
      uSpacing: u.spacing,
      uCur: u.cur,
      uLoaded: u.loaded,
      uFocus: u.focus,
      uGhost: u.ghost,
      uPeak: u.peak,
      uSpread: u.spread,
      uLift: u.lift,
      uFeather: u.feather,
    },
    vertexShader: /* glsl */ `
      uniform float uN;
      uniform float uSplit;
      uniform float uZ0;
      uniform float uSpacing;
      varying vec2 vUv;
      flat varying float vLayer;
      void main() {
        float drawIdx = float(gl_InstanceID);
        float layer = drawIdx < uSplit ? drawIdx : uN - 1.0 - (drawIdx - uSplit);
        vLayer = layer;
        vUv = uv;
        vec3 p = position;
        p.z += uZ0 - layer * uSpacing;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision highp sampler2DArray;
      uniform sampler2DArray uFrames;
      uniform float uCur;
      uniform float uLoaded;
      uniform float uFocus;
      uniform float uGhost;
      uniform float uPeak;
      uniform float uSpread;
      uniform float uLift;
      uniform float uFeather;
      varying vec2 vUv;
      flat varying float vLayer;
      ${FEATHER}
      void main() {
        float rel = vLayer - uCur;
        if (vLayer >= uLoaded) discard;
        // Same plane as the sharp frame would flicker. Once it lifts, keep a slice in the slot.
        if (abs(rel) < 0.5 && uLift < 0.02) discard;
        float onion = uPeak * exp(-pow(abs(vLayer - uFocus) / max(uSpread, 0.001), 2.0)) * step(0.5, uSpread);
        float a = max(uGhost, onion);
        a *= edgeFeather(vUv, uFeather);
        if (a < 0.003) discard;
        vec3 rgb = texture(uFrames, vec3(vUv.x, 1.0 - vUv.y, vLayer)).rgb; // canvas rows are stored top-down
        gl_FragColor = vec4(rgb, a);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: NormalBlending,
  });
}

/**
 * The current frame. Additive glow reads beautifully on a black stage but washes
 * out over a real room, so it's alpha-blended and brightened instead.
 */
export function currentMaterial(u: StackUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uFrames: u.frames, uCur: u.cur, uGlow: u.glow, uFeather: u.feather },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision highp sampler2DArray;
      uniform sampler2DArray uFrames;
      uniform float uCur;
      uniform float uGlow;
      uniform float uFeather;
      varying vec2 vUv;
      ${FEATHER}
      void main() {
        vec3 rgb = texture(uFrames, vec3(vUv.x, 1.0 - vUv.y, uCur)).rgb;
        float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
        vec3 lit = rgb * (1.0 + uGlow * 0.3) + rgb * smoothstep(0.35, 0.8, luma) * (uGlow * 0.45);
        float a = edgeFeather(vUv, uFeather);
        if (a < 0.003) discard;
        gl_FragColor = vec4(min(lit, vec3(1.0)), a);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: NormalBlending,
  });
}

/** Stands in for bloom, which XR can't afford: a soft spill in the current frame's own average colour. */
export function haloMaterial(u: StackUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uColor: u.haloColor, uStrength: u.haloStrength, uHalf: u.haloHalf, uReach: u.haloReach },
    vertexShader: /* glsl */ `
      uniform vec2 uHalf;
      uniform float uReach;
      varying vec2 vPos;
      void main() {
        vPos = position.xy * 2.0 * (uHalf + vec2(uReach * 4.0));
        gl_Position = projectionMatrix * modelViewMatrix * vec4(vPos, 0.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uStrength;
      uniform vec2 uHalf;
      uniform float uReach;
      varying vec2 vPos;
      void main() {
        vec2 q = abs(vPos) - uHalf;
        float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
        float a = uStrength * exp(-max(d, 0.0) / uReach);
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor, a);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: NormalBlending,
  });
}

/** Dot grid plus a soft contact shadow, drawn on the real table under the stack. */
export function floorMaterial(u: StackUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uHalf: u.half,
      uFloorR: u.floorR,
      uGap: { value: 0.1 * UNIT },
      uDotR: { value: 0.0011 },
      uDotColor: { value: new Color('#8B92A3') },
      uDotA: { value: 0.7 },
      uShadowColor: { value: new Color('#000000') },
      uShadowA: { value: 0.45 },
      uUnit: { value: UNIT },
    },
    vertexShader: /* glsl */ `
      uniform float uFloorR;
      varying vec2 vPos;
      void main() {
        vec3 p = position * vec3(uFloorR * 2.0, 1.0, uFloorR * 2.0);
        vPos = p.xz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec2 uHalf;
      uniform float uFloorR;
      uniform float uGap;
      uniform float uDotR;
      uniform vec3 uDotColor;
      uniform float uDotA;
      uniform vec3 uShadowColor;
      uniform float uShadowA;
      uniform float uUnit;
      varying vec2 vPos;
      void main() {
        vec2 g = vPos / uGap;
        float dist = length((g - floor(g + 0.5)) * uGap);
        float aa = max(fwidth(dist), 1e-6);
        float dots = 1.0 - smoothstep(uDotR - aa, uDotR + aa, dist);
        vec2 gfw = fwidth(g);
        dots *= 1.0 - smoothstep(0.12, 0.3, max(gfw.x, gfw.y)); // fade before dots alias into moiré
        dots *= (1.0 - smoothstep(uFloorR * 0.3, uFloorR, length(vPos))) * uDotA;
        vec2 q = abs(vPos) - uHalf;
        float rectDist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
        float shadow = (1.0 - smoothstep(-0.1 * uUnit, 0.55 * uUnit, rectDist)) * uShadowA;
        float a = max(dots, shadow);
        if (a < 0.003) discard;
        gl_FragColor = vec4(mix(uShadowColor, uDotColor, dots / max(dots + shadow, 1e-4)), a);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
  });
}

/**
 * A flat disc on the table: soft shadow (inner 0), ring (inner > 0) or, with
 * uProgress < 1, a ring that fills clockwise from the far side.
 * Use with a unit quad lying in XZ.
 */
export function discMaterial(color: string, inner: number, soft: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(color) },
      uOpacity: { value: 1 },
      uInner: { value: inner },
      uSoft: { value: soft },
      uProgress: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vPos;
      void main() {
        vPos = vec2(position.x, -position.z) * 2.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uInner;
      uniform float uSoft;
      uniform float uProgress;
      varying vec2 vPos;
      void main() {
        float r = length(vPos);
        float a = 1.0 - smoothstep(1.0 - uSoft, 1.0, r);
        if (uInner > 0.0) a *= smoothstep(uInner - uSoft, uInner, r);
        if (uProgress < 1.0) {
          float turn = atan(vPos.x, vPos.y) / 6.2831853;
          if (turn < 0.0) turn += 1.0;
          a *= turn <= uProgress ? 1.0 : 0.22;
        }
        a *= uOpacity;
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor, a);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
  });
}
