import {
  BoxGeometry,
  CameraFacing,
  CameraSource,
  CameraState,
  CameraUtils,
  CanvasTexture,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  VisibilityState,
  XRMesh,
  XRPlane,
  createSystem,
  outlineMaterial,
  type CameraDeviceInfo,
  type Entity,
} from '@iwsdk/core';
import { consoleShown, setConsoleStatus } from './debug-console.js';
import { EnvDepth } from './env-depth.js';
import { PREVIEW_FORCED, getMode } from './experience.js';
import { HandOccluder, SEGMENTS } from './hand-occluder.js';
import { drawHint, makeCanvas, type Canvas2D } from './labels.js';
import { cameraMount, PassthroughPhoto, type CameraMount, type CameraSideSetting, type HandJoints } from './passthrough-photo.js';
import { FrameMeter } from './frame-meter.js';
import { RaiseMaps } from './raise-map.js';
import { RoomMeshOverlay, fillBound, moveReach, type BoundLook, type StretchBound } from './room-mesh-overlay.js';
import { RoomPlanes, type PlaneHit, type PlaneMiss } from './room-planes.js';
import { StretchLook } from './stretch-component.js';
import { Spring, averageNormal, buildTriGrid, rayTriGrid, triangleNormal, type RayHit, type TriGrid } from './stretch-math.js';
import type { RubberUniformSet } from './stretch-material.js';
import { StretchSound } from './stretch-sound.js';

type Side = 'left' | 'right';
const SIDES: readonly Side[] = ['left', 'right'];

/** Hand travel below half of this does nothing; full response at one and a half. */
const DEAD = 0.03;
/** Rigid chunk that rides ahead of the pinch, metres. */
const AHEAD = 0.3;
/**
 * Slides beyond a soft cap ease into a hard one. Both scale with what is being stretched: the span
 * between two hands on one surface, or one hand's ramp. They never exceed these.
 */
const SLIDE_SOFT = 1;
const SLIDE_MAX = 1.5;
const SOFT_PER_SPAN = 2;
const MAX_PER_SPAN = 3;
/** Two grabs facing within ~25° and within 5 cm of one plane are on one surface and share a span. */
const SAME_SURFACE = Math.cos((25 * Math.PI) / 180);
const SAME_PLANE = 0.05;
/** The span between two hands eases over this long when one pinches or lets go. */
const SPAN_EASE = 0.3;
/** Ramps stay as set up to this distance and grow in proportion beyond it, so far pulls bend alike. */
const RAMP_NEAR = 0.8;
/** The smoothing step never exceeds this: a long frame cannot land a whole pull at once. */
const STEP_MAX = 1 / 50;
/**
 * The surface never follows faster than this, m/s over the capped step: above a quick pull's hand
 * speed on a normal frame (at 2.5 m/s it held every quick pull to 5 cm a frame), and on a long
 * frame it holds the jump to FOLLOW_MAX * STEP_MAX = 12 cm.
 */
const FOLLOW_MAX = 6;
/** The pinch ray must meet the grabbed plane within ~78° of its normal to slide. */
const GRAZE = 0.2;
/** Toward-you travel ignored, and how much sideways travel cancels it (a shoulder sweep shortens reach too). */
const TOWARD_DEAD = 0.02;
const LATERAL_SHARE = 0.35;
const EXPLODE_MAX = 0.8;
const LIFT_MAX = 0.08;
/**
 * A table or floor bursts only when the hand leaves it nearly straight off: the off-surface share of
 * the hand's travel ramps from 0.8 (37° off the normal) to full at 0.95 (18°). Pulling a table edge
 * toward your chest is mostly along the table, so it just stretches toward you.
 */
const STRAIGHT_FROM = 0.8;
const STRAIGHT_FULL = 0.95;
/** Surfaces this far from level (|normal.y| below 0.5, fading to 0.8) count as walls and burst as before. */
const WALL_UP = 0.5;
const WALL_FADE = 0.3;
/** The burst's rim stays inside ~25° of the grab point, so a full pull never fills the view. */
const BURST_ANGLE = Math.tan((25 * Math.PI) / 180);
/** Slide plus burst. Past this, scan triangles start to sliver. */
const PULL_MAX = 1.8;
/** While held, the surface follows the fingers with this time constant (s): direct, minus jitter. */
const FOLLOW = 0.025;
/** The slide stops before the grab point leaves its photo by less than this uv margin. */
const SLIDE_MARGIN = 0.1;
const RIPPLE_SECONDS = 0.8;
/** Scan normals are averaged over this radius around the hit. */
const NORMAL_RADIUS = 0.12;
/** A hand that loses tracking while holding keeps its pull this long, then lets go. */
const LOST_RELEASE = 0.5;
/** A pinch waits this long for the hand joints before it is dropped. */
const PENDING_GIVEUP = 0.3;
/** Re-pinching a surface that is still springing settles it this fast first. */
const SETTLE_STIFF = 1200;
const SETTLE_DAMP = 70;
const SETTLE_MAX = 0.12;
const FADE_IN = 0.12;
/** A pinch with no usable photo yet keeps trying this long (fresh pose, fresh frame) before it lets go. */
const PHOTO_WAIT = 0.4;
/** Frames after a pinch whose timing is kept and printed at release, to see a pop or a hitch. */
const ONSET_FRAMES = 12;
const FOOTPRINT = 9;
/**
 * Streaks bloom over this many degrees of pull, as seen from the head, after `stripes` degrees.
 * In angle, so a far table streaks after the same hand move as a near one. The shader and the sparkle both read it.
 */
const STREAK_SPAN_DEG = 25;
const DEG = Math.PI / 180;
const CARD_DISTANCE = 1.2;
const CARD_RISE = Math.sin((10 * Math.PI) / 180);

interface Look {
  gain: number;
  reach: number;
  ramp: number;
  stripes: number;
  feather: number;
  wobble: number;
  waveLength: number;
  waveSpeed: number;
  stiffness: number;
  damping: number;
  depthPull: number;
  radial: number;
  ripple: number;
  exposure: number;
  warmth: number;
  tint: number;
  lensScale: number;
  lensPitchTrim: number;
  lensYawTrim: number;
  lensRollTrim: number;
  lensDx: number;
  lensDy: number;
  lensDz: number;
  cameraLatency: number;
  handLag: number;
  cameraSide: CameraSideSetting;
  linearBlend: boolean;
}
const NUMBER_KEYS = [
  'gain', 'reach', 'ramp', 'stripes', 'feather', 'wobble', 'waveLength', 'waveSpeed',
  'stiffness', 'damping', 'depthPull', 'radial', 'ripple', 'exposure', 'warmth',
  'tint', 'lensScale', 'lensPitchTrim', 'lensYawTrim', 'lensRollTrim', 'lensDx', 'lensDy', 'lensDz', 'cameraLatency',
  'handLag',
] as const;

interface Grab {
  side: Side;
  /** Photo slot and sound voice. Left is 0. */
  slot: 0 | 1;
  /** Pinched, waiting for the next frame's hand joints to resolve where. */
  pending: boolean;
  pendingAt: number;
  holding: boolean;
  on: boolean;
  /** Order of grabbing. The earlier grab bends first, so the later one grabs what you see. */
  seq: number;
  mesh: Mesh | null;
  localG: Vector3;
  worldG: Vector3;
  localNormal: Vector3;
  normal: Vector3;
  hand0: Vector3;
  /** Head-to-hand direction at the pinch. Travel across it is sideways, not toward you. */
  ray0: Vector3;
  reach0: number;
  lift: Vector3;
  target: Vector3;
  D: Vector3;
  Dprev: Vector3;
  Dvel: Vector3;
  axis: Vector3;
  axisRel: Vector3;
  E: number;
  Evel: number;
  B: number;
  Bvel: number;
  explodeTo: number;
  liftTo: number;
  springs: [Spring, Spring, Spring, Spring, Spring];
  A: number;
  rippleT: number;
  lostT: number;
  fade: number;
  /** 0 until `stripes` degrees of pull, 1 by STREAK_SPAN_DEG more. What is drawn and what is heard both read it. */
  bloom: number;
  /** For the one console line each pull prints when it lets go. */
  heldAt: number;
  peakSlide: number;
  peakLift: number;
  peakBurst: number;
  peakBloom: number;
  clipped: boolean;
  /** The first ONSET_FRAMES frames after the pinch, 4 numbers each: dt ms, |D| cm, fade, ease. */
  readonly onset: Float32Array;
  onsetCount: number;
  /** ms the photo freeze took on the pinch frame, and the whole update that frame (-1 until known). */
  freezeMs: number;
  pinchUpdateMs: number;
  /** The last aim(): hand travel since the pinch, and the dead-zone ease it gave. */
  moved: number;
  ease: number;
  /** Head to grab point at the pinch, and the ramp that sets. */
  dist: number;
  ramp: number;
  /** Began on a surface the other grab had already moved, so it bends what was seen. */
  chain: boolean;
  /** What the slide caps were measured against (span between hands, or the ramp), and whether they bit. */
  span: number;
  capped: boolean;
}

const enum Card {
  None,
  Pinch,
  Scan,
  Spatial,
  Camera,
}
const COPY: Record<Card, { title: string; body: string }> = {
  [Card.None]: { title: '', body: '' },
  [Card.Pinch]: { title: 'Pinch anything and pull', body: 'It stretches, then it streaks.' },
  [Card.Scan]: { title: 'No room mesh yet', body: 'Finish Space Setup, then enter again.' },
  [Card.Spatial]: { title: 'Room scan is off', body: 'Allow spatial data, then enter again.' },
  [Card.Camera]: { title: 'Camera is off', body: 'Allow the camera, then enter again.' },
};

const WARDROBE = { x: -0.75, y: 1, z: -1.7, sx: 0.9, sy: 2, sz: 0.55 };
const FRONT_Z = WARDROBE.z + WARDROBE.sz / 2;

