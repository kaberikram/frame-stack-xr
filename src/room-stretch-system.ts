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
  createSystem,
  outlineMaterial,
  type ArrayCamera,
  type CameraDeviceInfo,
  type Entity,
} from '@iwsdk/core';
import { PREVIEW_FORCED, getMode } from './experience.js';
import { HandOccluder } from './hand-occluder.js';
import { drawHint, makeCanvas, type Canvas2D } from './labels.js';
import { cameraMount, PassthroughPhoto, type CameraMount, type HandJoints } from './passthrough-photo.js';
import { RoomMeshOverlay } from './room-mesh-overlay.js';
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
/** Slides beyond SLIDE_SOFT ease into SLIDE_MAX. */
const SLIDE_SOFT = 1;
const SLIDE_MAX = 1.5;
/** The pinch ray must meet the grabbed plane within ~78° of its normal to slide. */
const GRAZE = 0.2;
/** Toward-you travel ignored, and how much sideways travel cancels it (a shoulder sweep shortens reach too). */
const TOWARD_DEAD = 0.02;
const LATERAL_SHARE = 0.35;
const EXPLODE_MAX = 0.8;
const LIFT_MAX = 0.08;
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
const FOOTPRINT = 9;
/** Matches the shader's streak ramp and burst core. */
const STRIPE_WIDTH = 0.6;
const CORE = 0.12;
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
  lensPitch: number;
  cameraLatency: number;
  linearBlend: boolean;
}
const NUMBER_KEYS = [
  'gain', 'reach', 'ramp', 'stripes', 'feather', 'wobble', 'waveLength', 'waveSpeed',
  'stiffness', 'damping', 'depthPull', 'radial', 'ripple', 'exposure', 'warmth',
  'tint', 'lensScale', 'lensPitch', 'cameraLatency',
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
  [Card.Pinch]: { title: 'Pinch anything and pull', body: 'Sideways stretches. Toward you bursts.' },
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
      `hands=${has('hand-tracking')} anchors=${has('anchors')}`,
  );
}

