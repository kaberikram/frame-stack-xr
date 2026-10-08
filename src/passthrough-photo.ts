import {
  CanvasTexture,
  ClampToEdgeWrapping,
  LinearFilter,
  Matrix4,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type Object3D,
  type PerspectiveCamera,
} from '@iwsdk/core';

export type CameraMount = 'left' | 'right' | 'center' | 'view';

/**
 * Where the passthrough camera sits in the head's frame, before pitch. The right camera's published
 * offset from the right eye is a few centimetres toward centre, up and forward, which lands near the
 * middle of the head; the left mirrors it. Eye offsets are measured live when the mount is known.
 */
const FROM_EYE = { x: 0.032, y: 0.02, z: -0.025 };
const CENTER = { x: 0, y: 0.02, z: -0.025 };
// Quest 3's getUserMedia image behaves like ~77° horizontal FOV at 1280 wide (fx ≈ fy ≈ 800).
// Pixels are square, so other aspect ratios are crops of the same lens.
const REF_W = 1280;
const REF_F = 800;

const BANK = 8;
const POSES = 64;
const PROBE_W = 16;
const PROBE_H = 12;
/** Mean linear luminance below this is a warm-up or suspended frame. */
const DARK = 0.03;
const STEADY_RAD = (8 * Math.PI) / 180;
const STEADY_M = 0.1;
/** Frames this soon after the camera starts are still finding their exposure. */
const WARMUP = 1;
const ADMIT_GAP = 0.2;
const SAME_VIEW = Math.cos((20 * Math.PI) / 180);
const MAX_AGE = 30;
/** A photo must hold the whole grab footprint this far inside its edges. */
const MARGIN = 0.08;
/** Failing that, a hand-free photo still has to hold the grab point this far in. */
const CENTER_MARGIN = 0.15;
const HAND_PAD = 0.25;
/** A new frame of the same view replaces the stored one only if it covers this much less of the centre. */
const CLEANER = 0.02;
const CORE_U0 = 0.3;
const CORE_V0 = 0.25;
const CORE_U1 = 0.7;
const CORE_V1 = 0.75;
const RVFC_WAIT = 0.5;

export interface LensTuning {
  scale: number;
  pitchDeg: number;
  latency: number;
  exposure: number;
  warmth: number;
  tint: number;
}

interface MeanRgb {
  r: number;
  g: number;
  b: number;
  lum: number;
}

/** Why the last freeze found no photo. A string literal, so recording it allocates nothing. */
export type PhotoMiss = 'none' | 'no-video' | 'no-pose' | 'off-frame' | 'dark';

/** What the last freeze chose and why, for one console line per pinch. */
interface PickNote {
  source: 'bank' | 'live' | 'none';
  age: number;
  margin: number;
  tier: number;
  seen: number;
  old: number;
  edge: number;
  hand: number;
}

/** Packed world-space joints, with where each hand's run starts and how long it is. */
export interface HandJoints {
  points: Float32Array;
  leftStart: number;
  leftCount: number;
  rightStart: number;
  rightCount: number;
}

interface BankEntry {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  used: boolean;
  w: number;
  h: number;
  time: number;
  r: number;
  g: number;
  b: number;
  lum: number;
  readonly toClip: Matrix4;
  readonly cam: Vector3;
  readonly dir: Vector3;
  /** uv boxes of each tracked hand: u0, v0, u1, v1 per hand. u0 > u1 means no hand. */
  readonly hands: Float32Array;
}

export interface PhotoSlot {
  texture: CanvasTexture | null;
  /** A photo is frozen in this slot. */
  has: boolean;
  /** Its texture has actually reached the GPU. Uploads are deferred under multiview. */
  ready: boolean;
  /** The live frame with the pinching hand painted out: stretch it, but never streak the painted strip. */
  painted: boolean;
  readonly toClip: Matrix4;
  readonly cam: Vector3;
  readonly gain: Vector3;
}

interface SlotStore {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  r: number;
  g: number;
  b: number;
  lum: number;
}

/** Which visor camera a device label is talking about. A webcam stays `view`. */
export function cameraMount(label: string, facing: 'back' | 'front' | 'unknown'): CameraMount {
  const text = label.toLowerCase();
  const back = facing === 'back' || /back|environment|rear/.test(text);
  if (!back) return 'view';
  if (/left/.test(text) || /camera\D*1\b/.test(text)) return 'left';
  if (/right/.test(text) || /camera\D*2\b/.test(text)) return 'right';
  return 'center';
}

