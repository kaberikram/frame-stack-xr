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
import { EnvDepth } from './env-depth.js';
import { PREVIEW_FORCED, getMode } from './experience.js';
import { HandOccluder, SEGMENTS } from './hand-occluder.js';
import { polygonDepth } from './mesh-subdivide.js';
import { countStraight, makePalmPose, readPalm, type PalmPose } from './palm-pose.js';
import { drawHint, makeCanvas, type Canvas2D } from './labels.js';
import { cameraMount, PassthroughPhoto, type CameraMount, type CameraSideSetting, type HandJoints } from './passthrough-photo.js';
import { PushBox } from './push-box.js';
import { RoomMeshOverlay } from './room-mesh-overlay.js';
import { RoomPlanes, type PlaneHit, type PlaneMiss } from './room-planes.js';
import { StretchLook } from './stretch-component.js';
import { Spring, averageNormal, buildTriGrid, rayTriGrid, triangleNormal, type RayHit, type TriGrid } from './stretch-math.js';
import { Stillness } from './touch-logic.js';
import type { RubberUniformSet } from './stretch-material.js';
import { StretchSound } from './stretch-sound.js';

type Side = 'left' | 'right';
/** What held a cone's height: it followed the hand, sat just behind the fingers, or hit its cap. */
type LiftLimit = 'hand' | 'tip' | 'cap';
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
/** The surface never follows faster than this, m/s. */
const FOLLOW_MAX = 2.5;
/** The pinch ray must meet the grabbed plane within ~78° of its normal to slide. */
const GRAZE = 0.2;
/**
 * Pulling toward you: the cone comes at most TENT_FRAC of the slid spot's way to your head, and never
 * more than TENT_MAX. The burst ignores the first TOWARD_DEAD share of the reach at the pinch.
 */
const TOWARD_DEAD = 0.02;
const TENT_FRAC = 0.7;
const TENT_MAX = 1.2;
/**
 * How near the surface was to the fingers at the pinch, as a 0..1 share: full with the surface within
 * NEAR_FULL behind the fingers (a table pinched on), none from NEAR_NONE (a wall across the room).
 * Near, a pull toward you holds back CLOTH_DRAG of the slide toward you and the spot follows your
 * fingertips as cloth instead.
 */
const NEAR_FULL = 0.08;
const NEAR_NONE = 0.35;
const CLOTH_DRAG = 0.6;
/** The cone's direction turns toward where it is aimed at this rate, 1/s. */
const LIFT_TURN = 12;
/** The burst along the surface, now a side note to the cone: this share of before, and at most this far. */
const BURST_SHARE = 0.35;
const EXPLODE_MAX = 0.3;
/** The cone's tip stops this far behind the fingers. */
const TIP_CLEAR = 0.05;
/**
 * A long cone carries the pinched spot's colours up into its tip, from this share of the way, fully
 * this much later. Late, so most pulls read as cloth with its own texture rather than taffy.
 */
const TENT_STREAK_FROM = 0.25;
const TENT_STREAK_SPAN = 0.3;
/**
 * Fingertip vacuum: an index fingertip this close to a surface (no pinch) sucks it up. The pull
 * starts at SPIKE_RANGE and is full by SPIKE_FULL; the surface then reaches SPIKE_REACH of the way to
 * the tip, stopping at least SPIKE_KEEP short, so a fingertip resting on the table raises nothing.
 * About 5.6 cm at 20 cm, 10.7 cm at 15 cm (4 cm short of the tip), 9.7 cm at 12 cm (2 cm short). Its
 * base radius grows from SPIKE_RADIUS with its height.
 */
const SPIKE_RANGE = 0.25;
const SPIKE_FULL = 0.12;
const SPIKE_REACH = 0.9;
const SPIKE_KEEP = 0.012;
const SPIKE_RADIUS = 0.15;
const SPIKE_WIDEN = 0.6;
/** Below this height there is no spike to draw. */
const SPIKE_MIN = 2e-4;
/** The surface reaches up with this spring (a little under critical, so it overshoots) and falls back with the look's own wobble. */
const SPIKE_STIFF = 320;
const SPIKE_DAMP = 22;
/** A table plane counts under a spike only this far below the hit: where the dense room was snapped onto it. */
const SPIKE_CLUTTER = 0.02;
/**
 * A spike's photo ring, and how soon a failed freeze may be tried again. With no clean bank photo by
 * SPIKE_LIVE_AFTER, it takes the live frame with the hands cut out: the finger hides the cut anyway.
 */
const SPIKE_FOOTPRINT = 0.15;
const SPIKE_RETRY = 0.4;
const SPIKE_LIVE_AFTER = 0.5;
/** The spike's foot glides after the fingertip with this time constant (s). */
const SPIKE_GLIDE = 0.04;
/**
 * Palm push: an open palm held up to a wall, facing it, in front of your eyes and still for a moment,
 * captures that section of the wall; pushing the palm on sinks it in as a box, and it stays in.
 * To arm, PALM_FINGERS fingers at least PALM_STRAIGHT straight, thumb off the index, the palm facing
 * away from you within PALM_CONE of your gaze, facing the wall, and clear of it. Held, it lets go
 * when the fingers curl, the palm turns off the wall, tracking drops, or the hand leaves the box.
 */
const PALM_STRAIGHT = 0.88;
const PALM_FINGERS = 3;
const PALM_KEEP_STRAIGHT = 0.75;
const PALM_KEEP_FINGERS = 2;
const PALM_THUMB_GAP = 0.04;
const PALM_AWAY = 0.5;
const PALM_CONE = Math.cos((30 * Math.PI) / 180);
const PALM_REACH_MIN = 0.2;
const PALM_FACE = 0.6;
const PALM_KEEP_FACE = Math.cos((70 * Math.PI) / 180);
const PALM_OFF_WALL = 0.12;
const PALM_STILL_RADIUS = 0.035;
const PALM_STILL_HOLD = 0.25;
/** An open palm that has not armed for this long says why, once. */
const PALM_WHY_AFTER = 0.5;
/** A wall: |n.y| under PUSH_WALL_UP, this near to this far. */
const PUSH_WALL_UP = 0.5;
const PUSH_WALL_MIN = 0.4;
const PUSH_WALL_MAX = 5;
/**
 * The box's half width is PUSH_SIZE of the wall's distance (about a third of what you see), between
 * these; its half height PUSH_ASPECT of that. It only shrinks, to stay on the wall's detected outline
 * (by PUSH_EDGE) and inside its photo (by PUSH_PHOTO_MARGIN uv), never below PUSH_HALF_FLOOR.
 */
const PUSH_SIZE = 0.3;
const PUSH_HALF_MIN = 0.25;
const PUSH_HALF_MAX = 0.9;
const PUSH_ASPECT = 0.8;
const PUSH_HALF_FLOOR = 0.12;
const PUSH_EDGE = 0.03;
const PUSH_PHOTO_MARGIN = 0.09;
const PUSH_SHRINK = 0.85;
/** The camera sees little above your gaze: the box moves toward the gaze's hit by up to this share of its height. */
const PUSH_BIAS = 0.6;
/** A photo is tried at these scales at most every PUSH_RETRY, the live frame from PUSH_LIVE_AFTER, and given up at PUSH_GIVE_UP. */
const PUSH_SCALES = [1, 0.7, 0.5] as const;
const PUSH_RETRY = 0.3;
const PUSH_LIVE_AFTER = 0.6;
const PUSH_GIVE_UP = 1.5;
const PUSH_FOOTPRINT = 25;
/**
 * Pushing: hand travel along your line of sight through the palm, past PUSH_DEAD either way, times
 * PUSH_GAIN of the wall's distance over the palm's reach (so a box looks as deep for the same push at
 * any distance), plus PUSH_GIVE when it arms. At most PUSH_MAX, or the wall's own distance.
 */
