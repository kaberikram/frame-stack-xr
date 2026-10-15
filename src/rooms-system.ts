import {
  Group,
  InstancedBufferGeometry,
  LineSegments,
  Mesh,
  PlaneGeometry,
  Vector2,
  Vector3,
  createSystem,
  type Entity,
  type Material,
} from '@iwsdk/core';
import { getMode } from './experience.js';
import { LAYERS, MUSIC_URL } from './rooms-assets.js';
import {
  createRoomsUniforms,
  currentFrameMaterial,
  frameGeometry,
  frameMaterial,
  rulerGeometry,
  rulerMaterial,
  type FrameUniforms,
  type RoomsUniforms,
} from './rooms-build.js';
import { RoomsCamera, createPose, segmentHitsBox } from './rooms-camera.js';
import { RoomsLook } from './rooms-component.js';
import { BOXES, WALL, boxHeight, type BoxSpec } from './rooms-layout.js';
import {
  BAR,
  SHOT_TIMES,
  SONG_LENGTH,
  arrivalFlareAt,
  barTime,
  beatsAt,
  energyAt,
  fadeAt,
  flashAt,
  isRoom,
  kickAt,
  presenceAt,
  sectionAt,
  type ShotView,
} from './rooms-score.js';
import { RoomsVideos, type VideoSlot } from './rooms-videos.js';
import { SorangBloom, type BloomSwap } from './sorang-bloom.js';
import { SorangMusic } from './sorang-music.js';
import { createStackUniforms, ghostMaterial, haloMaterial, type StackUniforms } from './stack-materials.js';

const LOOK_KEYS = ['ghost', 'trail', 'feather', 'glow', 'kick', 'focusDim', 'flash', 'parallax', 'bloom', 'bloomThreshold', 'volume'] as const;
type Look = Record<(typeof LOOK_KEYS)[number], number>;

/** Seconds the empty frame takes to fade in before the song can start. */
const PREROLL = 1.2;
/** Where the frame stands if the scene has no Rooms node. */
const FALLBACK_POS = new Vector3(0, 0, -20);
/** A box this close to the line from the camera to the one it faces fades out of the way, metres. */
const OCCLUDE_MARGIN = 0.2;
/** How fast an occluding box fades, per second. */
const OCCLUDE_RATE = 10;
/** A click on the canvas moves less than this, in CSS pixels. */
const CLICK_SLOP = 5;
const DEG = Math.PI / 180;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const PARAMS = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
/** `?music=0` plays on a silent clock: no audio and no click to wait for. */
const MUSIC_OFF = PARAMS.get('music') === '0';
/** `?bloom=0` turns the glow off. */
const BLOOM_OFF = PARAMS.get('bloom') === '0';

/** `?roomsT=<song seconds>` freezes the piece there, for repeatable captures. */
function frozenFromUrl(): number | null {
  const raw = PARAMS.get('roomsT');
  if (raw === null) return null;
  const t = Number(raw);
  return Number.isFinite(t) && t >= 0 ? t : null;
}

export type RoomsPhase = 'preroll' | 'playing' | 'ended';

export interface RoomsStatus {
  text: string;
  busy: boolean;
}

/** The window.__rooms test hook. Times are song seconds. */
export interface RoomsHook {
  readonly song: number;
  readonly phase: RoomsPhase;
  readonly section: string;
  /** Bars since beat 1, fractional. */
  readonly bar: number;
  readonly shot: { view: string; move: string; at: number };
  seek(s: number): void;
  freeze(s: number | null): void;
  pause(): void;
  play(): void;
  restart(): void;
  setBloom(on: boolean): void;
  stats(): Record<string, number | string>;
}