function makeGrab(side: Side): Grab {
  return {
    side,
    slot: side === 'left' ? 0 : 1,
    pending: false,
    pendingAt: 0,
    holding: false,
    on: false,
    seq: 0,
    mesh: null,
    localG: new Vector3(),
    worldG: new Vector3(),
    localNormal: new Vector3(0, 0, 1),
    normal: new Vector3(0, 0, 1),
    hand0: new Vector3(),
    ray0: new Vector3(0, 0, -1),
    reach0: 0.45,
    lift: new Vector3(0, 0, 1),
    target: new Vector3(),
    D: new Vector3(),
    Dprev: new Vector3(),
    Dvel: new Vector3(),
    axis: new Vector3(1, 0, 0),
    axisRel: new Vector3(1, 0, 0),
    E: 0,
    Evel: 0,
    B: 0,
    Bvel: 0,
    explodeTo: 0,
    liftTo: 0,
    springs: [new Spring(), new Spring(), new Spring(), new Spring(), new Spring()],
    A: AHEAD,
    rippleT: 10,
    lostT: 0,
    fade: 0,
    bloom: 0,
    heldAt: 0,
    peakSlide: 0,
    peakLift: 0,
    peakBurst: 0,
    peakBloom: 0,
    clipped: false,
    onset: new Float32Array(ONSET_FRAMES * 4),
    onsetCount: 0,
    freezeMs: 0,
    pinchUpdateMs: 0,
    moved: 0,
    ease: 0,
    dist: 1,
    ramp: 0.35,
    chain: false,
    span: 0,
    capped: false,
  };
}

/** The removed ?calibrate=1 mode stored a grade here and re-applied it every frame, on every visit. */
const OLD_GRADE_KEY = 'jonze-stretch-grade';

function purgeOldGrade(): void {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(OLD_GRADE_KEY);
    if (raw === null) return;
    localStorage.removeItem(OLD_GRADE_KEY);
  } catch {
    return; // Storage blocked: nothing could have been stored either.
  }
  let text = raw;
  try {
    const g = JSON.parse(raw) as Record<string, number>;
    const f = (key: string, digits = 2) => (typeof g[key] === 'number' ? g[key].toFixed(digits) : '?');
    console.info(`[jonze] cleared old calibration grade exp=${f('exposure')} warm=${f('warmth')} tint=${f('tint')}`);
    text = `sat=${f('saturation')} con=${f('contrast')} lift=${f('blackLift', 3)} lens=${f('lensScale', 3)}/${f('lensPitch')}`;
  } catch {
    // Not JSON: print it raw.
  }
  console.info(`[jonze] old grade ${text}`);
}

/** Which optional features the headset actually granted. A missing camera or mesh shows here first. */
function logSession(session: XRSession): void {
  const features = (session as XRSession & { enabledFeatures?: readonly string[] }).enabledFeatures;
  if (!features) {
    console.info('[jonze] session started (features not reported)');
    return;
  }
  const has = (name: string) => (features.includes(name) ? 'Y' : 'n');
  console.info(
    `[jonze] session camera=${has('camera-access')} mesh=${has('mesh-detection')} plane=${has('plane-detection')} ` +
      `hands=${has('hand-tracking')} anchors=${has('anchors')} depth=${has('depth-sensing')}` +
      (session.depthUsage ? ` ${session.depthUsage}/${session.depthDataFormat ?? '?'}` : ''),
  );
}

const OCC_MODE = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('occ') : null;
/** `?occ=debug`: occluders green, the gate cyan, the cut magenta. `?occ=delta`: real depth against the room, as colour. */
const OCC_DEBUG = OCC_MODE === 'debug';
const OCC_DELTA = OCC_MODE === 'delta';

/** Developer check: `?lens=overlay` draws the live camera in stripes over the room at rest. */
const LENS_OVERLAY = typeof location !== 'undefined' && new URLSearchParams(location.search).get('lens') === 'overlay';
/** `?raise=0` keeps the scan as it is: no depth-raised objects under a pull. */
const RAISE = typeof location === 'undefined' || new URLSearchParams(location.search).get('raise') !== '0';
/** `?cull=0` draws the whole room with the stretch program, for comparing frame times. */
const CULL = typeof location === 'undefined' || new URLSearchParams(location.search).get('cull') !== '0';

/** The camera frame size, and whether it is the full square sensor or the 4:3 crop of it. */
function frameShape(video: HTMLVideoElement | null): string {
  const w = video?.videoWidth ?? 0;
  const h = video?.videoHeight ?? 0;
  const shape = w === h ? 'square' : Math.abs(w / Math.max(h, 1) - 4 / 3) < 0.01 ? '4:3 crop' : 'other crop';
  return `${w}x${h} (${shape})`;
}

