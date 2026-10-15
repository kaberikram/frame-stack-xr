/**
 * Rooms' lens: one fullscreen pass on the picture the camera already took. It throws the stack
 * in view into focus. No second tilted plane.
 *
 * IWSDK draws the scene itself, so this follows the bloom: capture the root into a target during
 * the update, then a quad in that root shows the result on the normal render. Desktop only.
 */
import {
  BufferGeometry,
  Color,
  DepthTexture,
  Float32BufferAttribute,
  LinearFilter,
  Mesh,
  NearestFilter,
  NoBlending,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type Object3D,
  type WebGLRenderer,
} from '@iwsdk/core';

const TAPS = 16;
/** Most blur, in pixels, once something is clearly nearer or farther than the stack in view. */
export const ROOMS_LENS_APERTURE = 7;

function fullscreenTriangle(): BufferGeometry {
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  return geo;
}

export class RoomsLens {
  /** Covers the viewport during the normal render. Hidden while the picture is captured. */
  readonly quad: Mesh;
  private readonly material: ShaderMaterial;
  private readonly geometry = fullscreenTriangle();
  private readonly size = new Vector2();
  private readonly prevClear = new Color();
  private target: WebGLRenderTarget | null = null;

  constructor(private readonly renderer: WebGLRenderer) {
    this.material = new ShaderMaterial({
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        uResolution: { value: new Vector2(1, 1) },
        uFocus: { value: 5 },
        uAperture: { value: ROOMS_LENS_APERTURE },
        uNear: { value: 0.1 },
        uFar: { value: 50 },
        uSeed: { value: 0 },
      },
      vertexShader: /* glsl */ `
        void main() {
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform vec2 uResolution;
        uniform float uFocus;
        uniform float uAperture;
        uniform float uNear;
        uniform float uFar;
        uniform float uSeed;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }

        float viewZOf(float depth) {
          return (uNear * uFar) / ((uFar - uNear) * depth - uFar);
        }

        float cocAt(vec2 uv) {
          float depth = texture(tDepth, uv).r;
          float z = max(-viewZOf(depth), 0.05);
          // A stack is deep. Anything within this share of the focus distance stays sharp,
          // so the layers read and a nearer box does not melt while the others glow.
          float rel = abs(z - uFocus) / max(uFocus, 0.05);
          return smoothstep(0.42, 1.15, rel) * uAperture;
        }

        void main() {
          vec2 uv = gl_FragCoord.xy / uResolution;
          float coc = cocAt(uv);
          vec2 texel = 1.0 / uResolution;
          float spin = hash(gl_FragCoord.xy * 0.37 + uSeed) * 6.2831853;
          vec3 acc = vec3(0.0);
          float wsum = 0.0;
          for (int i = 0; i < ${TAPS}; i++) {
            float fi = float(i);
            float a = fi * 2.39996323 + spin;
            float r = sqrt((fi + 0.5) / ${TAPS}.0) * coc;
            vec3 s = texture(tColor, uv + vec2(cos(a), sin(a)) * r * texel).rgb;
            float luma = dot(s, vec3(0.2126, 0.7152, 0.0722));
            float w = 1.0 + 7.0 * luma * luma * luma;
            acc += s * w;
            wsum += w;
          }
          vec3 col = acc / wsum;

          float cell = 3.0;
          float u = fract(gl_FragCoord.x / cell);
          // Cosine RGB stripes. Times two they average to white, so the grid does not tint the frame.
          vec3 led = 1.0 + cos(6.2831853 * (vec3(u) - vec3(0.1667, 0.5, 0.8333)));
          float row = abs(fract(gl_FragCoord.y / cell) - 0.5);
          led *= mix(1.0, 0.72, smoothstep(0.22, 0.48, row));
          float ledAmt = (1.0 - smoothstep(1.5, 8.0, coc)) * 0.4;
          col *= mix(vec3(1.0), led, ledAmt);

          col += (hash(gl_FragCoord.xy + uSeed) - 0.5) * 0.035;
          gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
          #include <colorspace_fragment>
        }`,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
      toneMapped: false,
    });
    this.quad = new Mesh(this.geometry, this.material);
    this.quad.name = 'rooms-lens';
    this.quad.frustumCulled = false;
    this.quad.renderOrder = 1e5;
    this.quad.visible = false;
    this.quad.raycast = () => {};
  }

  /**
   * Draw `root` into the lens target. The quad is hidden for the draw and put back after.
   * False when the buffer is too small to bother.
   */
  capture(root: Object3D, camera: Camera): boolean {
    this.renderer.getDrawingBufferSize(this.size);
    if (this.size.x < 2 || this.size.y < 2) return false;
    this.ensure(this.size.x, this.size.y);
    const renderer = this.renderer;
    const prev = renderer.getRenderTarget();
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.prevClear);
    const prevAuto = renderer.autoClear;
    const prevXr = renderer.xr.enabled;
    const shown = this.quad.visible;
    this.quad.visible = false;
    renderer.xr.enabled = false;
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 1);
    renderer.setRenderTarget(this.target);
    renderer.clear(true, true, false);
    renderer.render(root, camera);
    renderer.xr.enabled = prevXr;
    renderer.autoClear = prevAuto;
    renderer.setClearColor(this.prevClear, prevAlpha);
    renderer.setRenderTarget(prev);
    this.quad.visible = shown;
    const uniforms = this.material.uniforms;
    uniforms.tColor.value = this.target!.texture;
    uniforms.tDepth.value = this.target!.depthTexture;
    (uniforms.uResolution.value as Vector2).copy(this.size);
    return true;
  }

  /** Focus for this frame. `aperture` is already halved when the viewer prefers reduced motion. */
  present(focus: number, aperture: number, seed: number, near: number, far: number): void {
    const uniforms = this.material.uniforms;
    uniforms.uFocus.value = focus;
    uniforms.uAperture.value = aperture;
    uniforms.uSeed.value = seed;
    uniforms.uNear.value = near;
    uniforms.uFar.value = far;
  }

  hide(): void {
    this.quad.visible = false;
  }

  dispose(): void {
    this.quad.removeFromParent();
    this.material.dispose();
    this.geometry.dispose();
    this.target?.dispose();
    this.target = null;
  }

  private ensure(w: number, h: number): void {
    if (this.target && this.target.width === w && this.target.height === h) return;
    this.target?.dispose();
    const depth = new DepthTexture(w, h);
    depth.magFilter = NearestFilter;
    depth.minFilter = NearestFilter;
    this.target = new WebGLRenderTarget(w, h, {
      format: RGBAFormat,
      type: UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: depth,
      magFilter: LinearFilter,
      minFilter: LinearFilter,
      generateMipmaps: false,
    });
  }
}
