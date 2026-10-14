import {
  BoxGeometry,
  Group,
  LineSegments,
  Mesh,
  Points,
  Vector2,
  Vector3,
  createSystem,
  type Entity,
  type Material,
} from '@iwsdk/core';
import { getMode } from './experience.js';
import { MUSIC_URL } from './rooms-assets.js';
import {
  boxGeometry,
  createBoxUniforms,
  createFogUniforms,
  createRoomsUniforms,
  dustGeometry,
  dustMaterial,
  edgeGeometry,
  edgeMaterial,
  fogMaterial,
  frameGeometry,
  frameMaterial,
  glassMaterial,
  interiorMaterial,
  type BoxUniforms,
  type FogUniforms,
  type RoomsUniforms,
} from './rooms-build.js';
import { RoomsCamera, createPose, segmentHitsBox } from './rooms-camera.js';
import { RoomsLook } from './rooms-component.js';
import { ASPECT, BOXES, FOG, WALL, type BoxSpec, type FogSpec } from './rooms-layout.js';
import {
  BAR,
  SHOT_TIMES,
  SONG_LENGTH,
  arrivalFlareAt,
  barTime,
  beatsAt,
  burstAt,
  energyAt,
  fadeAt,
  flashAt,
  kickAt,
  presenceAt,
  sectionAt,
  type ShotView,
} from './rooms-score.js';
import { RoomsVideos, type VideoSlot } from './rooms-videos.js';
import { SorangBloom, type BloomSwap } from './sorang-bloom.js';
import { SorangMusic } from './sorang-music.js';

const LOOK_KEYS = ['glass', 'dust', 'kick', 'focusDim', 'flash', 'parallax', 'bloom', 'bloomThreshold', 'volume'] as const;
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

interface BoxRig {
  readonly spec: BoxSpec;
  readonly u: BoxUniforms;
  readonly group: Group;
  readonly interior: Mesh;
  readonly glass: Mesh;
  readonly edges: LineSegments;
  readonly slot: VideoSlot;
  /** 0..1, fading while it stands between the camera and the box it faces. */
  occ: number;
}

interface FogRig {
  readonly spec: FogSpec;
  readonly u: FogUniforms;
  readonly mesh: Mesh;
}

function viewName(view: ShotView): string {
  return typeof view === 'number' ? `box ${view + 1} (${BOXES[view]?.name ?? '?'})` : view;
}

/**
 * Rooms: glass boxes stacked inside a grid frame under a vault, each looping its own clip, a
 * plume of dust rising through them and smoke held in three cubes. The camera follows the shot
 * list in `rooms-score.ts`: eased flights between the overview and single rooms in the verses,
 * hard cuts on the beat in the drops. Everything is a function of the song second, so any moment
 * can be frozen and captured. Desktop only.
 */