const PUSH_DEAD = 0.015;
const PUSH_GAIN = 0.8;
const PUSH_GIVE = 0.02;
const PUSH_MAX = 2.5;
const PUSH_STIFF = 320;
const PUSH_DAMP = 22;
/** Let-go timers, seconds: fingers curled, palm turned off the wall, tracking lost, palm off the box (by PUSH_LEAVE_MARGIN of its size). */
const PUSH_CURL = 0.15;
const PUSH_TURN = 0.2;
const PUSH_LOST = 0.3;
const PUSH_LEAVE = 0.1;
const PUSH_LEAVE_MARGIN = 0.15;
/** Letting go keeps the deepest push of the last PUSH_LOOKBACK before it began: a lowered hand drifts back first. */
const PUSH_LOOKBACK = 0.15;
const PUSH_RING = 64;
/** Let go shallower than this and the box springs back out; deeper, it stays, with an inward nudge. */
const PUSH_KEEP_MIN = 0.05;
const PUSH_KICK = 0.15;
/** A box replaced by a palm elsewhere springs out on this faster spring. */
const PUSH_OUT_STIFF = 250;
const PUSH_OUT_DAMP = 16;
const PUSH_COOL = 0.4;
/** A pinch on the box springs it back out, unless the mesh under it is this much nearer (something in front). */
const PUSH_UNDO_NEARER = 0.1;
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
  /** The cone's direction, eased toward `liftAim`, where aim() points it. */
  lift: Vector3;
  liftAim: Vector3;
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
  /** How near the surface was behind the fingers at the pinch, 0..1 (NEAR_FULL, NEAR_NONE). */
  near: number;
  /** What held the cone this frame (aim), and at its peak: your fingers, or the cap. */
  liftWhy: LiftLimit;
  peakWhy: LiftLimit;
  /**
   * The index fingertip held close to a surface, no pinch: where the spike rises from (`hoverC`, on
   * the surface under the tip), the surface normal it rises along, its height now and wanted.
   * `hovering` stays on until the spike has sprung back. It shows through this hand's photo slot.
   */
  hovering: boolean;
  hoverC: Vector3;
  hoverN: Vector3;
  hoverH: number;
  hoverTo: number;
  hoverSpring: Spring;
  hoverFade: number;
  /** The slot photo was frozen for the spike, and when a freeze may be tried again. */
  hoverPhoto: boolean;
  hoverRetryAt: number;
  /** For the console line each spike prints when it settles. */
  hoverAt: number;
  hoverPeak: number;
  /** The gap when the spike began, the closest it came, and this frame's. */
  hoverFrom: number;
  hoverGap: number;
  hoverLast: number;
  hoverSurface: string;
}

type BoxPhase = 'none' | 'seek' | 'held' | 'rest' | 'out';

/** One hand holding the box: where its push is measured from, and its let-go timers. */
interface PalmHold {
  on: boolean;
  readonly ray0: Vector3;
  reach0: number;
  depth0: number;
  gain: number;
  curlT: number;
  turnT: number;
  lostT: number;
  leaveT: number;
  /** When the first let-go timer started (-1 none): the look-back runs from here. */
  onset: number;
}

/** One hand's palm this frame, and what it found on the wall. */
interface PalmTrack {
  readonly side: Side;
  readonly pose: PalmPose;
  /** Joints read this frame. */
  valid: boolean;
  /** Open, facing away, in front of your eyes: an arm-worthy palm. */
  open: boolean;
  /** Open enough to keep holding. */
  keep: boolean;
  readonly still: Stillness;
  /** Must close (or leave the pose) before it can arm again. */
  latch: boolean;
  coolUntil: number;
  /** The wall under it, for arming. */
  readonly hit: Vector3;
  readonly n: Vector3;
  dist: number;
  plane: number;
  why: string;
  openSince: number;
  whyLogged: boolean;
  readonly hold: PalmHold;
}

function makePalmTrack(side: Side): PalmTrack {
  return {
    side, pose: makePalmPose(), valid: false, open: false, keep: false,
    still: new Stillness(PALM_STILL_RADIUS, PALM_STILL_HOLD), latch: false, coolUntil: 0,
    hit: new Vector3(), n: new Vector3(0, 0, 1), dist: 0, plane: -1, why: '', openSince: -1, whyLogged: false,
    hold: { on: false, ray0: new Vector3(), reach0: 0.4, depth0: 0, gain: 1, curlT: 0, turnT: 0, lostT: 0, leaveT: 0, onset: -1 },
  };
}

