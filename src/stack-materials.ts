import {
  AdditiveBlending,
  Color,
  DataTexture,
  DoubleSide,
  LinearFilter,
  LinearSRGBColorSpace,
  NormalBlending,
  ShaderMaterial,
  Vector2,
  type Texture,
} from '@iwsdk/core';
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
        float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
        // A small lift so midtones hold against a bright room. Still well under the focused frame.
        vec3 lit = rgb * 1.18 + rgb * smoothstep(0.3, 0.85, luma) * 0.22;
        gl_FragColor = vec4(lit, a);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: NormalBlending,
  });
}

/**
 * The selected frame. Brightened like the browser version, then drawn with
 * premultiplied alpha so the feather fades onto whatever is behind it.
 * Additive blending cannot show the dark parts of a photo, so those were
 * reading as a black fade.
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
        vec3 lit = rgb * (1.0 + uGlow * 0.72) + rgb * smoothstep(0.35, 0.8, luma) * (uGlow * 0.95);
        float a = edgeFeather(vUv, uFeather);
        if (a < 0.003) discard;
        gl_FragColor = vec4(lit, a);
        #include <colorspace_fragment>
        gl_FragColor.rgb *= gl_FragColor.a;
      }`,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: NormalBlending,
    premultipliedAlpha: true,
  });
}

/**
 * Stands in for the browser version's bloom. The spill is masked by the same
 * edge feather as the slice, so it dies at the corners instead of filling the quad.
 */
export function haloMaterial(u: StackUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uColor: u.haloColor,
      uStrength: u.haloStrength,
      uHalf: u.haloHalf,
      uReach: u.haloReach,
      uFeather: u.feather,
    },
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
      uniform float uFeather;
      varying vec2 vPos;
      ${FEATHER}
      void main() {
        vec2 uv = clamp(vPos / (uHalf * 2.0) + 0.5, 0.0, 1.0);
        float vignette = edgeFeather(uv, uFeather);
        vec2 q = abs(vPos) - uHalf;
        float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
        float a = uStrength * vignette * exp(-max(d, 0.0) / max(uReach, 1e-4));
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor, a);
        #include <colorspace_fragment>
        gl_FragColor.rgb *= gl_FragColor.a;
      }`,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    premultipliedAlpha: true,
  });
}

/**
 * The pinched frame, enlarged. A flat photo until depth arrives, then the grid
 * pushes near pixels toward the viewer and grows them, so the picture stretches
 * instead of sitting as a flat card. High depth values are near.
 */
export function reliefMaterial(): ShaderMaterial {
  const depth = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  depth.colorSpace = LinearSRGBColorSpace;
  depth.magFilter = LinearFilter;
  depth.minFilter = LinearFilter;
  depth.generateMipmaps = false;
  depth.flipY = true;
  depth.needsUpdate = true;
  return new ShaderMaterial({
    uniforms: {
      uPhoto: { value: null as Texture | null },
      uDepth: { value: depth },
      uTexel: { value: new Vector2(1, 1) },
      uRelief: { value: 0 },
      uHasDepth: { value: 0 },
      uDepthAmt: { value: 0.62 },
      uFeather: { value: 0.08 },
    },
    vertexShader: /* glsl */ `
      uniform sampler2D uDepth;
      uniform vec2 uTexel;
      uniform float uRelief;
      uniform float uHasDepth;
      uniform float uDepthAmt;
      varying vec2 vUv;
      float raw(vec2 q) { return texture(uDepth, clamp(q, vec2(0.001), vec2(0.999))).r; }
      float depthAt(vec2 q) {
        vec2 r = uTexel * 4.5;
        float s = raw(q) * 4.0;
        s += (raw(q + vec2(r.x, 0.0)) + raw(q - vec2(r.x, 0.0)) + raw(q + vec2(0.0, r.y)) + raw(q - vec2(0.0, r.y))) * 2.0;
        s += raw(q + r) + raw(q - r) + raw(q + vec2(r.x, -r.y)) + raw(q - vec2(r.x, -r.y));
        return s / 16.0;
      }
      void main() {
        vUv = uv;
        vec3 p = position;
        if (uHasDepth > 0.5) {
          float z = (depthAt(uv) - 0.5) * uDepthAmt * uRelief;
          p.z += z;
          p.xy *= 1.0 + z * 0.7;
        }
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uPhoto;
      uniform float uFeather;
      varying vec2 vUv;
      ${FEATHER}
      void main() {
        vec3 rgb = texture(uPhoto, vUv).rgb;
        float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
        vec3 lit = rgb * 1.15 + rgb * smoothstep(0.35, 0.8, luma) * 0.2;
        float a = edgeFeather(vUv, uFeather);
        if (a < 0.003) discard;
        gl_FragColor = vec4(lit, a);
        #include <colorspace_fragment>
        gl_FragColor.rgb *= gl_FragColor.a;
      }`,
    transparent: true,
    depthWrite: true,
    side: DoubleSide,
    blending: NormalBlending,
    premultipliedAlpha: true,
  });
}

/** Soft contact shadow under the stack, drawn on the real table. */
export function floorMaterial(u: StackUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uHalf: u.half,
      uFloorR: u.floorR,
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
      uniform vec3 uShadowColor;
      uniform float uShadowA;
      uniform float uUnit;
      varying vec2 vPos;
      void main() {
        vec2 q = abs(vPos) - uHalf;
        float rectDist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
        float shadow = (1.0 - smoothstep(-0.1 * uUnit, 0.55 * uUnit, rectDist)) * uShadowA;
        if (shadow < 0.003) discard;
        gl_FragColor = vec4(uShadowColor, shadow);
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
