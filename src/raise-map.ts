import {
  BufferAttribute,
  BufferGeometry,
  HalfFloatType,
  Matrix4,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  RedFormat,
  Scene,
  ShaderMaterial,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type Object3D,
  type WebGLRenderer,
} from '@iwsdk/core';
import type { EnvDepth } from './env-depth.js';
import { SEGMENTS } from './hand-occluder.js';

/**
 * The scan is this far behind the headset's depth, at most, where an unscanned object stands in
 * front of it; and at least, so depth noise on a scanned surface never lifts it.
 */
export const RAISE_MIN = 0.03;
export const RAISE_MAX = 0.8;
/** Raise map size: about 0.4° a texel, a centimetre at arm's length. */
const SIZE = 256;
/** Depth farther than this is left alone: too coarse to be worth raising to. */
const RAISE_FAR = 6;
/** Depth texels this close to a hand segment (past its own radius) belong to the hand. */
const HAND_CLEAR = 0.05;
/** A hand texel looks this many steps of 2 texels along each of 8 directions for what is behind it. */
const FILL_STEPS = 48;

const COPY_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const COPY_FRAGMENT = /* glsl */ `
uniform highp sampler2DArray uEnvDepth;
uniform float uDepthRaw;
uniform float uDepthNear;
uniform mat4 uViewFromDepth;
uniform mat4 uInvProjection;
uniform mat4 uEyeWorld;
uniform vec4 uSegA[${SEGMENTS}];
uniform vec4 uSegB[${SEGMENTS}];
varying vec2 vUv;

float meters(vec2 uv) {
  float t = textureLod(uEnvDepth, vec3(uv, 0.0), 0.0).r;
  return uDepthRaw * uDepthNear / max(1.0 - t, 1e-5);
}

float segmentDistance(vec3 p, vec3 a, vec3 b) {
  vec3 ab = b - a;
  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0);
  return length(p - (a + ab * t));
}

void main() {
  // The nearest of five taps half a texel apart, as the hand cut reads it: a hand's edge stays the hand.
  vec2 texel = 0.5 / vec2(textureSize(uEnvDepth, 0).xy);
  float m = meters(vUv);
  m = min(m, meters(vUv + vec2(texel.x, 0.0)));
  m = min(m, meters(vUv - vec2(texel.x, 0.0)));
  m = min(m, meters(vUv + vec2(0.0, texel.y)));
  m = min(m, meters(vUv - vec2(0.0, texel.y)));
  if (m < ${RAISE_MIN.toFixed(3)} * 4.0 || m > ${RAISE_FAR.toFixed(1)}) {
    gl_FragColor = vec4(0.0);
    return;
  }
  // Where this texel is in the world: its view ray, out to the measured depth.
  vec2 viewUv = (uViewFromDepth * vec4(vUv, 0.0, 1.0)).xy;
  vec4 onRay = uInvProjection * vec4(viewUv * 2.0 - 1.0, 0.0, 1.0);
  vec3 ray = onRay.xyz / onRay.w;
  vec3 world = (uEyeWorld * vec4(ray * (m / max(-ray.z, 1e-5)), 1.0)).xyz;
  // Hands and forearms are not furniture: the pinching hand sits right on the grabbed surface.
  // Marked -1, unknown, for the fill pass to take from around it.
  for (int i = 0; i < ${SEGMENTS}; i++) {
    if (uSegA[i].w < 0.5) continue;
    if (segmentDistance(world, uSegA[i].xyz, uSegB[i].xyz) < uSegB[i].w + ${HAND_CLEAR.toFixed(3)}) {
      gl_FragColor = vec4(-1.0, 0.0, 0.0, 1.0);
      return;
    }
  }
  gl_FragColor = vec4(m, 0.0, 0.0, 1.0);
}
`;

/**
 * What is behind the hand: each hand texel looks outward along 8 directions for the first texel
 * that is not hand. Only when all 8 find a depth does it take one, the farthest, so a hand at an
 * object's edge leaves the scan alone rather than raising wall onto the object. Without this the
 * patch behind the pinching hand stayed on the scan while the object around it was raised.
 */
const FILL_FRAGMENT = /* glsl */ `
uniform sampler2D uSource;
varying vec2 vUv;

void main() {
  ivec2 size = textureSize(uSource, 0);
  ivec2 at = ivec2(vUv * vec2(size));
  float v = texelFetch(uSource, at, 0).r;
  if (v >= 0.0) {
    gl_FragColor = vec4(v, 0.0, 0.0, 1.0);
    return;
  }
  float far = 0.0;
  for (int d = 0; d < 8; d++) {
    float a = float(d) * 0.78539816;
    vec2 dir = vec2(cos(a), sin(a)) * 2.0;
    float found = -1.0;
    for (int k = 1; k <= ${FILL_STEPS}; k++) {
      ivec2 q = at + ivec2(round(dir * float(k)));
      if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) break;
      float w = texelFetch(uSource, q, 0).r;
      if (w >= 0.0) {
        found = w;
        break;
      }
    }
    if (found <= 0.0) {
      gl_FragColor = vec4(0.0);
      return;
    }
    far = max(far, found);
  }
  gl_FragColor = vec4(far, 0.0, 0.0, 1.0);
}
`;

function depthTarget(): WebGLRenderTarget {
  return new WebGLRenderTarget(SIZE, SIZE, {
    type: HalfFloatType,
    format: RedFormat,
    depthBuffer: false,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    generateMipmaps: false,
  });
}

/** One frozen copy of the headset's depth, and how to look a world point up in it. */
export class RaiseMap {
  readonly target = depthTarget();
  /** World point to homogeneous raise-map uv; w is the point's depth in front of the eye. */
  readonly toMap = new Matrix4();
  readonly eye = new Vector3();
  on = false;
}

