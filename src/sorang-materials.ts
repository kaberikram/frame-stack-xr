import {
  AdditiveBlending,
  DataArrayTexture,
  DoubleSide,
  NoBlending,
  ShaderMaterial,
  Vector2,
  Vector3,
  type Texture,
} from '@iwsdk/core';
// Same conventions as stack-materials.ts: three compiles these as GLSL ES 3.00 with its
// WebGL1-style defines, which keeps its multiview prefix working for the headset.
import { ORBIT_WRAP, SLICES } from './sorang-timeline.js';

/** Uniform objects shared by reference across Sorang's materials. Painting-local frame: +z toward the viewer. */
export function createSorangUniforms(photos: Texture) {
  return {
    uPaint: { value: null as Texture | null },
    uPhotos: { value: photos },
    uPhotoOn: { value: 0 },
    /** Half the painting's width and height, metres. */
    uHalf: { value: new Vector2(0.915, 0.915) },
    /** Tiles across, tiles up. */
    uGrid: { value: new Vector2(64, 64) },
    uShow: { value: 0 },
    /** Relief in metres: the look's depth times its clock. */
    uRelief: { value: 0 },
    uQuant: { value: 0 },
    uFan: { value: 0 },
    /** How far the nearest sheet fans toward the viewer, metres. */
    uSpan: { value: 0.6 },
    uRadial: { value: 0.5 },
    uScan: { value: SLICES + 10 },
    uBurst: { value: 0 },
    uDrift: { value: 0 },
    uDim: { value: 1 },
    uT: { value: 0 },
    uHeadL: { value: new Vector3(0, 0, 2.5) },
    uOrbitL: { value: new Vector3(0, 0, 1.5) },
    uFocusBack: { value: 1.5 },
    uReach: { value: 2.2 },
    uShell: { value: new Vector2(0.5, 2.8) },
    uShellH: { value: 1.2 },
    uSpin: { value: 0.25 },
    uContrast: { value: 0.9 },
    uChroma: { value: 0.35 },
    uScanGain: { value: 0.6 },
    uViewportH: { value: 1000 },
    uMinPx: { value: 1.25 },
    uOverscanPx: { value: 0.6 },
    uMaxPoint: { value: 16 },
    uDustSize: { value: 0.0035 },
    uFogStart: { value: 2.5 },
    uFog: { value: 0.25 },
  };
}
export type SorangUniforms = ReturnType<typeof createSorangUniforms>;

/** A 1×1×1 placeholder until the photo atlas lands. */
export function blankPhotos(): DataArrayTexture {
  const tex = new DataArrayTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, 1);
  tex.needsUpdate = true;
  return tex;
}