/**
 * Keeps a few clean camera frames, each stamped with the head pose it was taken from, and freezes
 * one into a slot when a hand grabs. Clean means steady, bright, and with every tracked hand boxed
 * so a grab can pick a frame whose hands are nowhere near what it stretches. On a desk the frames
 * come from the webcam through the preview camera.
 */
export class PassthroughPhoto {
  /** World-space points into the live camera's clip space, at the latency-corrected pose. */
  readonly worldToClip = new Matrix4();
  readonly liveCam = new Vector3();
  readonly slots: [PhotoSlot, PhotoSlot];
  /** Why the last freeze() returned false. */
  lastMiss: PhotoMiss = 'none';
  private readonly pickNote: PickNote = { source: 'none', age: 0, margin: 0, tier: 0, seen: 0, old: 0, edge: 0, hand: 0 };
  /** Tunables the system copies in from StretchLook each frame. */
  readonly lens: LensTuning = { scale: 1, pitchDeg: -15, latency: 0.07, exposure: 1.1, warmth: -0.1, tint: 0 };

  private readonly bank: BankEntry[] = [];
  private readonly stores: [SlotStore, SlotStore];
  private readonly probe: HTMLCanvasElement;
  private readonly probeCtx: CanvasRenderingContext2D;
  private readonly probeMean: MeanRgb = { r: 0, g: 0, b: 0, lum: 0 };
  private readonly scratchHands = new Float32Array(8);
  private lastAdmit = -Infinity;

  private readonly poses = new Float64Array(POSES * 8);
  private poseHead = -1;
  private poseCount = 0;

  private video: HTMLVideoElement | null = null;
  private videoW = 0;
  private videoH = 0;
  private activeAt = 0;
  private rvfcHandle = -1;
  private rvfcSeen = false;
  private frameSerial = 0;
  private frameTime = 0;
  private seenSerial = 0;
  private polledFrames = -1;
  private loggedPath = false;
  private loggedTrack: MediaStreamTrack | null = null;

  private readonly eyeShift = new Vector3(CENTER.x, CENTER.y, CENTER.z);
  private readonly camWorld = new Matrix4();
  private readonly offset = new Matrix4();
  private readonly pitch = new Matrix4();
  private readonly projection = new Matrix4();
  private readonly view = new Matrix4();
  private readonly pos = new Vector3();
  private readonly quat = new Quaternion();
  private readonly quatB = new Quaternion();
  private readonly quatC = new Quaternion();
  private readonly one = new Vector3(1, 1, 1);
  private readonly tmp = new Vector3();
  private readonly inv = new Matrix4();
  private readonly eyeLocal = new Matrix4();

  constructor() {
    for (let i = 0; i < BANK; i++) {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas is unavailable');
      this.bank.push({
        canvas, ctx, used: false, w: 0, h: 0, time: 0, r: 0, g: 0, b: 0, lum: 0,
        toClip: new Matrix4(), cam: new Vector3(), dir: new Vector3(), hands: new Float32Array(8),
      });
    }
    this.stores = [makeStore(), makeStore()];
    this.slots = [makeSlot(), makeSlot()];
    this.probe = document.createElement('canvas');
    this.probe.width = PROBE_W;
    this.probe.height = PROBE_H;
    const probeCtx = this.probe.getContext('2d', { willReadFrequently: true });
    if (!probeCtx) throw new Error('2D canvas is unavailable');
    this.probeCtx = probeCtx;
  }

  /** Call every presenting frame, after the input system moved the head. */
  recordHead(head: Object3D, now: number): void {
    head.matrixWorld.decompose(this.pos, this.quat, this.tmp);
    this.poseHead = (this.poseHead + 1) % POSES;
    this.poseCount = Math.min(POSES, this.poseCount + 1);
    const o = this.poseHead * 8;
    const p = this.poses;
    p[o] = now;
    p[o + 1] = this.pos.x;
    p[o + 2] = this.pos.y;
    p[o + 3] = this.pos.z;
    p[o + 4] = this.quat.x;
    p[o + 5] = this.quat.y;
    p[o + 6] = this.quat.z;
    p[o + 7] = this.quat.w;
  }