interface StackRig {
  readonly spec: BoxSpec;
  readonly slot: VideoSlot;
  /** Frame stack's own uniforms: layers, spacing, ghost, trail, feather, halo. */
  readonly S: StackUniforms;
  /** The sharp frame's and the ruler's. */
  readonly F: FrameUniforms;
  readonly group: Group;
  readonly ghosts: Mesh;
  readonly current: Mesh;
  readonly halo: Mesh;
  readonly ruler: LineSegments;
  /** Frame height, metres. */
  readonly h: number;
  /** 0..1, fading while it stands between the camera and the room it is on. */
  occ: number;
  /** Camera distance this frame, for drawing the stacks far to near. */
  dist: number;
}

/** Each stack's draw-order block: ghosts, then its sharp frame, halo and ruler. */
const ORDER_BASE = 100;
const ORDER_STEP = 10;

function viewName(view: ShotView): string {
  return isRoom(view) ? `room ${view.room + 1} (${BOXES[view.room]?.name ?? '?'}) ${view.angle}` : view;
}

/**
 * Rooms: five clips floating inside a grid frame under a vault, each as a frame stack like Frame
 * stack's: its frames as feathered ghost layers along a time axis, the clip itself travelling
 * through them sharp and lit, and a time ruler underneath. The camera follows the shot list in
 * `rooms-score.ts`: eased flights in the verses, hard cuts on the beat in the drops, face on to see
 * a clip in full or round its stack. Everything is a function of the song second, so any moment
 * can be frozen and captured. Desktop only.
 */
export class RoomsSystem extends createSystem({ anchors: { required: [RoomsLook] } }) {
  private U!: RoomsUniforms;
  private root!: Group;
  private frame!: LineSegments;
  private rooms: StackRig[] = [];
  /** Room indices, far to near, re-sorted each frame without allocating. */
  private readonly drawOrder: number[] = BOXES.map((_, i) => i);
  private bloom!: SorangBloom;
  private bloomOn = !BLOOM_OFF;
  private bloomSwaps: BloomSwap[] = [];
  private twins: Material[] = [];
  private music!: SorangMusic;
  private videos!: RoomsVideos;
  private readonly cam = new RoomsCamera();
  private readonly pose = createPose();
  private readonly look: Look = {
    ghost: 0.6,
    trail: 5,
    feather: 0.2,
    glow: 0.4,
    kick: 1,
    focusDim: 0.75,
    flash: 1,
    parallax: 1,
    bloom: 0.8,
    bloomThreshold: 0.6,
    volume: 0.9,
  };

  private phase: RoomsPhase = 'preroll';
  private paused = false;
  private prerollT = 0;
  /** The song second on screen while playing. */
  private song = 0;
  private frozen: number | null = frozenFromUrl();
  private active = false;
  private anchor: Entity | null = null;
  private fallback: Entity | null = null;
  private onFallback = false;
  /** The camera's own lens, put back when Rooms lets go of it. */
  private savedLens: { fov: number; far: number } | null = null;
  private lastShot = -1;
  private lastNeedsClick = false;

  private restartWanted = false;
  private pauseWanted = false;
  private muteWanted = false;
  private seekBars = 0;
  private downId = -1;
  private readonly down = new Vector2();
  private readonly pointer = new Vector2();
  private readonly parallax = new Vector2();

  private readonly eyeL = new Vector3();
  private readonly aimL = new Vector3();
  private readonly eyeW = new Vector3();
  private readonly targetW = new Vector3();
  private readonly tmp = new Vector3();
  private readonly bufSize = new Vector2();
  private statusNow: RoomsStatus = { text: 'Building the rooms', busy: true };
  private readonly listeners = new Set<() => void>();
  private updateMs = 0;
  private updates = 0;