const COMMON = /* glsl */ `
  uniform vec2 uHalf;
  uniform vec2 uGrid;
  uniform float uShow;
  uniform float uRelief;
  uniform float uQuant;
  uniform float uFan;
  uniform float uSpan;
  uniform float uRadial;
  uniform float uScan;
  uniform float uBurst;
  uniform float uDrift;
  uniform float uDim;
  uniform float uT;
  uniform vec3 uHeadL;
  uniform vec3 uOrbitL;
  uniform float uFocusBack;
  uniform float uReach;
  uniform vec2 uShell;
  uniform float uShellH;
  uniform float uSpin;
  uniform float uViewportH;
  uniform float uFogStart;
  uniform float uFog;

  uint pcg(uint v) {
    uint state = v * 747796405u + 2891336453u;
    uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
  }
  // An independent stream per key, so no two uses of one particle's seed correlate.
  float rnd(uint id, uint key) { return float(pcg(id ^ pcg(key + 1u))) / 4294967295.0; }
  vec3 rndDir(uint id, uint key) {
    float z = rnd(id, key) * 2.0 - 1.0;
    float a = rnd(id, key + 100u) * 6.2831853;
    float r = sqrt(max(0.0, 1.0 - z * z));
    return vec3(r * cos(a), r * sin(a), z);
  }
  float window01(float x, float start, float len) { return clamp((x - start) / max(len, 1e-4), 0.0, 1.0); }
  void basis(vec3 n, out vec3 e1, out vec3 e2) {
    vec3 a = abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    e1 = normalize(cross(a, n));
    e2 = cross(n, e1);
  }
  // Angular frequency rounded to whole turns per wrap, so the orbit clock wraps seamlessly.
  float quantHz(float w) {
    float k = 6.2831853 / ${ORBIT_WRAP.toFixed(1)};
    return round(w / k) * k;
  }
  float fogAt(vec3 p) { return exp(-max(0.0, distance(p, uHeadL) - uFogStart) * uFog); }

  // Relief, then the snap onto 100 sheets, then the fan toward the viewer, near sheets first.
  // along < 1 places a dust point part-way, which smears depth edges into radial streaks.
  vec3 slicePos(vec2 xy, float sN, float d, float along, out float grow) {
    float zr = uRelief * mix(d, sN, uQuant);
    float fan = smoothstep(0.0, 1.0, window01(uFan, (1.0 - sN) * 0.4, 0.6));
    grow = 1.0 + along * zr * uRadial;
    return vec3(xy * grow, along * (zr + uSpan * sN * fan));
  }

  // Burst along rays from a point behind the centre (radial on screen), near sheets first,
  // then ease into a closed-form orbit around the viewer. Reform is the same curve backwards.
  vec3 particle(vec3 F, float sN, uint id, float hero, out float b, out float w) {
    vec3 dir = normalize(F + vec3(0.0, 0.0, uFocusBack));
    float reach = uReach * (0.35 + 0.65 * rnd(id, 2u)) * (0.6 + 0.4 * sN);
    float bt = window01(uBurst, (1.0 - sN) * 0.45 + 0.1 * rnd(id, 1u), 0.45);
    b = 1.0 - pow(1.0 - bt, 3.0);
    vec3 sc = rndDir(id, 3u) * 0.12 * reach;
    vec3 B = F + dir * reach * b + sc * b * b;
    w = smoothstep(0.0, 1.0, window01(uDrift, 0.4 * rnd(id, 6u), 0.6));
    // Not even computed before the drift: a NaN from the orbit maths times zero is still NaN.
    if (w <= 0.0) return B;
    vec3 Bend = F + dir * reach + sc;
    vec3 n = rndDir(id, 5u);
    vec3 e1;
    vec3 e2;
    basis(n, e1, e2);
    vec3 rel = Bend - uOrbitL;
    float h0 = dot(rel, n);
    vec3 q = rel - n * h0;
    float r0 = length(q);
    float th0 = r0 > 1e-5 ? atan(dot(q, e2), dot(q, e1)) : 0.0;
    float rT = mix(mix(uShell.x, uShell.y, pow(rnd(id, 7u), 0.6)), 0.7 + 0.5 * rnd(id, 8u), hero);
    float om = quantHz(sign(rnd(id, 12u) - 0.5) * uSpin * (0.5 + rnd(id, 14u)) / sqrt(max(rT, 0.4)));
    float wob = quantHz(0.3 + 0.4 * rnd(id, 9u));
    float r = mix(r0, rT, w) * (1.0 + 0.06 * w * sin(wob * uT + 6.2832 * rnd(id, 10u)));
    float h = mix(h0, (rnd(id, 11u) - 0.5) * uShellH, w) + 0.12 * w * sin(wob * uT + 6.2832 * rnd(id, 13u));
    float th = th0 + om * uT;
    vec3 O = uOrbitL + n * h + (e1 * cos(th) + e2 * sin(th)) * r;
    return mix(B, O, w);
  }

  float pxPerMetre(vec3 p) {
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    return 0.5 * uViewportH * projectionMatrix[1][1] / max(-mv.z, 1e-3);
  }
`;

/** Opaque black behind everything: the black world now, and over passthrough later. */
export function voidMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: /* glsl */ `
      void main() { gl_Position = vec4(position.xy * 2.0, 0.999, 1.0); }`,
    fragmentShader: /* glsl */ `
      void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); }`,
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
  });
}