  /**
   * Follows the camera's video element. A new element or new size is a camera restart: the
   * bank is dropped and the warm-up starts again. Returns whether a usable video is playing.
   */
  watch(video: HTMLVideoElement | null, track: MediaStreamTrack | null, now: number): boolean {
    if (video !== this.video) {
      if (this.video && this.rvfcHandle >= 0) this.video.cancelVideoFrameCallback?.(this.rvfcHandle);
      this.video = video;
      this.rvfcHandle = -1;
      this.rvfcSeen = false;
      this.activeAt = now;
      this.polledFrames = -1;
      // A new camera start: print its frame size and path again.
      this.videoW = 0;
      this.videoH = 0;
      this.loggedPath = false;
      if (video && typeof video.requestVideoFrameCallback === 'function') {
        this.rvfcHandle = video.requestVideoFrameCallback(this.onFrame);
      }
    }
    if (!video || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return false;
    if (video.videoWidth !== this.videoW || video.videoHeight !== this.videoH) {
      this.videoW = video.videoWidth;
      this.videoH = video.videoHeight;
      this.activeAt = now;
      for (let i = 0; i < this.bank.length; i++) this.bank[i].used = false;
      console.info(`[jonze] camera frame ${this.videoW}x${this.videoH}`);
    }
    if (track && track !== this.loggedTrack) {
      this.loggedTrack = track;
      logTrack(track);
    }
    return true;
  }

  /** Measures where the camera sits relative to the head when the mount is one eye's camera. */
  measureMount(mount: CameraMount, head: Object3D, eyes: readonly Object3D[]): void {
    if ((mount !== 'left' && mount !== 'right') || eyes.length < 2) {
      this.eyeShift.set(CENTER.x, CENTER.y, CENTER.z);
      return;
    }
    const eye = mount === 'left' ? eyes[0] : eyes[eyes.length - 1];
    this.eyeLocal.compose(eye.position, eye.quaternion, this.one);
    this.inv.copy(head.matrix).invert().multiply(this.eyeLocal);
    this.eyeShift.setFromMatrixPosition(this.inv);
    const toward = mount === 'left' ? FROM_EYE.x : -FROM_EYE.x;
    this.eyeShift.x += toward;
    this.eyeShift.y += FROM_EYE.y;
    this.eyeShift.z += FROM_EYE.z;
  }

  /**
   * The live camera's projection: the head pose one camera latency ago on a headset, the preview
   * camera on a desk. Used for the pinch-frame fallback and the desk preview.
   */
  projectLive(presenting: boolean, viewCamera: PerspectiveCamera, now: number): boolean {
    if (!this.videoW) return false;
    if (presenting) {
      if (!this.poseAt(now - this.lens.latency)) return false;
      this.writeClip(this.worldToClip, this.liveCam);
    } else {
      viewCamera.updateMatrixWorld();
      this.worldToClip.copy(viewCamera.projectionMatrix).multiply(viewCamera.matrixWorldInverse);
      this.liveCam.setFromMatrixPosition(viewCamera.matrixWorld);
    }
    return true;
  }

  /**
   * Considers the newest camera frame for the bank. `handsKnown` is false while a hand that should
   * be tracked isn't, since it could be anywhere in the picture. `steady` covers the desk preview.
   */
  capture(presenting: boolean, viewCamera: PerspectiveCamera, joints: HandJoints | null, handsKnown: boolean, now: number): void {
    const video = this.video;
    if (!video || !this.videoW || !handsKnown) return;
    if (now - this.activeAt < WARMUP || now - this.lastAdmit < ADMIT_GAP) return;
    let captured = now - this.lens.latency;
    if (presenting) {
      if (this.rvfcSeen) {
        if (this.frameSerial === this.seenSerial) return;
        this.seenSerial = this.frameSerial;
        captured = this.frameTime > 0 ? this.frameTime : captured;
      } else {
        if (this.rvfcHandle >= 0 && now - this.activeAt < RVFC_WAIT) return;
        const frames = video.getVideoPlaybackQuality?.().totalVideoFrames ?? -1;
        if (frames >= 0 && frames === this.polledFrames) return;
        this.polledFrames = frames;
      }
      this.notePath();
      if (!this.steady(captured - 0.06, now)) return;
    }
    if (!this.measure(video)) return;
    if (presenting) {
      if (!this.poseAt(captured)) return;
    } else {
      viewCamera.updateMatrixWorld();
    }
    const entry = this.pick(presenting, viewCamera, joints, now);
    if (!entry) return;
    if (entry.canvas.width !== this.videoW || entry.canvas.height !== this.videoH) {
      entry.canvas.width = this.videoW;
      entry.canvas.height = this.videoH;
    }
    entry.ctx.drawImage(video, 0, 0, this.videoW, this.videoH);
    entry.used = true;
    entry.w = this.videoW;
    entry.h = this.videoH;
    entry.time = now;
    entry.r = this.probeMean.r;
    entry.g = this.probeMean.g;
    entry.b = this.probeMean.b;
    entry.lum = this.probeMean.lum;
    this.boxHands(entry, joints);
    this.lastAdmit = now;
  }

  /**
   * Freezes a photo into slot `k` for a grab whose footprint is `count` world points, the grab
   * point first. Prefers a recent bank frame with no hand on the footprint: one that holds all of
   * it, else one that holds the grab point well inside (the rest feathers out). Only then the live
   * frame, which has the pinching hand in it. False when nothing usable exists.
   */
  freeze(
    k: 0 | 1,
    footprint: Float32Array,
    count: number,
    presenting: boolean,
    viewCamera: PerspectiveCamera,
    now: number,
    joints: HandJoints | null,
  ): boolean {
    const note = this.pickNote;
    note.source = 'none';
    note.seen = 0;
    note.old = 0;
    note.edge = 0;
    note.hand = 0;
    let best: BankEntry | null = null;
    let bestScore = -Infinity;
    let bestMargin = 0;
    let bestTier = 0;
    for (let i = 0; i < this.bank.length; i++) {
      const entry = this.bank[i];
      if (!entry.used) continue;
      note.seen++;
      if (now - entry.time > MAX_AGE) {
        note.old++;
        continue;
      }
      const center = footprintMargin(entry.toClip, footprint, 1);
      if (center < CENTER_MARGIN) {
        note.edge++;
        continue;
      }
      if (touchesHands(entry, footprint, count)) {
        note.hand++;
        continue;
      }
      const margin = footprintMargin(entry.toClip, footprint, count);
      const tier = margin >= MARGIN ? 2 : 1;
      const score = tier * 10 + (margin >= MARGIN ? margin : center) / (1 + (now - entry.time) / 8);
      if (score > bestScore) {
        bestScore = score;
        best = entry;
        bestMargin = margin >= MARGIN ? margin : center;
        bestTier = tier;
      }
    }
    if (best) {
      this.fill(k, best.canvas, best.w, best.h, best);
      this.slots[k].painted = false;
      this.slots[k].toClip.copy(best.toClip);
      this.slots[k].cam.copy(best.cam);
      note.source = 'bank';
      note.age = now - best.time;
      note.margin = bestMargin;
      note.tier = bestTier;
      this.lastMiss = 'none';
      return true;
    }
    const video = this.video;
    if (!video || !this.videoW) {
      this.lastMiss = 'no-video';
      return false;
    }
    if (!this.projectLive(presenting, viewCamera, now)) {
      this.lastMiss = 'no-pose';
      return false;
    }
    const margin = footprintMargin(this.worldToClip, footprint, 1);
    if (margin < 0.02) {
      this.lastMiss = 'off-frame';
      return false;
    }
    if (!this.measure(video)) {
      this.lastMiss = 'dark';
      return false;
    }
    this.lastMiss = 'none';
    note.source = 'live';
    note.age = 0;
    note.margin = margin;
    note.tier = 0;
    this.fill(k, video, this.videoW, this.videoH, this.probeMean);
    this.slots[k].painted = this.smearHands(k, joints);
    this.slots[k].toClip.copy(this.worldToClip);
    this.slots[k].cam.copy(this.liveCam);
    return true;
  }

  /** One line on the last freeze for slot `k`: where its photo came from, or why there was none. */
  pickLine(k: 0 | 1): string {
    const n = this.pickNote;
    const side = k === 0 ? 'L' : 'R';
    const bank = `${n.seen}/${BANK} old${n.old} edge${n.edge} hand${n.hand}`;
    if (n.source === 'bank') return `photo ${side}: bank age=${n.age.toFixed(1)}s mrg=${n.margin.toFixed(2)} t${n.tier} | ${bank}`;
    if (n.source === 'live') {
      return `photo ${side}: live${this.slots[k].painted ? ', hand painted out' : ''} mrg=${n.margin.toFixed(2)} | ${bank}`;
    }
    return `photo ${side}: none (${this.lastMiss}) | ${bank}`;
  }

  /** True when `point` lands inside slot `k`'s photo with `margin` to spare. */
  slotContains(k: 0 | 1, point: Vector3, margin: number): boolean {
    const slot = this.slots[k];
    if (!slot.has) return true;
    return uvMargin(slot.toClip, point.x, point.y, point.z) >= margin;
  }

  /** Re-derives each slot's colour from the current exposure, warmth and tint. */
  updateGains(): void {
    for (let k = 0; k < 2; k++) this.writeGain(this.slots[k].gain);
  }

  drop(k: 0 | 1): void {
    this.slots[k].has = false;
  }

  /** Forget every frame: a new session, a recentred space, or a restarted camera. */
  clear(): void {
    for (let i = 0; i < this.bank.length; i++) this.bank[i].used = false;
    this.slots[0].has = false;
    this.slots[1].has = false;
    this.poseCount = 0;
    this.poseHead = -1;
    this.lastAdmit = -Infinity;
    this.loggedPath = false;
  }

  dispose(): void {
    if (this.video && this.rvfcHandle >= 0) this.video.cancelVideoFrameCallback?.(this.rvfcHandle);
    this.video = null;
    for (let k = 0; k < 2; k++) {
      this.slots[k].texture?.dispose();
      this.slots[k].texture = null;
    }
  }

  // ---------------------------------------------------------------- internals

  private readonly onFrame = (_now: number, meta: VideoFrameCallbackMetadata): void => {
    const video = this.video;
    if (!video) return;
    this.rvfcSeen = true;
    this.frameSerial++;
    const at = meta.captureTime ?? meta.expectedDisplayTime - this.lens.latency * 1000;
    this.frameTime = at / 1000;
    this.rvfcHandle = video.requestVideoFrameCallback(this.onFrame);
  };

  private notePath(): void {
    if (this.loggedPath) return;
    this.loggedPath = true;
    const f = REF_F * (this.videoW / REF_W) * this.lens.scale;
    const e = this.eyeShift;
    console.info(
      `[jonze] camera frames: ${this.rvfcSeen ? 'rVFC' : 'polling'} f=${f.toFixed(0)} pitch=${this.lens.pitchDeg.toFixed(2)} ` +
        `shift=${e.x.toFixed(3)},${e.y.toFixed(3)},${e.z.toFixed(3)}`,
    );
  }

  /** Copies a source into slot `k`'s own canvas, rebuilding its texture when the size changes. */
  private fill(k: 0 | 1, source: CanvasImageSource, w: number, h: number, rgb: MeanRgb): void {
    const store = this.stores[k];
    const slot = this.slots[k];
    if (store.w !== w || store.h !== h || !slot.texture) {
      store.canvas.width = w;
      store.canvas.height = h;
      store.w = w;
      store.h = h;
      slot.texture?.dispose();
      slot.texture = makeTexture(store.canvas, slot);
    }
    store.ctx.drawImage(source, 0, 0, w, h);
    store.r = rgb.r;
    store.g = rgb.g;
    store.b = rgb.b;
    store.lum = rgb.lum;
    slot.ready = false;
    if (slot.texture) slot.texture.needsUpdate = true;
    slot.has = true;
    this.writeGain(slot.gain);
  }

  /**
   * Exposure, warmth and tint only. No term from the photo's own average: that pulled a brown table
   * toward the room's mean grey. Allocates nothing; it runs every frame.
   */
  private writeGain(out: Vector3): void {
    const e = this.lens.exposure;
    const warm = this.lens.warmth;
    const tint = this.lens.tint;
    out.set(e * (1 + 0.5 * warm) * (1 - 0.25 * tint), e * (1 + 0.5 * tint), e * (1 - 0.5 * warm) * (1 - 0.25 * tint));
  }

  /** Mean linear RGB of the video, from a tiny copy. False when the frame is still black. */
  private measure(video: HTMLVideoElement): boolean {
    this.probeCtx.drawImage(video, 0, 0, PROBE_W, PROBE_H);
    const data = this.probeCtx.getImageData(0, 0, PROBE_W, PROBE_H).data;
    let r = 0;
    let g = 0;
    let b = 0;
    const n = PROBE_W * PROBE_H;
    for (let i = 0; i < data.length; i += 4) {
      r += SRGB_TO_LINEAR[data[i]];
      g += SRGB_TO_LINEAR[data[i + 1]];
      b += SRGB_TO_LINEAR[data[i + 2]];
    }
    const mean = this.probeMean;
    mean.r = r / n;
    mean.g = g / n;
    mean.b = b / n;
    mean.lum = 0.2126 * mean.r + 0.7152 * mean.g + 0.0722 * mean.b;
    return mean.lum >= DARK;
  }

  /**
   * Bank entry for a frame looking the way the camera looks now. Within one view the stored frame
   * stays unless the new one has less hand in the centre, or the stored one is older than MAX_AGE.
   */
  private pick(presenting: boolean, viewCamera: PerspectiveCamera, joints: HandJoints | null, now: number): BankEntry | null {
    const toClip = this.projection;
    const cam = this.pos;
    const dir = this.tmp;
    if (presenting) {
      this.writeClip(toClip, cam);
      dir.set(-this.camWorld.elements[8], -this.camWorld.elements[9], -this.camWorld.elements[10]).normalize();
    } else {
      toClip.copy(viewCamera.projectionMatrix).multiply(viewCamera.matrixWorldInverse);
      cam.setFromMatrixPosition(viewCamera.matrixWorld);
      viewCamera.getWorldDirection(dir);
    }
    let chosen: BankEntry | null = null;
    const incoming = coverBoxes(this.boxesFor(joints, toClip));
    for (let i = 0; i < this.bank.length; i++) {
      const entry = this.bank[i];
      if (entry.used && entry.dir.dot(dir) > SAME_VIEW) {
        const stale = now - entry.time > MAX_AGE;
        if (!stale && incoming + CLEANER >= coverBoxes(entry.hands)) return null;
        chosen = entry;
        break;
      }
    }
    if (!chosen) {
      for (let i = 0; i < this.bank.length; i++) {
        const entry = this.bank[i];
        if (!entry.used) {
          chosen = entry;
          break;
        }
        if (!chosen || entry.time < chosen.time) chosen = entry;
      }
    }
    if (!chosen) return null;
    chosen.toClip.copy(toClip);
    chosen.cam.copy(cam);
    chosen.dir.copy(dir);
    return chosen;
  }

  private boxHands(entry: BankEntry, joints: HandJoints | null): void {
    clearBoxes(entry.hands);
    if (!joints) return;
    this.writeBox(entry.hands, entry.toClip, joints.points, joints.leftStart, joints.leftCount, 0);
    this.writeBox(entry.hands, entry.toClip, joints.points, joints.rightStart, joints.rightCount, 1);
  }

  /** Hand boxes for `clip`, written into the scratch buffer. */
  private boxesFor(joints: HandJoints | null, clip: Matrix4): Float32Array {
    const box = this.scratchHands;
    clearBoxes(box);
    if (!joints) return box;
    this.writeBox(box, clip, joints.points, joints.leftStart, joints.leftCount, 0);
    this.writeBox(box, clip, joints.points, joints.rightStart, joints.rightCount, 1);
    return box;
  }

  private writeBox(box: Float32Array, clip: Matrix4, points: Float32Array, start: number, count: number, slot: number): void {
    if (count <= 0) return;
    const e = clip.elements;
    let u0 = Infinity;
    let v0 = Infinity;
    let u1 = -Infinity;
    let v1 = -Infinity;
    for (let i = start; i < start + count; i++) {
      const x = points[i * 3];
      const y = points[i * 3 + 1];
      const z = points[i * 3 + 2];
      const w = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (w <= 1e-4) continue;
      const u = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w) * 0.5 + 0.5;
      const v = ((e[1] * x + e[5] * y + e[9] * z + e[13]) / w) * 0.5 + 0.5;
      if (u < u0) u0 = u;
      if (v < v0) v0 = v;
      if (u > u1) u1 = u;
      if (v > v1) v1 = v;
    }
    if (u0 > u1) return;
    const padU = (u1 - u0) * HAND_PAD + 0.02;
    const padV = (v1 - v0) * HAND_PAD + 0.02;
    const o = slot * 4;
    box[o] = u0 - padU;
    box[o + 1] = v0 - padV;
    box[o + 2] = u1 + padU;
    box[o + 3] = v1 + padV;
  }

