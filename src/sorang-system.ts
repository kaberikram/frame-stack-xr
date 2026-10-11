import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LineSegments,
  Mesh,
  PlaneGeometry,
  Points,
  SRGBColorSpace,
  Vector2,
  Vector3,
  createSystem,
  type Entity,
  type Material,
  type Texture,
} from '@iwsdk/core';
import { loadBakedDepth } from './baked-depth.js';
import { cancelDepth, estimateDepth, type DepthField } from './depth-model.js';
import { getMode } from './experience.js';
import { PAINTING_DEPTH, decodeImageFile, loadPainting, loadPhotoAtlas, type Painting, type PhotoAtlas } from './sorang-assets.js';
import {
  LINK_PAIRS,
  buildDust,
  buildLinks,
  buildTiles,
  depthMap,
  dustBuffers,
  linkBuffers,
  tileBuffers,
  type DepthMap,
  type DustBuffers,
  type LinkBuffers,
  type TileBuffers,
} from './sorang-build.js';
import { SorangLook } from './sorang-component.js';
import { blankPhotos, createSorangUniforms, dustMaterial, linkMaterial, tileMaterial, voidMaterial, type SorangUniforms } from './sorang-materials.js';
import { HOLD_AT, SLICES, SorangTimeline, createClocks, type SorangGates, type SorangStage } from './sorang-timeline.js';

const LOOK_KEYS = ['size', 'tiles', 'dust', 'relief', 'radial', 'fan', 'mosaic', 'parallax', 'pace', 'reformSpeed'] as const;
type Look = Record<(typeof LOOK_KEYS)[number], number>;

/** The painting fills this share of the view, leaving room for the relief's outward push. */
const FRAMING = 0.78;
/** The scripted eye arc that shows the fanned slices as layers. */
const ARC_YAW = (20 * Math.PI) / 180;
/** The default painting's depth and photos get this long before it plays without them. */
const GATE_TIMEOUT_MS = 8000;
/** Burst reach, metres. */
const REACH = 2.2;
/** A click on the canvas moves less than this, in CSS pixels. */
const CLICK_SLOP = 5;
/** Where the painting hangs if the scene has no Sorang node. */
const FALLBACK_POS = new Vector3(0, 1.6, -2.5);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

/** `?sorangT=<seconds>` freezes the timeline there, for deterministic captures. */
function frozenFromUrl(): number | null {
  if (typeof location === 'undefined') return null;
  const raw = new URLSearchParams(location.search).get('sorangT');
  if (raw === null) return null;
  const t = Number(raw);
  return Number.isFinite(t) && t >= 0 ? t : null;
}

export interface SorangStatus {
  text: string;
  busy: boolean;
}

/** The window.__sorang test hook. */
export interface SorangHook {
  readonly ready: boolean;
  readonly T: number;
  readonly stage: SorangStage;
  seek(t: number): void;
  freeze(t: number | null): void;
  pause(): void;
  play(): void;
  reform(): boolean;
  setPhotos(on: boolean): void;
  setView(on: boolean): void;
  paintingRect(): { x0: number; y0: number; x1: number; y1: number } | null;
  stats(): Record<string, number>;
}

/**
 * Sorang: a painting hangs in the dark, as tall as you. It takes on depth, splits into 100
 * depth slices of stock-photo tiles, and bursts into particles that orbit the viewer.
 * Click or R brings them back. Everything moves on the GPU from one timeline; this system
 * only loads, builds, and writes uniforms.
 */
export class SorangSystem extends createSystem({ anchors: { required: [SorangLook] } }) {
  private U!: SorangUniforms;
  private root!: Group;
  private voidMesh!: Mesh;
  private tiles!: Mesh;
  private dust!: Points;
  private links!: LineSegments;
  private tileGeo!: InstancedBufferGeometry;
  private dustGeo!: BufferGeometry;
  private linkGeo!: BufferGeometry;
  private tileBuf!: TileBuffers;
  private dustBuf!: DustBuffers;
  private linkBuf!: LinkBuffers;
  private blank!: Texture;
  private readonly timeline = new SorangTimeline();
  private readonly clocks = createClocks();
  private readonly gates: SorangGates = { ready: false };
  private readonly look: Look = { size: 1.83, tiles: 64, dust: 256, relief: 0.35, radial: 0.5, fan: 0.6, mosaic: 0.9, parallax: 0.15, pace: 1, reformSpeed: 3 };
  private readonly frozenAt = frozenFromUrl();
  private anchor: Entity | null = null;
  private onFallback = false;
  private fallback: Entity | null = null;
  private active = false;
  private started = false;
  private atlasStarted = false;

