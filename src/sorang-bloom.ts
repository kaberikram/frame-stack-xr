import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  DepthFormat,
  DepthTexture,
  Float32BufferAttribute,
  LinearFilter,
  Mesh,
  NoBlending,
  OrthographicCamera,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  UnsignedIntType,
  Vector2,
  Vector4,
  WebGLRenderTarget,
  type Camera,
  type IUniform,
  type Material,
  type Object3D,
  type WebGLRenderer,
} from '@iwsdk/core';

/**
 * Selective bloom that works in the headset. IWSDK draws the scene itself with one
 * `renderer.render`, so this never takes over the main pass: before it, Sorang's pieces are drawn
 * again at a quarter of the eye's resolution, blurred down and back up, and a fullscreen quad in
 * Sorang's own root adds the glow during the normal render. The XR layer keeps its MSAA.
 *
 * - `mono`: the desktop canvas, plain 2D targets.
 * - `stereo`: XR without multiview (the dev emulator): 2D targets laid out like the XR
 *   framebuffer, each eye's viewport scaled down, and the blur kept inside each eye's rectangle.
 * - `multiview`: Quest. Every target is a two-layer texture array that three renders with
 *   OVR_multiview (it tags any target with `isWebGLMultiviewRenderTarget`), so each pass draws
 *   both eyes at once and the shaders read the layer for `VIEW_ID`.
 */

/** The source pass renders at this share of the eye's resolution. Each blur level halves it. */
const SCALE = 0.25;
/** Source, then three halvings. */
const LEVELS = 4;
/** Soft knee of the threshold, in linear brightness. */
const KNEE = 0.12;

export type BloomMode = 'mono' | 'stereo' | 'multiview';

/** Something drawn with one material, and the twin it is drawn with into the glow. */
export type BloomSwap = readonly [{ material: Material | Material[] }, Material];

interface Level {
  rt: WebGLRenderTarget;
  /** Texture arrays this side allocated for a multiview target, deleted with it. */
  raw: WebGLTexture[];
}

/** Calls three has but its typings don't list. */
interface RendererExtras {
  setRenderTargetTextures(target: WebGLRenderTarget, color: WebGLTexture, depth?: WebGLTexture): void;
}
interface XRExtras {
  isMultiview?: boolean;
  getRenderTarget?(): WebGLRenderTarget | null;
}
interface MultiviewTag {
  isWebGLMultiviewRenderTarget: boolean;
  numViews: number;
}

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

/** One sampler per kind of target; only the one for this program's variant exists after compile. */
const TAP = /* glsl */ `
  varying vec2 vUv;
  #ifdef VIEW_ID
  precision highp sampler2DArray;
  uniform sampler2DArray tArr;
  uniform sampler2DArray tAddArr;
  vec3 tap(vec2 uv) { return texture(tArr, vec3(uv, float(VIEW_ID))).rgb; }
  vec3 tapAdd(vec2 uv) { return texture(tAddArr, vec3(uv, float(VIEW_ID))).rgb; }
  #else
  uniform sampler2D tFlat;
  uniform sampler2D tAddFlat;
  /** Each eye's rectangle in uv (min xy, max xy). The second is empty on the desktop. */
  uniform vec4 uRect0;
  uniform vec4 uRect1;
  /** Half a source texel in uv, so a tap never reads across into the other eye. */
  uniform vec2 uEdge;
  vec2 keep(vec2 uv) {
    bool second = uRect1.z > uRect1.x && vUv.x >= uRect1.x && vUv.x <= uRect1.z && vUv.y >= uRect1.y && vUv.y <= uRect1.w;
    vec4 r = second ? uRect1 : uRect0;
    return clamp(uv, r.xy + uEdge, r.zw - uEdge);
  }
  vec3 tap(vec2 uv) { return texture(tFlat, keep(uv)).rgb; }
  vec3 tapAdd(vec2 uv) { return texture(tAddFlat, keep(uv)).rgb; }
  #endif
  /** Half an output texel, uv. */
  uniform vec2 uHalf;`;