  /** Stretches a strip of nearby pixels across each hand box. True when anything was painted. */
  private smearHands(k: 0 | 1, joints: HandJoints | null): boolean {
    if (!joints) return false;
    const store = this.stores[k];
    const box = this.boxesFor(joints, this.worldToClip);
    const left = paintOutHand(store, box, 0);
    const right = paintOutHand(store, box, 4);
    return left || right;
  }

  /** True when the head turned less than ~8°/s and moved less than 0.1 m/s between two times. */
  private steady(from: number, to: number): boolean {
    if (to - from < 1e-3 || !this.poseAt(from)) return false;
    const ax = this.pos.x;
    const ay = this.pos.y;
    const az = this.pos.z;
    this.quatC.copy(this.quat);
    if (!this.poseAt(to)) return false;
    const dt = to - from;
    const moved = Math.hypot(this.pos.x - ax, this.pos.y - ay, this.pos.z - az) / dt;
    const turned = this.quat.angleTo(this.quatC) / dt;
    return moved < STEADY_M && turned < STEADY_RAD;
  }

  /** Head pose at `time`, interpolated from the ring, into `pos`/`quat`. */
  private poseAt(time: number): boolean {
    const n = this.poseCount;
    if (n === 0) return false;
    const p = this.poses;
    let newer = this.poseHead;
    for (let i = 0; i < n; i++) {
      const idx = (this.poseHead - i + POSES) % POSES;
      const o = idx * 8;
      if (p[o] <= time) {
        if (i === 0) {
          this.readPose(o);
          return true;
        }
        const on = newer * 8;
        const span = p[on] - p[o];
        const f = span > 1e-6 ? (time - p[o]) / span : 0;
        this.readPose(o);
        this.quatB.set(p[on + 4], p[on + 5], p[on + 6], p[on + 7]);
        this.pos.set(
          this.pos.x + (p[on + 1] - this.pos.x) * f,
          this.pos.y + (p[on + 2] - this.pos.y) * f,
          this.pos.z + (p[on + 3] - this.pos.z) * f,
        );
        this.quat.slerp(this.quatB, f);
        return true;
      }
      newer = idx;
    }
    this.readPose(((this.poseHead - n + 1 + POSES) % POSES) * 8);
    return true;
  }