/**
 * Real objects the room scan missed (a lamp, a plush toy, the glass of a door) from the headset's
 * depth. At a pinch, the depth of the eye the depth was taken from is copied into a small map, with
 * the hands filled in from what is around them. The stretch's vertex stage then slides each scanned
 * point that sits 3-80 cm behind the measured surface onto it, along that eye's line of sight, and
 * bends it as the scan behind it bends. The photo lands on the object itself and stretches with it,
 * and a pull beside it no longer smears a flat copy of it across the wall. One map per photo slot;
 * `?lens=overlay` refreshes slot 0 every frame to check it.
 */
export class RaiseMaps {
  readonly maps = [new RaiseMap(), new RaiseMap()];
  /** False where half-float targets can't be drawn to; the stretch then keeps the scan as it is. */
  readonly supported: boolean;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: ShaderMaterial;
  private readonly fillMaterial: ShaderMaterial;
  private readonly quad: Mesh;
  /** The copy pass lands here, hand texels marked; the fill pass writes the slot's map from it. */
  private readonly scratch = depthTarget();
  private readonly eyeWorld = new Matrix4();
  private readonly tmp = new Matrix4();
  private readonly uvFromClip = new Matrix4();

  constructor(renderer: WebGLRenderer) {
    this.supported =
      renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
    this.material = new ShaderMaterial({
      vertexShader: COPY_VERTEX,
      fragmentShader: COPY_FRAGMENT,
      uniforms: {
        uEnvDepth: { value: null },
        uDepthRaw: { value: 1 },
        uDepthNear: { value: 0.1 },
        uViewFromDepth: { value: new Matrix4() },
        uInvProjection: { value: new Matrix4() },
        uEyeWorld: { value: new Matrix4() },
        uSegA: { value: Array.from({ length: SEGMENTS }, () => new Vector4()) },
        uSegB: { value: Array.from({ length: SEGMENTS }, () => new Vector4()) },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.fillMaterial = new ShaderMaterial({
      vertexShader: COPY_VERTEX,
      fragmentShader: FILL_FRAGMENT,
      uniforms: { uSource: { value: this.scratch.texture } },
      depthTest: false,
      depthWrite: false,
    });
    // One triangle over the whole target.
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.quad = new Mesh(geometry, this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    // Clip space to view uv, with z dropped so normDepthBufferFromNormView sees (u, v, 0, 1).
    this.uvFromClip.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 1);
    // Compile both programs and allocate every target now, outside any session, not on a pinch.
    // Drawn into the real targets, so the programs match the ones a capture uses.
    if (this.supported) {
      for (let i = 0; i < this.maps.length; i++) this.draw(renderer, this.maps[i].target);
    }
  }

  /**
   * Copies this frame's depth (the first eye) into slot `k`'s map. `rig` is the XR camera's parent,
   * which places the reference space in the world. Hands are cleared using `segA`/`segB`. Returns
   * false, leaving the map off, when there is no depth this frame.
   */
  capture(
    k: 0 | 1,
    renderer: WebGLRenderer,
    depth: EnvDepth,
    rig: Object3D | null,
    segA: readonly Vector4[],
    segB: readonly Vector4[],
  ): boolean {
    const map = this.maps[k];
    if (!this.supported || !depth.on) {
      map.on = false;
      return false;
    }
    this.eyeWorld.copy(depth.viewPose[0]);
    if (rig) {
      rig.updateWorldMatrix(true, false);
      this.eyeWorld.premultiply(rig.matrixWorld);
    }
    const u = this.material.uniforms;
    u.uEnvDepth.value = depth.texture;
    u.uDepthRaw.value = depth.rawToMeters;
    u.uDepthNear.value = depth.near;
    (u.uViewFromDepth.value as Matrix4).copy(depth.normDepth[0]).invert();
    (u.uInvProjection.value as Matrix4).copy(depth.viewProjection[0]).invert();
    (u.uEyeWorld.value as Matrix4).copy(this.eyeWorld);
    const a = u.uSegA.value as Vector4[];
    const b = u.uSegB.value as Vector4[];
    for (let i = 0; i < SEGMENTS; i++) {
      a[i].copy(segA[i]);
      b[i].copy(segB[i]);
    }
    // World to raise-map uv: view, projection, clip to uv, then the depth buffer's own uv.
    map.toMap.copy(this.eyeWorld).invert();
    map.toMap.premultiply(depth.viewProjection[0]);
    map.toMap.premultiply(this.uvFromClip);
    map.toMap.premultiply(this.tmp.copy(depth.normDepth[0]));
    map.eye.setFromMatrixPosition(this.eyeWorld);

    this.draw(renderer, map.target);
    map.on = true;
    return true;
  }

  dispose(): void {
    for (let i = 0; i < this.maps.length; i++) this.maps[i].target.dispose();
    this.scratch.dispose();
    this.quad.geometry.dispose();
    this.material.dispose();
    this.fillMaterial.dispose();
  }

  /**
   * The copy pass into the scratch target, then the fill into `target`. Outside the XR camera: with
   * xr enabled, three would swap in the headset's eyes.
   */
  private draw(renderer: WebGLRenderer, target: WebGLRenderTarget): void {
    const xr = renderer.xr;
    const wasXr = xr.enabled;
    const previous = renderer.getRenderTarget();
    xr.enabled = false;
    this.quad.material = this.material;
    renderer.setRenderTarget(this.scratch);
    renderer.render(this.scene, this.camera);
    this.quad.material = this.fillMaterial;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(previous);
    xr.enabled = wasXr;
  }
}
