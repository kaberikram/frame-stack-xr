import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Euler,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LineSegments,
  Mesh,
  PlaneGeometry,
  Points,
  Quaternion,
  SRGBColorSpace,
  Vector2,
  Vector3,
  InputComponent,
  createSystem,
  type Entity,
  type Material,
  type Texture,
} from '@iwsdk/core';
import { loadBakedDepth } from './baked-depth.js';
import { cancelDepth, estimateDepth, type DepthField } from './depth-model.js';
import { getMode } from './experience.js';
import {
  MUSIC_URL,
  PAINTING_DEPTH,
  decodeImageFile,
  loadMusicCues,
  loadPainting,
  loadPhotoAtlas,
  type Painting,
  type PhotoAtlas,
} from './sorang-assets.js';
import { SorangBloom, type BloomSwap } from './sorang-bloom.js';
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
import { SorangMusic } from './sorang-music.js';
import { createFeel, feelAt, type MusicCues, type SongFeel } from './sorang-song.js';
import { HOLD_AT, SLICES, SorangTimeline, createClocks, type SorangPhase, type SorangStage } from './sorang-timeline.js';

const LOOK_KEYS = ['size', 'tiles', 'dust', 'relief', 'radial', 'fan', 'mosaic', 'parallax', 'bloom', 'bloomThreshold', 'volume'] as const;
type Look = Record<(typeof LOOK_KEYS)[number], number>;

/** The painting fills this share of the view, leaving room for the relief's outward push. */
const FRAMING = 0.78;
/** The scripted eye arc that shows the fanned slices as layers. */
const ARC_YAW = (20 * Math.PI) / 180;
/** The default painting's depth and photos get this long before it plays without them. */
const GATE_TIMEOUT_MS = 8000;
/**
 * The look was tuned on a painting this size, in metres. Distances that belong to the painting
 * (burst reach, orbit shell, dust size, fog) scale by size / REF_SIZE, so a giant painting
 * bursts into a giant cloud.
 */
const REF_SIZE = 1.83;
/** Burst reach at REF_SIZE, metres. */
const REACH = 2.2;
/** How far a full kick spurs a flying piece outward, and a drop throws it, at REF_SIZE, metres. */
const SPUR = 0.12;
const SHOCK_REACH = 1.1;
/** How much the relief swells on a hit, and the fan on a kick, before the burst. */
const RELIEF_PULSE = 0.12;
const FAN_PULSE = 0.06;
/** The scripted desktop eye stands at this height, metres: a person looking up at the painting. */
const EYE_HEIGHT = 1.6;
/** How quickly the orbits recentre on the viewer, seconds. */
const ORBIT_FOLLOW = 5;
/** How fast the music's pull on the pieces dies away while R runs them home, seconds. */
const FEEL_FADE = 0.2;
/** Seconds a headset session waits for a select that allows sound before playing silently. */
const GESTURE_WAIT = 8;
/** A click on the canvas moves less than this, in CSS pixels. */
const CLICK_SLOP = 5;
/** Desktop walk, once the view is clicked: metres per second, and the faster rate while Shift is held. */
const WALK = 1.8;
const WALK_FAST = 4.2;
/** Radians per pixel of mouse look, and the pitch limit so the view can't flip. */
const LOOK_SENS = 0.0022;
const PITCH_LIMIT = 1.45;
/** Where the painting hangs if the scene has no Sorang node. */
const FALLBACK_POS = new Vector3(0, 2.3, -4.5);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const PARAMS = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
/** `?music=0` plays on a silent clock: no audio, no gesture to wait for, and `ecs_step` advances it exactly. */
const MUSIC_OFF = PARAMS.get('music') === '0';
/** `?bloom=0` turns the glow off, for comparisons and frame-time checks. */
const BLOOM_OFF = PARAMS.get('bloom') === '0';