/** Dual-Kawase downsample; the first one also keeps only what is bright. */
function downMaterial(): ShaderMaterial {
  return passMaterial(/* glsl */ `
    ${TAP}
    uniform float uThreshold;
    uniform float uFirst;
    void main() {
      vec3 c = tap(vUv) * 4.0;
      c += tap(vUv - uHalf);
      c += tap(vUv + uHalf);
      c += tap(vUv + vec2(uHalf.x, -uHalf.y));
      c += tap(vUv - vec2(uHalf.x, -uHalf.y));
      c *= 0.125;
      if (uFirst > 0.5) {
        float l = max(c.r, max(c.g, c.b));
        float soft = clamp(l - uThreshold + ${KNEE.toFixed(3)}, 0.0, ${(2 * KNEE).toFixed(3)});
        soft = soft * soft / ${(4 * KNEE).toFixed(3)};
        c *= max(soft, l - uThreshold) / max(l, 1e-4);
      }
      gl_FragColor = vec4(c, 1.0);
    }`);
}

/**
 * Dual-Kawase upsample of the level below, averaged with this level's own downsample for a
 * tighter core. Averaged, not summed: the targets are eight-bit and a sum would clip.
 */
function upMaterial(): ShaderMaterial {
  return passMaterial(/* glsl */ `
    ${TAP}
    void main() {
      vec3 c = tap(vUv + vec2(-uHalf.x * 2.0, 0.0));
      c += tap(vUv + vec2(-uHalf.x, uHalf.y)) * 2.0;
      c += tap(vUv + vec2(0.0, uHalf.y * 2.0));
      c += tap(vUv + vec2(uHalf.x, uHalf.y)) * 2.0;
      c += tap(vUv + vec2(uHalf.x * 2.0, 0.0));
      c += tap(vUv + vec2(uHalf.x, -uHalf.y)) * 2.0;
      c += tap(vUv + vec2(0.0, -uHalf.y * 2.0));
      c += tap(vUv + vec2(-uHalf.x, -uHalf.y)) * 2.0;
      gl_FragColor = vec4((c / 12.0 + tapAdd(vUv)) * 0.5, 1.0);
    }`);
}

function passMaterial(fragmentShader: string): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      tArr: { value: null },
      tAddArr: { value: null },
      tFlat: { value: null },
      tAddFlat: { value: null },
      uRect0: { value: new Vector4(0, 0, 1, 1) },
      uRect1: { value: new Vector4(0, 0, 0, 0) },
      uEdge: { value: new Vector2() },
      uHalf: { value: new Vector2() },
      uThreshold: { value: 0.25 },
      uFirst: { value: 0 },
    },
    vertexShader: VERTEX,
    fragmentShader,
    blending: NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}

function compositeMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      tArr: { value: null },
      tFlat: { value: null },
      uStrength: { value: 0 },
      uFull: { value: new Vector2(1, 1) },
    },
    vertexShader: VERTEX,
    fragmentShader: /* glsl */ `
      uniform float uStrength;
      /**
       * The framebuffer's size, px. The glow was drawn with every eye viewport scaled down by the
       * same factor, so a pixel's place in the framebuffer is its place in the glow, eyes and all.
       */
      uniform vec2 uFull;
      #ifdef VIEW_ID
      precision highp sampler2DArray;
      uniform sampler2DArray tArr;
      #else
      uniform sampler2D tFlat;
      #endif
      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        vec2 uv = gl_FragCoord.xy / uFull;
        #ifdef VIEW_ID
        vec3 c = texture(tArr, vec3(uv, float(VIEW_ID))).rgb;
        #else
        vec3 c = texture(tFlat, uv).rgb;
        #endif
        gl_FragColor = vec4(c * uStrength, 1.0);
        #include <colorspace_fragment>
        // Eight-bit targets band in a dark glow; a little noise hides it. Pure black stays black.
        float lit = step(0.5 / 255.0, max(gl_FragColor.r, max(gl_FragColor.g, gl_FragColor.b)));
        gl_FragColor.rgb += (hash(gl_FragCoord.xy) - 0.5) / 255.0 * lit;
      }`,
    transparent: true,
    blending: AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
}