  private readPose(o: number): void {
    const p = this.poses;
    this.pos.set(p[o + 1], p[o + 2], p[o + 3]);
    this.quat.set(p[o + 4], p[o + 5], p[o + 6], p[o + 7]);
  }

  /** Camera projection from the pose in `pos`/`quat`. Also leaves the camera matrix in `camWorld`. */
  private writeClip(outClip: Matrix4, outCam: Vector3): void {
    this.camWorld.compose(this.pos, this.quat, this.one);
    this.offset.makeTranslation(this.eyeShift.x, this.eyeShift.y, this.eyeShift.z);
    this.pitch.makeRotationX((this.lens.pitchDeg * Math.PI) / 180);
    this.camWorld.multiply(this.offset).multiply(this.pitch);
    const f = REF_F * (this.videoW / REF_W) * this.lens.scale;
    writeProjection(this.view, f, f, this.videoW * 0.5, this.videoH * 0.5, this.videoW, this.videoH);
    outCam.setFromMatrixPosition(this.camWorld);
    outClip.copy(this.camWorld).invert().premultiply(this.view);
  }
}

const SRGB_TO_LINEAR = (() => {
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    table[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return table;
})();

function makeStore(): SlotStore {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable');
  return { canvas, ctx, w: 0, h: 0, r: 0, g: 0, b: 0, lum: 0 };
}

function clearBoxes(box: Float32Array): void {
  for (let i = 0; i < 2; i++) {
    box[i * 4] = 1;
    box[i * 4 + 1] = 1;
    box[i * 4 + 2] = 0;
    box[i * 4 + 3] = 0;
  }
}

/** Fraction of the frame centre covered by hand boxes. */
function coverBoxes(box: Float32Array): number {
  const area = (CORE_U1 - CORE_U0) * (CORE_V1 - CORE_V0);
  let covered = 0;
  for (let h = 0; h < 2; h++) {
    const o = h * 4;
    if (box[o] > box[o + 2]) continue;
    const x0 = Math.max(CORE_U0, box[o]);
    const y0 = Math.max(CORE_V0, box[o + 1]);
    const x1 = Math.min(CORE_U1, box[o + 2]);
    const y1 = Math.min(CORE_V1, box[o + 3]);
    if (x1 > x0 && y1 > y0) covered += (x1 - x0) * (y1 - y0);
  }
  return covered / area;
}

function paintOutHand(store: SlotStore, box: Float32Array, o: number): boolean {
  if (box[o] > box[o + 2]) return false;
  const { ctx, canvas, w, h } = store;
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(box[o] * w)));
  const x1 = Math.max(0, Math.min(w, Math.ceil(box[o + 2] * w)));
  const y0 = Math.max(0, Math.min(h - 1, Math.floor((1 - box[o + 3]) * h)));
  const y1 = Math.max(0, Math.min(h, Math.ceil((1 - box[o + 1]) * h)));
  const dw = x1 - x0;
  const dh = y1 - y0;
  if (dw < 2 || dh < 2) return false;
  const sw = Math.max(4, Math.round(dw * 0.08));
  let sx = x0 - sw - 2;
  if (sx < 0) sx = x1 + 2;
  if (sx >= 0 && sx + sw <= w) {
    ctx.drawImage(canvas, sx, y0, sw, dh, x0, y0, dw, dh);
    return true;
  }
  const sh = Math.max(4, Math.round(Math.min(12, dh)));
  let sy = y0 - sh - 2;
  if (sy < 0) sy = y1 + 2;
  if (sy < 0 || sy + sh > h) return false;
  ctx.drawImage(canvas, x0, sy, dw, sh, x0, y0, dw, dh);
  return true;
}