/** `?sorangT=<song seconds>` freezes the piece there, for deterministic captures. */
function frozenFromUrl(): number | null {
  const raw = PARAMS.get('sorangT');
  if (raw === null) return null;
  const t = Number(raw);
  return Number.isFinite(t) && t >= 0 ? t : null;
}

export interface SorangStatus {
  text: string;
  busy: boolean;
}

/** The window.__sorang test hook. Times are song seconds. */
export interface SorangHook {
  readonly ready: boolean;
  readonly T: number;
  readonly song: number;
  readonly stage: SorangStage;
  readonly phase: SorangPhase;
  /** Play from song second `s`, with the music if it is unlocked. */
  seek(s: number): void;
  freeze(s: number | null): void;
  pause(): void;
  play(): void;
  /** R: run the pieces home and start the song again. */
  rewind(): void;
  setPhotos(on: boolean): void;
  setView(on: boolean): void;
  setBloom(on: boolean): void;
  feel(): SongFeel;
  paintingRect(): { x0: number; y0: number; x1: number; y1: number } | null;
  stats(): Record<string, number | string>;
}

/**
 * Sorang: a giant painting hangs in the dark. In time with its song it takes on depth, splits
 * into 100 depth slices of stock-photo tiles, and bursts into particles that orbit the viewer;
 * the riser pulls them back, the second drop throws them out again, and the outro brings them
 * home. Everything moves on the GPU from one timeline driven by the song; this system loads,
 * builds, writes uniforms, and draws the bloom.
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
  private readonly look: Look = {
    size: 4,
    tiles: 96,
    dust: 256,
    relief: 0.19,
    radial: 0.5,
    fan: 0.33,
    mosaic: 0.9,
    parallax: 0.15,
    bloom: 1.2,
    bloomThreshold: 0.3,
    volume: 0.9,
  };
  private music!: SorangMusic;
  private cues: MusicCues | null = null;
  private cuesStarted = false;
  private readonly feel = createFeel();
  private bloom!: SorangBloom;
  private bloomOn = !BLOOM_OFF;
  /** Objects drawn in the main pass but kept out of the glow. */
  private bloomHidden: Mesh[] = [];
  /** Each piece with the twin material it is drawn with into the glow. */
  private bloomSwaps: BloomSwap[] = [];
  /** Where the orbits centre, painting-local: the viewer, followed slowly. */
  private readonly orbitCentre = new Vector3();
  private orbitPlaced = false;
  /** Head distance from the painting's centre, metres. */
  private viewD = 2.5;
  private lastNeedsClick = false;
  /** Seconds the painting has waited in a headset session for sound to be allowed. */
  private gestureWait = 0;
  /** The XR session whose select events can unlock the music. */
  private session: XRSession | null = null;
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

  private rewindWanted = false;
  private pauseWanted = false;
  private muteWanted = false;
  private readonly pointer = new Vector2();
  private readonly parallax = new Vector2();
  private downId = -1;
  private readonly down = new Vector2();
  private swayClock = 0;
  private restD = 2.5;
  /** Desktop: the viewer has taken the camera. The scripted swing stays until the first look or step. */
  private walking = false;
  private yaw = 0;
  private pitch = 0;
  /** Set when the click only asked for the mouse, so it does not also reform the painting. */
  private lookGrab = false;
  private readonly move = { forward: 0, back: 0, left: 0, right: 0, fast: 0 };
  private readonly feet = new Vector3();
  private readonly worldQuat = new Quaternion();
  private readonly parentQuat = new Quaternion();
  private readonly localQuat = new Quaternion();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly flatForward = new Vector3(0, 0, -1);
  private readonly flatRight = new Vector3(1, 0, 0);

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
    this.bloom = new SorangBloom(this.renderer);
    this.root.add(this.bloom.composite);
    this.bloomHidden = [this.voidMesh];
    // Same uniforms, so the twins always match; each only ever renders into one kind of target.
    this.bloomSwaps = [
      [this.tiles, tileMaterial(this.U)],
      [this.dust, dustMaterial(this.U)],
      [this.links, linkMaterial(this.U)],
    ];
    this.music = new SorangMusic(MUSIC_URL, MUSIC_OFF);
    this.music.onFail = (stage) => {
      this.message(stage === 'context' ? 'This browser won’t play the music. Sorang plays on in silence.' : 'Couldn’t load the music. Sorang plays on in silence.');
      this.notify();
    };

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('mousemove', this.onMouseLook);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    this.renderer.xr.addEventListener('sessionstart', this.onSessionStart);
    this.renderer.xr.addEventListener('sessionend', this.dropSession);
    this.installHook();

    this.cleanupFuncs.push(
      this.queries.anchors.subscribe('qualify', (entity) => this.attach(entity), true),
      this.queries.anchors.subscribe('disqualify', (entity) => this.detach(entity)),
      () => {
        canvas.removeEventListener('pointerdown', this.onPointerDown);
        canvas.removeEventListener('pointerup', this.onPointerUp);
        window.removeEventListener('pointermove', this.onPointerMove);
        window.removeEventListener('mousemove', this.onMouseLook);
        window.removeEventListener('keydown', this.onKeyDown);
        window.removeEventListener('keyup', this.onKeyUp);
        window.removeEventListener('blur', this.onBlur);
        this.renderer.xr.removeEventListener('sessionstart', this.onSessionStart);
        this.renderer.xr.removeEventListener('sessionend', this.dropSession);
        this.dropSession();
        if (document.pointerLockElement === canvas) document.exitPointerLock();
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

  /** Play again from black: the painting fades in, then the song starts from the top. */
  restart(): void {
    this.timeline.restart();
    this.music?.stop();
    if (this.frozenAt !== null) this.timeline.freeze(this.frozenAt);
    this.lastStage = null;
    this.notify();
  }

  /** From a user gesture (a click, a key, Enter VR): the browser lets the music start after one. */
  unlockAudio(): void {
    this.music.unlock();
  }

  /** The painting is waiting for a click before the song can play. */
  get needsClick(): boolean {
    return this.active && this.timeline.waiting && this.music.needsGesture;
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
    this.readXRButtons();
    if (this.rewindWanted) this.rewind();
    if (this.pauseWanted) this.togglePause();
    if (this.muteWanted) this.music.setMuted(!this.music.isMuted);
    this.rewindWanted = false;
    this.pauseWanted = false;
    this.muteWanted = false;

    const reduced = reduceMotion.matches;
    this.music.setVolume(this.look.volume);
    const song = this.music.tick(dt);
    if (this.timeline.phase === 'playing' && this.music.ended) this.timeline.finish();
    const ready = this.gate.painting && this.gate.depth && this.gate.atlas && this.built;
    this.waitForGesture(dt, ready);
    if (this.timeline.waiting && ready && this.music.ready) {
      this.timeline.start();
      this.music.play(0);
      console.info(`[sorang] song starts${this.music.isSilent ? ' (silent clock)' : ''}`);
    }
    this.timeline.update(dt, song, reduced ? 0.2 : 1, this.clocks);
    const frozen = this.timeline.frozen;
    if (frozen !== null || this.timeline.phase === 'playing') {
      feelAt(this.cues, frozen ?? this.timeline.song, this.feel);
    } else if (this.timeline.phase === 'rewind') {
      // Let the spurs and the drop's throw die away as the pieces fly home, not vanish in a frame.
      if (!this.timeline.paused) this.decayFeel(dt);
    } else {
      feelAt(null, -1, this.feel);
    }
    this.swayClock += dt;
    this.placeView(dt, reduced);
    this.syncUniforms(reduced);
    this.drawBloom();
    const stage = this.timeline.stage;
    if (stage !== this.lastStage) {
      this.lastStage = stage;
      console.info(`[sorang] stage=${stage} T=${this.timeline.shownT.toFixed(2)} song=${(frozen ?? this.timeline.song).toFixed(2)}`);
      this.notify();
    }
    const needsClick = this.needsClick;
    if (needsClick !== this.lastNeedsClick) {
      this.lastNeedsClick = needsClick;
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
    this.orbitPlaced = false;
    this.restart();
    this.startMusic();
    if (!this.started) this.startDefault();
    else this.applyPending();
  }

  private leave(): void {
    this.active = false;
    // Back to black now, so the launcher never sees a stale drift stage on re-entry.
    this.restart();
    this.bloom.hide();
    this.rewindWanted = false;
    this.pauseWanted = false;
    this.muteWanted = false;
    this.downId = -1;
    this.dropWalk();
  }

  /** R, or a click once the song has ended: run the pieces home, then the song starts again. */
  private rewind(): void {
    // A frozen timeline ignores input; stopping the music under it would strand the song.
    if (this.timeline.frozen !== null) return;
    this.timeline.rewind();
    this.music.stop();
  }

  private decayFeel(dt: number): void {
    const f = this.feel;
    const k = Math.exp(-dt / FEEL_FADE);
    f.kick *= k;
    f.hit *= k;
    f.bass *= k;
    f.high *= k;
    f.energy *= k;
    f.shock *= k;
  }

  /**
   * A headset session can begin from the browser's own button with no click on the page, and the
   * browser then won't start sound. A select in the session unlocks it; if none comes, play on
   * the silent clock rather than hold the painting forever.
   */
  private waitForGesture(dt: number, ready: boolean): void {
    // Counted only once everything else is ready, so a slow load never spends the wait.
    if (!ready || !this.renderer.xr.isPresenting || !this.timeline.waiting || !this.music.needsGesture) {
      this.gestureWait = 0;
      return;
    }
    this.gestureWait += dt;
    if (this.gestureWait < GESTURE_WAIT) return;
    this.gestureWait = 0;
    this.music.goSilent('was never allowed to start in the headset');
    this.message('The headset didn’t allow sound, so Sorang plays in silence. Pinch or pull a trigger, or use Enter VR on the page, to hear it next time.');
  }

  private readonly onXRSelect = (): void => {
    if (getMode() === 'sorang') this.music.unlock();
  };

  private readonly onSessionStart = (): void => {
    const session = this.renderer.xr.getSession();
    if (!session || session === this.session) return;
    this.dropSession();
    this.session = session;
    // XR select and squeeze count as user activation, so they can start the music.
    session.addEventListener('select', this.onXRSelect);
    session.addEventListener('squeeze', this.onXRSelect);
  };

  private readonly dropSession = (): void => {
    const session = this.session;
    this.session = null;
    if (!session) return;
    session.removeEventListener('select', this.onXRSelect);
    session.removeEventListener('squeeze', this.onXRSelect);
  };

  private togglePause(): void {
    this.timeline.togglePause();
    if (this.timeline.phase !== 'playing') return;
    if (this.timeline.paused) this.music.pause();
    else this.music.resume();
  }

  // ---------------------------------------------------------------- loading

  private startMusic(): void {
    this.music.prefetch();
    if (this.cuesStarted) return;
    this.cuesStarted = true;
    loadMusicCues().then(
      (cues) => {
        this.cues = cues;
        // The song's own length once decoded; until then, the cues know it.
        if (this.music.isSilent || !this.music.ready) this.music.duration = cues.duration;
        console.info(`[sorang] music cues ${cues.duration.toFixed(1)} s, ${cues.kickT.length} kicks, ${cues.hitT.length} hits`);
      },
      (err: unknown) => {
        // Without cues the choreography still follows the song; only the beat pulses are lost.
        console.warn('[sorang] music cues unavailable', err);
      },
    );
  }

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
    this.root.updateWorldMatrix(true, false);

    if (this.renderer.xr.isPresenting) {
      this.player.head.getWorldPosition(this.head);
    } else if (this.walking) {
      this.stepWalk(dt);
      this.writeWalk(cam);
      cam.getWorldPosition(this.head);
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
      this.eye.set(Math.sin(yaw) * this.restD + this.parallax.x + sway * Math.sin(2 * Math.PI * 0.11 * s), 0, Math.cos(yaw) * this.restD);
      this.root.localToWorld(this.eye);
      // A person's eye height, looking up at the painting, so it reads as giant.
      this.eye.y = EYE_HEIGHT + this.parallax.y + sway * Math.sin(2 * Math.PI * 0.07 * s + 1);
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
    const headL = U.uHeadL.value;
    this.root.worldToLocal(headL.copy(this.head));
    this.viewD = Math.max(0.5, headL.length());

    // The orbits circle the viewer, recentring slowly as they walk. A frozen moment snaps, so
    // the same `?sorangT` always renders the same picture.
    if (!this.orbitPlaced || this.timeline.frozen !== null) {
      this.orbitCentre.copy(headL);
      this.orbitPlaced = true;
    } else {
      this.orbitCentre.lerp(headL, 1 - Math.exp(-dt / ORBIT_FOLLOW));
    }
    U.uOrbitL.value.copy(this.orbitCentre);
    const k = this.look.size / REF_SIZE;
    // Fog only for pieces beyond the painting.
    U.uFogStart.value = Math.max(2.5 * k, this.viewD + 0.1);
    U.uFog.value = 0.25 / k;
  }

  private syncUniforms(reduced: boolean): void {
    const U = this.U;
    const c = this.clocks;
    const f = this.feel;
    const size = this.look.size;
    const k = size / REF_SIZE;
    // Before the burst the music swells the relief on its hits and breathes the fan on its kicks.
    const still = 1 - c.burst;
    U.uShow.value = c.show;
    U.uRelief.value = c.relief * this.look.relief * size * (1 + RELIEF_PULSE * f.hit * still);
    U.uQuant.value = c.quant;
    U.uFan.value = c.fan;
    U.uSpan.value = Math.min(this.look.fan * size, 0.3 * this.viewD) * (1 + FAN_PULSE * f.kick * still);
    // The radial push multiplies a depth in metres; divide it back so the shape keeps its proportions.
    U.uRadial.value = this.look.radial / k;
    U.uScan.value = c.scan;
    U.uScanGain.value = 0.6 * (1 + 0.8 * f.hit);
    U.uBurst.value = c.burst;
    U.uDrift.value = c.drift;
    U.uDim.value = c.dim;
    U.uT.value = c.orbit;
    U.uReach.value = REACH * k * (reduced ? 0.4 : 1);
    U.uFocusBack.value = 1.5 * k;
    U.uShell.value.set(0.5 * k, 2.8 * k);
    U.uShellH.value = 1.2 * k;
    U.uDustSize.value = 0.0035 * k;
    U.uKick.value = f.kick;
    U.uHigh.value = f.high;
    U.uShock.value = f.shock;
    U.uSpur.value = SPUR * k * (reduced ? 0.3 : 1);
    U.uShockReach.value = SHOCK_REACH * k * (reduced ? 0.3 : 1);
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

  /** The glow for this frame, after the uniforms are final and before IWSDK renders. */
  private drawBloom(): void {
    // In a VR session the clear is already black; the void only has to cover passthrough.
    const session = this.renderer.xr.isPresenting ? this.renderer.xr.getSession() : null;
    this.voidMesh.visible = !session || session.environmentBlendMode !== 'opaque';
    if (!this.bloomOn || this.look.bloom <= 0) {
      this.bloom.hide();
      return;
    }
    const f = this.feel;
    // The glow belongs to the pieces in flight: on the whole painting it would wash out the photos.
    const burst = this.clocks.burst;
    const flying = burst * burst * (3 - 2 * burst);
    const strength = this.look.bloom * (0.3 + 0.7 * flying) * (0.75 + 0.35 * f.bass + 0.7 * f.kick + 1.2 * f.shock);
    this.bloom.render(this.root, this.camera, this.bloomHidden, this.bloomSwaps, this.U.uViewportH, strength, this.look.bloomThreshold);
  }

  // ---------------------------------------------------------------- input

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // Any key is a gesture the browser accepts for starting the music.
    if (getMode() === 'sorang') this.music.unlock();
    if (this.takeMoveKey(e)) return;
    if (getMode() !== 'sorang' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.typing(e)) return;
    if (e.code === 'KeyR') {
      this.rewindWanted = true;
    } else if (e.code === 'Space') {
      e.preventDefault();
      this.pauseWanted = true;
    } else if (e.code === 'KeyM') {
      this.muteWanted = true;
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.releaseMoveKey(e.code);
  };

  private readonly onBlur = (): void => {
    this.move.forward = 0;
    this.move.back = 0;
    this.move.left = 0;
    this.move.right = 0;
    this.move.fast = 0;
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || getMode() !== 'sorang') return;
    this.music.unlock();
    const canvas = this.renderer.domElement;
    if (!this.renderer.xr.isPresenting && document.pointerLockElement !== canvas) {
      canvas.requestPointerLock();
      this.lookGrab = true;
      return;
    }
    this.downId = e.pointerId;
    this.down.set(e.clientX, e.clientY);
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    // For touch the browser grants the gesture on pointerup, not pointerdown.
    if (getMode() === 'sorang') this.music.unlock();
    if (this.lookGrab) {
      this.lookGrab = false;
      return;
    }
    if (e.pointerId !== this.downId) return;
    this.downId = -1;
    if (getMode() !== 'sorang') return;
    // Once the song has ended, a click plays it again.
    if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < CLICK_SLOP && this.timeline.phase === 'ended') this.rewindWanted = true;
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.pointer.set((e.clientX / w) * 2 - 1, -((e.clientY / h) * 2 - 1));
  };

  private readonly onMouseLook = (e: MouseEvent): void => {
    if (getMode() !== 'sorang' || document.pointerLockElement !== this.renderer.domElement) return;
    this.armWalk();
    this.yaw -= e.movementX * LOOK_SENS;
    this.pitch -= e.movementY * LOOK_SENS;
    if (this.pitch > PITCH_LIMIT) this.pitch = PITCH_LIMIT;
    if (this.pitch < -PITCH_LIMIT) this.pitch = -PITCH_LIMIT;
    this.armWalk();
  };

  /** In the headset: a trigger or pinch plays the song again once it has ended; A or X restarts it. */
  private readXRButtons(): void {
    if (!this.renderer.xr.isPresenting) return;
    const pads = this.input.xr.gamepads;
    const left = pads.left;
    const right = pads.right;
    const select = (left?.getButtonDown(InputComponent.Trigger) ?? false) || (right?.getButtonDown(InputComponent.Trigger) ?? false);
    const restart = (left?.getButtonDown(InputComponent.X_Button) ?? false) || (right?.getButtonDown(InputComponent.A_Button) ?? false);
    // Polling isn't a gesture, but where the browser has already granted one this resumes the music.
    if (select || restart) this.music.unlock();
    if (restart || (select && this.timeline.phase === 'ended')) this.rewindWanted = true;
  }

  /** WASD and arrows walk. Shift is faster. Returns true when the key belongs to the walk. */
  private takeMoveKey(e: KeyboardEvent): boolean {
    const move = this.moveKey(e.code);
    if (!move) return false;
    if (getMode() !== 'sorang' || this.renderer.xr.isPresenting || this.typing(e)) return true;
    e.preventDefault();
    if (move === 'fast') this.move.fast = 1;
    else {
      this.move[move] = 1;
      this.armWalk();
    }
    return true;
  }

  private releaseMoveKey(code: string): void {
    const move = this.moveKey(code);
    if (!move) return;
    if (move === 'fast') this.move.fast = 0;
    else this.move[move] = 0;
  }

  private moveKey(code: string): 'forward' | 'back' | 'left' | 'right' | 'fast' | null {
    switch (code) {
      case 'KeyW':
      case 'ArrowUp':
        return 'forward';
      case 'KeyS':
      case 'ArrowDown':
        return 'back';
      case 'KeyA':
      case 'ArrowLeft':
        return 'left';
      case 'KeyD':
      case 'ArrowRight':
        return 'right';
      case 'ShiftLeft':
      case 'ShiftRight':
        return 'fast';
      default:
        return null;
    }
  }

  private typing(e: KeyboardEvent): boolean {
    const tag = (e.target as HTMLElement | null)?.tagName ?? '';
    return tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'A';
  }

  /** Keep the pose the scripted view had, then stop driving it. */
  private armWalk(): void {
    if (this.walking || this.renderer.xr.isPresenting || getMode() !== 'sorang') return;
    const cam = this.camera;
    cam.getWorldPosition(this.feet);
    cam.getWorldQuaternion(this.worldQuat);
    this.euler.setFromQuaternion(this.worldQuat, 'YXZ');
    this.yaw = this.euler.y;
    this.pitch = this.euler.x;
    this.walking = true;
  }

  private dropWalk(): void {
    this.walking = false;
    this.lookGrab = false;
    this.onBlur();
    if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock();
  }

  private stepWalk(dt: number): void {
    this.euler.set(this.pitch, this.yaw, 0, 'YXZ');
    this.worldQuat.setFromEuler(this.euler);
    this.tmp.set(0, 0, -1).applyQuaternion(this.worldQuat);
    this.tmp.y = 0;
    if (this.tmp.lengthSq() > 0.04) {
      this.tmp.normalize();
      this.flatForward.copy(this.tmp);
      this.tmp.set(1, 0, 0).applyQuaternion(this.worldQuat);
      this.tmp.y = 0;
      if (this.tmp.lengthSq() > 1e-6) this.flatRight.copy(this.tmp.normalize());
    }
    const speed = (this.move.fast ? WALK_FAST : WALK) * dt;
    const ahead = this.move.forward - this.move.back;
    const side = this.move.right - this.move.left;
    if (ahead !== 0) this.feet.addScaledVector(this.flatForward, ahead * speed);
    if (side !== 0) this.feet.addScaledVector(this.flatRight, side * speed);
  }

  private writeWalk(cam: typeof this.camera): void {
    this.tmp.copy(this.feet);
    const parent = cam.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      parent.worldToLocal(this.tmp);
      parent.getWorldQuaternion(this.parentQuat);
      this.localQuat.copy(this.parentQuat).invert().multiply(this.worldQuat);
      cam.quaternion.copy(this.localQuat);
    } else {
      cam.quaternion.copy(this.worldQuat);
    }
    cam.position.copy(this.tmp);
    cam.updateMatrixWorld();
  }

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
        return timeline.shownT;
      },
      get song() {
        return timeline.frozen ?? timeline.song;
      },
      get stage() {
        return timeline.stage;
      },
      get phase() {
        return timeline.phase;
      },
      seek: (s) => {
        timeline.freeze(null);
        timeline.start();
        this.music.play(s);
      },
      freeze: (s) => timeline.freeze(s),
      pause: () => {
        if (!timeline.paused) this.togglePause();
      },
      play: () => {
        if (timeline.paused) this.togglePause();
      },
      rewind: () => this.rewind(),
      setPhotos: (on) => {
        this.photosOn = on;
      },
      setView: (on) => {
        this.viewOn = on;
      },
      setBloom: (on) => {
        this.bloomOn = on;
      },
      feel: () => ({ ...this.feel }),
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

  private stats(): Record<string, number | string> {
    const info = this.renderer.info;
    const src = this.bloom.sourceSize;
    return {
      bloom: this.bloom.mode ?? 'off',
      bloomSize: `${src.w}x${src.h}`,
      music: this.music.isSilent ? 'silent' : this.music.isPlaying ? 'playing' : this.music.needsGesture ? 'locked' : 'idle',
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
    this.bloom.dispose();
    for (const [, twin] of this.bloomSwaps) twin.dispose();
    this.music.dispose();
  }
}