/** A triangle that covers the whole viewport: cheaper than a quad, and no seam. */
function fullscreenTriangle(): BufferGeometry {
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  return geo;
}

export class SorangBloom {
  /** Add to the root the bloom belongs to: it draws the glow during the normal render. */
  readonly composite: Mesh;
  private readonly compositeMat: ShaderMaterial;
  private readonly down = downMaterial();
  private readonly up = upMaterial();
  private readonly geometry = fullscreenTriangle();
  private readonly passMesh: Mesh;
  private readonly passScene = new Scene();
  private readonly passCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  /** L0 (source, with depth) through L3 going down. */
  private down_: Level[] = [];
  /** Up results at the sizes of L2 and L1; the composite reads the last. */
  private up_: Level[] = [];
  private currentMode: BloomMode | null = null;
  private fullW = 0;
  private fullH = 0;
  private readonly full = new Vector2();
  /** Visibility of the hidden objects across the source pass, without allocating. */
  private readonly wasVisible: boolean[] = [];
  /** Materials swapped out for the source pass, without allocating. */
  private readonly wasMaterial: Array<Material | Material[]> = [];
  private readonly prevClear = new Color();
  private readonly saved = [new Vector4(), new Vector4()];
  private readonly rects = [new Vector4(0, 0, 1, 1), new Vector4()];

  constructor(private readonly renderer: WebGLRenderer) {
    this.compositeMat = compositeMaterial();
    this.composite = new Mesh(this.geometry, this.compositeMat);
    this.composite.name = 'sorang-bloom';
    // Last of all, over everything Sorang draws.
    this.composite.renderOrder = 1e6;
    this.composite.frustumCulled = false;
    this.composite.raycast = () => {};
    this.composite.visible = false;
    this.passMesh = new Mesh(this.geometry, this.down);
    this.passMesh.frustumCulled = false;
    this.passScene.add(this.passMesh);
  }

  get mode(): BloomMode | null {
    return this.currentMode;
  }

  /** Source resolution, per eye for multiview. */
  get sourceSize(): { w: number; h: number } {
    const rt = this.down_[0]?.rt;
    return { w: rt?.width ?? 0, h: rt?.height ?? 0 };
  }

  /** Hide the glow, e.g. while bloom is turned off. */
  hide(): void {
    this.composite.visible = false;
  }

  /**
   * Draw the glow for this frame. Call after Sorang's uniforms are final and before IWSDK's
   * render. `hide` are drawn in the main pass but not into the glow (the black void).
   * `swaps` give each piece a twin material for the glow: the glow's targets are linear and the
   * screen is sRGB, and one material drawn into both would rebuild its program twice a frame.
   * `viewportH` is the uniform the point and tile sizes are measured in.
   */
  render(
    root: Object3D,
    camera: Camera,
    hide: readonly Object3D[],
    swaps: readonly BloomSwap[],
    viewportH: IUniform<number>,
    strength: number,
    threshold: number,
  ): void {
    const renderer = this.renderer;
    const xr = renderer.xr;
    const xrx = xr as unknown as XRExtras;
    // Before any allocation: a multiview allocation resets three's state, current target included.
    const prevTarget = renderer.getRenderTarget();
    let mode: BloomMode = 'mono';
    let cameras: readonly Camera[] = [];
    if (xr.isPresenting) {
      const target = xrx.getRenderTarget?.() ?? renderer.getRenderTarget();
      cameras = xr.getCamera().cameras;
      if (!target || cameras.length === 0) {
        this.hide();
        return;
      }
      mode = xrx.isMultiview ? 'multiview' : 'stereo';
      this.full.set(target.width, target.height);
    } else {
      renderer.getDrawingBufferSize(this.full);
    }
    if (this.full.x < 2 || this.full.y < 2) {
      this.hide();
      return;
    }
    this.ensure(mode, this.full.x, this.full.y);

    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.prevClear);
    const prevAuto = renderer.autoClear;
    const prevXr = xr.enabled;
    const prevH = viewportH.value;