  init(): void {
    this.U = createRoomsUniforms();

    this.root = new Group();
    this.root.name = 'rooms';
    this.root.visible = false;
    this.videos = new RoomsVideos(BOXES);
    this.videos.onChange = (slot) => {
      const rig = this.rooms.find((r) => r.slot === slot);
      if (rig) this.useClip(rig);
      this.refreshStatus();
    };

    this.frame = new LineSegments(frameGeometry(), frameMaterial(this.U));
    this.frame.renderOrder = 15;
    this.addPiece(this.frame, frameMaterial(this.U));

    // One quad for every frame: each stack scales it to its frames' size.
    const quad = new PlaneGeometry(1, 1);
    for (const spec of BOXES) this.rooms.push(this.buildStack(spec, quad));

    this.bloom = new SorangBloom(this.renderer, 'rooms');
    this.bloom.composite.name = 'rooms-bloom';
    this.root.add(this.bloom.composite);

    this.music = new SorangMusic(MUSIC_URL, MUSIC_OFF, 'rooms');
    this.music.duration = SONG_LENGTH;
    this.music.onFail = () => this.refreshStatus();

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('keydown', this.onKeyDown);
    this.installHook();
    this.refreshStatus();

    this.cleanupFuncs.push(
      this.queries.anchors.subscribe('qualify', (entity) => this.attach(entity), true),
      this.queries.anchors.subscribe('disqualify', (entity) => this.detach(entity)),
      () => {
        canvas.removeEventListener('pointerdown', this.onPointerDown);
        canvas.removeEventListener('pointerup', this.onPointerUp);
        window.removeEventListener('pointermove', this.onPointerMove);
        window.removeEventListener('keydown', this.onKeyDown);
        delete (window as unknown as { __rooms?: RoomsHook }).__rooms;
        this.dispose();
      },
    );
  }

  // ---------------------------------------------------------------- launcher API

