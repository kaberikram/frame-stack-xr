import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DataArrayTexture,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  InstancedBufferGeometry,
  LinearFilter,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  createSystem,
  type Entity,
  type Material,
  type Object3D,
} from '@iwsdk/core';
import { FrameStack } from './frame-stack-component.js';
import { DEMO_SECONDS, fmtTime, type FrameSource } from './frame-sources.js';
import { INK, drawMove, drawPlay, drawSpeed, drawStrip, drawTag, makeCanvas, type Atlas, type Canvas2D } from './labels.js';
import {
  BUTTON_R,
  FRAME_H,
  MOVE_H,
  MOVE_W,
  MOVE_X,
  PAD,
  PLAY_X,
  SPEED_X,
  STACK_YAW,
  STRIP_DEPTH,
  STRIP_GAP,
  STRIP_LENGTH,
  SURFACE_Y,
  UNIT,
} from './layout.js';
import {
  createStackUniforms,
  currentMaterial,
  floorMaterial,
  ghostMaterial,
  haloMaterial,
  type StackUniforms,
} from './stack-materials.js';
import type { Target } from './touch-logic.js';

/** Quest fill rate is the budget here: every visible slice blends over the ones behind it. */
export const MAX_LAYERS = 128;
const GPU_BUDGET = 32 * 1024 * 1024; // bytes for the whole frame array
const MAX_FRAME_PIXELS = 320 * 180;
const SPEEDS = [0.5, 1, 2, 4];
const MAJORS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const TAG_W = 0.054;
const TAG_H = 0.012;
const LOOK_KEYS = ['ghost', 'trail', 'length', 'lift', 'feather', 'glow'] as const;
type Look = Record<(typeof LOOK_KEYS)[number], number>;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
// Window rAF can stall during an immersive session, so slicing yields with a task instead.
const yieldToLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

function makeFrameArray(W: number, H: number, N: number) {
  const data = new Uint8Array(W * H * 4 * N);
  const tex = new DataArrayTexture(data, W, H, N);
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return { tex, data };
}

function frameSize(aspect: number, N: number) {
  const px = Math.min(MAX_FRAME_PIXELS, GPU_BUDGET / (4 * N));
  const W = Math.sqrt(px * aspect);
  const H = W / aspect;
  const s = Math.min(1, 512 / Math.max(W, H));
  return {
    W: Math.max(16, Math.floor((W * s) / 2) * 2),
    H: Math.max(16, Math.floor((H * s) / 2) * 2),
  };
}

interface Button {
  mesh: Mesh;
  paint: Canvas2D;
  tex: CanvasTexture;
}

/**
 * The frame stack on the table: slices, ghosts, glow, ruler, dot grid, and the
 * filmstrip slider with its controls. Owns the clip and playback; the table touch
 * system drives it through seek(), skimAt(), togglePlay() and cycleSpeed().
 */
export class FrameStackSystem extends createSystem({ stacks: { required: [FrameStack] } }) {
  kind: FrameSource['kind'] = 'demo';
  name = 'Demo clip';
  duration = DEMO_SECONDS;
  aspect = 16 / 9;
  /** Slices sampled per second of footage; applies on the next build. */
  rate = 8;
  N = 0;
  loaded = 0;
  playhead = 0;
  playing = false;
  speed = 1;
  skim: number | null = null;

  private focus = 0;
  private job = 0;
  private meanColors = new Float32Array(0);
  private texDirty = false;
  private lastUpload = 0;
  private stripDirty = true;
  private lastStrip = 0;
  private revealT = 1;
  private major = 1;
  private W = FRAME_H * (16 / 9);
  private H = FRAME_H;
  private pressed: Target | null = null;
  private repaint = true;
  private painted = { playing: false, speed: 0, pressed: null as Target | null, tag: -1, tagN: -1 };
  private readonly look: Look = { ghost: 1, trail: 16, length: 2, lift: 0.15, feather: 0.4, glow: 1 };
  private rig: Entity | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly eye = new Vector3();
  private readonly eyeQuat = new Quaternion();
  private readonly local = new Vector3();
  private readonly touchPoint = new Vector3();
  /** 0 at the first frame, 1 at the last. Written by `probe`. */
  stackU = 0;
  /** Meters outside the frame volume. 0 when the point is inside. Written by `probe`. */
  stackOutside = Infinity;
  /** Stack-local position along the time axis, in meters. Written by `probe`. */
  stackAxis = 0;
  private readonly cornerA = new Vector3();
  private readonly cornerB = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();