function smooth(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/**
 * Pinch the scanned room and pull. Each hand grabs the surface behind the pinch. Sideways pulls
 * slide that spot along the surface and stretch what is behind it into streaks; pulling toward
 * you bursts the surface outward from the pinch. At rest nothing is drawn: plain passthrough.
 */
export class RoomStretchSystem extends createSystem({
  settings: { required: [StretchLook] },
  meshes: { required: [XRMesh] },
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
    gain: 1, reach: 0.45, ramp: 0.35, stripes: 0.2, feather: 0.04, wobble: 0.035,
    waveLength: 0.45, waveSpeed: 7, stiffness: 90, damping: 9, depthPull: 0.35, radial: 2.5,
    ripple: 0.015, exposure: 1.1, warmth: -0.1, tint: 0,
    lensScale: 1, lensPitch: -15, cameraLatency: 0.07,
    linearBlend: true,
  };

  private readonly photo = new PassthroughPhoto();
  private readonly sound = new StretchSound();
  private overlay!: RoomMeshOverlay;
  private hands!: HandOccluder;
  private readonly handMap: { left: XRHand | null; right: XRHand | null } = { left: null, right: null };
  private readonly joints: HandJoints = { points: new Float32Array(0), leftStart: 0, leftCount: 0, rightStart: 0, rightCount: 0 };
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
  private readonly bestO = new Vector3();
  private readonly bestD = new Vector3();
  private readonly inv = new Matrix4();

  init(): void {
    this.overlay = new RoomMeshOverlay(this.scene);
    this.hands = new HandOccluder(this.scene);
    this.joints.points = this.hands.points;
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
    const stretch = getMode() === 'stretch';
    this.syncOutline(stretch);
    if (!stretch) {
      this.hud.visible = false;
      this.room.visible = false;
      this.overlay.hide(true);
      this.hands.setActive(false);
      this.stopCamera();
      this.clearGrabs();
      this.sound.stop();
      return;
    }
    const dt = Math.min(0.1, delta);
    const now = performance.now() / 1000;
    this.readLook();
    this.syncSession(now);
    if (!this.lookLogged) this.logLook();
    const presenting = this.renderer.xr.isPresenting;
    const video = this.cameraVideo();
    const hasVideo = this.photo.watch(video, this.cameraTrack(video), now);
    if (hasVideo !== this.videoWas) {
      this.videoWas = hasVideo;
      console.info(hasVideo ? `[jonze] camera video on ${video?.videoWidth}x${video?.videoHeight}` : '[jonze] camera video off');
    }
    this.applyLook();
    if (presenting) {
      this.wasPresenting = true;
      this.room.visible = false;
      this.player.head.getWorldPosition(this.head);
      this.player.head.getWorldQuaternion(this.headQuat);
      this.photo.recordHead(this.player.head, now);
      this.photo.measureMount(this.mount, this.player.head, (this.renderer.xr.getCamera() as ArrayCamera).cameras);
      this.refreshHands();
      const meshes = this.findMeshes();
      this.syncGrids(meshes);
      this.photo.capture(true, this.camera, this.handJoints(), this.handsKnown(), now);
      this.resolvePending(this.left, dt, now);
      this.resolvePending(this.right, dt, now);
      this.stepHand(this.left, dt);
      this.stepHand(this.right, dt);
      const active = this.left.on || this.right.on;
      this.overlay.setActive(active);
      this.overlay.sync(meshes);
      this.hands.inflate = this.left.holding || this.right.holding ? 1.3 : 1;
      this.publish(this.left, this.right, time, hasVideo);
      this.sing(this.left);
      this.sing(this.right);
      this.rearmCamera(now);
    } else if (!this.previewRoom) {
      // A headset back on the launch page. Leaving a session stops the camera; the frames
      // between the Enter click and the session starting must not.
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
      const live = this.photo.projectLive(false, this.camera, now);
      this.photo.capture(false, this.camera, null, true, now);
      this.updateDemo(dt, now);
      this.overlay.setPreviewLive(video, live, this.photo.worldToClip);
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
    this.player.updateWorldMatrix(true, false);
    this.handMap.left = this.input.xr.isPrimary('hand', 'left') ? this.input.xr.getPrimaryInputSource('left')?.hand ?? null : null;
    this.handMap.right = this.input.xr.isPrimary('hand', 'right') ? this.input.xr.getPrimaryInputSource('right')?.hand ?? null : null;
    this.hands.update(this.world.xrFrame, this.world.xrReferenceSpace, this.player.matrixWorld, this.handMap);
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
    if (!this.pinchPoint(grab.side, this.pinch)) return;
    if (!this.raycast(this.head, this.pinch)) {
      this.sound.miss(grab.slot, this.pinch.x, this.pinch.y, this.pinch.z);
      return;
    }
    grab.mesh = this.hitMesh;
    grab.holding = true;
    grab.on = true;
    grab.seq = ++this.grabSeq;
    grab.localG.copy(this.localHit);
    grab.localNormal.copy(this.localN);
    grab.hand0.copy(this.pinch);
    grab.reach0 = this.pinch.distanceTo(this.head);
    grab.ray0.copy(this.pinch).sub(this.head).normalize();
    grab.rippleT = 0;
    this.poseGrab(grab);
    grab.lift.copy(this.head).sub(grab.worldG).normalize();
    this.writeFootprint(grab);
    this.photo.freeze(grab.slot, this.footprint, FOOTPRINT, true, this.camera, now, this.handJoints());
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
        this.aim(grab, this.pinch);
      } else {
        grab.lostT += dt;
        if (grab.lostT > LOST_RELEASE) this.release(grab);
      }
    }
    if (grab.holding) {
      const f = 1 - Math.exp(-dt / FOLLOW);
      const inv = 1 / Math.max(dt, 1e-3);
      grab.Dprev.copy(grab.D);
      grab.D.lerp(grab.target, f);
      grab.Dvel.copy(grab.D).sub(grab.Dprev).multiplyScalar(inv);
      const e = grab.E + (grab.explodeTo - grab.E) * f;
      grab.Evel = (e - grab.E) * inv;
      grab.E = e;
      const b = grab.B + (grab.liftTo - grab.B) * f;
      grab.Bvel = (b - grab.B) * inv;
      grab.B = b;
      grab.lift.copy(this.head).sub(grab.worldG).normalize();
    } else if (grab.on) {
      this.stepSprings(grab, dt, this.look.stiffness, this.look.damping);
    }
    const len = grab.D.length();
    if (len > 1e-4) grab.axis.copy(grab.D).multiplyScalar(1 / len);
    grab.rippleT = Math.min(grab.rippleT + dt, 10);
    const slot = this.photo.slots[grab.slot];
    grab.fade = slot.has && slot.ready ? Math.min(1, grab.fade + dt / FADE_IN) : 0;
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
   * your eyes through your fingers meets that plane. Bringing the hand closer to your head than at
   * the pinch bursts the surface outward from the pinch instead of tenting it toward you.
   */
  private aim(grab: Grab, hand: Vector3): void {
    const travel = this.raw.copy(hand).sub(grab.hand0);
    const moved = travel.length();
    const ease = smooth((moved - 0.5 * DEAD) / DEAD);
    const ray = this.unit.copy(hand).sub(this.head);
    const reach = ray.length();
    const n = grab.normal;
    const across = n.dot(ray);
    if (across < -GRAZE * reach) {
      const k = this.tmp.copy(grab.worldG).sub(this.head).dot(n) / across;
      const slide = this.tmp2.copy(this.head).addScaledVector(ray, k).sub(grab.worldG);
      slide.addScaledVector(n, -slide.dot(n)).multiplyScalar(this.look.gain * ease);
      const len = slide.length();
      if (len > SLIDE_SOFT) {
        const room = SLIDE_MAX - SLIDE_SOFT;
        slide.multiplyScalar((SLIDE_SOFT + room * (1 - Math.exp(-(len - SLIDE_SOFT) / room))) / len);
      }
      this.keepInPhoto(grab, slide);
      grab.target.copy(slide);
    }
    const along = travel.dot(grab.ray0);
    const lateral = Math.sqrt(Math.max(0, moved * moved - along * along));
    const toward = Math.max(0, grab.reach0 - reach - LATERAL_SHARE * lateral - TOWARD_DEAD) * ease;
    const rim = Math.max(0, (BURST_ANGLE * this.head.distanceTo(grab.worldG) - 0.22) / 1.5);
    let e = Math.min(EXPLODE_MAX, rim, this.look.radial * toward);
    const slid = grab.target.length();
    if (slid + e > PULL_MAX) e = Math.max(0, PULL_MAX - slid);
    grab.explodeTo = e;
    grab.liftTo = Math.min(LIFT_MAX, this.look.depthPull * toward);
  }

  /** Shortens a slide so the grab point lands inside its photo: past the edge there is nothing to show. */
  private keepInPhoto(grab: Grab, slide: Vector3): void {
    if (!this.photo.slots[grab.slot].has) return;
    const probe = this.tmp.copy(grab.worldG).add(slide);
    if (this.photo.slotContains(grab.slot, probe, SLIDE_MARGIN)) return;
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
    grab.B = Math.min(LIFT_MAX, pull * 0.11);
    grab.E = 0;
    grab.rippleT = 10;
    grab.A = AHEAD;
    const slot = this.photo.slots[grab.slot];
    if (moving && !slot.has) {
      this.writeFootprint(grab);
      this.photo.freeze(grab.slot, this.footprint, FOOTPRINT, false, this.camera, now, null);
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
    U.uRamp.value = this.look.ramp;
    U.uStripes.value = this.look.stripes;
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
    const on = grab.on ? 1 : 0;
    const has = slot.has && slot.texture ? 1 : 0;
    // Streaks only on the side the pull went; the spring's overshoot flips D but not the picture.
    const len = grab.D.length();
    const sk = grab.holding || len < 1e-4 ? 1 : Math.max(0, grab.D.dot(grab.axisRel) / len);
    if (first) {
      U.uA0.value = grab.A;
      U.uE0.value = grab.E;
      U.uB0.value = grab.B;
      U.uRip0.value = grab.rippleT;
      U.uOn0.value = on;
      U.uSk0.value = sk;
      U.uHasPhoto0.value = has;
      U.uFade0.value = grab.fade;
    } else {
      U.uA1.value = grab.A;
      U.uE1.value = grab.E;
      U.uB1.value = grab.B;
      U.uRip1.value = grab.rippleT;
      U.uOn1.value = on;
      U.uSk1.value = sk;
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
    const ramp = Math.max(this.look.ramp, 1e-3);
    const taffy = smooth((1.5 * grab.D.length() / ramp - this.look.stripes) / STRIPE_WIDTH);
    const burst = smooth((1.5 * grab.E / (CORE + 0.35 * Math.max(grab.E, 0)) - this.look.stripes) / STRIPE_WIDTH);
    this.sound.track(grab.slot, grab.holding, mag / dist, Math.max(taffy, burst), G.x, G.y, G.z);
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
      `[jonze] look stripes=${k.stripes.toFixed(2)} ramp=${k.ramp.toFixed(2)} radial=${k.radial.toFixed(1)} ` +
        `lens=${k.lensScale.toFixed(3)}/${k.lensPitch.toFixed(2)} lat=${k.cameraLatency.toFixed(3)}`,
    );
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
      return;
    }
  }

  private applyLook(): void {
    const lens = this.photo.lens;
    lens.scale = this.look.lensScale;
    lens.pitchDeg = this.look.lensPitch;
    lens.latency = this.look.cameraLatency;
    lens.exposure = this.look.exposure;
    lens.warmth = this.look.warmth;
    lens.tint = this.look.tint;
    this.photo.updateGains();
  }

  // ---------------------------------------------------------------- camera

  private attachCamera(devices: CameraDeviceInfo[]): boolean {
    if (getMode() !== 'stretch' || this.cameraEntity) return !!this.cameraEntity;
    const back = CameraUtils.findByFacing(devices, CameraFacing.Back);
    const chosen = back ?? devices[0];
    if (!chosen) {
      console.warn('[jonze] camera: no video inputs');
      return false;
    }
    this.mount = cameraMount(chosen.label, back ? 'back' : 'unknown');
    console.info(`[jonze] camera pick "${chosen.label}" mount=${this.mount}${back ? ' back' : ''} of ${devices.length}`);
    console.debug('[jonze] camera devices', devices.map((d) => d.label).join(' | '));
    const anchor = new Group();
    anchor.name = 'passthrough-camera';
    anchor.visible = false;
    const entity = this.world.createTransformEntity(anchor);
    entity.addComponent(CameraSource);
    entity.setValue(CameraSource, 'deviceId', chosen.deviceId);
    entity.setValue(CameraSource, 'facing', back ? CameraFacing.Back : CameraFacing.Unknown);
    // 4:3 keeps the lens's full height; 16:9 crops ~14° off the top and bottom.
    entity.setValue(CameraSource, 'width', 1280);
    entity.setValue(CameraSource, 'height', 960);
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