  status(): RoomsStatus {
    return this.statusNow;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** From a user gesture (the tab, a click, a key): the browser lets the music start after one. */
  unlockAudio(): void {
    this.music.unlock();
  }

  /** The frame is up and waiting for a click before the song can play. */
  get needsClick(): boolean {
    return this.active && this.frozen === null && this.phase === 'preroll' && this.music.needsGesture;
  }

  get currentPhase(): RoomsPhase {
    return this.phase;
  }

  /** Play again from the top. After the song has ended the frame fades back in first. */
  restart(): void {
    this.restartWanted = true;
  }

  // ---------------------------------------------------------------- frame loop

  update(delta: number): void {
    // Desktop only: a headset session (the browser can offer one by itself) stops the piece.
    const on = getMode() === 'rooms' && !this.renderer.xr.isPresenting;
    this.root.visible = on;
    if (!on) {
      if (this.active) this.leave();
      return;
    }
    const start = performance.now();
    if (!this.active) this.enter();
    const dt = Math.min(0.1, delta);
    this.readLook();
    if (this.restartWanted) this.doRestart();
    if (this.pauseWanted) this.togglePause();
    if (this.muteWanted) this.music.setMuted(!this.music.isMuted);
    if (this.seekBars !== 0) this.seekBy(this.seekBars);
    this.restartWanted = false;
    this.pauseWanted = false;
    this.muteWanted = false;
    this.seekBars = 0;

    this.music.setVolume(this.look.volume);
    const heard = this.music.tick(dt);
    if (this.phase === 'preroll') {
      this.prerollT += dt;
      if (this.frozen === null && this.prerollT >= PREROLL && this.music.ready) this.begin();
    } else if (this.phase === 'playing') {
      if (!this.paused) this.song = heard;
      if (this.music.ended) {
        this.phase = 'ended';
        this.videos.pause();
        this.notify();
      }
    }
    const s = this.frozen ?? (this.phase === 'preroll' ? 0 : this.phase === 'ended' ? SONG_LENGTH : this.song);
    if (this.frozen !== null) this.videos.hold(this.frozen);
    this.draw(s, dt);

    const needsClick = this.needsClick;
    if (needsClick !== this.lastNeedsClick) {
      this.lastNeedsClick = needsClick;
      this.notify();
    }
    this.updateMs += performance.now() - start;
    this.updates++;
  }

  private enter(): void {
    this.active = true;
    if (!this.anchor && !this.onFallback) {
      console.warn('[rooms] no RoomsLook node in the scene; standing the frame at the default spot');
      const holder = new Group();
      holder.add(this.root);
      this.fallback = this.world.createTransformEntity(holder);
      this.fallback.object3D?.position.copy(FALLBACK_POS);
      this.onFallback = true;
    }
    this.savedLens = { fov: this.camera.fov, far: this.camera.far };
    this.music.prefetch();
    this.videos.load();
    this.toPreroll(true);
    this.lastShot = -1;
    this.parallax.set(0, 0);
  }

  private leave(): void {
    this.active = false;
    this.music.stop();
    // Release the decoders too: the other modes (and a headset's 2D page) need them more.
    this.videos.unload();
    for (const rig of this.rooms) this.useClip(rig);
    this.bloom.hide();
    this.toPreroll(true);
    this.downId = -1;
    this.releaseCamera();
  }

  /** The lens back as it was. Safe to call twice. */
  private releaseCamera(): void {
    const lens = this.savedLens;
    if (!lens) return;
    this.savedLens = null;
    this.camera.fov = lens.fov;
    this.camera.far = lens.far;
    this.camera.updateProjectionMatrix();
  }

  /** Back to the empty frame, waiting for the song. `fromBlack` fades the frame in again. */
  private toPreroll(fromBlack: boolean): void {
    this.phase = 'preroll';
    this.paused = false;
    this.song = 0;
    this.prerollT = fromBlack ? 0 : PREROLL;
    this.notify();
  }

  private begin(): void {
    this.phase = 'playing';
    this.paused = false;
    this.song = 0;
    this.music.play(0);
    this.videos.restart();
    this.videos.play();
    console.info(`[rooms] song starts${this.music.isSilent ? ' (silent clock)' : ''}, ${this.videos.liveCount}/${BOXES.length} clips`);
    this.notify();
  }

  private doRestart(): void {
    if (this.frozen !== null) return;
    this.music.stop();
    this.videos.pause();
    this.toPreroll(this.phase === 'ended');
  }

  private togglePause(): void {
    if (this.frozen !== null || this.phase !== 'playing') return;
    this.paused = !this.paused;
    if (this.paused) {
      this.music.pause();
      this.videos.pause();
    } else {
      this.music.resume();
      this.videos.play();
    }
  }

  /** ←/→: jump to the start of the bar before or after this one. */
  private seekBy(bars: number): void {
    if (this.frozen !== null || this.phase !== 'playing') return;
    const here = Math.floor(beatsAt(this.song) / 4 + 1e-3);
    const to = Math.min(SONG_LENGTH - 0.5, Math.max(0, barTime(Math.max(0, here + bars))));
    this.music.seek(to);
    this.song = to;
  }

  // ---------------------------------------------------------------- drawing

  private draw(s: number, dt: number): void {
    const U = this.U;
    const look = this.look;
    const reduced = reduceMotion.matches;
    const preroll = this.phase === 'preroll' && this.frozen === null;
    const energy = preroll ? 0 : energyAt(s);
    const kick = preroll ? 0 : kickAt(s) * look.kick;

    // The camera, root-local, then into the world.
    const cam = this.camera;
    this.cam.evaluate(s, cam.aspect || 1, reduced ? 0 : kick, this.pose);
    const pose = this.pose;
    if (this.frozen === null) {
      const k = 1 - Math.exp(-3 * dt);
      this.parallax.x += (this.pointer.x - this.parallax.x) * k;
      this.parallax.y += (this.pointer.y - this.parallax.y) * k;
      const reach = look.parallax * (reduced ? 0.5 : 1) * (1 - this.cam.focus) * DEG;
      pose.az -= this.parallax.x * 2.5 * reach;
      pose.el += this.parallax.y * 1.5 * reach;
    }
    RoomsCamera.eye(pose, this.eyeL);
    this.root.updateWorldMatrix(true, false);
    this.eyeW.copy(this.eyeL);
    this.root.localToWorld(this.eyeW);
    this.targetW.copy(pose.target);
    this.root.localToWorld(this.targetW);
    this.tmp.copy(this.eyeW);
    if (cam.parent) {
      cam.parent.updateWorldMatrix(true, false);
      cam.parent.worldToLocal(this.tmp);
    }
    cam.position.copy(this.tmp);
    cam.lookAt(this.targetW);
    // Far enough for the outro's long pull, however tall the window.
    const far = Math.max(this.savedLens?.far ?? cam.far, pose.dist + 30);
    if (cam.fov !== pose.fov || cam.far !== far) {
      cam.fov = pose.fov;
      cam.far = far;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();

    const st = this.cam.state;
    const shot = SHOT_TIMES[st.to];
    const cut = st.to !== this.lastShot && shot.move === 'cut';
    if (st.to !== this.lastShot) {
      this.lastShot = st.to;
      if (this.frozen === null && this.phase === 'playing') {
        console.info(`[rooms] shot=${viewName(shot.view)} ${shot.move} bar=${(beatsAt(shot.at) / 4).toFixed(2)} s=${shot.at.toFixed(2)} ${sectionAt(shot.at).name}`);
      }
    }

    // Shared uniforms.
    const fade = fadeAt(s);
    const frameShow = preroll ? smooth01(this.prerollT / PREROLL) : this.phase === 'ended' && this.frozen === null ? 0 : 1 - fade;
    const beats = beatsAt(s);
    U.uEnergy.value = energy;
    U.uBeatAge.value = s < 0.045 ? 1 : (beats - Math.floor(beats)) * (BAR / 4);
    U.uRing.value = (sectionAt(s).kind === 'drop' ? 1 : 0.3) * energy * look.kick;
    U.uFrameShow.value = frameShow;
    const barPhase = beats / 4 - Math.floor(beats / 4);
    U.uScan.value.set(barPhase * WALL * 1.1 - 0.3, preroll ? 0 : 0.35 + 0.65 * energy);
    // A cut flares the scene's own light: edges, grid and glow.
    const flash = preroll ? 0 : flashAt(s, st) * look.flash * (reduced ? 0.3 : 1);
    U.uFlash.value = flash;
    this.renderer.getDrawingBufferSize(this.bufSize);
    U.uViewportH.value = this.bufSize.y;

    // Focus: the room in view stays lit; the others dim and any in the way fade out.
    const focus = this.cam.focus;
    const focusSlot = this.cam.focusSlot;
    const focused = focusSlot >= 0 ? this.rooms[focusSlot] : null;
    // What the camera looks at is the room's own centre or front, so it never counts as in the way.
    this.aimL.copy(pose.target);
    const snap = cut || this.frozen !== null;
    const kOcc = snap ? 1 : 1 - Math.exp(-OCCLUDE_RATE * dt);
    // Frame stack's ghost opacity, normalised by the layer count so density reads the same at any count.
    const ghostK = (look.ghost / 0.5) ** 2;
    const ghost = 1 - Math.exp((-6.75 * ghostK) / Math.max(2, LAYERS));
    for (const rig of this.rooms) {
      const spec = rig.spec;
      const presence = preroll ? 0 : presenceAt(s, spec.order);
      const mine = rig === focused;
      const dim = focused && !mine ? look.focusDim * focus : 0;
      const blocking = focused !== null && !mine && focus > 0.05 && segmentHitsBox(this.eyeL, this.aimL, spec, OCCLUDE_MARGIN);
      rig.occ += ((blocking ? 0 : 1) - rig.occ) * kOcc;
      const bright = (1 - dim) * rig.occ;
      const flare = preroll ? 0 : arrivalFlareAt(s, spec.order);
      this.syncStack(rig, s, presence, bright, mine ? this.cam.frontness : 0, ghost, kick, flare, flash);
    }
    this.sortStacks();

    // The glow: everything glows a little, and it swells on the drops and the cuts.
    if (!this.bloomOn || look.bloom <= 0 || frameShow <= 0) {
      this.bloom.hide();
      return;
    }
    const strength = look.bloom * (0.55 + 0.45 * energy + 0.4 * flash) * Math.max(frameShow, 0.2);
    this.bloom.render(this.root, cam, NOTHING_HIDDEN, this.bloomSwaps, U.uViewportH, strength, look.bloomThreshold);
  }

  // ---------------------------------------------------------------- input

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (getMode() !== 'rooms') return;
    // Any key is a gesture the browser accepts for starting the music.
    this.music.unlock();
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
    if (e.code === 'KeyR') {
      this.restartWanted = true;
    } else if (e.code === 'Space') {
      e.preventDefault();
      this.pauseWanted = true;
    } else if (e.code === 'KeyM') {
      this.muteWanted = true;
    } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      e.preventDefault();
      this.seekBars += e.code === 'ArrowLeft' ? -1 : 1;
    }
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || getMode() !== 'rooms') return;
    this.music.unlock();
    this.downId = e.pointerId;
    this.down.set(e.clientX, e.clientY);
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (getMode() !== 'rooms') return;
    // For touch the browser grants the gesture on pointerup, not pointerdown.
    this.music.unlock();
    if (e.pointerId !== this.downId) return;
    this.downId = -1;
    // Once the song has ended, a click plays it again.
    if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < CLICK_SLOP && this.phase === 'ended') this.restartWanted = true;
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.pointer.set((e.clientX / w) * 2 - 1, -((e.clientY / h) * 2 - 1));
  };

  // ---------------------------------------------------------------- helpers

  /** Add a piece to the root, drawn with `twin` into the glow. */
  private addPiece(object: Mesh | LineSegments, twin: Material, parent = true): void {
    object.raycast = () => {};
    if (parent) this.root.add(object);
    this.bloomSwaps.push([object, twin]);
    this.twins.push(twin);
  }

  /** One room: its frames as ghost layers, the clip itself as the sharp frame, its halo, and the time ruler. */
  private buildStack(spec: BoxSpec, quad: PlaneGeometry): StackRig {
    const slot = this.videos.slots[spec.slot];
    const h = boxHeight(spec);
    const S = createStackUniforms(slot.frames);
    S.n.value = LAYERS;
    S.loaded.value = 0;
    S.z0.value = spec.d / 2;
    S.spacing.value = LAYERS > 1 ? spec.d / (LAYERS - 1) : 0;
    // Every layer keeps its slot; the sharp frame is drawn over its own.
    S.lift.value = 1;
    S.haloHalf.value.set(spec.w / 2, h / 2);
    S.haloReach.value = 0.05 * spec.w;
    const F: FrameUniforms = {
      uVideo: { value: this.videos.texture(slot) },
      uBright: { value: 0 },
      uGlow: { value: this.look.glow },
      uFeather: S.feather,
      uCur: { value: 0 },
      uRuler: { value: 0 },
    };
    const group = new Group();
    group.name = `rooms-stack-${spec.slot + 1}`;
    group.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
    group.rotation.y = spec.yaw * DEG;
    const geo = new InstancedBufferGeometry();
    geo.setIndex(quad.getIndex());
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    geo.instanceCount = LAYERS;
    const ghosts = new Mesh(geo, ghostMaterial(S));
    ghosts.scale.set(spec.w, h, 1); // x/y only: the layers' z offsets come from the shader
    ghosts.frustumCulled = false;
    const current = new Mesh(quad, currentFrameMaterial(F));
    current.scale.set(spec.w, h, 1);
    const halo = new Mesh(quad, haloMaterial(S));
    halo.frustumCulled = false; // sized in its shader
    const ruler = new LineSegments(rulerGeometry(spec.w, h, spec.d, LAYERS), rulerMaterial(F));
    group.add(ghosts, current, halo, ruler);
    this.root.add(group);
    this.addPiece(ghosts, ghostMaterial(S), false);
    this.addPiece(current, currentFrameMaterial(F), false);
    this.addPiece(halo, haloMaterial(S), false);
    this.addPiece(ruler, rulerMaterial(F), false);
    return { spec, slot, S, F, group, ghosts, current, halo, ruler, h, occ: 1, dist: 0 };
  }

  /**
   * One room's frame for song second `s`. `presence` builds it up frame by frame (and takes it
   * apart), `bright` dims it while another room is in view, and `frontness` brings the sharp
   * frame from its slot in the stack to the front, for the face-on views.
   */
  private syncStack(rig: StackRig, s: number, presence: number, bright: number, frontness: number, ghost: number, kick: number, flare: number, flash: number): void {
    const { S, F, spec } = rig;
    const look = this.look;
    // Where the clip is in its loop is where its sharp frame sits in the stack.
    const cur = Math.min(LAYERS - 1, this.videos.phase(rig.slot, s) * LAYERS);
    const shown = Math.min(1, presence * 1.4);
    S.loaded.value = presence * LAYERS;
    S.cur.value = Math.round(cur);
    S.focus.value = cur;
    S.ghost.value = ghost * bright;
    S.peak.value = (0.38 + 0.3 * kick) * bright;
    S.spread.value = look.trail;
    S.feather.value = look.feather;
    F.uGlow.value = look.glow;

    // The camera in the stack's frame: draw each side from its far end inward, like Frame stack.
    const dx = this.eyeL.x - spec.pos[0];
    const dz = this.eyeL.z - spec.pos[2];
    const dy = this.eyeL.y - spec.pos[1];
    const yaw = spec.yaw * DEG;
    const localZ = dx * Math.sin(yaw) + dz * Math.cos(yaw);
    const ci = S.spacing.value > 0 ? (S.z0.value - localZ) / S.spacing.value : -1e4;
    S.split.value = Math.min(LAYERS, Math.max(0, Math.floor(ci) + 1));
    rig.dist = dx * dx + dy * dy + dz * dz;

    // The sharp frame: in its slot, or at the front of the stack when the camera is face on.
    const slotZ = S.z0.value - cur * S.spacing.value;
    const z = slotZ + (S.z0.value + 0.6 * S.spacing.value - slotZ) * frontness;
    rig.current.position.set(0, 0, z);
    rig.halo.position.set(0, 0, z);
    F.uBright.value = bright * shown;
    const m = Math.round(cur) * 3;
    const means = rig.slot.means;
    S.haloColor.value.setRGB(Math.min(1, means[m] * 1.6 + 0.02), Math.min(1, means[m + 1] * 1.6 + 0.02), Math.min(1, means[m + 2] * 1.6 + 0.02));
    S.haloStrength.value = 0.18 * look.glow * bright * shown * (1 + 0.8 * kick + 2 * flare + 1.2 * flash);
    F.uCur.value = cur;
    F.uRuler.value = bright * presence * (0.5 + 0.6 * kick + flash);
    rig.group.visible = presence > 0.001 && rig.occ > 0.01;
  }

  /** Transparent stacks draw far to near, each as one block, so a near stack's layers veil a far one's frame. */
  private sortStacks(): void {
    const order = this.drawOrder;
    const rooms = this.rooms;
    for (let i = 1; i < order.length; i++) {
      const k = order[i];
      let j = i - 1;
      while (j >= 0 && rooms[order[j]].dist < rooms[k].dist) {
        order[j + 1] = order[j];
        j--;
      }
      order[j + 1] = k;
    }
    for (let rank = 0; rank < order.length; rank++) {
      const rig = rooms[order[rank]];
      const base = ORDER_BASE + rank * ORDER_STEP;
      rig.ghosts.renderOrder = base;
      rig.current.renderOrder = base + 2;
      rig.halo.renderOrder = base + 3;
      rig.ruler.renderOrder = base + 4;
    }
  }

  /** A slot's clip or frame sheet has landed: the sharp frame shows the clip, the layers its frames. */
  private useClip(rig: StackRig): void {
    rig.F.uVideo.value = this.videos.texture(rig.slot);
    rig.S.frames.value = rig.slot.frames;
  }

  private readLook(): void {
    const entity = this.anchor;
    if (!entity) return;
    for (const key of LOOK_KEYS) {
      const v = entity.getValue(RoomsLook, key);
      if (typeof v === 'number' && Number.isFinite(v)) this.look[key] = v;
    }
  }

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

  private refreshStatus(): void {
    const live = this.videos.liveCount;
    const clips = live === 0 ? `${BOXES.length} rooms, test cards until clips arrive` : live === BOXES.length ? `${BOXES.length} rooms, all clips loaded` : `${BOXES.length} rooms, ${live} clips and ${BOXES.length - live} test cards`;
    const music = this.music.isSilent ? ' · silent clock' : '';
    this.statusNow = { text: `${clips}${music}`, busy: false };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private installHook(): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the getters below need the system
    const sys = this;
    const shown = () => sys.frozen ?? sys.song;
    const hook: RoomsHook = {
      get song() {
        return shown();
      },
      get phase() {
        return sys.phase;
      },
      get section() {
        return sectionAt(shown()).name;
      },
      get bar() {
        return beatsAt(shown()) / 4;
      },
      get shot() {
        const shot = SHOT_TIMES[sys.cam.state.to];
        return { view: viewName(shot.view), move: shot.move, at: shot.at };
      },
      seek: (s) => {
        this.frozen = null;
        if (this.phase !== 'playing') this.begin();
        this.music.play(s);
        this.song = Math.max(0, s);
        // Playing from there, so it no longer counts as paused.
        if (this.paused) {
          this.paused = false;
          this.videos.play();
        }
      },
      freeze: (s) => {
        this.frozen = s === null ? null : Math.max(0, s);
        if (s === null && this.phase === 'playing' && !this.paused) this.videos.play();
      },
      pause: () => {
        if (!this.paused) this.togglePause();
      },
      play: () => {
        if (this.paused) this.togglePause();
      },
      restart: () => this.restart(),
      setBloom: (on) => {
        this.bloomOn = on;
      },
      stats: () => this.stats(),
    };
    (window as unknown as { __rooms?: RoomsHook }).__rooms = hook;
  }

  private stats(): Record<string, number | string> {
    const info = this.renderer.info;
    const src = this.bloom.sourceSize;
    const ms = this.updates ? this.updateMs / this.updates : 0;
    this.updateMs = 0;
    this.updates = 0;
    return {
      bloom: this.bloom.mode ?? 'off',
      bloomSize: `${src.w}x${src.h}`,
      music: this.music.isSilent ? 'silent' : this.music.isPlaying ? 'playing' : this.music.needsGesture ? 'locked' : 'idle',
      clips: `${this.videos.liveCount}/${BOXES.length}`,
      stacks: `${this.videos.stackedCount}/${BOXES.length}`,
      fov: this.camera.fov,
      far: this.camera.far,
      calls: info.render.calls,
      triangles: info.render.triangles,
      points: info.render.points,
      lines: info.render.lines,
      programs: info.programs?.length ?? -1,
      textures: info.memory.textures,
      // Average since the previous call, so a caller can measure a steady stretch.
      updateMs: ms,
    };
  }

  private dispose(): void {
    this.releaseCamera();
    this.root.removeFromParent();
    this.root.traverse((object) => {
      const mesh = object as Mesh;
      if (mesh.geometry && mesh !== this.bloom.composite) mesh.geometry.dispose();
      if (mesh.material && mesh !== this.bloom.composite) (mesh.material as Material).dispose();
    });
    for (const twin of this.twins) twin.dispose();
    this.bloom.dispose();
    this.music.dispose();
    this.videos.dispose();
  }
}

const NOTHING_HIDDEN: readonly Mesh[] = [];

function smooth01(v: number): number {
  const u = v < 0 ? 0 : v > 1 ? 1 : v;
  return u * u * (3 - 2 * u);
}

function typing(e: KeyboardEvent): boolean {
  const tag = (e.target as HTMLElement | null)?.tagName ?? '';
  return tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'A';
}