  private painting: Painting | null = null;
  private paintTex: CanvasTexture | null = null;
  private depth: DepthField | null = null;
  private map: DepthMap | null = null;
  private atlas: PhotoAtlas | null = null;
  private photoMeans: Float32Array = new Float32Array(0);
  private pendingDepth: DepthField | null = null;
  private pendingAtlas: PhotoAtlas | null = null;
  private readonly gate = { painting: false, depth: false, atlas: false };
  private mapDirty = false;
  private tilesDirty = false;
  private built = false;
  private framesSinceBuild = 0;
  /** Bumped per image, so a slower load can't replace a newer picture. */
  private gen = 0;
  /** Bumped per Load image pick, for the decode race only. */
  private pick = 0;
  private depthTimer = 0;
  private atlasTimer = 0;
  private statusNow: SorangStatus = { text: 'Opening the painting', busy: true };
  private readonly listeners = new Set<() => void>();
  private readonly messageListeners = new Set<(message: string) => void>();
  private lastStage: SorangStage | null = null;
  private photosOn = true;
  private viewOn = true;

  private toggleWanted = false;
  private pauseWanted = false;
  private readonly pointer = new Vector2();
  private readonly parallax = new Vector2();
  private downId = -1;
  private readonly down = new Vector2();
  private swayClock = 0;
  private restD = 2.5;

  private readonly eye = new Vector3();
  private readonly centre = new Vector3();
  private readonly head = new Vector3();
  private readonly tmp = new Vector3();
  private readonly bufSize = new Vector2();
  private updateMs = 0;
  private updates = 0;

  init(): void {
    this.blank = blankPhotos();
    this.U = createSorangUniforms(this.blank);
    const gl = this.renderer.getContext();
    const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | null;
    this.U.uMaxPoint.value = Math.max(1, Math.min(16, range?.[1] ?? 16));

    this.root = new Group();
    this.root.name = 'sorang';
    this.root.visible = false;

    this.voidMesh = new Mesh(new PlaneGeometry(1, 1), voidMaterial());
    this.voidMesh.renderOrder = -1000;
    this.makeTileGeometry(this.look.tiles * this.look.tiles);
    this.tiles = new Mesh(this.tileGeo, tileMaterial(this.U));
    this.tiles.renderOrder = 20;
    this.makeDustGeometry(this.look.dust * this.look.dust);
    this.dust = new Points(this.dustGeo, dustMaterial(this.U));
    this.dust.renderOrder = 21;
    this.linkBuf = linkBuffers();
    this.linkGeo = new BufferGeometry();
    this.linkGeo.setAttribute('position', new BufferAttribute(this.linkBuf.position, 3));
    this.linkGeo.setAttribute('aTile', new BufferAttribute(this.linkBuf.tile, 4));
    this.linkGeo.setAttribute('aInfo', new BufferAttribute(this.linkBuf.info, 4));
    this.linkGeo.setDrawRange(0, 0);
    this.links = new LineSegments(this.linkGeo, linkMaterial(this.U));
    this.links.renderOrder = 22;
    for (const object of [this.voidMesh, this.tiles, this.dust, this.links]) {
      // Positions come from the shader, so CPU bounds and raycasts mean nothing.
      object.frustumCulled = false;
      object.raycast = () => {};
      this.root.add(object);
    }

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('keydown', this.onKeyDown);
    this.installHook();

    this.cleanupFuncs.push(
      this.queries.anchors.subscribe('qualify', (entity) => this.attach(entity), true),
      this.queries.anchors.subscribe('disqualify', (entity) => this.detach(entity)),
      () => {
        canvas.removeEventListener('pointerdown', this.onPointerDown);
        canvas.removeEventListener('pointerup', this.onPointerUp);
        window.removeEventListener('pointermove', this.onPointerMove);
        window.removeEventListener('keydown', this.onKeyDown);
        const w = window as unknown as { __sorang?: SorangHook };
        delete w.__sorang;
        this.dispose();
      },
    );
  }