/** The one pushed-in box: its rectangle on the wall, how deep it is, and where it is in its life. */
interface BoxState {
  phase: BoxPhase;
  /** The hand that armed it, or last held it. */
  side: Side;
  readonly C: Vector3;
  readonly U: Vector3;
  readonly V: Vector3;
  readonly N: Vector3;
  hw: number;
  hh: number;
  dist: number;
  /** How much of its first size it kept, after the wall's outline and the photo. */
  fit: number;
  plane: number;
  readonly spring: Spring;
  depthTo: number;
  /** Where it stays, once let go. */
  target: number;
  peak: number;
  fade: number;
  seekAt: number;
  retryAt: number;
  startAt: number;
  restAt: number;
  outStiff: number;
  outDamp: number;
  /** A hand waiting to arm a new box once this one has sprung out. */
  next: Side | null;
  /** Recent depth targets, for the look-back when let go. */
  readonly ringT: Float32Array;
  readonly ringD: Float32Array;
  ringHead: number;
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
  [Card.Pinch]: { title: 'Pinch anything and pull', body: 'Or hold a palm up to a wall and push.' },
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
    liftAim: new Vector3(0, 0, 1),
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
    near: 0,
    liftWhy: 'hand',
    peakWhy: 'hand',
    hovering: false,
    hoverC: new Vector3(),
    hoverN: new Vector3(0, 1, 0),
    hoverH: 0,
    hoverTo: 0,
    hoverSpring: new Spring(),
    hoverFade: 0,
    hoverPhoto: false,
    hoverRetryAt: 0,
    hoverAt: 0,
    hoverPeak: 0,
    hoverFrom: 1,
    hoverGap: 1,
    hoverLast: 1,
    hoverSurface: '',
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

/** Desk preview: `?demo=push` loops a box pushed into the stand-in wall instead of the two-hand pull. */
const DEMO_PUSH = typeof location !== 'undefined' && new URLSearchParams(location.search).get('demo') === 'push';

/** Developer check: `?lens=overlay` draws the live camera in stripes over the room at rest. */
const LENS_OVERLAY = typeof location !== 'undefined' && new URLSearchParams(location.search).get('lens') === 'overlay';

/** The camera frame size, and whether it is the full square sensor or the 4:3 crop of it. */
function frameShape(video: HTMLVideoElement | null): string {
  const w = video?.videoWidth ?? 0;
  const h = video?.videoHeight ?? 0;
  const shape = w === h ? 'square' : Math.abs(w / Math.max(h, 1) - 4 / 3) < 0.01 ? '4:3 crop' : 'other crop';
  return `${w}x${h} (${shape})`;
}

/** Two decimals without the leading zero, for console lines the panel cuts at 72 characters. */
function short(v: number): string {
  return v.toFixed(2).replace(/^(-?)0\./, '$1.');
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
    waveLength: 0.45, waveSpeed: 7, stiffness: 90, damping: 9, depthPull: 1, radial: 2.5,
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
  private readonly planeHit: PlaneHit = { point: new Vector3(), normal: new Vector3(), distance: 0, label: '', horizontal: true, delta: 0, index: -1 };
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

  private pushBox!: PushBox;
  private readonly palms: Record<Side, PalmTrack> = { left: makePalmTrack('left'), right: makePalmTrack('right') };
  private readonly box: BoxState = {
    phase: 'none', side: 'right', C: new Vector3(), U: new Vector3(1, 0, 0), V: new Vector3(0, 1, 0), N: new Vector3(0, 0, 1),
    hw: 0.3, hh: 0.24, dist: 2, fit: 1, plane: -1, spring: new Spring(), depthTo: 0, target: 0, peak: 0, fade: 0,
    seekAt: 0, retryAt: 0, startAt: 0, restAt: 0, outStiff: 90, outDamp: 9, next: null,
    ringT: new Float32Array(PUSH_RING).fill(-Infinity), ringD: new Float32Array(PUSH_RING), ringHead: 0,
  };
  private readonly pushFootprint = new Float32Array(PUSH_FOOTPRINT * 3);
  private readonly gaze = new Vector3(0, 0, -1);
  private readonly boxP = new Vector3();
  private readonly boxQ = new Vector3();
  /** Distance from the head to where the last boxHit() crossed the box's wall. */
  private boxT = 0;

  init(): void {
    this.overlay = new RoomMeshOverlay(this.scene, LENS_OVERLAY);
    if (LENS_OVERLAY) console.info('[jonze] lens overlay: live camera in stripes over the room at rest; hold still to read it');
    this.hands = new HandOccluder(this.scene, OCC_DEBUG);
    this.pushBox = new PushBox(this.scene, this.overlay.uniforms);
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
      this.hud.visible = false;
      this.room.visible = false;
      this.overlay.hide(true);
      this.pushBox.setVisible(false, false);
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
      this.stepPush(dt, now);
      this.resolvePending(this.left, dt, now);
      this.resolvePending(this.right, dt, now);
      this.stepHand(this.left, dt);
      this.stepHand(this.right, dt);
      this.stepHover(this.left, dt, now);
      this.stepHover(this.right, dt, now);
      // A spike draws the room only once it has a photo to show.
      const active = this.left.on || this.right.on || (this.left.hovering && this.left.hoverPhoto) || (this.right.hovering && this.right.hoverPhoto);
      if (LENS_OVERLAY) {
        const live = !active && hasVideo && this.photo.projectFrame(true, this.camera, now);
        this.overlay.setLive(video, live, this.photo.worldToClip);
        this.overlay.uniforms.uLensOn.value = live ? 1 : 0;
      }
      // The depth debug views show the whole room, pinched or not. A pushed-in box needs the room's
      // depth around its opening: when nothing else moves, that is all the room draws.
      const debug = this.overlay.uniforms.uLensOn.value > 0 || OCC_DEBUG || OCC_DELTA;
      const boxed = this.box.phase === 'held' || this.box.phase === 'rest' || this.box.phase === 'out';
      this.overlay.setVariant(!boxed ? 'full' : active || debug ? 'hole' : 'depth');
      this.overlay.setActive(active || boxed || debug);
      this.overlay.sync(meshes, this.head);
      this.overlay.syncPlanes(this.roomPlanes);
      this.publish(this.left, this.right, time, hasVideo);
      this.pushBox.setVisible(true, false);
      this.writePushBox(dt);
      this.sing(this.left);
      this.sing(this.right);
      this.singBox();
      this.rearmCamera(now);
      const updateMs = performance.now() - startMs;
      if (this.left.pinchUpdateMs < 0) this.left.pinchUpdateMs = updateMs;
      if (this.right.pinchUpdateMs < 0) this.right.pinchUpdateMs = updateMs;
    } else if (!this.previewRoom) {
      // A headset back on the launch page. Leaving a session stops the camera; the frames
      // between the Enter click and the session starting must not.
      this.room.visible = false;
      this.overlay.hide(false);
      this.pushBox.setVisible(false, false);
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
      if (DEMO_PUSH) this.updatePushDemo(dt, now);
      else this.updateDemo(dt, now);
      this.overlay.setLive(video, live, this.photo.worldToClip);
      this.publish(this.demoL, this.demoR, time, hasVideo);
      this.pushBox.setVisible(true, true);
      this.writePushBox(dt);
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
    const now = performance.now() / 1000;
    for (const side of SIDES) if (this.palms[side].hold.on) this.letGo(this.palms[side], now, 'pause');
    if (this.box.phase === 'seek') this.box.phase = 'none';
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
    // An open palm doesn't pinch: a select from a hand arming or holding the box is a false one.
    if (grab.holding || grab.pending || this.pushOwns(side)) return;
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
  /** `note` builds the console text for the pinch line; the fingertip spike asks every frame without it. */
  private preferPlane(note = true, clutter?: number): boolean {
    if (note) this.hitNote = 'mesh';
    const mesh = this.hitMesh;
    if (!mesh || this.roomPlanes.count === 0) return false;
    this.rayDir.copy(this.pinch).sub(this.head);
    if (this.rayDir.lengthSq() < 1e-8) return false;
    this.rayDir.normalize();
    mesh.updateWorldMatrix(true, false);
    this.meshHitWorld.copy(this.localHit).applyMatrix4(mesh.matrixWorld);
    const meshT = this.meshHitWorld.distanceTo(this.head);
    if (!this.roomPlanes.underHit(this.head, this.rayDir, meshT, this.planeHit, this.planeMiss, clutter)) {
      const miss = this.planeMiss;
      if (note && miss.found) this.hitNote = `mesh (${miss.label} ${(miss.delta * 100).toFixed(0)}cm)`;
      return false;
    }
    this.inv.copy(mesh.matrixWorld).invert();
    this.localHit.copy(this.planeHit.point).applyMatrix4(this.inv);
    this.localN.copy(this.planeHit.normal).transformDirection(this.inv);
    if (note) this.hitNote = `plane:${this.planeHit.label} d=${(this.planeHit.delta * 100).toFixed(1)}cm`;
    return true;
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
    if (this.pinchUndo(grab)) return;
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
    grab.near = 1 - smooth((grab.dist - grab.reach0 - NEAR_FULL) / (NEAR_NONE - NEAR_FULL));
    grab.lift.copy(this.head).sub(grab.worldG).normalize();
    grab.liftAim.copy(grab.lift);
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
    const n = grab.normal;
    const surface = Math.abs(n.y) < 0.5 ? 'wall' : n.y > 0 ? 'table' : 'ceiling';
    console.info(
      `[jonze] pinch ${tag} ${surface} ${this.head.distanceTo(grab.worldG).toFixed(2)}m dense=${this.overlay.ready ? 'y' : 'n'} ` +
        `hit=${this.hitNote} ${this.scanNote()}`,
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
    this.writeFootprintAt(grab.worldG, grab.normal, Math.min(0.4, Math.max(0.25, this.look.reach * 0.8)));
  }

  /** The photo footprint: `centre` first, then a ring of radius `r` in the surface with normal `n`. */
  private writeFootprintAt(centre: Vector3, n: Vector3, r: number): void {
    this.tanU.set(0, 1, 0).cross(n);
    if (this.tanU.lengthSq() < 1e-6) this.tanU.set(1, 0, 0).cross(n);
    this.tanU.normalize();
    this.tanV.copy(n).cross(this.tanU);
    const f = this.footprint;
    f[0] = centre.x;
    f[1] = centre.y;
    f[2] = centre.z;
    for (let i = 1; i < FOOTPRINT; i++) {
      const a = ((i - 1) / (FOOTPRINT - 1)) * Math.PI * 2;
      const c = Math.cos(a) * r;
      const s = Math.sin(a) * r;
      f[i * 3] = centre.x + this.tanU.x * c + this.tanV.x * s;
      f[i * 3 + 1] = centre.y + this.tanU.y * c + this.tanV.y * s;
      f[i * 3 + 2] = centre.z + this.tanU.z * c + this.tanV.z * s;
    }
  }

  // ---------------------------------------------------------------- fingertip spikes

  /**
   * An index fingertip held close to a surface, without pinching, draws a small spike of it up
   * toward the tip: higher as the finger comes closer, following it across the surface, springing
   * back with a wobble when it leaves. A pinch, or a pull still springing back, owns the hand's photo
   * slot, so then there is no spike.
   */
  private stepHover(grab: Grab, dt: number, now: number): void {
    const free = !grab.pending && !grab.on && !this.pushOwns(grab.side);
    if (!free) {
      // A pinch took over the slot: the spike springs down under the new pull, on its old fade, while
      // the pull's photo uploads and fades in.
      if (grab.hovering) {
        grab.hoverTo = 0;
        grab.hoverH = grab.hoverSpring.step(0, dt, this.look.stiffness * 2, this.look.damping);
        if (grab.hoverSpring.atRest(0, 0.0008)) this.endSpike(grab, now, true);
      }
      return;
    }
    // Only on the dense room: the raw scans are too coarse to draw a fingertip-sized point.
    const want = this.hands.hasPinch[grab.side] && this.overlay.ready ? this.aimSpike(grab, dt) : 0;
    grab.hoverTo = want;
    if (want > 0 && !grab.hovering) {
      grab.hovering = true;
      grab.hoverAt = now;
      grab.hoverPeak = 0;
      grab.hoverFrom = grab.hoverLast;
      grab.hoverGap = grab.hoverLast;
    }
    if (!grab.hovering) return;
    const rising = want > 0;
    grab.hoverH = grab.hoverSpring.step(
      want, dt, rising ? SPIKE_STIFF : this.look.stiffness * 2, rising ? SPIKE_DAMP : this.look.damping,
    );
    if (grab.hoverH > grab.hoverPeak) grab.hoverPeak = grab.hoverH;
    if (rising) this.spikePhoto(grab, now);
    const slot = this.photo.slots[grab.slot];
    grab.hoverFade = grab.hoverPhoto && slot.has && slot.ready ? Math.min(1, grab.hoverFade + dt / FADE_IN) : 0;
    if (!rising && grab.hoverSpring.atRest(0, 0.0008)) this.endSpike(grab, now, false);
  }

  /**
   * The spike this hand wants, metres, from the surface along your line of sight through the index
   * tip. It rises from the tip's foot on that surface's plane, so it reaches straight up to the finger.
   */
  private aimSpike(grab: Grab, dt: number): number {
    const tip = this.hands.indexTip[grab.side];
    this.pinch.copy(tip);
    if (!this.raycast(this.head, this.pinch) || !this.hitMesh) return 0;
    // A plane only where the dense room lies on it: a book or a laptop on the table is the surface.
    this.preferPlane(false, SPIKE_CLUTTER);
    const mesh = this.hitMesh;
    mesh.updateWorldMatrix(true, false);
    const hit = this.tmp.copy(this.localHit).applyMatrix4(mesh.matrixWorld);
    const n = this.tmp2.copy(this.localN).transformDirection(mesh.matrixWorld);
    const gap = this.unit.copy(tip).sub(hit).dot(n);
    if (gap <= SPIKE_KEEP || gap >= SPIKE_RANGE) return 0;
    // An open palm at a wall is a push in the making, not a vacuum.
    if (this.palms[grab.side].open && Math.abs(n.y) < PUSH_WALL_UP) return 0;
    const foot = this.raw.copy(tip).addScaledVector(n, -gap);
    // Where a box is pushed in, the wall under the finger is gone.
    if (this.box.phase !== 'none' && this.box.phase !== 'seek' && this.boxHit(this.head, foot, 0)) return 0;
    if (!grab.hovering) {
      grab.hoverC.copy(foot);
      grab.hoverN.copy(n);
    } else {
      // Tracking jitters by millimetres: the spike glides after the finger instead of shaking.
      const f = 1 - Math.exp(-Math.min(dt, STEP_MAX) / SPIKE_GLIDE);
      grab.hoverC.lerp(foot, f);
      grab.hoverN.lerp(n, f).normalize();
    }
    grab.hoverLast = gap;
    if (gap < grab.hoverGap) grab.hoverGap = gap;
    grab.hoverSurface = Math.abs(n.y) < 0.5 ? 'wall' : n.y > 0 ? 'table' : 'ceiling';
    return (1 - smooth((gap - SPIKE_FULL) / (SPIKE_RANGE - SPIKE_FULL))) * SPIKE_REACH * (gap - SPIKE_KEEP);
  }

  /**
   * Freezes a photo for the spike into the hand's slot: a bank frame only. A live frame has this
   * very finger cut out right where the spike rises, so without a clean one there is no spike. Again
   * when the spike glides off the photo, at most every SPIKE_RETRY.
   */
  private spikePhoto(grab: Grab, now: number): void {
    const slot = this.photo.slots[grab.slot];
    if (grab.hoverPhoto && slot.has && this.photo.slotContains(grab.slot, grab.hoverC, SLIDE_MARGIN)) return;
    if (now < grab.hoverRetryAt) return;
    const liveOk = now - grab.hoverAt >= SPIKE_LIVE_AFTER;
    grab.hoverRetryAt = liveOk ? now + SPIKE_RETRY : Math.min(now + SPIKE_RETRY, grab.hoverAt + SPIKE_LIVE_AFTER);
    this.writeFootprintAt(grab.hoverC, grab.hoverN, SPIKE_FOOTPRINT);
    const frozen = this.photo.freeze(grab.slot, this.footprint, FOOTPRINT, true, this.camera, now, this.handJoints(), this.head, liveOk);
    grab.hoverPhoto = frozen;
    if (!frozen) grab.hoverFade = 0;
  }

  /** One console line per spike, then back to rest. `keep` leaves the slot photo to a pinch that took over. */
  private endSpike(grab: Grab, now: number, keep: boolean): void {
    if (grab.hoverPeak > 0.003) {
      const photo = grab.hoverPhoto ? (this.photo.slots[grab.slot].live ? 'live' : 'bank') : 'none';
      console.info(
        `[jonze] hover ${grab.side === 'left' ? 'L' : 'R'} ${grab.hoverSurface} from ${(grab.hoverFrom * 100).toFixed(0)} to ${(grab.hoverGap * 100).toFixed(1)}cm ` +
          `peak ${(grab.hoverPeak * 100).toFixed(1)}cm photo ${photo} ${(now - grab.hoverAt).toFixed(1)}s` +
          (keep ? ' -> pinch' : ''),
      );
    }
    if (grab.hoverPhoto && !keep) this.photo.drop(grab.slot);
    this.resetSpike(grab);
  }

  private resetSpike(grab: Grab): void {
    grab.hovering = false;
    grab.hoverH = 0;
    grab.hoverTo = 0;
    grab.hoverSpring.reset(0);
    grab.hoverFade = 0;
    grab.hoverPhoto = false;
    grab.hoverPeak = 0;
  }

  // ---------------------------------------------------------------- palm push

  /** Every presenting frame, before pinches resolve: read both palms, then move the box along. */
  private stepPush(dt: number, now: number): void {
    this.gaze.set(0, 0, -1).applyQuaternion(this.headQuat);
    this.readPalmTrack(this.palms.left, now);
    this.readPalmTrack(this.palms.right, now);
    const box = this.box;
    switch (box.phase) {
      case 'none':
        for (const side of SIDES) {
          if (this.candidate(this.palms[side], dt, now) === 'wall') {
            this.beginSeek(this.palms[side], now);
            break;
          }
        }
        break;
      case 'seek':
        this.stepSeek(now);
        break;
      case 'held':
        this.stepHeld(dt, now);
        // A second palm on the box joins the push.
        if (this.box.phase === 'held') {
          for (const side of SIDES) {
            const track = this.palms[side];
            if (!track.hold.on && this.candidate(track, dt, now) === 'box') {
              this.startHold(track, now, box.depthTo, 'join');
            }
          }
        }
        break;
      case 'rest':
        box.spring.step(box.target, dt, this.look.stiffness, this.look.damping);
        for (const side of SIDES) {
          const kind = this.candidate(this.palms[side], dt, now);
          if (kind === 'box') {
            this.startHold(this.palms[side], now, box.target, 'rearm');
            break;
          }
          if (kind === 'wall') {
            // One box at a time: the old one springs out first, then this palm arms the new one.
            box.next = side;
            this.startOut(now, 'replace', PUSH_OUT_STIFF, PUSH_OUT_DAMP);
            break;
          }
        }
        break;
      case 'out':
        box.spring.step(0, dt, box.outStiff, box.outDamp);
        if (box.spring.atRest(0, 0.01)) {
          const next = box.next;
          this.endBox(now, true);
          if (next) {
            const track = this.palms[next];
            if (track.open && this.palmWall(track)) this.beginSeek(track, now);
          }
        }
        break;
    }
  }

  /** Reads one hand's palm and whether it is open toward a wall in front of your eyes. */
  private readPalmTrack(track: PalmTrack, now: number): void {
    const j = this.joints;
    const right = track.side === 'right';
    const count = right ? j.rightCount : j.leftCount;
    const start = right ? j.rightStart : j.leftStart;
    track.valid = this.hands.hasPinch[track.side] && count >= 25 && readPalm(j.points, start, right, track.pose);
    if (!track.valid) {
      track.open = false;
      track.keep = false;
    } else {
      const pose = track.pose;
      const toPalm = this.tmpA.copy(pose.centre).sub(this.head);
      const reach = toPalm.length();
      toPalm.multiplyScalar(1 / Math.max(reach, 1e-6));
      track.keep = countStraight(pose, PALM_KEEP_STRAIGHT) >= PALM_KEEP_FINGERS;
      track.open =
        countStraight(pose, PALM_STRAIGHT) >= PALM_FINGERS &&
        pose.thumbGap > PALM_THUMB_GAP &&
        reach > PALM_REACH_MIN &&
        pose.normal.dot(toPalm) > PALM_AWAY &&
        toPalm.dot(this.gaze) > PALM_CONE;
    }
    if (!track.open) {
      track.latch = false;
      track.still.reset();
      track.openSince = -1;
      track.whyLogged = false;
    } else if (track.openSince < 0) {
      track.openSince = now;
    }
  }

  /**
   * Whether this palm, held still, would arm: on the box (`box`, to push it again or join), or on a
   * wall elsewhere (`wall`). Says once, after a moment, why an open palm is not arming.
   */
  private candidate(track: PalmTrack, dt: number, now: number): 'none' | 'box' | 'wall' {
    const grab = track.side === 'left' ? this.left : this.right;
    if (!track.open || track.latch || now < track.coolUntil || grab.pending || grab.on || grab.hovering) {
      if (!track.open) track.still.reset();
      return 'none';
    }
    const boxed = this.box.phase === 'held' || this.box.phase === 'rest';
    let kind: 'none' | 'box' | 'wall' = 'none';
    if (boxed && this.boxHit(this.head, track.pose.centre, 0)) kind = 'box';
    else if (this.palmWall(track)) kind = 'wall';
    if (kind === 'none') {
      track.still.reset();
      if (!track.whyLogged && now - track.openSince > PALM_WHY_AFTER) {
        track.whyLogged = true;
        console.info(`[jonze] push ${track.side === 'left' ? 'L' : 'R'}? ${track.why}`);
      }
      return 'none';
    }
    const c = track.pose.centre;
    return track.still.update(c.x, c.y, c.z, dt) >= 1 ? kind : 'none';
  }

  /** The wall along your line of sight through the palm, and whether the palm faces it, clear of it. */
  private palmWall(track: PalmTrack): boolean {
    const pose = track.pose;
    this.pinch.copy(pose.centre);
    if (!this.raycast(this.head, this.pinch) || !this.hitMesh) {
      track.why = 'no wall';
      return false;
    }
    const snapped = this.preferPlane(false);
    const mesh = this.hitMesh;
    mesh.updateWorldMatrix(true, false);
    const hit = track.hit.copy(this.localHit).applyMatrix4(mesh.matrixWorld);
    const n = track.n.copy(this.localN).transformDirection(mesh.matrixWorld);
    track.plane = snapped ? this.planeHit.index : -1;
    track.dist = hit.distanceTo(this.head);
    const face = -pose.normal.dot(n);
    if (Math.abs(n.y) >= PUSH_WALL_UP) track.why = n.y > 0 ? 'floor' : 'ceiling';
    else if (track.dist < PUSH_WALL_MIN || track.dist > PUSH_WALL_MAX) track.why = `far ${track.dist.toFixed(1)}m`;
    else if (face < PALM_FACE) track.why = `face ${face.toFixed(2)}`;
    else if (this.tmpA.copy(pose.centre).sub(hit).dot(n) < PALM_OFF_WALL) track.why = 'touch';
    else return true;
    return false;
  }

  /** Lays the box's rectangle out on the wall under this palm and starts looking for its photo. */
  private beginSeek(track: PalmTrack, now: number): void {
    const box = this.box;
    const N = box.N.copy(track.n);
    const C = box.C.copy(track.hit);
    const U = box.U.set(0, 1, 0).cross(N).normalize();
    const V = box.V.copy(N).cross(U);
    box.dist = track.dist;
    box.plane = track.plane;
    const half = Math.min(PUSH_HALF_MAX, Math.max(PUSH_HALF_MIN, PUSH_SIZE * track.dist));
    box.hw = half;
    box.hh = PUSH_ASPECT * half;
    box.fit = 1;
    // The camera sees little above your gaze: a palm raised high centres the box nearer the gaze.
    const along = this.gaze.dot(N);
    if (along < -1e-3) {
      const t = this.tmpA.copy(C).sub(this.head).dot(N) / along;
      const below = this.tmpA.copy(this.head).addScaledVector(this.gaze, t).sub(C).dot(V);
      if (t > 0 && below < 0) C.addScaledVector(V, Math.max(below, -PUSH_BIAS * box.hh));
    }
    this.fitBox((p) => this.onPlane(p));
    if (box.hw < PUSH_HALF_FLOOR || box.hh < PUSH_HALF_FLOOR) {
      console.info(`[jonze] push ${track.side === 'left' ? 'L' : 'R'}? edge ${(2 * box.hw).toFixed(2)}x${(2 * box.hh).toFixed(2)}`);
      track.latch = true;
      return;
    }
    box.phase = 'seek';
    box.side = track.side;
    box.seekAt = now;
    box.retryAt = now;
    box.next = null;
    track.still.reset();
  }

  /** Shrinks the box's width and height, each by PUSH_SHRINK, until every rim point passes `inside`. */
  private fitBox(inside: (p: Vector3) => boolean): void {
    const box = this.box;
    const w0 = box.hw;
    const h0 = box.hh;
    for (let i = 0; i < 12; i++) {
      let uOut = false;
      let vOut = false;
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) {
          if (a === 0 && b === 0) continue;
          const p = this.boxP.copy(box.C).addScaledVector(box.U, a * box.hw).addScaledVector(box.V, b * box.hh);
          if (inside(p)) continue;
          if (a !== 0) uOut = true;
          if (b !== 0) vOut = true;
        }
      }
      if (!uOut && !vOut) break;
      if (uOut) box.hw *= PUSH_SHRINK;
      if (vOut) box.hh *= PUSH_SHRINK;
    }
    box.fit *= Math.min(box.hw / w0, box.hh / h0);
  }

  /** On the wall's detected outline, PUSH_EDGE in from its edge. Any point counts when the wall has none. */
  private onPlane(p: Vector3): boolean {
    const plane = this.box.plane >= 0 ? this.roomPlanes.planes[this.box.plane] : null;
    if (!plane || plane.points < 3) return true;
    const q = this.boxQ.copy(p).applyMatrix4(plane.inverse);
    return polygonDepth(plane.polygon, plane.points, q.x, q.z) >= PUSH_EDGE;
  }

  /** Centre first, then a 5x5 grid over the rectangle: all of it must be in the photo and clear of hands. */
  private writePushFootprint(scale: number): void {
    const box = this.box;
    const f = this.pushFootprint;
    f[0] = box.C.x;
    f[1] = box.C.y;
    f[2] = box.C.z;
    let i = 1;
    for (let a = -2; a <= 2; a++) {
      for (let b = -2; b <= 2; b++) {
        if (a === 0 && b === 0) continue;
        const p = this.boxP.copy(box.C).addScaledVector(box.U, 0.5 * a * box.hw * scale).addScaledVector(box.V, 0.5 * b * box.hh * scale);
        f[i * 3] = p.x;
        f[i * 3 + 1] = p.y;
        f[i * 3 + 2] = p.z;
        i++;
      }
    }
  }

  /** The box's photo: a clean bank frame with no hand anywhere on it, smaller if need be; late, the live frame. */
  private stepSeek(now: number): void {
    const box = this.box;
    const track = this.palms[box.side];
    const tag = box.side === 'left' ? 'L' : 'R';
    if (!track.keep) {
      box.phase = 'none';
      track.latch = true;
      return;
    }
    if (now < box.retryAt) return;
    box.retryAt = now + PUSH_RETRY;
    const liveOk = now - box.seekAt >= PUSH_LIVE_AFTER;
    const t0 = performance.now();
    let frozen = false;
    for (let i = 0; i < (liveOk ? 1 : PUSH_SCALES.length) && !frozen; i++) {
      const scale = PUSH_SCALES[i];
      this.writePushFootprint(scale);
      frozen = this.photo.freeze(2, this.pushFootprint, PUSH_FOOTPRINT, true, this.camera, now, this.handJoints(), this.head, liveOk, Infinity);
      if (frozen && scale < 1) {
        box.hw *= scale;
        box.hh *= scale;
        box.fit *= scale;
      }
    }
    if (frozen) {
      this.fitBox((p) => this.photo.slotContains(2, p, PUSH_PHOTO_MARGIN));
      if (box.hw >= PUSH_HALF_FLOOR && box.hh >= PUSH_HALF_FLOOR) {
        const ms = performance.now() - t0;
        const face = -track.pose.normal.dot(box.N);
        console.info(
          `[jonze] push ${tag} wall ${box.dist.toFixed(1)}m ${(2 * box.hw).toFixed(2)}x${(2 * box.hh).toFixed(2)} ` +
            `fit${box.fit.toFixed(2).replace(/^0\./, '.')} face${face.toFixed(2).replace(/^0\./, '.')}${box.plane >= 0 ? ' plane' : ''}`,
        );
        console.info(`[jonze] ${this.photo.pickLine(2)} ${ms.toFixed(0)}ms`);
        box.spring.reset(0);
        box.depthTo = 0;
        box.peak = 0;
        box.fade = 0;
        box.startAt = now;
        box.ringHead = 0;
        box.ringT.fill(-Infinity);
        this.startHold(track, now, PUSH_GIVE, '');
        return;
      }
      this.photo.drop(2);
    }
    if (now - box.seekAt > PUSH_GIVE_UP) {
      console.warn(`[jonze] push ${tag}: ${this.photo.pickLine(2)}, gave up`);
      this.sound.miss(track.side === 'left' ? 0 : 1, box.C.x, box.C.y, box.C.z);
      box.phase = 'none';
      track.latch = true;
    }
  }

  /** A palm takes hold of the box: its push is measured from here, adding to `depth0`. */
  private startHold(track: PalmTrack, now: number, depth0: number, note: string): void {
    const box = this.box;
    const hold = track.hold;
    const toPalm = hold.ray0.copy(track.pose.centre).sub(this.head);
    hold.reach0 = toPalm.length();
    toPalm.multiplyScalar(1 / Math.max(hold.reach0, 1e-6));
    hold.gain = (PUSH_GAIN * box.dist) / Math.max(0.25, hold.reach0);
    hold.depth0 = depth0;
    hold.curlT = 0;
    hold.turnT = 0;
    hold.lostT = 0;
    hold.leaveT = 0;
    hold.onset = -1;
    hold.on = true;
    track.still.reset();
    box.phase = 'held';
    box.side = track.side;
    box.depthTo = depth0;
    this.pinched = true;
    if (note) console.info(`[jonze] push ${track.side === 'left' ? 'L' : 'R'} ${note} ${short(depth0)}m`);
  }

  private stepHeld(dt: number, now: number): void {
    const box = this.box;
    const cap = Math.min(PUSH_MAX, box.dist);
    let depthTo = box.depthTo;
    let lead = -1;
    for (const side of SIDES) {
      const track = this.palms[side];
      const hold = track.hold;
      if (!hold.on) continue;
      const pose = track.pose;
      if (!track.valid) {
        hold.lostT += dt;
      } else {
        hold.lostT = 0;
        hold.curlT = track.keep ? 0 : hold.curlT + dt;
        hold.turnT = -pose.normal.dot(box.N) < PALM_KEEP_FACE ? hold.turnT + dt : 0;
        hold.leaveT = this.boxHit(this.head, pose.centre, PUSH_LEAVE_MARGIN) ? 0 : hold.leaveT + dt;
      }
      const timing = hold.lostT > 0 || hold.curlT > 0 || hold.turnT > 0 || hold.leaveT > 0;
      if (!timing) hold.onset = -1;
      else if (hold.onset < 0) hold.onset = now;
      const why =
        hold.lostT > PUSH_LOST ? 'lost' : hold.curlT > PUSH_CURL ? 'curl' : hold.turnT > PUSH_TURN ? 'turn' : hold.leaveT > PUSH_LEAVE ? 'off' : '';
      if (why) {
        this.letGo(track, now, why);
        if (box.phase !== 'held') return;
        continue;
      }
      if (!track.valid) continue;
      const push = this.tmpA.copy(pose.centre).sub(this.head).dot(hold.ray0) - hold.reach0;
      const travel = Math.sign(push) * Math.max(0, Math.abs(push) - PUSH_DEAD);
      const d = Math.min(cap, Math.max(0, hold.depth0 + hold.gain * travel));
      const lean = Math.abs(d - hold.depth0);
      if (lean > lead) {
        lead = lean;
        depthTo = d;
      }
    }
    box.depthTo = depthTo;
    box.ringT[box.ringHead] = now;
    box.ringD[box.ringHead] = depthTo;
    box.ringHead = (box.ringHead + 1) % PUSH_RING;
    const depth = box.spring.step(depthTo, dt, PUSH_STIFF, PUSH_DAMP);
    if (depth > box.peak) box.peak = depth;
  }

  /**
   * One palm lets go. The box keeps the deepest push of the moment before letting go began; with no
   * palm left on it, it stays there (or springs out, when barely pushed). A palm still on it carries on
   * from where it stands.
   */
  private letGo(track: PalmTrack, now: number, why: string): void {
    const box = this.box;
    const hold = track.hold;
    hold.on = false;
    track.latch = true;
    const from = (hold.onset >= 0 ? hold.onset : now) - PUSH_LOOKBACK;
    let target = 0;
    let seen = false;
    for (let i = 0; i < PUSH_RING; i++) {
      if (box.ringT[i] >= from) {
        target = Math.max(target, box.ringD[i]);
        seen = true;
      }
    }
    if (!seen) target = box.depthTo;
    const other = this.palms[track.side === 'left' ? 'right' : 'left'];
    if (other.hold.on) {
      // The other palm carries on from the depth this one left.
      box.depthTo = target;
      this.startHold(other, now, target, '');
      return;
    }
    const tag = track.side === 'left' ? 'L' : 'R';
    const held = now - box.startAt;
    if (target < PUSH_KEEP_MIN) {
      console.info(`[jonze] push ${tag} ${held.toFixed(1)}s peak${short(box.peak)}m ${why}, low`);
      this.startOut(now, 'low', this.look.stiffness, this.look.damping);
      return;
    }
    box.phase = 'rest';
    box.target = target;
    box.restAt = now;
    box.spring.velocity += PUSH_KICK;
    const photo = this.photo.slots[2].live ? 'live' : 'bank';
    console.info(`[jonze] push ${tag} rest ${short(target)}m ${held.toFixed(1)}s ${why} ${photo} fit${short(box.fit)}`);
    this.sound.settle(2, box.C.x, box.C.y, box.C.z);
  }

  /** The box springs back out of the wall, past it, and settles flat; then it is gone. */
  private startOut(now: number, why: string, stiff: number, damp: number): void {
    const box = this.box;
    if (box.phase !== 'held' && why !== 'low') {
      this.sound.fall(2, box.spring.value / Math.max(0.5, box.dist), box.C.x, box.C.y, box.C.z);
    }
    for (const side of SIDES) {
      if (this.palms[side].hold.on) {
        this.palms[side].hold.on = false;
        this.palms[side].latch = true;
      }
    }
    if (why !== 'low') console.info(`[jonze] push out ${why} ${short(box.spring.value)}m`);
    box.phase = 'out';
    box.outStiff = stiff;
    box.outDamp = damp;
    box.restAt = now;
  }

  /** The box is gone: its photo dropped, the room whole again. */
  private endBox(now: number, log: boolean): void {
    const box = this.box;
    if (box.phase === 'none') return;
    if (log && box.phase !== 'seek') console.info(`[jonze] push clear ${(now - box.startAt).toFixed(0)}s`);
    box.phase = 'none';
    box.next = null;
    box.fade = 0;
    box.depthTo = 0;
    box.spring.reset(0);
    this.photo.drop(2);
    this.pushBox.hide();
    for (const side of SIDES) {
      const track = this.palms[side];
      track.hold.on = false;
      track.latch = true;
      track.coolUntil = now + PUSH_COOL;
    }
  }

  /**
   * Whether the line from `origin` through `through` crosses the box's wall inside its rectangle
   * (grown by `margin` of its size). Leaves the distance to the crossing in `boxT`.
   */
  private boxHit(origin: Vector3, through: Vector3, margin: number): boolean {
    const box = this.box;
    const dir = this.boxQ.copy(through).sub(origin);
    const across = dir.dot(box.N);
    if (across > -1e-6) return false;
    const t = this.boxP.copy(box.C).sub(origin).dot(box.N) / across;
    if (t <= 0) return false;
    this.boxT = t * dir.length();
    const q = this.boxP.copy(origin).addScaledVector(dir, t).sub(box.C);
    const grow = 1 + margin;
    return Math.abs(q.dot(box.U)) <= box.hw * grow && Math.abs(q.dot(box.V)) <= box.hh * grow;
  }

  /** A hand busy with the box: arming it or holding it. Its pinches and spikes stand down. */
  private pushOwns(side: Side): boolean {
    return (this.box.phase === 'seek' && this.box.side === side) || this.palms[side].hold.on;
  }

  /** A pinch on the box springs it back out; the pinch is used up. False when the pinch missed the box. */
  private pinchUndo(grab: Grab): boolean {
    const box = this.box;
    if (box.phase !== 'held' && box.phase !== 'rest') return false;
    if (!this.boxHit(this.head, this.pinch, 0)) return false;
    const toBox = this.boxT;
    if (this.raycast(this.head, this.pinch) && this.hitMesh) {
      this.hitMesh.updateWorldMatrix(true, false);
      const hit = this.tmpA.copy(this.localHit).applyMatrix4(this.hitMesh.matrixWorld);
      // Something stands in front of the box: pinch that instead.
      if (hit.distanceTo(this.head) < toBox - PUSH_UNDO_NEARER) return false;
    }
    this.pinched = true;
    this.startOut(performance.now() / 1000, `pinch ${grab.side === 'left' ? 'L' : 'R'}`, this.look.stiffness, this.look.damping);
    return true;
  }

  /** After publish: the box's shape and photo, for the room's opening and the box itself. */
  private writePushBox(dt: number): void {
    const box = this.box;
    if (box.phase !== 'held' && box.phase !== 'rest' && box.phase !== 'out') {
      this.pushBox.hide();
      return;
    }
    this.pushBox.place(box.C, box.U, box.hw, box.V, box.hh, box.N, box.spring.value);
    const slot = this.photo.slots[2];
    box.fade = slot.has && slot.ready ? Math.min(1, box.fade + dt / FADE_IN) : 0;
    this.pushBox.writePhoto(slot, box.fade);
  }

  /** The box's own voice: it strums when taken, climbs as it goes in, settles or falls when let go. */
  private singBox(): void {
    const box = this.box;
    const C = box.C;
    const dist = Math.max(0.5, box.dist);
    const depth = box.spring.value;
    if (box.phase === 'held') this.sound.track(2, true, depth / dist, 0, C.x, C.y, C.z);
    else if (box.phase === 'rest') this.sound.track(2, false, (box.target - depth) / dist, 0, C.x, C.y, C.z);
    else if (box.phase === 'out') this.sound.track(2, false, depth / dist, 0, C.x, C.y, C.z);
    else this.sound.track(2, false, 0, 0, C.x, C.y, C.z);
  }

  /** Forget the box and both palms, at once and quietly. */
  private clearPush(): void {
    const box = this.box;
    box.phase = 'none';
    box.next = null;
    box.fade = 0;
    box.depthTo = 0;
    box.spring.reset(0);
    this.photo.drop(2);
    this.pushBox.hide();
    for (const side of SIDES) {
      const track = this.palms[side];
      track.hold.on = false;
      track.latch = false;
      track.still.reset();
      track.coolUntil = 0;
    }
  }

  /** Desk preview, `?demo=push`: a box on the stand-in wall goes in, stays, comes partway out, then pops. */
  private updatePushDemo(dt: number, now: number): void {
    this.demoT += dt;
    const t = this.demoT % 10;
    const box = this.box;
    if (t < 0.2) {
      if (box.phase !== 'none') this.clearPush();
      return;
    }
    if (box.phase === 'none') {
      box.C.set(0, 0.75, -2);
      box.U.set(1, 0, 0);
      box.V.set(0, 1, 0);
      box.N.set(0, 0, 1);
      box.hw = 0.28;
      box.hh = 0.22;
      box.dist = box.C.distanceTo(this.head);
      box.fit = 1;
      box.plane = -1;
      box.spring.reset(0);
      box.startAt = now;
      box.phase = 'held';
      box.retryAt = now;
    }
    // The webcam may start after the loop does: keep trying for a photo.
    if (!this.photo.slots[2].has && now >= box.retryAt) {
      box.retryAt = now + 0.5;
      this.writePushFootprint(1);
      this.photo.freeze(2, this.pushFootprint, PUSH_FOOTPRINT, false, this.camera, now, null, this.head, true, Infinity);
      if (this.photo.slots[2].has || this.photo.lastMiss !== 'no-video') console.info(`[jonze] ${this.photo.pickLine(2)}`);
    }
    if (t < 2) {
      box.phase = 'held';
      box.depthTo = smooth((t - 0.2) / 1.8) * 1.2;
      box.spring.step(box.depthTo, dt, PUSH_STIFF, PUSH_DAMP);
    } else if (t < 5) {
      if (box.phase === 'held') box.spring.velocity += PUSH_KICK;
      box.phase = 'rest';
      box.target = 1.2;
      box.spring.step(box.target, dt, this.look.stiffness, this.look.damping);
    } else if (t < 6.5) {
      box.phase = 'held';
      box.depthTo = 1.2 - smooth((t - 5) / 1.5) * 0.6;
      box.spring.step(box.depthTo, dt, PUSH_STIFF, PUSH_DAMP);
    } else if (t < 8.5) {
      if (box.phase === 'held') box.spring.velocity += PUSH_KICK;
      box.phase = 'rest';
      box.target = 0.6;
      box.spring.step(box.target, dt, this.look.stiffness, this.look.damping);
    } else {
      box.phase = 'out';
      box.spring.step(0, dt, this.look.stiffness, this.look.damping);
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
      // Turned toward where aim() points it: your head, or near a surface, your fingertips.
      grab.lift.lerp(grab.liftAim, 1 - Math.exp(-step * LIFT_TURN)).normalize();
      const slid = grab.D.length();
      if (slid > grab.peakSlide) grab.peakSlide = slid;
      if (b > grab.peakLift) {
        grab.peakLift = b;
        grab.peakWhy = grab.liftWhy;
      }
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
    const near = grab.near;
    // The slide: where your line of sight through the fingers meets the surface (a far wall moves as
    // much as it looks), or, pinched right on a surface, where your hand itself went along it. Lifting
    // the hand off a table must not slide the spot away from you.
    const slide = this.tmp2;
    const across = n.dot(ray);
    const sight = across < -GRAZE * reach;
    if (sight) {
      const k = this.tmp.copy(grab.worldG).sub(this.head).dot(n) / across;
      slide.copy(this.head).addScaledVector(ray, k).sub(grab.worldG);
      slide.addScaledVector(n, -slide.dot(n)).multiplyScalar(this.look.gain * ease);
    }
    if (near > 0) {
      const along = this.tmpA.copy(travel).addScaledVector(n, -travel.dot(n)).multiplyScalar(this.look.gain * ease);
      if (sight) slide.lerp(along, near);
      else slide.copy(along);
    } else if (!sight) {
      slide.copy(grab.target);
    }
    const len = slide.length();
    const span = this.slideSpan(grab, dt);
    const soft = Math.min(SLIDE_SOFT, SOFT_PER_SPAN * span);
    const hard = Math.min(SLIDE_MAX, MAX_PER_SPAN * span);
    if (len > soft) {
      const room = Math.max(1e-3, hard - soft);
      slide.multiplyScalar((soft + room * (1 - Math.exp(-(len - soft) / room))) / len);
      grab.capped = true;
    }
    // Near a surface, the part of the slide toward you is mostly held back: the pinched spot follows
    // your fingers as cloth instead (the cone below), its base dragging behind. Sideways stays a slide.
    const held = this.tmpC.set(0, 0, 0);
    if (near > 0) {
      const toward = this.tmpB.copy(this.head).sub(grab.worldG);
      toward.addScaledVector(n, -toward.dot(n));
      if (toward.lengthSq() > 1e-6) {
        toward.normalize();
        const share = slide.dot(toward);
        if (share > 0) {
          held.copy(toward).multiplyScalar(share * CLOTH_DRAG);
          slide.addScaledVector(held, -near);
        }
      }
    }
    this.keepInPhoto(grab, slide);
    grab.target.copy(slide);
    const reach0 = Math.max(0.1, grab.reach0);
    // The burst still reads how far the hand came toward your head.
    const toward = Math.max(0, reach0 - reach - TOWARD_DEAD * reach0) * ease;
    const off = travel.dot(n);
    const straight = moved > 1e-3 ? smooth((off / moved - STRAIGHT_FROM) / (STRAIGHT_FULL - STRAIGHT_FROM)) : 0;
    const wall = 1 - smooth((Math.abs(n.y) - WALL_UP) / WALL_FADE);
    const rim = Math.max(0, (BURST_ANGLE * this.head.distanceTo(grab.worldG) - 0.22) / 1.5);
    let e = Math.min(EXPLODE_MAX, rim, BURST_SHARE * this.look.radial * toward * Math.max(straight, wall));
    const slid = grab.target.length();
    if (slid + e > PULL_MAX) e = Math.max(0, PULL_MAX - slid);
    grab.explodeTo = e;
    // The cone, like cloth pinched between your fingers. Far (a wall well behind your hand): its tip
    // on your line of sight through them, at the depth that keeps the pinch's own proportion of hand
    // to surface, rising toward your head. Near (pinched right on a surface): its tip follows your
    // fingertips: what the slide held back, plus how far they rose off the surface.
    const spot = this.tmpA.copy(grab.worldG).add(grab.target);
    const depth = spot.distanceTo(this.head);
    const tipDepth = Math.max(reach + TIP_CLEAR, (reach * grab.dist) / reach0);
    const farV = this.tmpB.copy(this.head).sub(spot).normalize().multiplyScalar(Math.max(0, depth - tipDepth) * ease);
    const nearV = held.addScaledVector(n, Math.max(0, off) * ease);
    const v = farV.multiplyScalar(1 - near).addScaledVector(nearV, near).multiplyScalar(this.look.depthPull);
    const b = v.length();
    const cap = Math.min(TENT_MAX, TENT_FRAC * depth);
    grab.liftWhy = b > cap ? 'cap' : near < 0.5 && tipDepth === reach + TIP_CLEAR ? 'tip' : 'hand';
    grab.liftTo = Math.min(b, cap);
    if (b > 1e-3) grab.liftAim.copy(v).multiplyScalar(1 / b);
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
        `D${short(grab.peakSlide)} x${ratio.toFixed(1)} lift${short(grab.peakLift)}(${grab.peakWhy}) ` +
        `n${short(grab.near).replace('1.00', '1')} burst${short(grab.peakBurst)} bloom${short(grab.peakBloom)}` +
        (grab.chain ? ' chain' : ''),
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
    this.resetSpike(this.left);
    this.resetSpike(this.right);
    this.left.pending = false;
    this.right.pending = false;
    this.photo.drop(0);
    this.photo.drop(1);
    this.clearPush();
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
    grab.peakWhy = 'hand';
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
    grab.lift.copy(this.head).sub(grab.worldG).sub(grab.D).normalize();
    grab.dist = Math.max(0.2, this.head.distanceTo(grab.worldG));
    grab.ramp = this.look.ramp * Math.max(1, grab.dist / RAMP_NEAR);
    // The right hand also pulls toward the camera, so a desk screenshot shows the cone.
    grab.B = sign > 0 ? pull * 0.55 : Math.min(0.08, pull * 0.11);
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
    // Near a surface the cone carries what the slide held back, so it counts toward the angle too.
    const move = this.tmp.copy(grab.D).multiplyScalar(sk).addScaledVector(grab.lift, grab.near * Math.max(0, grab.B)).length();
    const angle = Math.atan2(move, grab.dist) / DEG;
    grab.bloom = grab.on && streaks ? smooth((angle - this.look.stripes) / STREAK_SPAN_DEG) : 0;
    // The cone carries the pinched spot's colours by how far of its way toward you it has come.
    const tent = grab.on && streaks ? smooth((grab.B / Math.max(0.2, grab.dist) - TENT_STREAK_FROM) / TENT_STREAK_SPAN) : 0;
    (first ? U.uTentBloom0 : U.uTentBloom1).value = tent;
    // A fingertip spike, when this hand has one up.
    // Its wobble back dips below the surface too.
    const spike = Math.abs(grab.hoverH) > SPIKE_MIN;
    const hov = first ? U.uHov0.value : U.uHov1.value;
    const hovT = first ? U.uHovT0.value : U.uHovT1.value;
    if (spike) {
      hov.set(grab.hoverC.x, grab.hoverC.y, grab.hoverC.z, SPIKE_RADIUS + SPIKE_WIDEN * Math.abs(grab.hoverH));
      hovT.copy(grab.hoverN).multiplyScalar(grab.hoverH);
      (first ? U.uHovN0 : U.uHovN1).value.copy(grab.hoverN);
    } else {
      hovT.set(0, 0, 0);
    }
    const fade = Math.max(grab.fade, spike ? grab.hoverFade : 0);
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
      U.uFade0.value = fade;
    } else {
      U.uA1.value = grab.A;
      U.uE1.value = grab.E;
      U.uB1.value = grab.B;
      U.uRip1.value = grab.rippleT;
      U.uOn1.value = on;
      U.uBloom1.value = grab.bloom;
      U.uHasPhoto1.value = has;
      U.uFade1.value = fade;
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
    const holding = this.left.holding || this.right.holding || this.box.phase === 'held';
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
    this.pushBox.dispose();
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