  private U!: StackUniforms;
  private root!: Group;
  private base!: Group;
  private stackGroup!: Group;
  private ghostGeo!: InstancedBufferGeometry;
  private ghosts!: Mesh;
  private halo!: Mesh;
  private current!: Mesh;
  private floor!: Mesh;
  private box!: LineSegments;
  private ruler!: LineSegments;
  private tick!: LineSegments;
  private stripPaint!: Canvas2D;
  private stripTex!: CanvasTexture;
  private curMarker!: Group;
  private headMarker!: Group;
  private playBtn!: Button;
  private speedBtn!: Button;
  private move!: Button;
  private tag!: Mesh;
  private tagPaint!: Canvas2D;
  private tagTex!: CanvasTexture;
  private tagEntity!: Entity;
  private work!: Canvas2D;
  private atlas!: Atlas;
  private atlasCtx!: CanvasRenderingContext2D;

  init(): void {
    this.U = createStackUniforms(makeFrameArray(2, 2, 1).tex);
    this.root = new Group();
    this.base = new Group(); // on the table, time axis along the film strip; grows upward on reveal
    this.stackGroup = new Group();
    this.root.add(this.base);
    this.base.add(this.stackGroup);

    const quad = new PlaneGeometry(1, 1);
    const flatQuad = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

    this.ghostGeo = new InstancedBufferGeometry();
    this.ghostGeo.setIndex(quad.getIndex());
    this.ghostGeo.setAttribute('position', quad.getAttribute('position'));
    this.ghostGeo.setAttribute('uv', quad.getAttribute('uv'));
    this.ghostGeo.instanceCount = 1;
    this.ghosts = new Mesh(this.ghostGeo, ghostMaterial(this.U));
    this.ghosts.frustumCulled = false; // slices are offset in the shader, so CPU bounds mean nothing
    this.halo = new Mesh(quad, haloMaterial(this.U));
    this.halo.frustumCulled = false;
    this.current = new Mesh(quad, currentMaterial(this.U));
    this.floor = new Mesh(flatQuad, floorMaterial(this.U));
    this.floor.frustumCulled = false;

    const line = (color: string | Color) => new LineBasicMaterial({ color, transparent: true, depthWrite: true });
    this.box = new LineSegments(new EdgesGeometry(new BoxGeometry(1, 1, 1)), line(INK.red));
    this.box.visible = false;
    const rulerGeo = new BufferGeometry();
    rulerGeo.setAttribute('position', new BufferAttribute(new Float32Array(MAX_LAYERS * 6), 3));
    rulerGeo.setDrawRange(0, 0);
    this.ruler = new LineSegments(rulerGeo, line(new Color(INK.text).lerp(new Color(INK.stage), 0.4)));
    this.ruler.frustumCulled = false;
    this.tick = new LineSegments(
      new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0.17 * UNIT, 0, 0], 3)),
      line(INK.text),
    );

    // Draw order. IWSDK's hand mesh is invisible but writes depth at order 0, so a real
    // finger cuts through everything drawn after it. Lines go before the slices so the
    // slices blend over them, as in the browser version.
    this.floor.renderOrder = 1;
    this.box.renderOrder = 5;
    this.ruler.renderOrder = 5;
    this.tick.renderOrder = 5;
    this.ghosts.renderOrder = 6;
    this.halo.renderOrder = 7;
    this.current.renderOrder = 8;
    this.stackGroup.add(this.floor, this.box, this.ruler, this.tick, this.ghosts, this.halo, this.current);

    // Filmstrip slider and controls, flat on the table
    this.stripPaint = makeCanvas(2048, 164);
    this.stripTex = this.canvasTexture(this.stripPaint.canvas);
    const strip = new Mesh(
      new PlaneGeometry(STRIP_LENGTH, STRIP_DEPTH).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ map: this.stripTex, transparent: true, depthWrite: false }),
    );
    strip.position.y = SURFACE_Y;
    strip.renderOrder = 2;
    this.curMarker = this.marker(0.0032);
    this.headMarker = this.marker(0.0014);
    this.playBtn = this.button(256, 256, 2 * BUTTON_R, 2 * BUTTON_R, PLAY_X);
    this.speedBtn = this.button(256, 256, 2 * BUTTON_R, 2 * BUTTON_R, SPEED_X);
    this.move = this.button(256, 118, MOVE_W, MOVE_H, MOVE_X);
    this.root.add(strip, this.curMarker, this.headMarker, this.playBtn.mesh, this.speedBtn.mesh, this.move.mesh);

    // The frame tag lives in world space so it can turn to face the viewer.
    this.tagPaint = makeCanvas(288, 64);
    this.tagTex = this.canvasTexture(this.tagPaint.canvas);
    this.tag = new Mesh(
      new PlaneGeometry(TAG_W, TAG_H),
      new MeshBasicMaterial({ map: this.tagTex, transparent: true, depthWrite: false }),
    );
    this.tag.renderOrder = 9;
    this.tag.visible = false;
    const tagRoot = new Group();
    tagRoot.add(this.tag);
    this.tagEntity = this.world.createTransformEntity(tagRoot);

    this.work = makeCanvas(16, 16, true);
    const atlas = makeCanvas(16, 16, true); // CPU-backed so thumbnails survive GPU resets
    this.atlas = { canvas: atlas.canvas, w: 160, h: 90, cols: 12 };
    this.atlasCtx = atlas.ctx;

    this.cleanupFuncs.push(
      this.queries.stacks.subscribe('qualify', (entity) => this.attach(entity), true),
      this.queries.stacks.subscribe('disqualify', (entity) => this.detach(entity)),
      () => this.dispose(),
    );
    void document.fonts.ready.then(() => {
      this.repaint = true; // repaint labels once the Recursive face has arrived
      this.painted.tag = -1;
    });
  }

  // ---------------------------------------------------------------- public controls

  get ready(): boolean {
    return this.N > 0 && this.loaded >= this.N;
  }

  displayIndex(): number {
    if (!this.loaded) return 0;
    if (this.loaded < this.N) return this.loaded - 1; // follow the slicing head while loading
    return clamp(this.skim ?? Math.floor(this.playhead), 0, this.N - 1);
  }

  /** Scrub: jump the playhead to a strip position (0..1) and pause. */
  seek(u: number): void {
    if (!this.ready) return;
    this.playing = false;
    this.skim = null;
    this.playhead = clamp(Math.floor(u * this.N), 0, this.N - 1);
  }

  /** Preview a strip position without moving the playhead; null returns to the playhead. */
  skimAt(u: number | null): void {
    this.skim = u === null || !this.ready ? null : clamp(Math.floor(u * this.N), 0, this.N - 1);
  }

  /**
   * Project a rig-local point onto the stack. Writes `stackU`, `stackOutside` and
   * `stackAxis`. The time axis is the stack's local z: the first frame sits at +z.
   */
  probe(x: number, y: number, z: number): void {
    const rig = this.rig?.object3D;
    if (!rig) {
      this.stackU = 0;
      this.stackAxis = 0;
      this.stackOutside = Infinity;
      return;
    }
    this.touchPoint.set(x, y, z);
    rig.localToWorld(this.touchPoint);
    this.stackGroup.updateWorldMatrix(true, false);
    this.stackGroup.worldToLocal(this.touchPoint);
    const p = this.touchPoint;
    const dx = Math.max(0, Math.abs(p.x) - (this.W / 2 + PAD));
    const dy = Math.max(0, Math.abs(p.y) - (this.H / 2 + PAD));
    const dz = Math.max(0, Math.abs(p.z) - (this.U.z0.value + PAD));
    this.stackOutside = Math.hypot(dx, dy, dz);
    this.stackAxis = p.z;
    this.stackU = this.uOnAxis(p.z);
  }

  /** 0..1 along the time axis from a stack-local z, in meters. */
  uOnAxis(z: number): number {
    const span = Math.max(this.U.z0.value * 2, 1e-6);
    return clamp((this.U.z0.value - z) / span, 0, 1);
  }

  togglePlay(): void {
    this.setPlaying(!this.playing);
  }

  cycleSpeed(): void {
    this.speed = SPEEDS[(SPEEDS.indexOf(this.speed) + 1) % SPEEDS.length];
  }

  setPressed(target: Target | null): void {
    this.pressed = target;
  }

  /** Slices rise out of the table after placement. */
  reveal(): void {
    this.revealT = reduceMotion.matches ? 1 : 0;
    this.base.scale.y = reduceMotion.matches ? 1 : 0.001;
  }

  /** Whether a slice sits on a long ruler tick. */
  isMajor(i: number): boolean {
    return i % this.major === 0;
  }

  describe(): string {
    if (!this.ready) return this.N ? `Slicing ${this.name}: ${this.loaded} of ${this.N} frames` : `Slicing ${this.name}`;
    const t = Math.round(this.duration);
    const d = this.duration < 60 ? `${+this.duration.toFixed(1)} s` : `${Math.floor(t / 60)} min${t % 60 ? ` ${t % 60} s` : ''}`;
    return `${this.name}, ${d}, cut into ${this.N} frames`;
  }

  rateNote(): string {
    if (!this.N) return '';
    const every = this.duration / this.N;
    const capped = Math.round(this.duration * this.rate) > MAX_LAYERS;
    return `${capped ? 'Capped at ' : ''}${this.N} frames, one every ${every < 1 ? every.toFixed(2) : every.toFixed(1)} s.`;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notify(): void {
    this.listeners.forEach((listener) => listener());
  }

  /** Slices a source into the frame array, uploading layers in batches as they land. */
  async build(source: FrameSource): Promise<boolean> {
    const my = ++this.job; // stops any slicing in progress
    const N = clamp(Math.round(source.duration * this.rate), 2, MAX_LAYERS);
    const { W, H } = frameSize(source.aspect, N);
    const { tex, data } = makeFrameArray(W, H, N);
    const old = this.U.frames.value;
    this.U.frames.value = tex;
    old.dispose();

    this.meanColors = new Float32Array(N * 3);
    this.kind = source.kind;
    this.name = source.name;
    this.duration = source.duration;
    this.aspect = source.aspect;
    this.N = N;
    this.loaded = 0;
    this.playhead = 0;
    this.skim = null;
    this.focus = 0;
    this.setPlaying(false);
    const { canvas: work, ctx: workCtx } = this.work;
    work.width = W;
    work.height = H;
    const a = this.atlas;
    a.w = Math.max(24, Math.round(a.h * source.aspect));
    a.cols = Math.max(1, Math.floor(2048 / a.w));
    a.canvas.width = a.cols * a.w;
    a.canvas.height = Math.ceil(N / a.cols) * a.h;
    this.layout();
    this.notify();

    for (let i = 0; i < N; i++) {
      await source.draw(workCtx, W, H, (i / N) * source.duration, i);
      if (my !== this.job) return false;
      const px = workCtx.getImageData(0, 0, W, H).data;
      data.set(px, i * W * H * 4);
      tex.addLayerUpdate(i);
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let p = 0; p < px.length; p += 4 * 17) {
        r += LINEAR[px[p]];
        g += LINEAR[px[p + 1]];
        b += LINEAR[px[p + 2]];
        n++;
      }
      this.meanColors[i * 3] = r / n;
      this.meanColors[i * 3 + 1] = g / n;
      this.meanColors[i * 3 + 2] = b / n;
      this.atlasCtx.drawImage(work, 0, 0, W, H, (i % a.cols) * a.w, Math.floor(i / a.cols) * a.h, a.w, a.h);
      this.loaded = i + 1;
      this.texDirty = true;
      this.stripDirty = true;
      if (i % 4 === 3 || i === N - 1) this.notify();
      if (source.kind === 'demo' && i % 3 === 2) await yieldToLoop();
    }
    this.playhead = 0;
    this.setPlaying(!reduceMotion.matches);
    this.notify();
    return true;
  }

  // ---------------------------------------------------------------- frame loop

  update(delta: number): void {
    if (!this.rig) return;
    const dt = Math.min(0.1, delta);
    const now = performance.now();
    this.readLook();

    if (this.playing) this.playhead = (this.playhead + dt * (this.N / this.duration) * this.speed) % this.N;
    const target = this.displayIndex();
    if (this.focus !== target) {
      const jump = Math.abs(target - this.focus);
      this.focus = reduceMotion.matches || jump > this.N / 2 ? target : this.focus + (target - this.focus) * (1 - Math.exp(-dt * 16));
      if (Math.abs(target - this.focus) < 0.01) this.focus = target;
    }

    if (this.texDirty && now - this.lastUpload > 90) {
      this.U.frames.value.needsUpdate = true; // batch per-layer uploads while slicing
      this.texDirty = false;
      this.lastUpload = now;
    }
    if (this.stripDirty && (now - this.lastStrip > 150 || this.ready)) {
      drawStrip(this.stripPaint, this.atlas, this.N, this.loaded, this.aspect);
      this.stripTex.needsUpdate = true;
      this.stripDirty = false;
      this.lastStrip = now;
    }
    if (this.revealT < 1) {
      this.revealT = Math.min(1, this.revealT + dt / 0.5);
      this.base.scale.y = Math.max(0.001, 1 - (1 - this.revealT) ** 3);
    }
    this.sync(target);
  }

  private sync(idx: number): void {
    const U = this.U;
    U.cur.value = idx;
    U.focus.value = this.focus;
    U.loaded.value = this.loaded;

    // Draw each side from the far end toward the viewer. One sweep across the
    // whole stack piles the slices up and washes the middle out.
    this.viewer(this.eye, this.eyeQuat);
    this.stackGroup.updateWorldMatrix(true, false);
    this.local.copy(this.eye);
    this.stackGroup.worldToLocal(this.local);
    const ci = U.spacing.value > 0 ? (U.z0.value - this.local.z) / U.spacing.value : -1e4;
    U.split.value = clamp(Math.floor(ci) + 1, 0, this.N);

    // Per-slice opacity is normalised by slice count, so density reads the same at 16 or 128 frames.
    const s = (this.look.ghost / 0.5) ** 2;
    U.ghost.value = 1 - Math.exp((-4.5 * s) / Math.max(2, this.N));
    U.spread.value = this.look.trail;
    U.lift.value = this.look.lift;
    U.feather.value = this.look.feather;
    U.glow.value = this.look.glow;

    const has = this.loaded > 0;
    this.box.visible = false;
    this.current.visible = has;
    this.halo.visible = has;
    this.tick.visible = has;
    this.curMarker.visible = has;
    const z = U.z0.value - idx * U.spacing.value;
    const ly = this.look.lift * FRAME_H * 0.85;
    this.current.position.set(0, ly, z);
    this.halo.position.set(0, ly, z);
    this.tick.position.z = z;
    const m = idx * 3;
    if (m + 2 < this.meanColors.length) {
      const c = this.meanColors;
      U.haloColor.value.setRGB(Math.min(1, c[m] * 1.6 + 0.02), Math.min(1, c[m + 1] * 1.6 + 0.02), Math.min(1, c[m + 2] * 1.6 + 0.02));
    }
    U.haloStrength.value = 0.32 * this.look.glow;

    this.curMarker.position.x = this.stripX(idx);
    this.headMarker.visible = has && this.skim !== null;
    if (this.headMarker.visible) this.headMarker.position.x = this.stripX(Math.floor(this.playhead));
    this.paintButtons();
    this.placeTag(idx, ly, z);
  }

  private viewer(pos: Vector3, quat: Quaternion): void {
    const source = this.renderer.xr.isPresenting ? this.player.head : this.camera;
    source.getWorldPosition(pos);
    source.getWorldQuaternion(quat);
  }

  private placeTag(idx: number, ly: number, z: number): void {
    const show = this.loaded > 0 && this.revealT >= 1 && (this.rig?.object3D?.visible ?? false);
    this.tag.visible = show;
    if (!show) return;
    if (this.painted.tag !== idx || this.painted.tagN !== this.N) {
      this.painted.tag = idx;
      this.painted.tagN = this.N;
      drawTag(this.tagPaint, String(idx + 1).padStart(3, '0'), fmtTime((idx / Math.max(1, this.N)) * this.duration));
      this.tagTex.needsUpdate = true;
    }
    this.cornerA.set(-this.W / 2, this.H / 2 + ly, z);
    this.cornerB.set(this.W / 2, this.H / 2 + ly, z);
    this.stackGroup.localToWorld(this.cornerA);
    this.stackGroup.localToWorld(this.cornerB);
    this.right.set(1, 0, 0).applyQuaternion(this.eyeQuat);
    this.up.set(0, 1, 0).applyQuaternion(this.eyeQuat);
    // whichever top corner of the current frame is on the viewer's left right now
    const corner = this.cornerA.dot(this.right) <= this.cornerB.dot(this.right) ? this.cornerA : this.cornerB;
    this.tag.position.copy(corner).addScaledVector(this.right, TAG_W / 2 - 0.001).addScaledVector(this.up, TAG_H / 2 + 0.006);
    this.tag.quaternion.copy(this.eyeQuat);
  }

  private paintButtons(): void {
    const p = this.painted;
    const pressed = this.pressed;
    if (this.repaint || p.playing !== this.playing || (p.pressed === 'play') !== (pressed === 'play')) {
      drawPlay(this.playBtn.paint, this.playing, pressed === 'play');
      this.playBtn.tex.needsUpdate = true;
    }
    if (this.repaint || p.speed !== this.speed || (p.pressed === 'speed') !== (pressed === 'speed')) {
      drawSpeed(this.speedBtn.paint, this.speed, pressed === 'speed');
      this.speedBtn.tex.needsUpdate = true;
    }
    if (this.repaint || (p.pressed === 'move') !== (pressed === 'move')) {
      drawMove(this.move.paint, pressed === 'move');
      this.move.tex.needsUpdate = true;
    }
    p.playing = this.playing;
    p.speed = this.speed;
    p.pressed = pressed;
    this.repaint = false;
    // a press sinks the control slightly, like the browser version's :active scale
    this.playBtn.mesh.scale.setScalar(pressed === 'play' ? 0.94 : 1);
    this.speedBtn.mesh.scale.setScalar(pressed === 'speed' ? 0.94 : 1);
    this.move.mesh.scale.setScalar(pressed === 'move' ? 0.94 : 1);
  }

  // ---------------------------------------------------------------- layout

  private layout(): void {
    const U = this.U;
    const H = FRAME_H;
    const W = FRAME_H * this.aspect;
    const D = Math.max(W, H) * this.look.length;
    this.W = W;
    this.H = H;
    const N = Math.max(1, this.N);
    U.n.value = N;
    U.z0.value = D / 2;
    U.spacing.value = N > 1 ? D / (N - 1) : 0;
    this.ghostGeo.instanceCount = N;
    this.ghosts.scale.set(W, H, 1); // x/y only: the z offsets come from the shader
    this.current.scale.set(W, H, 1);
    U.haloHalf.value.set(W / 2, H / 2);
    this.box.scale.set(W + 2 * PAD, H + 2 * PAD, D + 2 * PAD);
    this.box.visible = false;

    const floorY = -H / 2 - PAD;
    this.floor.position.y = floorY;
    U.half.value.set(W / 2 + PAD, D / 2 + PAD);
    U.floorR.value = Math.hypot(W, D) * 1.1;

    const seconds = MAJORS.find((k) => this.duration / k <= 20) ?? 600;
    this.major = Math.max(1, Math.round((seconds * this.N) / Math.max(this.duration, 1e-6)));
    const x0 = W / 2 + PAD;
    const attr = this.ruler.geometry.getAttribute('position') as BufferAttribute;
    const pos = attr.array as Float32Array;
    for (let i = 0; i < this.N; i++) {
      const z = U.z0.value - i * U.spacing.value;
      const o = i * 6;
      pos[o] = x0;
      pos[o + 1] = floorY;
      pos[o + 2] = z;
      pos[o + 3] = x0 + (i % this.major === 0 ? 0.09 : 0.035) * UNIT;
      pos[o + 4] = floorY;
      pos[o + 5] = z;
    }
    attr.needsUpdate = true;
    this.ruler.geometry.setDrawRange(0, this.N * 2);
    this.tick.position.set(x0, floorY, 0);

    // Sit the stack behind the strip: its turned footprint has to clear the strip's far edge.
    const halfDepth = Math.abs((W / 2 + PAD) * Math.sin(STACK_YAW)) + Math.abs((D / 2 + PAD) * Math.cos(STACK_YAW));
    this.base.position.set(0, 0, -(STRIP_DEPTH / 2 + STRIP_GAP + halfDepth));
    this.base.rotation.y = STACK_YAW;
    this.stackGroup.position.y = H / 2 + PAD;
    this.stripDirty = true;
  }

  private stripX(i: number): number {
    return ((i + 0.5) / Math.max(1, this.N) - 0.5) * STRIP_LENGTH;
  }

  private setPlaying(p: boolean): void {
    this.playing = p && this.N > 1 && this.loaded === this.N;
  }

  // ---------------------------------------------------------------- rig + helpers

  private attach(entity: Entity): void {
    if (this.rig) return;
    this.rig = entity;
    entity.object3D?.add(this.root);
    this.readLook(true);
  }

  private detach(entity: Entity): void {
    if (entity !== this.rig) return;
    this.root.removeFromParent();
    this.rig = null;
    this.tag.visible = false;
  }

  private readLook(force = false): void {
    const rig = this.rig;
    if (!rig) return;
    const length = this.look.length;
    for (let i = 0; i < LOOK_KEYS.length; i++) {
      const key = LOOK_KEYS[i];
      const value = rig.getValue(FrameStack, key);
      if (typeof value === 'number') this.look[key] = value;
    }
    if (force || this.look.length !== length) this.layout();
  }

  private canvasTexture(canvas: HTMLCanvasElement): CanvasTexture {
    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy()); // the table is seen at a grazing angle
    return tex;
  }

  private marker(width: number): Group {
    const group = new Group();
    const plate = (w: number, depth: number, color: string, opacity: number, order: number) => {
      const mesh = new Mesh(
        new PlaneGeometry(w, depth).rotateX(-Math.PI / 2),
        new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
      );
      mesh.renderOrder = order;
      return mesh;
    };
    group.add(
      plate(width + 0.003, STRIP_DEPTH + 0.008, INK.stage, 0.85, 3),
      plate(width, STRIP_DEPTH + 0.006, '#FFFFFF', 1, 4),
    );
    group.position.y = SURFACE_Y + 0.0004;
    group.visible = false;
    return group;
  }

  private button(pw: number, ph: number, w: number, h: number, x: number): Button {
    const paint = makeCanvas(pw, ph);
    const tex = this.canvasTexture(paint.canvas);
    const mesh = new Mesh(
      new PlaneGeometry(w, h).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
    );
    mesh.position.set(x, SURFACE_Y, 0);
    mesh.renderOrder = 3;
    return { mesh, paint, tex };
  }

  private dispose(): void {
    const release = (object: Object3D) =>
      object.traverse((o) => {
        const mesh = o as Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material as Material | Material[] | undefined;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
      });
    release(this.root);
    release(this.tag);
    for (const tex of [this.U.frames.value, this.stripTex, this.tagTex, this.playBtn.tex, this.speedBtn.tex, this.move.tex]) tex.dispose();
    this.root.removeFromParent();
    this.tagEntity.dispose();
  }
}