function makeSlot(): PhotoSlot {
  return {
    texture: null, has: false, ready: false, painted: false,
    toClip: new Matrix4(), cam: new Vector3(), gain: new Vector3(1, 1, 1),
  };
}

/** Created at the frame's real size: three allocates immutable storage on the first upload. */
function makeTexture(canvas: HTMLCanvasElement, slot: PhotoSlot): CanvasTexture {
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.onUpdate = () => {
    slot.ready = true;
  };
  return tex;
}

/** Distance from the point's uv to the nearest frame edge; negative outside or behind. */
function uvMargin(clip: Matrix4, x: number, y: number, z: number): number {
  const e = clip.elements;
  const w = e[3] * x + e[7] * y + e[11] * z + e[15];
  if (w <= 1e-4) return -1;
  const u = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w) * 0.5 + 0.5;
  const v = ((e[1] * x + e[5] * y + e[9] * z + e[13]) / w) * 0.5 + 0.5;
  return Math.min(u, 1 - u, v, 1 - v);
}

/** Smallest margin over the footprint's points. */
function footprintMargin(clip: Matrix4, points: Float32Array, count: number): number {
  let low = Infinity;
  for (let i = 0; i < count; i++) {
    const m = uvMargin(clip, points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
    if (m < low) low = m;
    if (low < 0) return low;
  }
  return low;
}

/** True when any footprint point lands in a hand box of that frame. */
function touchesHands(entry: BankEntry, points: Float32Array, count: number): boolean {
  const e = entry.toClip.elements;
  const box = entry.hands;
  for (let i = 0; i < count; i++) {
    const x = points[i * 3];
    const y = points[i * 3 + 1];
    const z = points[i * 3 + 2];
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (w <= 1e-4) continue;
    const u = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w) * 0.5 + 0.5;
    const v = ((e[1] * x + e[5] * y + e[9] * z + e[13]) / w) * 0.5 + 0.5;
    for (let h = 0; h < 2; h++) {
      const o = h * 4;
      if (box[o] <= box[o + 2] && u >= box[o] && u <= box[o + 2] && v >= box[o + 1] && v <= box[o + 3]) return true;
    }
  }
  return false;
}

function logTrack(track: MediaStreamTrack): void {
  const settings = track.getSettings() as MediaTrackSettings & { resizeMode?: string };
  const fps = settings.frameRate ? settings.frameRate.toFixed(0) : '?';
  console.info(`[jonze] camera "${track.label}" ${settings.width}x${settings.height}@${fps} resize=${settings.resizeMode ?? '?'}`);
  try {
    const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
    console.debug('[jonze] camera settings', JSON.stringify(settings), JSON.stringify(caps));
  } catch {
    // Some browsers throw on getCapabilities for camera tracks; the log is only a hint.
  }
}

/** OpenGL projection from pixel intrinsics. x right, y up, camera looking down -Z. */
function writeProjection(target: Matrix4, fx: number, fy: number, cx: number, cy: number, width: number, height: number): void {
  const near = 0.05;
  const far = 40;
  const x = (2 * fx) / width;
  const y = (2 * fy) / height;
  const a = 1 - (2 * cx) / width;
  const b = (2 * cy) / height - 1;
  const c = -(far + near) / (far - near);
  const d = -(2 * far * near) / (far - near);
  target.set(x, 0, a, 0, 0, y, b, 0, 0, 0, c, d, 0, 0, -1, 0);
}