    // Source: Sorang's pieces only, at a quarter of the resolution, with depth.
    const src = this.down_[0].rt;
    this.composite.visible = false;
    for (let i = 0; i < hide.length; i++) {
      this.wasVisible[i] = hide[i].visible;
      hide[i].visible = false;
    }
    for (let i = 0; i < swaps.length; i++) {
      this.wasMaterial[i] = swaps[i][0].material;
      swaps[i][0].material = swaps[i][1];
    }
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 1);
    renderer.setRenderTarget(src);
    renderer.clear(true, true, false);
    viewportH.value = src.height;
    if (mode !== 'mono') {
      // Three reads the eye viewports only in onAnimationFrame, so scaling them for this one
      // call and putting them back is safe.
      const sx = src.width / this.fullW;
      const sy = src.height / this.fullH;
      for (let i = 0; i < cameras.length && i < 2; i++) {
        const v = (cameras[i] as Camera & { viewport: Vector4 }).viewport;
        this.saved[i].copy(v);
        // The eye's rectangle in uv, so the blur stays inside it.
        this.rects[i].set(v.x / this.fullW, v.y / this.fullH, (v.x + v.z) / this.fullW, (v.y + v.w) / this.fullH);
        v.set(Math.round(v.x * sx), Math.round(v.y * sy), Math.round(v.z * sx), Math.round(v.w * sy));
      }
      renderer.render(root, camera);
      for (let i = 0; i < cameras.length && i < 2; i++) (cameras[i] as Camera & { viewport: Vector4 }).viewport.copy(this.saved[i]);
    } else {
      renderer.render(root, camera);
    }
    if (mode !== 'stereo') {
      this.rects[0].set(0, 0, 1, 1);
      this.rects[1].set(0, 0, 0, 0);
    } else if (cameras.length < 2) {
      this.rects[1].set(0, 0, 0, 0);
    }
    viewportH.value = prevH;
    for (let i = 0; i < hide.length; i++) hide[i].visible = this.wasVisible[i];
    for (let i = 0; i < swaps.length; i++) swaps[i][0].material = this.wasMaterial[i];

    // Blur: with XR off, a pass is one fullscreen draw into the whole target.
    xr.enabled = false;
    for (let i = 1; i < LEVELS; i++) this.pass(this.down, this.down_[i - 1].rt, null, this.down_[i].rt, i === 1, threshold, mode);
    this.pass(this.up, this.down_[3].rt, this.down_[2].rt, this.up_[0].rt, false, threshold, mode);
    this.pass(this.up, this.up_[0].rt, this.down_[1].rt, this.up_[1].rt, false, threshold, mode);

    xr.enabled = prevXr;
    renderer.autoClear = prevAuto;
    renderer.setClearColor(this.prevClear, prevAlpha);
    renderer.setRenderTarget(prevTarget);

    const out = this.up_[1].rt.texture;
    const u = this.compositeMat.uniforms;
    u.tArr.value = mode === 'multiview' ? out : null;
    u.tFlat.value = mode === 'multiview' ? null : out;
    (u.uFull.value as Vector2).set(this.fullW, this.fullH);
    u.uStrength.value = strength;
    this.composite.visible = strength > 0;
  }

  dispose(): void {
    this.release();
    this.down.dispose();
    this.up.dispose();
    this.compositeMat.dispose();
    this.geometry.dispose();
    this.composite.removeFromParent();
  }

  // ----------------------------------------------------------------

  private pass(
    material: ShaderMaterial,
    from: WebGLRenderTarget,
    add: WebGLRenderTarget | null,
    to: WebGLRenderTarget,
    first: boolean,
    threshold: number,
    mode: BloomMode,
  ): void {
    const u = material.uniforms;
    const array = mode === 'multiview';
    u.tArr.value = array ? from.texture : null;
    u.tFlat.value = array ? null : from.texture;
    u.tAddArr.value = array && add ? add.texture : null;
    u.tAddFlat.value = !array && add ? add.texture : null;
    (u.uRect0.value as Vector4).copy(this.rects[0]);
    (u.uRect1.value as Vector4).copy(this.rects[1]);
    (u.uEdge.value as Vector2).set(0.5 / from.width, 0.5 / from.height);
    (u.uHalf.value as Vector2).set(0.5 / to.width, 0.5 / to.height);
    u.uThreshold.value = threshold;
    u.uFirst.value = first ? 1 : 0;
    this.passMesh.material = material;
    this.renderer.setRenderTarget(to);
    this.renderer.render(this.passScene, this.passCam);
  }

  /** (Re)allocate the targets when the mode or the output size changes. */
  private ensure(mode: BloomMode, fullW: number, fullH: number): void {
    if (mode === this.currentMode && fullW === this.fullW && fullH === this.fullH) return;
    this.release();
    this.currentMode = mode;
    this.fullW = fullW;
    this.fullH = fullH;
    let w = Math.max(2, Math.round(fullW * SCALE));
    let h = Math.max(2, Math.round(fullH * SCALE));
    const sizes: Array<[number, number]> = [];
    for (let i = 0; i < LEVELS; i++) {
      sizes.push([w, h]);
      w = Math.max(2, Math.round(w / 2));
      h = Math.max(2, Math.round(h / 2));
    }
    this.down_ = sizes.map(([lw, lh], i) => this.target(mode, lw, lh, i === 0));
    this.up_ = [this.target(mode, sizes[2][0], sizes[2][1], false), this.target(mode, sizes[1][0], sizes[1][1], false)];
    if (mode === 'multiview') {
      // Raw GL texture binds above bypass three's state cache; make it forget what it thinks is bound.
      this.renderer.resetState();
    }
    console.info(
      `[jonze] sorang bloom mode=${mode} ${sizes[0][0]}x${sizes[0][1]}` +
        `${mode === 'multiview' ? ' per eye' : ''} from ${fullW}x${fullH}, ${LEVELS} levels`,
    );
  }

  private target(mode: BloomMode, w: number, h: number, depth: boolean): Level {
    if (mode !== 'multiview') {
      const rt = new WebGLRenderTarget(w, h, {
        format: RGBAFormat,
        type: UnsignedByteType,
        magFilter: LinearFilter,
        minFilter: LinearFilter,
        generateMipmaps: false,
        depthBuffer: depth,
        stencilBuffer: false,
      });
      return { rt, raw: [] };
    }
    // Multiview, built the way three's own XR layer target is: external texture arrays for colour
    // and depth. Three's own allocation can't make a depth array for a custom multiview target, and
    // every multiview target gets a depth attachment whether it wants one or not.
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const color = gl.createTexture();
    const depthTex = gl.createTexture();
    if (!color || !depthTex) throw new Error('bloom: texture allocation failed');
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, color);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, w, h, 2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, depthTex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.DEPTH_COMPONENT24, w, h, 2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    const rt = new WebGLRenderTarget(w, h, {
      format: RGBAFormat,
      type: UnsignedByteType,
      magFilter: LinearFilter,
      minFilter: LinearFilter,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
      // Depth 2: three binds it as a texture array when it attaches it.
      depthTexture: new DepthTexture(w, h, UnsignedIntType, undefined, undefined, undefined, undefined, undefined, undefined, DepthFormat, 2),
    });
    const tag = rt as unknown as MultiviewTag;
    tag.isWebGLMultiviewRenderTarget = true;
    tag.numViews = 2;
    (this.renderer as unknown as RendererExtras).setRenderTargetTextures(rt, color, depthTex);
    return { rt, raw: [color, depthTex] };
  }

  private release(): void {
    const gl = this.renderer.getContext();
    for (const level of [...this.down_, ...this.up_]) {
      level.rt.depthTexture?.dispose();
      level.rt.dispose();
      for (const tex of level.raw) gl.deleteTexture(tex);
    }
    this.down_ = [];
    this.up_ = [];
    this.currentMode = null;
    this.composite.visible = false;
  }
}