export class RoomsSystem extends createSystem({ anchors: { required: [RoomsLook] } }) {
  private U!: RoomsUniforms;
  private root!: Group;
  private frame!: LineSegments;
  private dust!: Points;
  private boxes: BoxRig[] = [];
  private fogs: FogRig[] = [];
  private bloom!: SorangBloom;
  private bloomOn = !BLOOM_OFF;
  private bloomSwaps: BloomSwap[] = [];
  private twins: Material[] = [];
  private music!: SorangMusic;
  private videos!: RoomsVideos;
  private readonly cam = new RoomsCamera();
  private readonly pose = createPose();
  private readonly look: Look = {
    glass: 0.7,
    dust: 1,
    kick: 1,
    focusDim: 0.75,
    flash: 1,
    parallax: 1,
    bloom: 1.1,
    bloomThreshold: 0.35,
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
  private savedFov: number | null = null;
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
  private readonly burst = { age: 1e3, amp: 0 };
  private statusNow: RoomsStatus = { text: 'Building the rooms', busy: true };
  private readonly listeners = new Set<() => void>();
  private updateMs = 0;
  private updates = 0;

  init(): void {
    this.U = createRoomsUniforms();
    const gl = this.renderer.getContext();
    const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | null;
    this.U.uMaxPoint.value = Math.max(1, Math.min(12, range?.[1] ?? 12));

    this.root = new Group();
    this.root.name = 'rooms';
    this.root.visible = false;
    this.videos = new RoomsVideos(BOXES);
    this.videos.onChange = (slot) => {
      const rig = this.boxes.find((b) => b.slot === slot);
      if (rig) this.useClip(rig);
      this.refreshStatus();
    };

    this.frame = new LineSegments(frameGeometry(), frameMaterial(this.U));
    this.frame.renderOrder = 15;
    this.addPiece(this.frame, frameMaterial(this.U));

    for (const spec of BOXES) {
      const slot = this.videos.slots[spec.slot];
      const u = createBoxUniforms(this.U, spec, this.videos.texture(slot));
      const group = new Group();
      group.name = `rooms-box-${spec.slot + 1}`;
      group.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
      group.rotation.y = spec.yaw * DEG;
      const interior = new Mesh(boxGeometry(spec), interiorMaterial(u));
      interior.renderOrder = 10;
      const glass = new Mesh(boxGeometry(spec, 1.003), glassMaterial(u));
      glass.renderOrder = 30;
      const edges = new LineSegments(edgeGeometry(spec), edgeMaterial(u));
      edges.renderOrder = 35;
      group.add(interior, glass, edges);
      this.root.add(group);
      // The clip glows only where it is bright; the glass and edges glow fully.
      this.addPiece(interior, interiorMaterial(u, 0.55), false);
      this.addPiece(glass, glassMaterial(u), false);
      this.addPiece(edges, edgeMaterial(u), false);
      this.boxes.push({ spec, u, group, interior, glass, edges, slot, occ: 1 });
    }

    FOG.forEach((spec, i) => {
      const u = createFogUniforms(this.U, spec, 3.7 * (i + 1));
      const mesh = new Mesh(new BoxGeometry(spec.size, spec.size, spec.size), fogMaterial(u));
      mesh.name = `rooms-fog-${i + 1}`;
      mesh.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
      mesh.rotation.y = spec.yaw * DEG;
      mesh.renderOrder = 20;
      this.addPiece(mesh, fogMaterial(u));
      this.fogs.push({ spec, u, mesh });
    });

    this.dust = new Points(dustGeometry(), dustMaterial(this.U));
    this.dust.renderOrder = 40;
    this.addPiece(this.dust, dustMaterial(this.U));

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
    const on = getMode() === 'rooms';
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
    this.savedFov = this.camera.fov;
    this.music.prefetch();
    this.videos.load();
    this.toPreroll(true);
    this.lastShot = -1;
    this.parallax.set(0, 0);
  }

  private leave(): void {
    this.active = false;
    this.music.stop();
    this.videos.pause();
    this.bloom.hide();
    this.toPreroll(true);
    this.downId = -1;
    if (this.savedFov !== null) {
      this.camera.fov = this.savedFov;
      this.camera.updateProjectionMatrix();
      this.savedFov = null;
    }
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
    if (cam.fov !== pose.fov) {
      cam.fov = pose.fov;
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
    U.uSong.value = s;
    U.uKick.value = kick;
    U.uEnergy.value = energy;
    U.uBeatAge.value = s < 0.045 ? 1 : (beats - Math.floor(beats)) * (BAR / 4);
    U.uRing.value = (sectionAt(s).kind === 'drop' ? 1 : 0.3) * energy * look.kick;
    U.uFrameShow.value = frameShow;
    const barPhase = beats / 4 - Math.floor(beats / 4);
    U.uScan.value.set(barPhase * WALL * 1.1 - 0.3, preroll ? 0 : 0.35 + 0.65 * energy);
    // Thinner in a front view, so the plume drifting past never hides the room.
    U.uDustShow.value = frameShow * (preroll ? 0.35 : 0.45 + 0.55 * energy) * (1 - 0.55 * this.cam.focus);
    U.uDustAmount.value = look.dust;
    burstAt(s, this.burst);
    U.uBurstAge.value = this.burst.age;
    U.uBurstAmp.value = preroll ? 0 : this.burst.amp * (reduced ? 0.4 : 1);
    // A cut flares the scene's own light: edges, grid and glow.
    const flash = preroll ? 0 : flashAt(s, st) * look.flash * (reduced ? 0.3 : 1);
    U.uFlash.value = flash;
    this.renderer.getDrawingBufferSize(this.bufSize);
    U.uViewportH.value = this.bufSize.y;

    // Focus: the box the camera faces stays lit; the others dim and any in the way fade out.
    const focus = this.cam.focus;
    const focusSlot = this.cam.focusSlot;
    const focused = focusSlot >= 0 ? this.boxes[focusSlot] : null;
    if (focused) {
      // Aim at the middle of its open front, so the box itself never counts as in the way.
      this.aimL.set(0, 0, focused.spec.d / 2).applyAxisAngle(Y_AXIS, focused.spec.yaw * DEG).add(focused.group.position);
    }
    const snap = cut || this.frozen !== null;
    const kOcc = snap ? 1 : 1 - Math.exp(-OCCLUDE_RATE * dt);
    for (const rig of this.boxes) {
      const spec = rig.spec;
      const presence = preroll ? 0 : presenceAt(s, spec.order);
      const mine = rig === focused;
      const dim = focused && !mine ? look.focusDim * focus : 0;
      const blocking = focused !== null && !mine && focus > 0.05 && segmentHitsBox(this.eyeL, this.aimL, spec, OCCLUDE_MARGIN);
      rig.occ += ((blocking ? 0 : 1) - rig.occ) * kOcc;
      const bright = presence * (1 - dim) * rig.occ;
      const facing = mine ? focus : 0;
      rig.u.uBright.value = bright;
      rig.u.uGlass.value = look.glass * (1 - 0.8 * facing);
      rig.u.uHaze.value = 1 - 0.85 * facing;
      const flare = preroll ? 0 : arrivalFlareAt(s, spec.order);
      rig.u.uEdge.value = presence * rig.occ * (1 - 0.6 * dim) * (0.35 + 0.55 * kick + 1.6 * flare + 1.2 * flash);
      rig.group.visible = presence > 0.001 && rig.occ > 0.01;
      U.uBoxBright.value[spec.slot] = bright;
    }
    for (const rig of this.fogs) {
      const presence = preroll ? 0 : presenceAt(s, rig.spec.order);
      const dim = focused ? look.focusDim * focus : 0;
      rig.u.uBright.value = presence * (1 - dim) * (0.55 + 0.35 * energy);
      rig.mesh.visible = rig.u.uBright.value > 0.002;
      // The camera in the cube's frame: undo its position and yaw.
      const c = rig.u.uCamL.value;
      c.set(this.eyeL.x - rig.spec.pos[0], this.eyeL.y - rig.spec.pos[1], this.eyeL.z - rig.spec.pos[2]);
      c.applyAxisAngle(Y_AXIS, -rig.spec.yaw * DEG);
    }

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

  /** Add a piece to the root, drawn with `twin` into the glow. Positions come from shaders, so bounds mean nothing. */
  private addPiece(object: Mesh | Points | LineSegments, twin: Material, parent = true): void {
    if (object instanceof Points) object.frustumCulled = false;
    object.raycast = () => {};
    if (parent) this.root.add(object);
    this.bloomSwaps.push([object, twin]);
    this.twins.push(twin);
  }

  /** A slot's clip has decoded: show it, cover-fitted to the 16:9 back wall. */
  private useClip(rig: BoxRig): void {
    const tex = this.videos.texture(rig.slot);
    rig.u.uVideo.value = tex;
    rig.u.uLive.value = rig.slot.live ? 1 : 0;
    const a = rig.slot.aspect;
    const cover = rig.u.uCover.value;
    if (a > ASPECT) cover.set(ASPECT / a, 1, (1 - ASPECT / a) / 2, 0);
    else cover.set(1, a / ASPECT, 0, (1 - a / ASPECT) / 2);
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
      fov: this.camera.fov,
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

const Y_AXIS = new Vector3(0, 1, 0);
const NOTHING_HIDDEN: readonly Mesh[] = [];

function smooth01(v: number): number {
  const u = v < 0 ? 0 : v > 1 ? 1 : v;
  return u * u * (3 - 2 * u);
}

function typing(e: KeyboardEvent): boolean {
  const tag = (e.target as HTMLElement | null)?.tagName ?? '';
  return tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'A';
}