/**
 * The mosaic. Each instance is one tile: flat, the tiles sample the painting at their own
 * sub-uv, so together they are the painting. As depth arrives they fan onto 100 sheets,
 * the stock photo shows through, and then they fly. Fades darken toward black, never alpha.
 */
export function tileMaterial(u: SorangUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: u,
    vertexShader: /* glsl */ `
      ${COMMON}
      uniform float uMinPx;
      uniform float uOverscanPx;
      uniform float uPhotoOn;
      uniform float uScanGain;
      attribute vec4 aTile; // i, j, slice, photo layer
      attribute vec4 aInfo; // equalised depth, photo mean, hero
      varying vec2 vPaintUv;
      varying vec2 vLocal;
      varying vec3 vLook; // photo reveal, gain, scan glow
      flat varying float vLayer;
      flat varying float vPhotoMean;
      void main() {
        uint id = uint(aTile.y * uGrid.x + aTile.x + 0.5);
        float sN = (aTile.z + 0.5) / ${SLICES.toFixed(1)};
        vec2 xy = ((aTile.xy + 0.5) / uGrid - 0.5) * 2.0 * uHalf;
        float grow;
        vec3 F = slicePos(xy, sN, aInfo.x, 1.0, grow);
        F.z += 1e-4 * rnd(id, 15u);
        float b;
        float w;
        vec3 P = particle(F, sN, id, aInfo.z, b, w);

        float tileM = 2.0 * uHalf.x / uGrid.x;
        float flySize = mix(0.6 + 0.4 * rnd(id, 4u), 3.0, aInfo.z);
        float size = tileM * grow * mix(1.0, flySize, w) * smoothstep(0.10, 0.35, distance(P, uHeadL));

        // A card in the painting's plane that turns to face the viewer as it flies, with a little roll.
        float turn = max(0.7 * b, w);
        vec3 toHead = uHeadL - P;
        float headDist = length(toHead);
        vec3 face = headDist > 1e-4 ? toHead / headDist : vec3(0.0, 0.0, 1.0);
        vec3 nrm = mix(vec3(0.0, 0.0, 1.0), face, turn);
        nrm = dot(nrm, nrm) > 1e-8 ? normalize(nrm) : vec3(0.0, 0.0, 1.0);
        vec3 ax = cross(vec3(0.0, 1.0, 0.0), nrm);
        ax = dot(ax, ax) > 1e-6 ? normalize(ax) : vec3(1.0, 0.0, 0.0);
        vec3 ay = cross(nrm, ax);
        float roll = (rnd(id, 0u) - 0.5) * 1.6 * turn;
        vec3 rx = ax * cos(roll) + ay * sin(roll);
        vec3 ry = ay * cos(roll) - ax * sin(roll);

        float ppm = pxPerMetre(P);
        float minM = uMinPx / ppm;
        float drawn = max(size, minM) + uOverscanPx / ppm;
        float energy = clamp(size / minM, 0.0, 1.0);
        vec3 corner = P + (rx * position.x + ry * position.y) * drawn;
        // The overscan samples the neighbour's painting pixels, so flat tiles meet with no seam.
        vLocal = 0.5 + position.xy * drawn / max(size, 1e-6);
        vPaintUv = (aTile.xy + vLocal) / uGrid;
        vLayer = aTile.w;
        vPhotoMean = aInfo.y;

        float reveal = uPhotoOn * clamp((aTile.z - uScan + 4.0 * rnd(id, 16u)) / 6.0, 0.0, 1.0);
        float sheetShade = mix(1.0, mix(0.72, 1.0, sN), uFan * (1.0 - b));
        float gain = uShow * mix(1.0, uDim, w) * sheetShade * fogAt(P) * energy * energy;
        float glow = uScanGain * exp(-pow((aTile.z - uScan) / 2.5, 2.0)) * (1.0 - b);
        vLook = vec3(reveal, gain, glow * gain);

        gl_Position = projectionMatrix * modelViewMatrix * vec4(corner, 1.0);
        if (size <= 1e-5 || uShow <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision highp sampler2DArray;
      uniform sampler2D uPaint;
      uniform sampler2DArray uPhotos;
      uniform float uContrast;
      uniform float uChroma;
      varying vec2 vPaintUv;
      varying vec2 vLocal;
      varying vec3 vLook;
      flat varying float vLayer;
      flat varying float vPhotoMean;
      float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
      void main() {
        vec3 P = texture(uPaint, vPaintUv).rgb;
        // Sampled outside any branch, so the photo's mip level comes from smooth derivatives.
        vec2 q = clamp(vLocal, 0.0, 1.0);
        vec3 S = texture(uPhotos, vec3(q.x, 1.0 - q.y, vLayer)).rgb; // atlas rows are stored top-down
        float lP = luma(P);
        float lS = luma(S);
        float lp = sqrt(lP);
        // Photo detail rides on the painting's brightness, most in the mid-greys.
        float l = clamp(lp + (sqrt(lS) - vPhotoMean) * uContrast * mix(0.3, 1.0, 4.0 * lp * (1.0 - lp)), 0.0, 1.0);
        vec3 hueP = P / max(lP, 0.02);
        vec3 hueS = min(S / max(lS, 0.02), vec3(3.0));
        vec3 tint = clamp(mix(hueP, hueS, uChroma) * l * l, 0.0, 1.0);
        vec3 col = mix(P, tint, vLook.x) * (vLook.y + vLook.z) * (gl_FrontFacing ? 1.0 : 0.55);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
    side: DoubleSide,
    blending: NoBlending,
    depthWrite: true,
    depthTest: true,
  });
}

/** Fine dust: radial streaks while the relief grows, then the small particles of the orbit. */
export function dustMaterial(u: SorangUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: u,
    vertexShader: /* glsl */ `
      ${COMMON}
      uniform float uMaxPoint;
      uniform float uDustSize;
      attribute vec2 aDust; // slice, equalised depth
      varying vec2 vUv;
      varying float vGain;
      void main() {
        uint id = uint(gl_VertexID) + 7919u * 4096u;
        float sN = (aDust.x + 0.5) / ${SLICES.toFixed(1)};
        vec2 xy = (position.xy - 0.5) * 2.0 * uHalf;
        float grow;
        vec3 F = slicePos(xy, sN, aDust.y, sqrt(rnd(id, 17u)), grow);
        F.z -= 0.001; // just behind the tiles, so the flat painting hides it
        float b;
        float w;
        vec3 P = particle(F, sN, id, 0.0, b, w);
        float px = uDustSize * pxPerMetre(P) * mix(1.0, 0.6 + 0.8 * rnd(id, 18u), w);
        float vis = smoothstep(0.02, 0.12, uRelief) * uShow;
        vUv = position.xy;
        vGain = vis * min(1.0, px * px) * fogAt(P) * mix(1.0, uDim, w);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(P, 1.0);
        if (vis <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = clamp(px, 1.0, uMaxPoint);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uPaint;
      varying vec2 vUv;
      varying float vGain;
      void main() {
        vec3 col = textureLod(uPaint, vUv, 2.0).rgb * vGain * 1.1;
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
    blending: NoBlending,
    depthWrite: true,
    depthTest: true,
  });
}

/** The faint straight lines of the orbit: pairs of tiles, black until the pieces drift. */
export function linkMaterial(u: SorangUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: u,
    vertexShader: /* glsl */ `
      ${COMMON}
      attribute vec4 aTile;
      attribute vec4 aInfo;
      varying float vGain;
      void main() {
        uint id = uint(aTile.y * uGrid.x + aTile.x + 0.5);
        float sN = (aTile.z + 0.5) / ${SLICES.toFixed(1)};
        vec2 xy = ((aTile.xy + 0.5) / uGrid - 0.5) * 2.0 * uHalf;
        float grow;
        vec3 F = slicePos(xy, sN, aInfo.x, 1.0, grow);
        float b;
        float w;
        vec3 P = particle(F, sN, id, aInfo.z, b, w);
        vGain = 0.08 * w * uShow * uDim * fogAt(P);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(P, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying float vGain;
      void main() {
        gl_FragColor = vec4(vec3(0.85) * vGain, 1.0);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: true,
  });
}