  // ---------------------------------------------------------------- launcher API

  status(): SorangStatus {
    return this.statusNow;
  }

  get stage(): SorangStage {
    return this.timeline.stage;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Toast-worthy problems: a picture that won't decode, photos that won't load. */
  onMessage(listener: (message: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  /** Play again from black. */
  restart(): void {
    this.timeline.restart();
    if (this.frozenAt !== null) this.timeline.freeze(this.frozenAt);
    this.lastStage = null;
    this.notify();
  }

  /** Send the pieces out, or bring them back. */
  toggle(): boolean {
    return this.timeline.toggle();
  }

  /** Swap in a picture the viewer picked; depth comes from the in-browser model. */
  async useImage(file: File): Promise<void> {
    // Decode first: a file that won't decode must leave the current picture and its depth alone.
    const pick = ++this.pick;
    const before = this.statusNow;
    this.setStatus(`Opening ${file.name}`, true);
    let picked: Painting;
    try {
      picked = await decodeImageFile(file);
    } catch (err) {
      if (pick !== this.pick) return;
      console.warn('[sorang] image decode failed', err);
      this.message(`Couldn’t decode ${file.name}. JPEG, PNG and WebP work in most browsers.`);
      this.setStatus(before.text, before.busy);
      return;
    }
    if (pick !== this.pick) return;
    const gen = ++this.gen;
    this.started = true;
    this.startAtlas();
    cancelDepth('sorang');
    window.clearTimeout(this.depthTimer);
    this.setPainting(picked);
    this.depth = null;
    this.pendingDepth = null;
    this.gate.depth = false;
    this.restart();
    try {
      const field = await estimateDepth(picked.depth, 'sorang', (message) => {
        if (gen === this.gen) this.setStatus(message, true);
      });
      this.offerDepth(field, gen, 'model');
    } catch (err) {
      if (gen !== this.gen || (err instanceof Error && err.message === 'cancelled')) return;
      console.warn('[sorang] depth unavailable', err);
      this.message(`Couldn’t read depth for ${picked.name}. It plays with shading standing in for depth.`);
      this.gate.depth = true;
      this.setStatus(this.builtText(), false);
    }
  }

  // ---------------------------------------------------------------- frame loop

  update(delta: number): void {
    const on = getMode() === 'sorang';
    this.root.visible = on;
    if (!on) {
      if (this.active) this.leave();
      return;
    }
    const start = performance.now();
    if (!this.active) this.enter();
    const dt = Math.min(0.1, delta);
    this.readLook();
    this.applyPending();
    if (this.mapDirty || this.tilesDirty) this.rebuild();
    if (this.toggleWanted) this.timeline.toggle();
    if (this.pauseWanted) this.timeline.togglePause();
    this.toggleWanted = false;
    this.pauseWanted = false;

    const reduced = reduceMotion.matches;
    this.gates.ready = this.gate.painting && this.gate.depth && this.gate.atlas && this.built;
    this.timeline.update(dt, this.gates, this.look.pace, this.look.reformSpeed, reduced ? 0.2 : 1, this.clocks);
    this.swayClock += dt;
    this.placeView(dt, reduced);
    this.syncUniforms(reduced);
    const stage = this.timeline.stage;
    if (stage !== this.lastStage) {
      this.lastStage = stage;
      console.info(`[sorang] stage=${stage} T=${(this.timeline.frozen ?? this.timeline.T).toFixed(2)}`);
      this.notify();
    }
    if (this.built) this.framesSinceBuild++;
    this.updateMs += performance.now() - start;
    this.updates++;
  }

  private enter(): void {
    this.active = true;
    if (!this.anchor && !this.onFallback) {
      console.warn('[sorang] no SorangLook node in the scene; hanging the painting at the default spot');
      const holder = new Group();
      holder.add(this.root);
      this.fallback = this.world.createTransformEntity(holder);
      // After creation, so the position goes through the entity's Transform.
      this.fallback.object3D?.position.copy(FALLBACK_POS);
      this.onFallback = true;
    }
    this.parallax.set(0, 0);
    this.restart();
    if (!this.started) this.startDefault();
    else this.applyPending();
  }

  private leave(): void {
    this.active = false;
    // Back to black now, so the launcher never sees a stale drift stage on re-entry.
    this.restart();
    this.toggleWanted = false;
    this.pauseWanted = false;
    this.downId = -1;
  }

  // ---------------------------------------------------------------- loading

  private startDefault(): void {
    this.started = true;
    const gen = ++this.gen;
    this.setStatus('Opening the painting', true);
    this.startAtlas();
    window.clearTimeout(this.depthTimer);
    this.depthTimer = window.setTimeout(() => {
      if (gen !== this.gen || this.gate.depth) return;
      console.warn('[sorang] depth is slow; playing with shading for depth until it lands');
      this.gate.depth = true;
      if (this.built) this.setStatus(this.builtText(), false);
    }, GATE_TIMEOUT_MS);
    const painting = loadPainting();
    painting.then(
      (p) => {
        if (gen !== this.gen) return;
        this.setPainting(p);
      },
      (err: unknown) => {
        if (gen !== this.gen) return;
        console.warn('[sorang] painting failed', err);
        this.setStatus('Couldn’t open the painting.', false);
        this.message('Couldn’t open the painting. Load an image instead, or reload the page.');
      },
    );
    loadBakedDepth(PAINTING_DEPTH, 0)
      .then((field) => this.offerDepth(field, gen, 'baked'))
      .catch(async (err: unknown) => {
        console.warn('[sorang] baked depth unavailable, estimating instead', err);
        const p = await painting;
        if (gen !== this.gen) throw new Error('cancelled'); // a picked image owns the 'sorang' estimate now
        const field = await estimateDepth(p.depth, 'sorang');
        this.offerDepth(field, gen, 'model');
      })
      .catch((err: unknown) => {
        if (gen !== this.gen || (err instanceof Error && err.message === 'cancelled')) return;
        console.warn('[sorang] depth unavailable; shading stands in for depth', err);
        this.gate.depth = true;
        if (this.built) this.setStatus(this.builtText(), false);
      });
  }

  private startAtlas(): void {
    if (this.atlasStarted) return;
    this.atlasStarted = true;
    this.atlasTimer = window.setTimeout(() => {
      if (this.gate.atlas) return;
      console.warn('[sorang] tile photos are slow; playing without them until they land');
      this.gate.atlas = true;
    }, GATE_TIMEOUT_MS);
    loadPhotoAtlas().then(
      (atlas) => {
        window.clearTimeout(this.atlasTimer);
        this.gate.atlas = true;
        if (this.canSwap()) this.setAtlas(atlas);
        else this.pendingAtlas = atlas;
      },
      (err: unknown) => {
        window.clearTimeout(this.atlasTimer);
        console.warn('[sorang] tile photos failed', err);
        this.gate.atlas = true;
        this.message('Couldn’t load the tile photos.');
      },
    );
  }

  /** Data may change only while it can't be seen changing: before the relief starts, or frozen. */
  private canSwap(): boolean {
    return this.timeline.frozen !== null || this.timeline.T <= HOLD_AT || !this.active;
  }

  private offerDepth(field: DepthField, gen: number, source: string): void {
    if (gen !== this.gen) return;
    window.clearTimeout(this.depthTimer);
    console.info(`[sorang] depth ${source} ${field.width}x${field.height}`);
    this.gate.depth = true;
    if (this.canSwap()) {
      this.depth = field;
      this.mapDirty = true;
    } else {
      this.pendingDepth = field;
    }
  }

  private applyPending(): void {
    if (!this.canSwap()) return;
    if (this.pendingDepth) {
      this.depth = this.pendingDepth;
      this.pendingDepth = null;
      this.mapDirty = true;
    }
    if (this.pendingAtlas) {
      this.setAtlas(this.pendingAtlas);
      this.pendingAtlas = null;
    }
  }

  private setPainting(p: Painting): void {
    this.painting = p;
    const tex = new CanvasTexture(p.display);
    tex.colorSpace = SRGBColorSpace;
    tex.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    this.paintTex?.dispose();
    this.paintTex = tex;
    this.U.uPaint.value = tex;
    this.gate.painting = true;
    this.mapDirty = true;
  }

  private setAtlas(atlas: PhotoAtlas): void {
    const old = this.atlas;
    this.atlas = atlas;
    this.photoMeans = atlas.means;
    this.U.uPhotos.value = atlas.texture;
    if (old) old.texture.dispose();
    this.tilesDirty = true;
  }

  // ---------------------------------------------------------------- building

  private makeTileGeometry(capacity: number): void {
    const quad = new PlaneGeometry(1, 1);
    const geo = new InstancedBufferGeometry();
    geo.setIndex(quad.getIndex());
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    this.tileBuf = tileBuffers(capacity);
    geo.setAttribute('aTile', new InstancedBufferAttribute(this.tileBuf.tile, 4));
    geo.setAttribute('aInfo', new InstancedBufferAttribute(this.tileBuf.info, 4));
    geo.instanceCount = 0;
    if (this.tileGeo) this.tileGeo.dispose();
    this.tileGeo = geo;
    if (this.tiles) this.tiles.geometry = geo;
  }

  private makeDustGeometry(capacity: number): void {
    this.dustBuf = dustBuffers(Math.max(1, capacity));
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.dustBuf.position, 3));
    geo.setAttribute('aDust', new BufferAttribute(this.dustBuf.dust, 2));
    geo.setDrawRange(0, 0);
    if (this.dustGeo) this.dustGeo.dispose();
    this.dustGeo = geo;
    if (this.dust) this.dust.geometry = geo;
  }

  private rebuild(): void {
    const p = this.painting;
    if (!p) return;
    const started = performance.now();
    if (this.mapDirty || !this.map) this.map = depthMap(p.display, this.depth);
    const aspect = p.display.width / p.display.height;
    buildTiles(this.map, aspect, this.look.tiles, this.photoMeans, this.tileBuf);
    buildDust(this.map, aspect, this.look.dust, this.dustBuf);
    buildLinks(this.tileBuf, this.linkBuf);
    for (const name of ['aTile', 'aInfo']) (this.tileGeo.getAttribute(name) as InstancedBufferAttribute).needsUpdate = true;
    this.tileGeo.instanceCount = this.tileBuf.count;
    for (const name of ['position', 'aDust']) (this.dustGeo.getAttribute(name) as BufferAttribute).needsUpdate = true;
    this.dustGeo.setDrawRange(0, this.dustBuf.count);
    for (const name of ['position', 'aTile', 'aInfo']) (this.linkGeo.getAttribute(name) as BufferAttribute).needsUpdate = true;
    this.linkGeo.setDrawRange(0, this.tileBuf.count ? LINK_PAIRS * 2 : 0);
    this.U.uGrid.value.set(this.tileBuf.grid.x, this.tileBuf.grid.y);
    const source = this.depth ? `depth ${this.depth.width}x${this.depth.height}` : 'shading for depth';
    console.info(
      `[sorang] built ${p.name}: ${this.tileBuf.grid.x}x${this.tileBuf.grid.y} tiles on ${SLICES} slices, ` +
        `${this.dustBuf.count} dust, ${source}, planar=${this.map.planar.toFixed(2)}, photos=${this.photoMeans.length} ` +
        `(${(performance.now() - started).toFixed(0)} ms)`,
    );
    this.mapDirty = false;
    this.tilesDirty = false;
    this.built = true;
    this.framesSinceBuild = 0;
    if (this.gate.depth || !this.statusNow.busy) this.setStatus(this.builtText(), false);
    else this.notify();
  }

  private builtText(): string {
    const name = this.painting?.name ?? 'No painting';
    return this.built ? `${name} · ${SLICES} slices · ${this.tileBuf.count} tiles` : name;
  }

  private readLook(): void {
    const anchor = this.anchor;
    if (!anchor) return;
    const tiles = this.look.tiles;
    const dust = this.look.dust;
    for (let i = 0; i < LOOK_KEYS.length; i++) {
      const key = LOOK_KEYS[i];
      const value = anchor.getValue(SorangLook, key);
      if (typeof value === 'number' && Number.isFinite(value)) this.look[key] = value;
    }
    this.look.tiles = Math.max(16, Math.min(128, Math.round(this.look.tiles)));
    this.look.dust = Math.max(0, Math.min(384, Math.round(this.look.dust)));
    if (this.look.tiles !== tiles) {
      this.makeTileGeometry(this.look.tiles * this.look.tiles);
      this.tilesDirty = true;
    }
    if (this.look.dust !== dust) {
      this.makeDustGeometry(this.look.dust * this.look.dust);
      this.tilesDirty = true;
    }
  }

  // ---------------------------------------------------------------- view

  private placeView(dt: number, reduced: boolean): void {
    const U = this.U;
    const p = this.painting;
    const aspect = p ? p.display.width / p.display.height : 1;
    const grid = this.tileBuf.grid;
    // Long side is `size`; the short side follows the tile grid so every tile is square.
    const halfW = aspect >= 1 ? this.look.size / 2 : (this.look.size / 2) * (grid.x / Math.max(1, grid.y));
    const halfH = aspect >= 1 ? halfW * (grid.y / Math.max(1, grid.x)) : this.look.size / 2;
    U.uHalf.value.set(halfW, halfH);

    const cam = this.camera;
    const t = Math.tan((cam.fov * Math.PI) / 360);
    this.restD = Math.max(halfH / (FRAMING * t), halfW / (FRAMING * t * cam.aspect));
    U.uOrbitL.value.set(0, 0, this.restD - 1);
    // Fog only for pieces beyond the painting: a narrow window or a big painting sits further back.
    U.uFogStart.value = Math.max(2.5, this.restD + 0.1);
    this.root.updateWorldMatrix(true, false);

    if (this.renderer.xr.isPresenting) {
      this.player.head.getWorldPosition(this.head);
    } else {
      const still = this.timeline.frozen !== null || !this.viewOn;
      const reach = still ? 0 : this.look.parallax * (reduced ? 0.5 : 1);
      if (still) {
        this.parallax.set(0, 0);
      } else {
        const k = 1 - Math.exp(-4 * dt);
        this.parallax.x += (this.pointer.x * reach - this.parallax.x) * k;
        this.parallax.y += (this.pointer.y * reach * 0.6 - this.parallax.y) * k;
      }
      const yaw = reduced ? 0 : this.clocks.arc * ARC_YAW;
      const sway = still || reduced ? 0 : this.clocks.sway * 0.04;
      const s = this.swayClock;
      this.eye.set(
        Math.sin(yaw) * this.restD + this.parallax.x + sway * Math.sin(2 * Math.PI * 0.11 * s),
        this.parallax.y + sway * Math.sin(2 * Math.PI * 0.07 * s + 1),
        Math.cos(yaw) * this.restD,
      );
      this.root.localToWorld(this.eye);
      this.centre.set(0, 0, 0);
      this.root.localToWorld(this.centre);
      this.tmp.copy(this.eye);
      if (cam.parent) {
        cam.parent.updateWorldMatrix(true, false);
        cam.parent.worldToLocal(this.tmp);
      }
      cam.position.copy(this.tmp);
      cam.lookAt(this.centre);
      cam.updateMatrixWorld();
      this.head.copy(this.eye);
    }
    this.root.worldToLocal(U.uHeadL.value.copy(this.head));
  }

  private syncUniforms(reduced: boolean): void {
    const U = this.U;
    const c = this.clocks;
    U.uShow.value = c.show;
    U.uRelief.value = c.relief * this.look.relief;
    U.uQuant.value = c.quant;
    U.uFan.value = c.fan;
    U.uSpan.value = Math.min(this.look.fan, 0.3 * this.restD);
    U.uRadial.value = this.look.radial;
    U.uScan.value = c.scan;
    U.uBurst.value = c.burst;
    U.uDrift.value = c.drift;
    U.uDim.value = c.dim;
    U.uT.value = c.orbit;
    U.uReach.value = REACH * (reduced ? 0.4 : 1);
    U.uContrast.value = this.look.mosaic;
    U.uPhotoOn.value = this.atlas && this.photosOn ? 1 : 0;
    if (this.renderer.xr.isPresenting) {
      const viewport = this.renderer.xr.getCamera().cameras[0]?.viewport;
      if (viewport && viewport.w > 0) U.uViewportH.value = viewport.w;
    } else {
      this.renderer.getDrawingBufferSize(this.bufSize);
      U.uViewportH.value = this.bufSize.y;
    }
  }

  // ---------------------------------------------------------------- input

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (getMode() !== 'sorang' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target as HTMLElement | null)?.tagName ?? '';
    if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'A') return;
    if (e.code === 'KeyR') {
      this.toggleWanted = true;
    } else if (e.code === 'Space') {
      e.preventDefault();
      this.pauseWanted = true;
    }
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || getMode() !== 'sorang') return;
    this.downId = e.pointerId;
    this.down.set(e.clientX, e.clientY);
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.downId) return;
    this.downId = -1;
    if (getMode() !== 'sorang') return;
    if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < CLICK_SLOP) this.toggleWanted = true;
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.pointer.set((e.clientX / w) * 2 - 1, -((e.clientY / h) * 2 - 1));
  };

  // ---------------------------------------------------------------- rig + helpers

  private attach(entity: Entity): void {
    if (this.anchor) return;
    this.anchor = entity;
    this.root.position.set(0, 0, 0);
    entity.object3D?.add(this.root);
    if (this.fallback) {
      this.fallback.dispose();
      this.fallback = null;
    }
    this.onFallback = false;
  }

  private detach(entity: Entity): void {
    if (entity !== this.anchor) return;
    this.root.removeFromParent();
    this.anchor = null;
  }

  private setStatus(text: string, busy: boolean): void {
    this.statusNow = { text, busy };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private message(text: string): void {
    for (const listener of this.messageListeners) listener(text);
  }

  private installHook(): void {
    const timeline = this.timeline;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the getters below need the system
    const sys = this;
    const hook: SorangHook = {
      get ready() {
        return sys.isReady();
      },
      get T() {
        return timeline.frozen ?? timeline.T;
      },
      get stage() {
        return timeline.stage;
      },
      seek: (t) => timeline.seek(t),
      freeze: (t) => timeline.freeze(t),
      pause: () => {
        timeline.paused = true;
      },
      play: () => {
        timeline.paused = false;
      },
      reform: () => timeline.toggle(),
      setPhotos: (on) => {
        this.photosOn = on;
      },
      setView: (on) => {
        this.viewOn = on;
      },
      paintingRect: () => this.paintingRect(),
      stats: () => this.stats(),
    };
    (window as unknown as { __sorang?: SorangHook }).__sorang = hook;
  }

  private isReady(): boolean {
    return this.active && this.gate.painting && this.gate.depth && this.gate.atlas && this.built && !this.pendingAtlas && !this.pendingDepth && this.framesSinceBuild >= 2;
  }

  /** The flat painting's rectangle in CSS pixels, for comparing a capture with the source. */
  private paintingRect(): { x0: number; y0: number; x1: number; y1: number } | null {
    if (!this.root.parent) return null;
    const half = this.U.uHalf.value;
    const canvas = this.renderer.domElement;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    this.root.updateWorldMatrix(true, false);
    this.camera.updateMatrixWorld();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const v = new Vector3(sx * half.x, sy * half.y, 0);
      this.root.localToWorld(v);
      v.project(this.camera);
      const px = ((v.x + 1) / 2) * canvas.clientWidth;
      const py = ((1 - v.y) / 2) * canvas.clientHeight;
      x0 = Math.min(x0, px);
      y0 = Math.min(y0, py);
      x1 = Math.max(x1, px);
      y1 = Math.max(y1, py);
    }
    return { x0, y0, x1, y1 };
  }

  private stats(): Record<string, number> {
    const info = this.renderer.info;
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      points: info.render.points,
      lines: info.render.lines,
      programs: info.programs?.length ?? -1,
      textures: info.memory.textures,
      geometries: info.memory.geometries,
      tiles: this.tileBuf.count,
      dust: this.dustBuf.count,
      // Average since the previous call, so a caller can measure a steady stretch.
      updateMs: this.takeUpdateMs(),
    };
  }

  private takeUpdateMs(): number {
    const ms = this.updates ? this.updateMs / this.updates : 0;
    this.updateMs = 0;
    this.updates = 0;
    return ms;
  }

  private dispose(): void {
    window.clearTimeout(this.depthTimer);
    window.clearTimeout(this.atlasTimer);
    this.root.removeFromParent();
    for (const object of [this.voidMesh, this.tiles, this.dust, this.links]) {
      object.geometry.dispose();
      (object.material as Material).dispose();
    }
    this.paintTex?.dispose();
    this.atlas?.texture.dispose();
    this.pendingAtlas?.texture.dispose();
    this.blank.dispose();
  }
}