function smooth(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/**
 * Pinch the scanned room and pull. Each hand grabs the surface behind the pinch. A pull slides that
 * spot along the surface and stretches what is behind it, real texture first, streaking on long
 * pulls; pulling a wall (or a table straight up) toward you also bursts it outward from the pinch.
 * At rest nothing is drawn: plain passthrough.
 */
export class RoomStretchSystem extends createSystem({
  settings: { required: [StretchLook] },
  meshes: { required: [XRMesh] },
  planes: { required: [XRPlane] },
}) {
  private readonly left = makeGrab('left');
  private readonly right = makeGrab('right');
  private readonly demoL = makeGrab('left');
  private readonly demoR = makeGrab('right');
  private readonly scans: TriScan[] = [];
  private readonly scanIds: number[] = [];
  private readonly globalMeshes: Mesh[] = [];
  private readonly objects: Mesh[] = [];
  private readonly shown: Mesh[] = [];
  private readonly globalCache = new WeakMap<Entity, boolean>();
  private readonly hit: RayHit = { t: Infinity, tri: -1 };
  private hitMesh: Mesh | null = null;
  private meshLog = -1;
  /** Desk-only stand-in. A headset that can enter passthrough must not show it. */
  private previewRoom = PREVIEW_FORCED || typeof navigator === 'undefined' || !navigator.xr;
  private wasPresenting = false;
  private presentedAt = 0;
  private demoT = 0;
  private grabSeq = 0;
  private session: XRSession | null = null;
  private refSpace: XRReferenceSpace | null = null;
  private outlineShown = true;
  private readonly look: Look = {
    gain: 1, reach: 0.45, ramp: 0.35, stripes: 11, feather: 0.07, wobble: 0.035,
    waveLength: 0.45, waveSpeed: 7, stiffness: 90, damping: 9, depthPull: 0.35, radial: 2.5,
    ripple: 0.015, exposure: 1.1, warmth: -0.1, tint: 0,
    lensScale: 1, lensPitchTrim: 0, lensYawTrim: 0, lensRollTrim: 0, lensDx: 0, lensDy: 0, lensDz: 0,
    cameraLatency: 0, handLag: 0.03, cameraSide: 'auto',
    linearBlend: true,
  };

  private readonly photo = new PassthroughPhoto();
  /** This frame's real delta, uncapped, for the onset timing line. */
  private frameDt = 0;
  private xrLogged = false;
  private eyeWaits = 0;
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();
  private readonly tmpC = new Vector3();
  private readonly depth = new EnvDepth();
  private readonly sound = new StretchSound();
  private meter!: FrameMeter;
  private readonly bounding: BoundLook = { reach: 0.45, core: 0.12, ripple: 0.015, wobble: 0.035 };
  private raise!: RaiseMaps;
  private overlay!: RoomMeshOverlay;
  private hands!: HandOccluder;
  private readonly handMap: { left: XRHand | null; right: XRHand | null } = { left: null, right: null };
  private readonly joints: HandJoints = {
    points: new Float32Array(0), leftStart: 0, leftCount: 0, rightStart: 0, rightCount: 0,
    arms: new Float32Array(0), armOk: new Uint8Array(0),
  };
  private room!: Group;
  private cameraEntity: Entity | null = null;
  private cameraWanted = false;
  private rearmAt = 0;
  private rearmTries = 0;
  private mount: CameraMount = 'view';
  private arming: Promise<boolean> | null = null;
  private trackVideo: HTMLVideoElement | null = null;
  private track: MediaStreamTrack | null = null;
  /** Diagnostics: each prints on change, never per frame. */
  private lookLogged = false;
  private videoWas = false;
  private cameraStateWas = '';

  private hud!: Group;
  private hudEntity!: Entity;
  private card!: Mesh;
  private cardMat!: MeshBasicMaterial;
  private cardPaint!: Canvas2D;
  private cardTex!: CanvasTexture;
  private cardShown = Card.None;
  private cardOpacity = 0;
  private cardSettled = false;
  private pinched = false;

  private readonly footprint = new Float32Array(FOOTPRINT * 3);
  private readonly head = new Vector3();
  private readonly headQuat = new Quaternion();
  private readonly pinch = new Vector3();
  private readonly raw = new Vector3();
  private readonly unit = new Vector3();
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly tanU = new Vector3();
  private readonly tanV = new Vector3();
  private readonly localO = new Vector3();
  private readonly localD = new Vector3();
  private readonly localHit = new Vector3();
  private readonly localN = new Vector3();
  private readonly roomPlanes = new RoomPlanes();
  private readonly planeHit: PlaneHit = { point: new Vector3(), normal: new Vector3(), distance: 0, label: '', horizontal: true, delta: 0 };
  private readonly planeMiss: PlaneMiss = { label: '', delta: 0, found: false };
  /** Each scanned mesh's label, for the pinch line. */
  private readonly meshLabels = new WeakMap<Mesh, string>();
  private hitScan = -1;
  private readonly rayDir = new Vector3();
  private readonly meshHitWorld = new Vector3();
  /** How the last grab found its point, for the pinch line. */
  private hitNote = 'mesh';
  private readonly bestO = new Vector3();
  private readonly bestD = new Vector3();
  private readonly inv = new Matrix4();

  init(): void {
    this.overlay = new RoomMeshOverlay(this.scene, LENS_OVERLAY);
    if (LENS_OVERLAY) console.info('[jonze] lens overlay: live camera in stripes over the room at rest; hold still to read it');
    if (!CULL) console.info('[jonze] cull=0: the whole room draws with the stretch program');
    this.meter = new FrameMeter(this.renderer, this.scene);
    this.raise = new RaiseMaps(this.renderer);
    if (!RAISE) console.info('[jonze] raise=0: unscanned objects stay flat under a pull');
    else if (!this.raise.supported) console.info('[jonze] raise off: no half-float render targets here');
    this.hands = new HandOccluder(this.scene, OCC_DEBUG);
    this.photo.history = this.hands;
    this.joints.points = this.hands.points;
    this.joints.arms = this.hands.arms;
    this.joints.armOk = this.hands.armOk;
    purgeOldGrade();
    this.buildRoom();
    if (navigator.xr && !PREVIEW_FORCED) {
      void navigator.xr.isSessionSupported('immersive-ar').then((ok) => {
        this.previewRoom = !ok;
      });
    }

    this.hud = new Group();
    this.hud.visible = false;
    this.cardPaint = makeCanvas(1024, 256);
    this.cardTex = new CanvasTexture(this.cardPaint.canvas);
    this.cardTex.colorSpace = SRGBColorSpace;
    // Depth-tested so the depth-only hand spheres hide it behind your fingers.
    this.cardMat = new MeshBasicMaterial({ map: this.cardTex, transparent: true, depthWrite: false, depthTest: true, opacity: 0 });
    this.card = new Mesh(new PlaneGeometry(0.46, 0.115), this.cardMat);
    this.card.renderOrder = 10;
    this.card.visible = false;
    this.hud.add(this.card);
    this.hudEntity = this.world.createTransformEntity(this.hud);

    this.demoL.worldG.set(WARDROBE.x - 0.18, 1.2, FRONT_Z);
    this.demoR.worldG.set(WARDROBE.x + 0.18, 1.2, FRONT_Z);
    this.demoL.seq = 1;
    this.demoR.seq = 2;

    this.cleanupFuncs.push(
      () => this.dispose(),
      this.queries.meshes.subscribe('qualify', (entity) => {
        this.globalCache.set(entity, this.isGlobal(entity));
      }),
      this.queries.meshes.subscribe('disqualify', (entity) => {
        this.globalCache.delete(entity);
      }),
      this.visibilityState.subscribe((state) => {
        if (state !== VisibilityState.Visible) this.pause();
      }),
    );
    void document.fonts.ready.then(() => {
      if (this.cardShown !== Card.None) this.paintCard(this.cardShown);
    });
  }

  /**
   * Open the passthrough camera. Call from the Enter click so the permission
   * prompt keeps the user gesture. Safe to call again.
   */
  armCamera(): Promise<boolean> {
    this.cameraWanted = true;
    if (this.cameraEntity) return Promise.resolve(true);
    if (this.arming) return this.arming;
    this.arming = CameraUtils.getDevices()
      .then((devices) => {
        this.arming = null;
        return this.attachCamera(devices);
      })
      .catch((error: unknown) => {
        this.arming = null;
        console.warn('[jonze] camera arm failed:', error);
        return false;
      });
    return this.arming;
  }

  /** Call from the Enter click so the pull can sing in the headset. */
  unlockAudio(): void {
    this.sound.unlock();
  }

  update(delta: number, time: number): void {
    // Every mode: three's own depth occluder must never draw over the scene.
    this.depth.sync(this.renderer, this.world.xrFrame, this.renderer.xr.getSession());
    const stretch = getMode() === 'stretch';
    this.syncOutline(stretch);
    if (!stretch) {
      this.meter.idle();
      this.hud.visible = false;
      this.room.visible = false;
      this.overlay.hide(true);
      this.hands.setActive(false);
      this.stopCamera();
      this.clearGrabs();
      this.sound.stop();
      return;
    }
    const startMs = performance.now();
    const dt = Math.min(0.1, delta);
    this.frameDt = delta;
    const now = startMs / 1000;
    this.readLook();
    this.syncSession(now);
    if (!this.lookLogged) this.logLook();
    const presenting = this.renderer.xr.isPresenting;
    const video = this.cameraVideo();
    const hasVideo = this.photo.watch(video, this.cameraTrack(video), now);
    if (hasVideo !== this.videoWas) {
      this.videoWas = hasVideo;
      console.info(hasVideo ? `[jonze] camera video on ${frameShape(video)}` : '[jonze] camera video off');
    }
    this.applyLook();
    this.warmTextures();
    if (presenting) {
      this.wasPresenting = true;
      this.room.visible = false;
      this.player.head.getWorldPosition(this.head);
      this.player.head.getWorldQuaternion(this.headQuat);
      this.photo.recordHead(this.player.head, this.world.xrFrame?.predictedDisplayTime, now);
      if (!this.xrLogged) this.logEyes();
      this.refreshHands();
      this.publishDepth();
      this.roomPlanes.sync(this.queries.planes.entities);
      const meshes = this.findMeshes();
      this.syncGrids(meshes);
      this.photo.capture(true, this.camera, this.handJoints(), this.handsKnown(), now);
      this.resolvePending(this.left, dt, now);
      this.resolvePending(this.right, dt, now);
      this.stepHand(this.left, dt);
      this.stepHand(this.right, dt);
      const active = this.left.on || this.right.on;
      if (LENS_OVERLAY) {
        const live = !active && hasVideo && this.photo.projectFrame(true, this.camera, now);
        this.overlay.setLive(video, live, this.photo.worldToClip);
        this.overlay.uniforms.uLensOn.value = live ? 1 : 0;
        // The stripes check the raise too: slot 0's map follows the live depth while nothing is held.
        if (live && RAISE) this.captureRaise(0);
      }
      // The depth debug views show the whole room, pinched or not, so they draw all of it.
      const debugView = this.overlay.uniforms.uLensOn.value > 0 || OCC_DEBUG || OCC_DELTA;
      this.overlay.setActive(active || debugView, active);
      this.overlay.setCull(CULL && !debugView);
      // Uniforms and chunk bounds first: the chunks drawn this frame must match this frame's pull.
      this.publish(this.left, this.right, time, hasVideo);
      this.overlay.sync(meshes, this.head);
      this.overlay.syncPlanes(this.roomPlanes);
      this.sing(this.left);
      this.sing(this.right);
      this.rearmCamera(now);
      const updateMs = performance.now() - startMs;
      if (this.left.pinchUpdateMs < 0) this.left.pinchUpdateMs = updateMs;
      if (this.right.pinchUpdateMs < 0) this.right.pinchUpdateMs = updateMs;
      if (consoleShown()) {
        const room = active || debugView ? this.overlay.chunksDrawn : -1;
        const text = this.meter.frame(this.frameDt, updateMs, room, this.overlay.chunkCount, now);
        if (text) setConsoleStatus(text);
      }
    } else if (!this.previewRoom) {
      // A headset back on the launch page. Leaving a session stops the camera; the frames
      // between the Enter click and the session starting must not.
      this.meter.idle();
      this.room.visible = false;
      this.overlay.hide(false);
      this.hands.setActive(false);
      this.hud.visible = false;
      this.sound.stop();
      if (this.wasPresenting) {
        this.wasPresenting = false;
        this.stopCamera();
        this.clearGrabs();
      }
      return;
    } else {
      this.overlay.hide(false);
      this.hands.setActive(false);
      this.room.visible = true;
      this.camera.getWorldPosition(this.head);
      this.camera.getWorldQuaternion(this.headQuat);
      this.sound.stop();
      const live = this.photo.projectFrame(false, this.camera, now);
      this.photo.capture(false, this.camera, null, true, now);
      this.updateDemo(dt, now);
      this.overlay.setLive(video, live, this.photo.worldToClip);
      this.publish(this.demoL, this.demoR, time, hasVideo);
    }
    this.hud.visible = true;
    this.updateHud(dt, presenting, hasVideo, now);
  }

  // ---------------------------------------------------------------- room

  private buildRoom(): void {
    const mat = this.overlay.previewMaterial;
    this.room = new Group();
    this.room.name = 'stretch-stand-in';
    const add = (mesh: Mesh) => {
      mesh.material = mat;
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      this.room.add(mesh);
    };
    const floor = new Mesh(new PlaneGeometry(4, 4, 80, 80));
    floor.rotation.x = -Math.PI / 2;
    add(floor);
    const wall = new Mesh(new PlaneGeometry(4, 2.4, 80, 48));
    wall.position.set(0, 1.2, -2);
    add(wall);
    const wardrobe = new Mesh(new BoxGeometry(WARDROBE.sx, WARDROBE.sy, WARDROBE.sz, 18, 40, 11));
    wardrobe.position.set(WARDROBE.x, WARDROBE.y, WARDROBE.z);
    add(wardrobe);
    const table = new Mesh(new BoxGeometry(1.2, 0.72, 0.7, 24, 14, 14));
    table.position.set(0.85, 0.36, -1.15);
    add(table);
    this.room.visible = false;
    this.scene.add(this.room);
  }

  /**
   * Quest often delivers the room as separate object meshes, and only labels one
   * of them "global mesh". Prefer the global mesh when it is actually there;
   * otherwise draw every scanned mesh.
   */
  private findMeshes(): readonly Mesh[] {
    const globals = this.globalMeshes;
    const objects = this.objects;
    globals.length = 0;
    objects.length = 0;
    for (const entity of this.queries.meshes.entities) {
      const mesh = entity.object3D as Mesh | null;
      const position = mesh?.geometry?.getAttribute('position');
      if (!mesh?.isMesh || !position || position.count < 3) continue;
      let global = this.globalCache.get(entity);
      if (global === undefined) {
        global = this.isGlobal(entity);
        this.globalCache.set(entity, global);
      }
      if (!this.meshLabels.has(mesh)) this.meshLabels.set(mesh, this.meshLabel(entity));
      if (global) globals.push(mesh);
      else objects.push(mesh);
    }
    const useGlobals = globals.length > 0;
    const chosen = useGlobals ? globals : objects;
    const hidden = useGlobals ? objects : globals;
    for (let i = 0; i < hidden.length; i++) {
      if (hidden[i].visible) hidden[i].visible = false;
    }
    const shown = this.shown;
    shown.length = 0;
    for (let i = 0; i < chosen.length; i++) shown.push(chosen[i]);
    this.noteMeshes(globals.length, objects.length, shown.length);
    return shown;
  }

  private meshLabel(entity: Entity): string {
    const stored = entity.getValue(XRMesh, 'semanticLabel');
    const raw = entity.getValue(XRMesh, '_mesh') as { semanticLabel?: string } | null;
    const label = (typeof stored === 'string' && stored) || raw?.semanticLabel || '';
    return label.replace(/\s+/g, '_');
  }

  private isGlobal(entity: Entity): boolean {
    if (entity.getValue(XRMesh, 'isBounded3D') !== true) return true;
    const stored = entity.getValue(XRMesh, 'semanticLabel');
    const raw = entity.getValue(XRMesh, '_mesh') as { semanticLabel?: string } | null;
    const label = `${typeof stored === 'string' ? stored : ''} ${raw?.semanticLabel ?? ''}`.toLowerCase();
    return label.replace(/[_-]+/g, ' ').includes('global');
  }

  private noteMeshes(globals: number, objects: number, shown: number): void {
    const key = globals * 1e6 + objects * 1e3 + shown;
    if (key === this.meshLog) return;
    this.meshLog = key;
    console.info(`[jonze] room meshes: ${shown} shown, ${globals} global, ${objects} objects`);
  }

  private syncGrids(meshes: readonly Mesh[]): void {
    const ids = this.scanIds;
    let same = ids.length === meshes.length * 3;
    for (let i = 0; same && i < meshes.length; i++) {
      const mesh = meshes[i];
      same =
        ids[i * 3] === mesh.id &&
        ids[i * 3 + 1] === (mesh.geometry.getAttribute('position')?.count ?? 0) &&
        ids[i * 3 + 2] === (mesh.geometry.getIndex()?.count ?? 0);
    }
    if (same) return;
    ids.length = 0;
    this.scans.length = 0;
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      const position = mesh.geometry.getAttribute('position');
      const index = mesh.geometry.getIndex();
      ids.push(mesh.id, position?.count ?? 0, index?.count ?? 0);
      if (!position || position.count < 3) continue;
      const positions = this.packed(position);
      const indices = index ? index.array : this.sequence(position.count);
      let minX = Infinity;
      let minY = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxZ = -Infinity;
      for (let v = 0; v < positions.length; v += 3) {
        const x = positions[v];
        const y = positions[v + 1];
        const z = positions[v + 2];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
      if (!Number.isFinite(minX)) continue;
      this.scans.push({
        mesh,
        positions,
        index: indices,
        grid: buildTriGrid(positions, indices, minX, minY, minZ, maxX, maxY, maxZ),
      });
    }
  }

  private sequence(count: number): Uint32Array {
    const out = new Uint32Array(count);
    for (let i = 0; i < count; i++) out[i] = i;
    return out;
  }

  private packed(position: { count: number; array: ArrayLike<number>; getX(i: number): number; getY(i: number): number; getZ(i: number): number }): ArrayLike<number> {
    if (position.array.length === position.count * 3) return position.array;
    const out = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      out[i * 3] = position.getX(i);
      out[i * 3 + 1] = position.getY(i);
      out[i * 3 + 2] = position.getZ(i);
    }
    return out;
  }

  // ---------------------------------------------------------------- session and lifecycle

  private syncSession(now: number): void {
    const session = this.xrManager.getSession() ?? null;
    if (session !== this.session) {
      this.session?.removeEventListener('selectstart', this.onSelectStart);
      this.session?.removeEventListener('selectend', this.onSelectEnd);
      session?.addEventListener('selectstart', this.onSelectStart);
      session?.addEventListener('selectend', this.onSelectEnd);
      this.session = session;
      this.lookLogged = false;
      if (session) logSession(session);
      this.depth.reset();
      this.xrLogged = false;
      this.eyeWaits = 0;
      this.clearGrabs();
      this.photo.clear();
      this.pinched = false;
      this.presentedAt = now;
      this.rearmTries = 0;
    }
    const space = this.world.xrReferenceSpace ?? null;
    if (space !== this.refSpace) {
      this.refSpace?.removeEventListener('reset', this.onReset);
      space?.addEventListener('reset', this.onReset);
      this.refSpace = space;
    }
  }

  /** Recentring moves the world under every stored photo. */
  private readonly onReset = (): void => {
    this.clearGrabs();
    this.photo.clear();
  };

  /** The system menu, a blur, or the headset coming off: let go and go quiet. */
  private pause(): void {
    this.left.pending = false;
    this.right.pending = false;
    if (this.left.holding) this.release(this.left);
    if (this.right.holding) this.release(this.right);
    this.sound.stop();
  }

  private syncOutline(stretch: boolean): void {
    // IWSDK's white hand outline is shared by every mode; in stretch mode the real hands are enough.
    const want = !stretch;
    if (this.outlineShown === want) return;
    this.outlineShown = want;
    outlineMaterial.visible = want;
  }

  // ---------------------------------------------------------------- hands and grabs

  /** Select events arrive outside the XR frame, where hand joints can't be read. Resolve them next update. */
  private readonly onSelectStart = (event: Event): void => {
    if (getMode() !== 'stretch' || !this.renderer.xr.isPresenting) return;
    const side = (event as XRInputSourceEvent).inputSource?.handedness;
    if (side !== 'left' && side !== 'right') return;
    const grab = side === 'left' ? this.left : this.right;
    if (grab.holding || grab.pending) return;
    this.sound.unlock();
    grab.pending = true;
    grab.pendingAt = performance.now() / 1000;
  };

  private readonly onSelectEnd = (event: Event): void => {
    const side = (event as XRInputSourceEvent).inputSource?.handedness;
    if (side !== 'left' && side !== 'right') return;
    const grab = side === 'left' ? this.left : this.right;
    grab.pending = false;
    if (grab.holding) this.release(grab);
  };

  private refreshHands(): void {
    this.hands.setActive(true);
    this.hands.lag = this.look.handLag;
    this.hands.pinching.left = this.left.holding;
    this.hands.pinching.right = this.right.holding;
    this.player.updateWorldMatrix(true, false);
    this.player.head.updateWorldMatrix(true, false);
    this.handMap.left = this.input.xr.isPrimary('hand', 'left') ? this.input.xr.getPrimaryInputSource('left')?.hand ?? null : null;
    this.handMap.right = this.input.xr.isPrimary('hand', 'right') ? this.input.xr.getPrimaryInputSource('right')?.hand ?? null : null;
    // Joints are predicted for the display time; stamp them with it, the clock the head poses use.
    const now = performance.now() / 1000;
    const shownMs = this.world.xrFrame?.predictedDisplayTime;
    const shownAt = shownMs !== undefined && Math.abs(shownMs / 1000 - now) <= 0.25 ? shownMs / 1000 : now;
    this.hands.update(
      this.world.xrFrame, this.world.xrReferenceSpace, this.player.matrixWorld, this.handMap,
      shownAt, this.player.head.matrixWorld,
    );
  }

  /**
   * Once a session: whether three draws both eyes in one pass, and where the eyes sit against the
   * camera it uses for cameraPosition. The hand cut measures its line of sight from each eye.
   */
  private logEyes(): void {
    const xr = this.renderer.xr;
    const cam = xr.getCamera();
    if (cam.cameras.length < 2) return;
    // three poses the eyes when it renders; until a frame has been drawn they all sit at the origin.
    const mid = this.tmpA.setFromMatrixPosition(cam.matrixWorld);
    const left = this.tmpB.setFromMatrixPosition(cam.cameras[0].matrixWorld);
    const right = this.tmpC.setFromMatrixPosition(cam.cameras[1].matrixWorld);
    const apart = left.distanceTo(right);
    // Unposed until three draws a frame; a view that never separates its eyes is reported anyway.
    if (apart < 0.01 && ++this.eyeWaits < 300) return;
    this.xrLogged = true;
    left.add(right).multiplyScalar(0.5);
    console.info(
      `[jonze] xr multiview=${(xr as { isMultiview?: boolean }).isMultiview ? 'Y' : 'n'} eyes ${apart.toFixed(3)}m apart, ` +
        `${left.distanceTo(mid).toFixed(3)}m from the draw camera`,
    );
  }

  /** Uploads photo textures made at camera start, so a pinch never allocates GPU storage. */
  private warmTextures(): void {
    const list = this.photo.warmList;
    for (let i = 0; i < list.length; i++) this.renderer.initTexture(list[i]);
    list.length = 0;
  }

  /** Headset depth and the hand segments it may cut around, for the stretch shader. */
  private publishDepth(): void {
    const U = this.overlay.uniforms;
    const d = this.depth;
    U.uDepthOn.value = d.on ? 1 : 0;
    U.uOccDebug.value = OCC_DEBUG ? 1 : OCC_DELTA ? 2 : 0;
    for (let i = 0; i < SEGMENTS; i++) {
      U.uSegA.value[i].copy(this.hands.segA[i]);
      U.uSegB.value[i].copy(this.hands.segB[i]);
    }
    if (!d.on) return;
    U.uEnvDepth.value = d.texture;
    U.uDepthRaw.value = d.rawToMeters;
    U.uDepthNear.value = d.near;
    U.uEyeSize.value.copy(d.eyeSize);
    U.uNormDepth0.value.copy(d.normDepth[0]);
    U.uNormDepth1.value.copy(d.normDepth[1]);
  }

  private handJoints(): HandJoints {
    const j = this.joints;
    j.leftStart = this.hands.leftStart;
    j.leftCount = this.hands.leftCount;
    j.rightStart = this.hands.rightStart;
    j.rightCount = this.hands.rightCount;
    return j;
  }

  /** False while a hand that should be tracked isn't: it could be anywhere in a camera frame. */
  private handsKnown(): boolean {
    for (let i = 0; i < SIDES.length; i++) {
      const side = SIDES[i];
      if (this.handMap[side] && !this.hands.hasPinch[side]) return false;
    }
    return true;
  }

  /** Thumb and index midpoint for a tracked hand; the ray origin for a controller. */
  private pinchPoint(side: Side, out: Vector3): boolean {
    if (this.hands.hasPinch[side]) {
      out.copy(this.hands.thumbTip[side]).add(this.hands.indexTip[side]).multiplyScalar(0.5);
      return true;
    }
    if (this.handMap[side]) return false;
    const ray = this.player.raySpaces[side];
    if (!ray) return false;
    ray.getWorldPosition(out);
    return true;
  }

  private raycast(origin: Vector3, through: Vector3): boolean {
    let bestT = Infinity;
    let bestTri = -1;
    let bestScan: TriScan | null = null;
    for (let i = 0; i < this.scans.length; i++) {
      const scan = this.scans[i];
      const mesh = scan.mesh;
      if (!mesh.parent) continue;
      mesh.updateWorldMatrix(true, false);
      this.inv.copy(mesh.matrixWorld).invert();
      this.localO.copy(origin).applyMatrix4(this.inv);
      this.localD.copy(through).applyMatrix4(this.inv).sub(this.localO);
      const len = this.localD.length();
      if (len < 1e-5) continue;
      this.localD.multiplyScalar(1 / len);
      if (!rayTriGrid(
        scan.positions, scan.index, scan.grid,
        this.localO.x, this.localO.y, this.localO.z,
        this.localD.x, this.localD.y, this.localD.z,
        this.hit,
      )) continue;
      if (this.hit.t >= bestT || this.hit.t > 12) continue;
      bestT = this.hit.t;
      bestTri = this.hit.tri;
      bestScan = scan;
      this.bestO.copy(this.localO);
      this.bestD.copy(this.localD);
    }
    if (!bestScan) return false;
    this.hit.t = bestT;
    this.hit.tri = bestTri;
    this.hitMesh = bestScan.mesh;
    this.hitScan = this.scans.indexOf(bestScan);
    this.localHit.copy(this.bestO).addScaledVector(this.bestD, bestT);
    triangleNormal(bestScan.positions, bestScan.index, bestTri, this.localN);
    averageNormal(
      bestScan.positions, bestScan.index, bestScan.grid,
      this.localHit.x, this.localHit.y, this.localHit.z, NORMAL_RADIUS,
      this.localN.x, this.localN.y, this.localN.z, this.localN,
    );
    if (this.localN.dot(this.bestD) > 0) this.localN.negate();
    return true;
  }

  /** Which scan the pinch hit: its index, label and triangle count. */
  private scanNote(): string {
    const scan = this.scans[this.hitScan];
    if (!scan) return '';
    const label = this.meshLabels.get(scan.mesh) || '?';
    return `#${this.hitScan}/${this.scans.length} ${label} ${Math.floor(scan.index.length / 3)}t`;
  }

  /**
   * The scan is lumpy by a centimetre or two; a detected plane is flat. When the line of sight
   * through the pinch meets a plane just around the mesh hit, grab there with the plane's normal.
   */
  private preferPlane(): void {
    this.hitNote = 'mesh';
    const mesh = this.hitMesh;
    if (!mesh || this.roomPlanes.count === 0) return;
    this.rayDir.copy(this.pinch).sub(this.head);
    if (this.rayDir.lengthSq() < 1e-8) return;
    this.rayDir.normalize();
    mesh.updateWorldMatrix(true, false);
    this.meshHitWorld.copy(this.localHit).applyMatrix4(mesh.matrixWorld);
    const meshT = this.meshHitWorld.distanceTo(this.head);
    if (!this.roomPlanes.underHit(this.head, this.rayDir, meshT, this.planeHit, this.planeMiss)) {
      const miss = this.planeMiss;
      if (miss.found) this.hitNote = `mesh (${miss.label} ${(miss.delta * 100).toFixed(0)}cm)`;
      return;
    }
    this.inv.copy(mesh.matrixWorld).invert();
    this.localHit.copy(this.planeHit.point).applyMatrix4(this.inv);
    this.localN.copy(this.planeHit.normal).transformDirection(this.inv);
    this.hitNote = `plane:${this.planeHit.label} d=${(this.planeHit.delta * 100).toFixed(1)}cm`;
  }

  private poseGrab(grab: Grab): void {
    const mesh = grab.mesh;
    if (!mesh?.parent || (!grab.holding && !grab.on)) return;
    mesh.updateWorldMatrix(true, false);
    grab.worldG.copy(grab.localG).applyMatrix4(mesh.matrixWorld);
    grab.normal.copy(grab.localNormal).transformDirection(mesh.matrixWorld);
  }

  /** Turns a pinch from the last select event into a grab, now that the hand joints are readable. */
  private resolvePending(grab: Grab, dt: number, now: number): void {
    if (!grab.pending) return;
    if (this.handMap[grab.side] && !this.hands.hasPinch[grab.side]) {
      if (now - grab.pendingAt > PENDING_GIVEUP) grab.pending = false;
      return;
    }
    if (grab.on && !grab.holding) {
      // Still springing from the last pull: settle it fast, so re-basing doesn't pop.
      this.stepSprings(grab, dt, SETTLE_STIFF, SETTLE_DAMP);
      if (!this.springsAtRest(grab) && now - grab.pendingAt < SETTLE_MAX) return;
    }
    grab.pending = false;
    this.resetGrab(grab);
    this.photo.drop(grab.slot);
    const tag = grab.side === 'left' ? 'L' : 'R';
    if (!this.pinchPoint(grab.side, this.pinch)) {
      console.warn(`[jonze] pinch ${tag}: no hand pose`);
      return;
    }
    if (!this.raycast(this.head, this.pinch)) {
      console.warn(`[jonze] pinch ${tag}: no room mesh under the pinch (${this.scans.length} scans)`);
      this.sound.miss(grab.slot, this.pinch.x, this.pinch.y, this.pinch.z);
      return;
    }
    this.preferPlane();
    grab.mesh = this.hitMesh;
    grab.holding = true;
    grab.on = true;
    grab.seq = ++this.grabSeq;
    grab.localG.copy(this.localHit);
    grab.localNormal.copy(this.localN);
    grab.hand0.copy(this.pinch);
    grab.reach0 = this.pinch.distanceTo(this.head);
    const other = grab === this.left ? this.right : this.left;
    grab.chain = other.on && other.D.length() > 0.02;
    grab.capped = false;
    grab.ray0.copy(this.pinch).sub(this.head).normalize();
    grab.rippleT = 0;
    this.poseGrab(grab);
    grab.dist = Math.max(0.2, this.head.distanceTo(grab.worldG));
    grab.ramp = this.look.ramp * Math.max(1, grab.dist / RAMP_NEAR);
    grab.span = grab.ramp;
    grab.lift.copy(this.head).sub(grab.worldG).normalize();
    this.writeFootprint(grab);
    const freezeAt = performance.now();
    const frozen = this.photo.freeze(grab.slot, this.footprint, FOOTPRINT, true, this.camera, now, this.handJoints(), this.head);
    grab.freezeMs = performance.now() - freezeAt;
    if (!frozen) {
      // Nothing to show: bending it would be invisible. Without video a retry can't help.
      const retry = this.photo.lastMiss !== 'no-video' && now - grab.pendingAt < PHOTO_WAIT;
      this.resetGrab(grab);
      this.photo.drop(grab.slot);
      if (retry) {
        grab.pending = true;
        return;
      }
      console.warn(`[jonze] ${this.photo.pickLine(grab.slot)}, released`);
      this.sound.miss(grab.slot, this.pinch.x, this.pinch.y, this.pinch.z);
      return;
    }
    const raised = RAISE && this.captureRaise(grab.slot);
    const n = grab.normal;
    const surface = Math.abs(n.y) < 0.5 ? 'wall' : n.y > 0 ? 'table' : 'ceiling';
    console.info(
      `[jonze] pinch ${tag} ${surface} ${this.head.distanceTo(grab.worldG).toFixed(2)}m dense=${this.overlay.ready ? 'y' : 'n'} ` +
        `raise=${raised ? 'y' : 'n'} hit=${this.hitNote} ${this.scanNote()}`,
    );
    console.info(`[jonze] ${this.photo.pickLine(grab.slot)} | ${grab.freezeMs.toFixed(1)}ms`);
    grab.heldAt = now;
    grab.onsetCount = 0;
    grab.pinchUpdateMs = -1;
    grab.fade = 0;
    this.pinched = true;
  }

  /** The grab point and a ring at reach in its surface plane: what the photo has to cover. */
  private writeFootprint(grab: Grab): void {
    const n = grab.normal;
    this.tanU.set(0, 1, 0).cross(n);
    if (this.tanU.lengthSq() < 1e-6) this.tanU.set(1, 0, 0).cross(n);
    this.tanU.normalize();
    this.tanV.copy(n).cross(this.tanU);
    const r = Math.min(0.4, Math.max(0.25, this.look.reach * 0.8));
    const f = this.footprint;
    f[0] = grab.worldG.x;
    f[1] = grab.worldG.y;
    f[2] = grab.worldG.z;
    for (let i = 1; i < FOOTPRINT; i++) {
      const a = ((i - 1) / (FOOTPRINT - 1)) * Math.PI * 2;
      const c = Math.cos(a) * r;
      const s = Math.sin(a) * r;
      f[i * 3] = grab.worldG.x + this.tanU.x * c + this.tanV.x * s;
      f[i * 3 + 1] = grab.worldG.y + this.tanU.y * c + this.tanV.y * s;
      f[i * 3 + 2] = grab.worldG.z + this.tanU.z * c + this.tanV.z * s;
    }
  }

  private stepHand(grab: Grab, dt: number): void {
    if (grab.pending) return;
    this.poseGrab(grab);
    if (grab.holding) {
      if (this.pinchPoint(grab.side, this.pinch)) {
        grab.lostT = 0;
        this.aim(grab, this.pinch, dt);
      } else {
        grab.lostT += dt;
        if (grab.lostT > LOST_RELEASE) this.release(grab);
      }
    }
    // A long frame (a pinch-frame hitch) must not land the whole pull at once: smooth by a capped
    // step and cap the speed, so the stretch still grows over a few frames. Velocities use real time.
    const step = Math.min(dt, STEP_MAX);
    if (grab.holding) {
      const f = 1 - Math.exp(-step / FOLLOW);
      const inv = 1 / Math.max(dt, 1e-3);
      grab.Dprev.copy(grab.D);
      grab.D.lerp(grab.target, f);
      const jump = this.tmp.copy(grab.D).sub(grab.Dprev);
      const most = FOLLOW_MAX * step;
      if (jump.lengthSq() > most * most) grab.D.copy(grab.Dprev).addScaledVector(jump, most / jump.length());
      grab.Dvel.copy(grab.D).sub(grab.Dprev).multiplyScalar(inv);
      const e = grab.E + (grab.explodeTo - grab.E) * f;
      grab.Evel = (e - grab.E) * inv;
      grab.E = e;
      const b = grab.B + (grab.liftTo - grab.B) * f;
      grab.Bvel = (b - grab.B) * inv;
      grab.B = b;
      grab.lift.copy(this.head).sub(grab.worldG).normalize();
      const slid = grab.D.length();
      if (slid > grab.peakSlide) grab.peakSlide = slid;
      if (b > grab.peakLift) grab.peakLift = b;
      if (e > grab.peakBurst) grab.peakBurst = e;
    } else if (grab.on) {
      this.stepSprings(grab, dt, this.look.stiffness, this.look.damping);
    }
    const len = grab.D.length();
    if (len > 1e-4) grab.axis.copy(grab.D).multiplyScalar(1 / len);
    grab.rippleT = Math.min(grab.rippleT + dt, 10);
    const slot = this.photo.slots[grab.slot];
    grab.fade = slot.has && slot.ready ? Math.min(1, grab.fade + step / FADE_IN) : 0;
    if (grab.holding && grab.onsetCount < ONSET_FRAMES) {
      const o = grab.onsetCount++ * 4;
      grab.onset[o] = this.frameDt * 1000;
      grab.onset[o + 1] = grab.D.length() * 100;
      grab.onset[o + 2] = grab.fade;
      grab.onset[o + 3] = grab.ease;
    }
    const wasOn = grab.on;
    grab.on = grab.holding || !this.springsAtRest(grab) || grab.rippleT < RIPPLE_SECONDS;
    if (wasOn && !grab.on) {
      this.resetGrab(grab);
      this.photo.drop(grab.slot);
    }
  }

  private stepSprings(grab: Grab, dt: number, stiffness: number, damping: number): void {
    const s = grab.springs;
    grab.D.set(s[0].step(0, dt, stiffness, damping), s[1].step(0, dt, stiffness, damping), s[2].step(0, dt, stiffness, damping));
    grab.E = s[3].step(0, dt, stiffness, damping);
    grab.B = s[4].step(0, dt, stiffness, damping);
  }

  private springsAtRest(grab: Grab): boolean {
    const s = grab.springs;
    for (let i = 0; i < s.length; i++) if (!s[i].atRest(0)) return false;
    return true;
  }

  /** Hands the held pull to the springs, keeping its velocity, so letting go wobbles back. */
  private release(grab: Grab): void {
    if (grab.holding) this.logPull(grab);
    grab.holding = false;
    grab.axisRel.copy(grab.axis);
    const s = grab.springs;
    s[0].value = grab.D.x;
    s[0].velocity = grab.Dvel.x;
    s[1].value = grab.D.y;
    s[1].velocity = grab.Dvel.y;
    s[2].value = grab.D.z;
    s[2].velocity = grab.Dvel.z;
    s[3].value = grab.E;
    s[3].velocity = grab.Evel;
    s[4].value = grab.B;
    s[4].velocity = grab.Bvel;
    grab.target.set(0, 0, 0);
    grab.explodeTo = 0;
    grab.liftTo = 0;
  }

  /**
   * The grabbed spot stays on the pinch ray: it slides in the surface plane to where the ray from
   * your eyes through your fingers meets that plane, so pulling a table edge toward you stretches it
   * toward you. Bringing the hand closer to your head bursts a wall outward from the pinch; a table
   * or floor bursts only when the hand comes nearly straight off it.
   */
  private aim(grab: Grab, hand: Vector3, dt: number): void {
    const travel = this.raw.copy(hand).sub(grab.hand0);
    const moved = travel.length();
    const ease = smooth((moved - 0.5 * DEAD) / DEAD);
    grab.moved = moved;
    grab.ease = ease;
    const ray = this.unit.copy(hand).sub(this.head);
    const reach = ray.length();
    const n = grab.normal;
    const across = n.dot(ray);
    if (across < -GRAZE * reach) {
      const k = this.tmp.copy(grab.worldG).sub(this.head).dot(n) / across;
      const slide = this.tmp2.copy(this.head).addScaledVector(ray, k).sub(grab.worldG);
      slide.addScaledVector(n, -slide.dot(n)).multiplyScalar(this.look.gain * ease);
      const len = slide.length();
      const span = this.slideSpan(grab, dt);
      const soft = Math.min(SLIDE_SOFT, SOFT_PER_SPAN * span);
      const hard = Math.min(SLIDE_MAX, MAX_PER_SPAN * span);
      if (len > soft) {
        const room = Math.max(1e-3, hard - soft);
        slide.multiplyScalar((soft + room * (1 - Math.exp(-(len - soft) / room))) / len);
        grab.capped = true;
      }
      this.keepInPhoto(grab, slide);
      grab.target.copy(slide);
    }
    const along = travel.dot(grab.ray0);
    const lateral = Math.sqrt(Math.max(0, moved * moved - along * along));
    const toward = Math.max(0, grab.reach0 - reach - LATERAL_SHARE * lateral - TOWARD_DEAD) * ease;
    const off = travel.dot(n);
    const straight = moved > 1e-3 ? smooth((off / moved - STRAIGHT_FROM) / (STRAIGHT_FULL - STRAIGHT_FROM)) : 0;
    const wall = 1 - smooth((Math.abs(n.y) - WALL_UP) / WALL_FADE);
    const rim = Math.max(0, (BURST_ANGLE * this.head.distanceTo(grab.worldG) - 0.22) / 1.5);
    let e = Math.min(EXPLODE_MAX, rim, this.look.radial * toward * Math.max(straight, wall));
    const slid = grab.target.length();
    if (slid + e > PULL_MAX) e = Math.max(0, PULL_MAX - slid);
    grab.explodeTo = e;
    grab.liftTo = Math.min(LIFT_MAX, this.look.depthPull * toward);
  }

  /**
   * What a slide is measured against: the distance between the two hands when both hold the same
   * surface (pulling them apart stretches what is between them), else this grab's ramp.
   */
  private slideSpan(grab: Grab, dt: number): number {
    const other = grab === this.left ? this.right : this.left;
    let want = grab.ramp;
    // One surface: facing the same way and in one plane, not just parallel (floor and table, or two walls).
    if (other.holding && other.mesh === grab.mesh && other.normal.dot(grab.normal) > SAME_SURFACE) {
      const n = grab.normal;
      const a = other.worldG;
      const b = grab.worldG;
      const off = (a.x - b.x) * n.x + (a.y - b.y) * n.y + (a.z - b.z) * n.z;
      if (Math.abs(off) < SAME_PLANE) want = Math.max(0.1, a.distanceTo(b));
    }
    // Eased, so the caps don't jump when the other hand pinches or lets go.
    grab.span += (want - grab.span) * (1 - Math.exp(-Math.min(dt, STEP_MAX) / SPAN_EASE));
    return grab.span;
  }

  /** One line per pull, when it lets go: how far it went and whether streaks or the photo edge came in. */
  private logPull(grab: Grab): void {
    const held = performance.now() / 1000 - grab.heldAt;
    // Short, with the limiters first: the panel cuts lines at 72 characters.
    const short = (v: number) => v.toFixed(2).replace(/^0\./, '.');
    const ratio = grab.span > 1e-3 ? grab.peakSlide / grab.span : 0;
    const limit = (grab.clipped ? ' clip' : '') + (grab.capped ? ' cap' : '');
    console.info(
      `[jonze] pull ${grab.side === 'left' ? 'L' : 'R'} ${held.toFixed(1)}s${limit} ${grab.dist.toFixed(1)}m ` +
        `D${short(grab.peakSlide)} x${ratio.toFixed(1)} lift${short(grab.peakLift)} ` +
        `burst${short(grab.peakBurst)} bloom${short(grab.peakBloom)} chain=${grab.chain ? 'y' : 'n'}`,
    );
    this.logOnset(grab);
  }

  /**
   * The pull's first frames, two short lines: frame times (a hitch shows as one long frame), then how
   * far the surface had moved (cm) and the fade (0-9). A pop is a jump in D within one frame.
   */
  private logOnset(grab: Grab): void {
    const n = grab.onsetCount;
    if (n === 0) return;
    const tag = grab.side === 'left' ? 'L' : 'R';
    let dt = '';
    let d = '';
    let fade = '';
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      dt += ` ${Math.round(grab.onset[o])}`;
      d += ` ${Math.round(grab.onset[o + 1])}`;
      fade += Math.min(9, Math.floor(grab.onset[o + 2] * 10));
    }
    const upd = grab.pinchUpdateMs >= 0 ? grab.pinchUpdateMs.toFixed(1) : '?';
    console.info(`[jonze] onset ${tag} freeze ${grab.freezeMs.toFixed(1)} upd ${upd}ms dt${dt}`);
    console.info(`[jonze] onset ${tag} D${d} a ${fade}`);
  }

  /** Shortens a slide so the grab point lands inside its photo: past the edge there is nothing to show. */
  private keepInPhoto(grab: Grab, slide: Vector3): void {
    if (!this.photo.slots[grab.slot].has) return;
    const probe = this.tmp.copy(grab.worldG).add(slide);
    if (this.photo.slotContains(grab.slot, probe, SLIDE_MARGIN)) return;
    grab.clipped = true;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) * 0.5;
      probe.copy(grab.worldG).addScaledVector(slide, mid);
      if (this.photo.slotContains(grab.slot, probe, SLIDE_MARGIN)) lo = mid;
      else hi = mid;
    }
    slide.multiplyScalar(lo);
  }

  private clearGrabs(): void {
    this.resetGrab(this.left);
    this.resetGrab(this.right);
    this.left.pending = false;
    this.right.pending = false;
    this.photo.drop(0);
    this.photo.drop(1);
  }

  private resetGrab(grab: Grab): void {
    grab.holding = false;
    grab.on = false;
    grab.mesh = null;
    grab.target.set(0, 0, 0);
    grab.D.set(0, 0, 0);
    grab.Dprev.set(0, 0, 0);
    grab.Dvel.set(0, 0, 0);
    grab.E = 0;
    grab.Evel = 0;
    grab.B = 0;
    grab.Bvel = 0;
    grab.explodeTo = 0;
    grab.liftTo = 0;
    grab.rippleT = 10;
    grab.lostT = 0;
    grab.fade = 0;
    grab.bloom = 0;
    grab.peakSlide = 0;
    grab.peakLift = 0;
    grab.peakBurst = 0;
    grab.peakBloom = 0;
    grab.clipped = false;
    for (let i = 0; i < grab.springs.length; i++) grab.springs[i].reset(0);
  }

  /** Desktop preview: two points on the wardrobe pull apart, hold, then return. */
  private updateDemo(dt: number, now: number): void {
    this.demoT += dt;
    const t = this.demoT % 8;
    let pull = 0;
    if (t < 1.2) pull = smooth(t / 1.2) * 0.72;
    else if (t < 5.2) pull = 0.72;
    else if (t < 6.8) pull = (1 - smooth((t - 5.2) / 1.6)) * 0.72;
    const moving = pull > 0.02;
    this.camera.getWorldPosition(this.head);
    this.demoGrab(this.demoL, -1, pull, moving, dt, now);
    this.demoGrab(this.demoR, 1, pull, moving, dt, now);
  }

  private demoGrab(grab: Grab, sign: number, pull: number, moving: boolean, dt: number, now: number): void {
    grab.on = moving;
    grab.holding = moving;
    grab.D.set(sign * pull, 0, 0);
    grab.axis.set(sign, 0, 0);
    grab.axisRel.copy(grab.axis);
    grab.normal.set(0, 0, 1);
    grab.lift.copy(this.head).sub(grab.worldG).normalize();
    grab.dist = Math.max(0.2, this.head.distanceTo(grab.worldG));
    grab.ramp = this.look.ramp * Math.max(1, grab.dist / RAMP_NEAR);
    grab.B = Math.min(LIFT_MAX, pull * 0.11);
    grab.E = 0;
    grab.rippleT = 10;
    grab.A = AHEAD;
    const slot = this.photo.slots[grab.slot];
    if (moving && !slot.has) {
      this.writeFootprint(grab);
      if (this.photo.freeze(grab.slot, this.footprint, FOOTPRINT, false, this.camera, now, null, this.head)) {
        console.info(`[jonze] ${this.photo.pickLine(grab.slot)}`);
      }
    } else if (!moving && slot.has) {
      this.photo.drop(grab.slot);
    }
    grab.fade = slot.has && slot.ready ? Math.min(1, grab.fade + dt / FADE_IN) : 0;
  }

  private publish(a: Grab, b: Grab, time: number, hasVideo: boolean): void {
    const U = this.overlay.uniforms;
    const aFirst = !b.on || (a.on && a.seq <= b.seq);
    this.writeGrab(U, 0, aFirst ? a : b);
    this.writeGrab(U, 1, aFirst ? b : a);
    U.uReach.value = this.look.reach;
    U.uFeather.value = this.look.feather;
    U.uWobble.value = this.look.wobble;
    U.uWaveK.value = 1 / Math.max(this.look.waveLength, 0.05);
    U.uWaveSpeed.value = this.look.waveSpeed;
    U.uTime.value = time;
    U.uRipple.value = this.look.ripple;
    U.uAnyPhoto.value = hasVideo ? 1 : 0;
    U.uLinear.value = this.look.linearBlend ? 1 : 0;
    this.publishRaise();
    const g0 = aFirst ? a : b;
    const g1 = aFirst ? b : a;
    const [b0, b1] = this.overlay.bounds;
    this.boundGrab(b0, g0, 0);
    // A chained second grab bends what the first already moved: its reach grows by that move.
    this.boundGrab(b1, g1, g0.on && g1.chain ? moveReach(g0, this.boundLook()) : 0);
  }

  /** Where a grab can move the room this frame. */
  private boundGrab(bound: StretchBound, grab: Grab, grow: number): void {
    bound.on = grab.on;
    if (grab.on) fillBound(bound, grab, this.boundLook(), grow);
  }

  private boundLook(): BoundLook {
    const b = this.bounding;
    b.reach = this.look.reach;
    b.core = this.overlay.uniforms.uCore.value;
    b.ripple = this.look.ripple;
    b.wobble = this.look.wobble;
    return b;
  }

  /** Copies this frame's depth into photo slot `k`'s raise map, hands cleared. */
  private captureRaise(k: 0 | 1): boolean {
    return this.raise.capture(k, this.renderer, this.depth, this.camera.parent, this.hands.segA, this.hands.segB);
  }

  /**
   * Each photo slot's raise map is used while its grab is on; slot 0's also while the lens stripes
   * show, so they can be checked on the objects it raises.
   */
  private publishRaise(): void {
    const U = this.overlay.uniforms;
    const lens = U.uLensOn.value > 0;
    for (let k = 0; k < 2; k++) {
      const map = this.raise.maps[k];
      const grab = k === 0 ? this.left : this.right;
      const on = RAISE && map.on && (grab.on || (k === 0 && lens)) ? 1 : 0;
      if (k === 0) {
        U.uRaiseOn0.value = on;
        U.uRaise0.value = map.target.texture;
        U.uRaiseToMap0.value.copy(map.toMap);
        U.uRaiseEye0.value.copy(map.eye);
      } else {
        U.uRaiseOn1.value = on;
        U.uRaise1.value = map.target.texture;
        U.uRaiseToMap1.value.copy(map.toMap);
        U.uRaiseEye1.value.copy(map.eye);
      }
    }
  }



  private writeGrab(U: RubberUniformSet, k: 0 | 1, grab: Grab): void {
    const first = k === 0;
    (first ? U.uG0 : U.uG1).value.copy(grab.worldG);
    (first ? U.uD0 : U.uD1).value.copy(grab.D);
    (first ? U.uAxis0 : U.uAxis1).value.copy(grab.axis);
    (first ? U.uN0 : U.uN1).value.copy(grab.normal);
    (first ? U.uLift0 : U.uLift1).value.copy(grab.lift);
    const slot = this.photo.slots[grab.slot];
    (first ? U.uPhoto0 : U.uPhoto1).value = slot.texture;
    (first ? U.uWorldToClip0 : U.uWorldToClip1).value.copy(slot.toClip);
    (first ? U.uCamPos0 : U.uCamPos1).value.copy(slot.cam);
    (first ? U.uGain0 : U.uGain1).value.copy(slot.gain);
    const fill = slot.fill;
    const hasFill = slot.has && fill.has && fill.ready && fill.texture ? 1 : 0;
    (first ? U.uFill0 : U.uFill1).value = fill.texture;
    (first ? U.uFillToClip0 : U.uFillToClip1).value.copy(fill.toClip);
    (first ? U.uFillCam0 : U.uFillCam1).value.copy(fill.cam);
    (first ? U.uHasFill0 : U.uHasFill1).value = hasFill;
    const on = grab.on ? 1 : 0;
    const has = slot.has && slot.texture ? 1 : 0;
    // Streaks only on the side the pull went; the spring's overshoot flips D but not the picture.
    const len = grab.D.length();
    const sk = grab.holding || len < 1e-4 ? 1 : Math.max(0, grab.D.dot(grab.axisRel) / len);
    // A live frame's grabbed column is the hand's hole: without a fill behind it, it only stretches.
    const streaks = !slot.live || hasFill > 0;
    const angle = Math.atan2(len * sk, grab.dist) / DEG;
    grab.bloom = grab.on && streaks ? smooth((angle - this.look.stripes) / STREAK_SPAN_DEG) : 0;
    (first ? U.uRamp0 : U.uRamp1).value = grab.ramp;
    if (!first) U.uChain1.value = grab.chain ? 1 : 0;
    if (grab.holding && grab.bloom > grab.peakBloom) grab.peakBloom = grab.bloom;
    if (first) {
      U.uA0.value = grab.A;
      U.uE0.value = grab.E;
      U.uB0.value = grab.B;
      U.uRip0.value = grab.rippleT;
      U.uOn0.value = on;
      U.uBloom0.value = grab.bloom;
      U.uHasPhoto0.value = has;
      U.uFade0.value = grab.fade;
    } else {
      U.uA1.value = grab.A;
      U.uE1.value = grab.E;
      U.uB1.value = grab.B;
      U.uRip1.value = grab.rippleT;
      U.uOn1.value = on;
      U.uBloom1.value = grab.bloom;
      U.uHasPhoto1.value = has;
      U.uFade1.value = grab.fade;
    }
  }

  /**
   * Feeds one hand to the sound. Pull is in radians of visual pull: the held target while holding,
   * so notes follow the fingers, then the spring after release, negative while it overshoots.
   */
  private sing(grab: Grab): void {
    const G = grab.worldG;
    if (!grab.on) {
      this.sound.track(grab.slot, false, 0, 0, G.x, G.y, G.z);
      return;
    }
    const dist = Math.max(0.5, this.head.distanceTo(G));
    let mag: number;
    if (grab.holding) {
      mag = Math.max(grab.target.length(), grab.explodeTo);
    } else {
      const len = grab.D.length();
      mag = Math.max(len, grab.E);
      if (len >= grab.E && grab.D.dot(grab.axisRel) < 0) mag = -len;
    }
    // publish() ran first this frame, so the sparkle follows the streaks actually drawn.
    this.sound.track(grab.slot, grab.holding, mag / dist, grab.bloom, G.x, G.y, G.z);
  }

  // ---------------------------------------------------------------- hint card

  private updateHud(dt: number, presenting: boolean, hasVideo: boolean, now: number): void {
    const want = this.cardFor(presenting, hasVideo, now);
    if (want !== Card.None && want !== this.cardShown) this.paintCard(want);
    const holding = this.left.holding || this.right.holding;
    const target = want !== Card.None && !holding ? 1 : 0;
    this.placeCard(dt, target);
  }

  private placeCard(dt: number, target: number): void {
    this.cardOpacity += (target - this.cardOpacity) * (1 - Math.exp(-dt * 6));
    const visible = this.cardOpacity > 0.01;
    if (this.card.visible !== visible) this.card.visible = visible;
    this.cardMat.opacity = this.cardOpacity;
    if (!visible) {
      this.cardSettled = false;
      return;
    }
    this.unit.set(0, 0, -1).applyQuaternion(this.headQuat);
    this.unit.y = 0;
    if (this.unit.lengthSq() < 1e-6) this.unit.set(0, 0, -1);
    this.unit.normalize();
    this.pinch.copy(this.unit).multiplyScalar(CARD_DISTANCE * Math.sqrt(1 - CARD_RISE * CARD_RISE)).add(this.head);
    this.pinch.y += CARD_DISTANCE * CARD_RISE;
    if (!this.cardSettled) {
      this.card.position.copy(this.pinch);
      this.cardSettled = true;
    } else {
      this.card.position.lerp(this.pinch, 1 - Math.exp(-dt * 3));
    }
    this.card.lookAt(this.head);
  }

  private cardFor(presenting: boolean, hasVideo: boolean, now: number): Card {
    if (!presenting) return Card.None;
    const since = now - this.presentedAt;
    if (!this.scans.length && since > 4) {
      const features = (this.session as (XRSession & { enabledFeatures?: readonly string[] }) | null)?.enabledFeatures;
      return features && !features.includes('mesh-detection') ? Card.Spatial : Card.Scan;
    }
    if (!hasVideo && since > 3) return Card.Camera;
    if (!this.pinched && this.scans.length) return Card.Pinch;
    return Card.None;
  }

  private paintCard(card: Card): void {
    this.cardShown = card;
    drawHint(this.cardPaint, COPY[card].title, COPY[card].body);
    this.cardTex.needsUpdate = true;
  }

  /** What the pull is actually running with, once per session. */
  private logLook(): void {
    this.lookLogged = true;
    const k = this.look;
    console.info(
      `[jonze] look exp=${k.exposure.toFixed(2)} warm=${k.warmth.toFixed(2)} tint=${k.tint.toFixed(2)} ` +
        `feather=${k.feather.toFixed(3)} wobble=${k.wobble.toFixed(3)} lin=${k.linearBlend ? 1 : 0}`,
    );
    console.info(
      `[jonze] look stripes=${k.stripes.toFixed(0)}deg ramp=${k.ramp.toFixed(2)} radial=${k.radial.toFixed(1)} ` +
        `lat=${k.cameraLatency.toFixed(3)} hand=${k.handLag.toFixed(3)}${OCC_MODE ? ` occ=${OCC_MODE}` : ''}`,
    );
    const trimmed =
      k.lensScale !== 1 || k.lensPitchTrim !== 0 || k.lensYawTrim !== 0 || k.lensRollTrim !== 0 ||
      k.lensDx !== 0 || k.lensDy !== 0 || k.lensDz !== 0 || k.cameraSide !== 'auto' || k.cameraLatency !== 0;
    if (trimmed) {
      console.warn(
        `[jonze] lens trims x${k.lensScale.toFixed(3)} pyr=${k.lensPitchTrim}/${k.lensYawTrim}/${k.lensRollTrim} ` +
          `d=${k.lensDx},${k.lensDy},${k.lensDz} side=${k.cameraSide} lat=${k.cameraLatency}`,
      );
    }
  }

  private readLook(): void {
    for (const entity of this.queries.settings.entities) {
      for (let i = 0; i < NUMBER_KEYS.length; i++) {
        const key = NUMBER_KEYS[i];
        const value = entity.getValue(StretchLook, key);
        if (typeof value === 'number') this.look[key] = value;
      }
      const linear = entity.getValue(StretchLook, 'linearBlend');
      if (typeof linear === 'boolean') this.look.linearBlend = linear;
      const side = entity.getValue(StretchLook, 'cameraSide');
      if (side === 'left' || side === 'right' || side === 'auto') this.look.cameraSide = side;
      return;
    }
  }

  private applyLook(): void {
    const lens = this.photo.lens;
    lens.scale = this.look.lensScale;
    lens.pitchTrim = this.look.lensPitchTrim;
    lens.yawTrim = this.look.lensYawTrim;
    lens.rollTrim = this.look.lensRollTrim;
    lens.dx = this.look.lensDx;
    lens.dy = this.look.lensDy;
    lens.dz = this.look.lensDz;
    lens.side = this.look.cameraSide;
    lens.latency = this.look.cameraLatency;
    lens.exposure = this.look.exposure;
    lens.warmth = this.look.warmth;
    lens.tint = this.look.tint;
    this.photo.updateGains();
  }

  // ---------------------------------------------------------------- camera

  private attachCamera(devices: CameraDeviceInfo[]): boolean {
    if (getMode() !== 'stretch' || this.cameraEntity) return !!this.cameraEntity;
    // The left room camera on purpose: the lens model is measured for it and mirrored for the right.
    const backs = devices.filter((d) => d.facing === CameraFacing.Back);
    const backLabels = backs.map((d) => d.label);
    const back = backs.find((d) => cameraMount(d.label, 'back', backLabels) === 'left') ?? backs[0] ?? null;
    const chosen = back ?? devices[0];
    if (!chosen) {
      console.warn('[jonze] camera: no video inputs');
      return false;
    }
    this.mount = cameraMount(chosen.label, back ? 'back' : 'unknown', backLabels);
    this.photo.setMount(this.mount);
    console.info(`[jonze] camera pick "${chosen.label}" side=${this.mount} of ${devices.length} (${backs.length} back)`);
    console.debug('[jonze] camera devices', devices.map((d) => d.label).join(' | '));
    const anchor = new Group();
    anchor.name = 'passthrough-camera';
    anchor.visible = false;
    const entity = this.world.createTransformEntity(anchor);
    entity.addComponent(CameraSource);
    entity.setValue(CameraSource, 'deviceId', chosen.deviceId);
    entity.setValue(CameraSource, 'facing', back ? CameraFacing.Back : CameraFacing.Unknown);
    // The full square sensor where the firmware offers it; otherwise the nearest is the 1280x960 crop
    // of the same lens. The constraints are ideal, so either opens.
    entity.setValue(CameraSource, 'width', 1280);
    entity.setValue(CameraSource, 'height', 1280);
    entity.setValue(CameraSource, 'frameRate', 30);
    this.cameraEntity = entity;
    this.rearmTries = 0;
    return true;
  }

  /** IWSDK retries a failing camera itself; this only covers an arm that never happened or failed. */
  private rearmCamera(now: number): void {
    if (!this.cameraWanted || this.cameraEntity || this.arming || this.rearmTries >= 3 || now < this.rearmAt) return;
    this.rearmTries++;
    this.rearmAt = now + Math.pow(2, this.rearmTries - 1);
    void this.armCamera();
  }

  private cameraVideo(): HTMLVideoElement | null {
    const entity = this.cameraEntity;
    const state = entity ? String(entity.getValue(CameraSource, 'state')) : '';
    if (state !== this.cameraStateWas) {
      this.cameraStateWas = state;
      if (state && state !== CameraState.Active) console.info(`[jonze] camera state ${state}`);
    }
    if (!entity || state !== CameraState.Active) return null;
    return entity.getValue(CameraSource, 'videoElement') as HTMLVideoElement | null;
  }

  private cameraTrack(video: HTMLVideoElement | null): MediaStreamTrack | null {
    if (video === this.trackVideo) return this.track;
    this.trackVideo = video;
    const stream = video?.srcObject;
    this.track = stream instanceof MediaStream ? stream.getVideoTracks()[0] ?? null : null;
    return this.track;
  }

  private stopCamera(): void {
    const entity = this.cameraEntity;
    if (!entity) return;
    const stream = entity.getValue(CameraSource, 'stream') as MediaStream | null;
    stream?.getTracks().forEach((track) => track.stop());
    const video = entity.getValue(CameraSource, 'videoElement') as HTMLVideoElement | null;
    if (video) {
      video.pause();
      video.srcObject = null;
    }
    const texture = entity.getValue(CameraSource, 'texture') as { dispose(): void } | null;
    texture?.dispose();
    entity.setValue(CameraSource, 'state', CameraState.Active);
    entity.dispose({ disposeResources: false });
    this.cameraEntity = null;
  }

  private dispose(): void {
    this.session?.removeEventListener('selectstart', this.onSelectStart);
    this.session?.removeEventListener('selectend', this.onSelectEnd);
    this.refSpace?.removeEventListener('reset', this.onReset);
    outlineMaterial.visible = true;
    this.stopCamera();
    this.overlay.dispose();
    this.meter.dispose();
    this.raise.dispose();
    this.hands.dispose();
    this.photo.dispose();
    this.sound.dispose();
    this.room.traverse((object) => {
      const mesh = object as Mesh;
      mesh.geometry?.dispose();
    });
    this.room.removeFromParent();
    this.cardTex.dispose();
    this.cardMat.dispose();
    this.hudEntity.dispose();
  }
}

interface TriScan {
  mesh: Mesh;
  positions: ArrayLike<number>;
  index: ArrayLike<number>;
  grid: TriGrid;
}
