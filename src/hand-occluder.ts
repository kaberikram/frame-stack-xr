import { CapsuleGeometry, InstancedMesh, Matrix4, MeshBasicMaterial, Object3D, ShaderMaterial, SphereGeometry, Vector3, Vector4, type Material } from '@iwsdk/core';
import type { HandJoints } from './passthrough-photo.js';

const JOINTS = [
  'wrist',
  'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
  'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
  'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
  'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
  'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip',
] as const;

/** Pairs of joint indices. A sphere at the midpoint fills the gap between joints. */
const BONES: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8], [8, 9],
  [0, 10], [10, 11], [11, 12], [12, 13], [13, 14],
  [0, 15], [15, 16], [16, 17], [17, 18], [18, 19],
  [0, 20], [20, 21], [21, 22], [22, 23], [23, 24],
];

const JOINT_COUNT = JOINTS.length;
/** One capsule up each forearm, toward the elbow: one smooth edge where three spheres left a scalloped one. */
const FOREARM_RADIUS = 0.03;
const FOREARM_LENGTH = 0.24;
/** Capsule centre, metres up the arm from the wrist: it starts at the wrist and ends past 0.3 m. */
const FOREARM_CENTER = 0.15;
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 9;
const MIDDLE_TIP = 14;
const PINKY_TIP = 24;
/** Thumb and index distal and tip joints: the pinching fingertips, drawn without lag and a little larger. */
const PINCH_JOINTS = [3, 4, 8, 9] as const;
const PINCH_RADIUS = 0.017;
const PER_HAND = JOINT_COUNT + BONES.length;
const HANDS = 2;
/**
 * Joint frames kept per hand, about 0.2 s: enough to draw the occluders a little in the past, and
 * to look up where the hands were when a camera frame was exposed.
 */
const RING = 16;
/** A history lookup this much older than the oldest frame kept has no answer. */
const HISTORY_SLACK = 0.03;
/**
 * Where the depth cut may act: four segments fanned from the wrist to the thumb, index, middle and
 * pinky tips (they cover the palm and fingers, spread or not), and the forearm. Reach is from the
 * segment's axis.
 */
export const SEGMENTS_PER_HAND = 5;
export const SEGMENTS = SEGMENTS_PER_HAND * HANDS;
const HAND_REACH = 0.035;
const FOREARM_REACH = FOREARM_RADIUS + 0.02;
const FOREARM_GATE = 0.26;
/** Kind codes in segA.w for the shader. */
const KIND_HAND = 1;
const KIND_ARM = 2;
/**
 * A shoulder model for the elbow: below, beside and a little behind the head, upper arm and
 * forearm lengths of an average adult. The elbow bends down and outward.
 */
const SHOULDER_SIDE = 0.17;
const SHOULDER_DOWN = 0.22;
const SHOULDER_BACK = 0.05;
const UPPER_ARM = 0.29;
const FOREARM = 0.26;
const POLE_OUT = 0.6;
const UP = new Vector3(0, 1, 0);
const TIPS = [THUMB_TIP, INDEX_TIP, MIDDLE_TIP, PINKY_TIP] as const;
const ARM_SEGMENT = TIPS.length;

type Side = 'left' | 'right';
const SIDES: readonly Side[] = ['left', 'right'];

interface FramePoses extends XRFrame {
  fillPoses?: (spaces: XRSpace[], baseSpace: XRSpace, transforms: Float32Array) => boolean;
}

/**
 * Depth-only spheres on the hand joints and a capsule on each forearm. Drawn before the room mesh so
 * the real hands and arms show through the virtual room. The same joints box the hands in camera
 * frames. The occluders trail the tracked joints by `lag`: tracking predicts the hand for the
 * display time, while passthrough shows it a few frames late, and an occluder ahead of the real
 * hand opens a halo of unstretched room behind it.
 */
export class HandOccluder {
  /** Packed xyz of every tracked joint, world space. `jointCount` is how many are valid. */
  readonly points = new Float32Array(JOINT_COUNT * HANDS * 3);
  jointCount = 0;
  /**
   * Each hand's forearm for keeping it out of camera photos: wrist xyz then unit direction up the arm,
   * 6 floats per hand (left first). `armOk[0|1]` is 1 while that hand's arm is valid.
   */
  readonly arms = new Float32Array(6 * HANDS);
  readonly armOk = new Uint8Array(HANDS);
  /** Where each hand's joints sit in `points`. A count of 0 means that hand isn't tracked. */
  leftStart = 0;
  leftCount = 0;
  rightStart = 0;
  rightCount = 0;
  /** Seconds the occluders trail the tracked joints. Pinch and photo logic use the current joints. */
  lag = 0.03;
  /** Set by the system: that hand is holding a pinch, so its fingertips are drawn without lag. */
  readonly pinching = { left: false, right: false };
  /**
   * Where the depth cut may act, from the trailing joints, SEGMENTS_PER_HAND per hand: four hand
   * segments then the forearm. `segA[i]` is the start and the kind in w (0 off, 1 hand, 2 arm);
   * `segB[i]` the end and the reach in w.
   */
  readonly segA = Array.from({ length: SEGMENTS }, () => new Vector4());
  readonly segB = Array.from({ length: SEGMENTS }, () => new Vector4());
  readonly indexTip = { left: new Vector3(), right: new Vector3() };
  readonly thumbTip = { left: new Vector3(), right: new Vector3() };
  readonly hasPinch = { left: false, right: false };

  private readonly mesh: InstancedMesh;
  private readonly arm: InstancedMesh;
  private readonly dummy = new Object3D();
  private readonly dir = new Vector3();
  private readonly headPos = new Vector3();
  private readonly yawRight = new Vector3();
  private readonly yawBack = new Vector3();
  private readonly shoulder = new Vector3();
  private readonly toWrist = new Vector3();
  private readonly pole = new Vector3();
  private readonly ring = [new Float32Array(RING * JOINT_COUNT * 3), new Float32Array(RING * JOINT_COUNT * 3)];
  /** Per ring frame: wrist xyz, forearm direction xyz, 1 when the arm was valid. */
  private readonly ringArm = [new Float32Array(RING * 7), new Float32Array(RING * 7)];
  /** jointsAt() writes here: both hands as they were at one moment. */
  private readonly past: HandJoints = {
    points: new Float32Array(JOINT_COUNT * HANDS * 3), leftStart: 0, leftCount: 0, rightStart: 0, rightCount: 0,
    arms: new Float32Array(6 * HANDS), armOk: new Uint8Array(HANDS),
  };
  private readonly ringTime = [new Float64Array(RING), new Float64Array(RING)];
  private readonly ringHead = [-1, -1];
  private readonly ringCount = [0, 0];
  /** One hand's joints `lag` seconds ago, world space. */
  private readonly drawn = new Float32Array(JOINT_COUNT * 3);
  /** bracket()'s answer: ring indices around a time and the mix between them. */
  private older = 0;
  private newer = 0;
  private mixF = 0;
  private readonly poses = new Float32Array(JOINT_COUNT * 16);
  private readonly spaces: Record<Side, XRSpace[]> = { left: [], right: [] };
  private readonly handRef: Record<Side, XRHand | null> = { left: null, right: null };
  private readonly local = new Float32Array(JOINT_COUNT * 3);

  /** `debug` draws the occluders 30% green instead of invisible, for `?occ=debug`. */
  constructor(parent: Object3D, debug = false) {
    const mat: Material = debug ? debugMaterial() : new MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: true });
    this.mesh = new InstancedMesh(new SphereGeometry(1, 6, 5), mat, PER_HAND * HANDS);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 0;
    this.mesh.visible = false;
    this.mesh.count = PER_HAND * HANDS;
    this.dummy.scale.set(0, 0, 0);
    this.dummy.updateMatrix();
    for (let i = 0; i < PER_HAND * HANDS; i++) this.mesh.setMatrixAt(i, this.dummy.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
    parent.add(this.mesh);
    this.arm = new InstancedMesh(new CapsuleGeometry(FOREARM_RADIUS, FOREARM_LENGTH, 4, 10), mat, HANDS);
    this.arm.frustumCulled = false;
    this.arm.renderOrder = 0;
    this.arm.visible = false;
    for (let i = 0; i < HANDS; i++) this.arm.setMatrixAt(i, this.dummy.matrix);
    this.arm.instanceMatrix.needsUpdate = true;
    parent.add(this.arm);
  }

  setActive(on: boolean): void {
    this.mesh.visible = on;
    this.arm.visible = on;
    if (!on) {
      this.ringCount[0] = 0;
      this.ringCount[1] = 0;
      for (let i = 0; i < SEGMENTS; i++) this.segA[i].w = 0;
      this.jointCount = 0;
      this.leftCount = 0;
      this.rightCount = 0;
      this.hasPinch.left = false;
      this.hasPinch.right = false;
      this.armOk[0] = 0;
      this.armOk[1] = 0;
    }
  }

  update(
    frame: XRFrame | null,
    ref: XRReferenceSpace | null,
    playerWorld: Matrix4,
    hands: Record<Side, XRHand | null>,
    shownAt: number,
    head: Matrix4,
  ): void {
    this.jointCount = 0;
    this.leftCount = 0;
    this.rightCount = 0;
    this.armOk[0] = 0;
    this.armOk[1] = 0;
    if (!this.mesh.visible || !frame || !ref) {
      this.hasPinch.left = false;
      this.hasPinch.right = false;
      return;
    }
    this.headFrame(head);
    for (let s = 0; s < SIDES.length; s++) {
      const side = SIDES[s];
      const hand = hands[side];
      const base = s * PER_HAND;
      if (!hand || !this.fillJoints(frame, ref, side, hand)) {
        this.hasPinch[side] = false;
        this.ringCount[s] = 0;
        for (let i = 0; i < SEGMENTS_PER_HAND; i++) this.segA[s * SEGMENTS_PER_HAND + i].w = 0;
        this.hideRange(base, PER_HAND);
        this.hideArm(s);
        continue;
      }
      const start = this.jointCount;
      this.writeHand(side, base, playerWorld, shownAt);
      if (side === 'left') {
        this.leftStart = start;
        this.leftCount = JOINT_COUNT;
      } else {
        this.rightStart = start;
        this.rightCount = JOINT_COUNT;
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.arm.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.arm.geometry.dispose();
    (this.mesh.material as Material).dispose();
    this.mesh.removeFromParent();
    this.arm.removeFromParent();
  }

  private fillJoints(frame: XRFrame, ref: XRReferenceSpace, side: Side, hand: XRHand): boolean {
    const spaces = this.jointSpaces(side, hand);
    if (spaces.length !== JOINT_COUNT) return false;
    const posed = frame as FramePoses;
    if (posed.fillPoses?.(spaces, ref, this.poses)) return this.readTranslations();
    for (let i = 0; i < JOINT_COUNT; i++) {
      const pose = frame.getJointPose?.(spaces[i] as XRJointSpace, ref);
      if (!pose) return false;
      const p = pose.transform.position;
      const o = i * 16;
      this.poses[o + 12] = p.x;
      this.poses[o + 13] = p.y;
      this.poses[o + 14] = p.z;
    }
    return true;
  }

  private readTranslations(): boolean {
    for (let i = 0; i < JOINT_COUNT; i++) {
      const o = i * 16;
      if (this.poses[o + 15] === 0) return false;
    }
    return true;
  }

  private jointSpaces(side: Side, hand: XRHand): XRSpace[] {
    if (this.handRef[side] === hand && this.spaces[side].length === JOINT_COUNT) return this.spaces[side];
    const list: XRSpace[] = [];
    for (let i = 0; i < JOINTS.length; i++) {
      const space = hand.get(JOINTS[i]);
      if (!space) {
        this.spaces[side] = [];
        this.handRef[side] = null;
        return [];
      }
      list.push(space);
    }
    this.spaces[side] = list;
    this.handRef[side] = hand;
    return list;
  }

  /** `shownAt` is when these joints are for: the XR frame's display time, on the page clock. */
  private writeHand(side: Side, base: number, playerWorld: Matrix4, shownAt: number): void {
    const e = playerWorld.elements;
    for (let i = 0; i < JOINT_COUNT; i++) {
      const px = this.poses[i * 16 + 12];
      const py = this.poses[i * 16 + 13];
      const pz = this.poses[i * 16 + 14];
      const x = e[0] * px + e[4] * py + e[8] * pz + e[12];
      const y = e[1] * px + e[5] * py + e[9] * pz + e[13];
      const z = e[2] * px + e[6] * py + e[10] * pz + e[14];
      this.local[i * 3] = x;
      this.local[i * 3 + 1] = y;
      this.local[i * 3 + 2] = z;
      const n = this.jointCount++;
      this.points[n * 3] = x;
      this.points[n * 3 + 1] = y;
      this.points[n * 3 + 2] = z;
    }
    this.thumbTip[side].set(this.local[THUMB_TIP * 3], this.local[THUMB_TIP * 3 + 1], this.local[THUMB_TIP * 3 + 2]);
    this.indexTip[side].set(this.local[INDEX_TIP * 3], this.local[INDEX_TIP * 3 + 1], this.local[INDEX_TIP * 3 + 2]);
    this.hasPinch[side] = true;
    const h = side === 'left' ? 0 : 1;
    this.armOk[h] = this.forearm(this.local, h, this.dir) ? 1 : 0;
    if (this.armOk[h]) {
      const o = h * 6;
      this.arms[o] = this.local[WRIST * 3];
      this.arms[o + 1] = this.local[WRIST * 3 + 1];
      this.arms[o + 2] = this.local[WRIST * 3 + 2];
      this.arms[o + 3] = this.dir.x;
      this.arms[o + 4] = this.dir.y;
      this.arms[o + 5] = this.dir.z;
    }

    this.record(h, shownAt);
    const d = this.drawn;
    const pinching = this.pinching[side];
    // A pinching hand's fingertips hold the sheet: tracking is right there, so no lag.
    if (pinching) {
      for (let i = 0; i < PINCH_JOINTS.length; i++) {
        const j = PINCH_JOINTS[i] * 3;
        d[j] = this.local[j];
        d[j + 1] = this.local[j + 1];
        d[j + 2] = this.local[j + 2];
      }
    }
    for (let i = 0; i < JOINT_COUNT; i++) {
      const radius = i === WRIST ? 0.02 : pinching && isPinchJoint(i) ? PINCH_RADIUS : 0.013;
      this.place(base + i, d[i * 3], d[i * 3 + 1], d[i * 3 + 2], radius);
    }
    for (let i = 0; i < BONES.length; i++) {
      const [a, b] = BONES[i];
      this.place(
        base + JOINT_COUNT + i,
        (d[a * 3] + d[b * 3]) * 0.5,
        (d[a * 3 + 1] + d[b * 3 + 1]) * 0.5,
        (d[a * 3 + 2] + d[b * 3 + 2]) * 0.5,
        0.012,
      );
    }
    const w = WRIST * 3;
    const s0 = h * SEGMENTS_PER_HAND;
    for (let i = 0; i < TIPS.length; i++) {
      const t = TIPS[i] * 3;
      this.segA[s0 + i].set(d[w], d[w + 1], d[w + 2], KIND_HAND);
      this.segB[s0 + i].set(d[t], d[t + 1], d[t + 2], HAND_REACH);
    }
    const arm = this.segA[s0 + ARM_SEGMENT];
    if (!this.forearm(d, h, this.dir)) {
      arm.w = 0;
      this.hideArm(h);
      return;
    }
    arm.set(d[w], d[w + 1], d[w + 2], KIND_ARM);
    this.segB[s0 + ARM_SEGMENT].set(
      d[w] + this.dir.x * FOREARM_GATE,
      d[w + 1] + this.dir.y * FOREARM_GATE,
      d[w + 2] + this.dir.z * FOREARM_GATE,
      FOREARM_REACH,
    );
    this.dummy.position.set(
      d[w] + this.dir.x * FOREARM_CENTER,
      d[w + 1] + this.dir.y * FOREARM_CENTER,
      d[w + 2] + this.dir.z * FOREARM_CENTER,
    );
    this.dummy.quaternion.setFromUnitVectors(UP, this.dir);
    this.dummy.scale.set(1, 1, 1);
    this.dummy.updateMatrix();
    this.arm.setMatrixAt(h, this.dummy.matrix);
    this.dummy.quaternion.identity();
  }

  /** The head's position and its level right and back directions, for the shoulder model. */
  private headFrame(head: Matrix4): void {
    const e = head.elements;
    this.headPos.set(e[12], e[13], e[14]);
    this.yawRight.set(e[0], 0, e[2]);
    if (this.yawRight.lengthSq() < 1e-6) this.yawRight.set(1, 0, 0);
    this.yawRight.normalize();
    // Level back is level right turned 90 degrees about up: (x, z) -> (-z, x).
    this.yawBack.set(-this.yawRight.z, 0, this.yawRight.x);
  }

  /**
   * Unit direction from the wrist toward the elbow, into `out`. The elbow comes from two-bone IK
   * between a modelled shoulder and the tracked wrist, bending down and outward, so a bent wrist
   * no longer turns the forearm with the hand.
   */
  private forearm(joints: Float32Array, h: number, out: Vector3): boolean {
    const side = h === 0 ? -1 : 1;
    const shoulder = this.shoulder
      .copy(this.headPos)
      .addScaledVector(this.yawRight, side * SHOULDER_SIDE)
      .addScaledVector(this.yawBack, SHOULDER_BACK);
    shoulder.y -= SHOULDER_DOWN;
    const w = WRIST * 3;
    const u = this.toWrist.set(joints[w] - shoulder.x, joints[w + 1] - shoulder.y, joints[w + 2] - shoulder.z);
    const reach = u.length();
    if (reach < 1e-4) return false;
    u.multiplyScalar(1 / reach);
    const d = Math.min(UPPER_ARM + FOREARM - 1e-3, Math.max(Math.abs(UPPER_ARM - FOREARM) + 1e-3, reach));
    const cosA = (UPPER_ARM * UPPER_ARM + d * d - FOREARM * FOREARM) / (2 * UPPER_ARM * d);
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    const pole = this.pole.set(0, -1, 0).addScaledVector(this.yawRight, side * POLE_OUT);
    pole.addScaledVector(u, -pole.dot(u));
    if (pole.lengthSq() < 1e-8) pole.copy(this.yawBack).addScaledVector(u, -this.yawBack.dot(u));
    pole.normalize();
    // Elbow = shoulder + u*L1*cosA + pole*L1*sinA; the forearm points from the wrist to it.
    out.copy(shoulder).addScaledVector(u, UPPER_ARM * cosA).addScaledVector(pole, UPPER_ARM * sinA);
    out.set(out.x - joints[w], out.y - joints[w + 1], out.z - joints[w + 2]);
    const len = out.length();
    if (len < 1e-4) return false;
    out.multiplyScalar(1 / len);
    return true;
  }

  /** Pushes this frame's joints for hand `h` and leaves the joints `lag` ago in `drawn`. */
  private record(h: number, at: number): void {
    const ring = this.ring[h];
    const times = this.ringTime[h];
    // Display times only move forward; a repeated one (a dropped frame) replaces nothing.
    if (this.ringCount[h] > 0 && at <= times[this.ringHead[h]]) at = times[this.ringHead[h]] + 1e-4;
    const head = (this.ringHead[h] + 1) % RING;
    this.ringHead[h] = head;
    this.ringCount[h] = Math.min(RING, this.ringCount[h] + 1);
    ring.set(this.local, head * JOINT_COUNT * 3);
    const arm = this.ringArm[h];
    const o = head * 7;
    const okArm = this.armOk[h] === 1;
    for (let i = 0; i < 6; i++) arm[o + i] = okArm ? this.arms[h * 6 + i] : 0;
    arm[o + 6] = okArm ? 1 : 0;
    times[head] = at;
    this.bracket(h, at - this.lag);
    const a = this.older * JOINT_COUNT * 3;
    const b = this.newer * JOINT_COUNT * 3;
    const f = this.mixF;
    for (let i = 0; i < JOINT_COUNT * 3; i++) this.drawn[i] = ring[a + i] + (ring[b + i] - ring[a + i]) * f;
  }

  /**
   * Finds the two ring frames of hand `h` around `time` into older/newer/mixF. Past the oldest frame,
   * both are the oldest; past the newest, both are the newest. False when the hand has no frames.
   */
  private bracket(h: number, time: number): boolean {
    const n = this.ringCount[h];
    if (n === 0) return false;
    const times = this.ringTime[h];
    const head = this.ringHead[h];
    let newer = head;
    let older = head;
    let f = 0;
    for (let i = 0; i < n; i++) {
      const idx = (head - i + RING) % RING;
      older = idx;
      if (times[idx] <= time) {
        const span = times[newer] - times[idx];
        f = span > 1e-6 ? (time - times[idx]) / span : 0;
        break;
      }
      newer = idx;
    }
    // Ring younger than the time: `older` is the oldest frame and `f` stays 0.
    this.older = older;
    this.newer = older === head ? head : newer;
    this.mixF = Math.min(1, Math.max(0, f));
    return true;
  }

  /**
   * Both hands as they were at `time` (page-clock seconds), from the ring: the joints and forearms to
   * cut out of a camera frame exposed then. Null when no tracked hand has history that far back; a
   * hand missing at that time is left out. Reuses one object.
   */
  jointsAt(time: number): HandJoints | null {
    const out = this.past;
    out.leftCount = 0;
    out.rightCount = 0;
    out.armOk[0] = 0;
    out.armOk[1] = 0;
    let n = 0;
    let any = false;
    for (let h = 0; h < HANDS; h++) {
      if (!this.bracket(h, time)) continue;
      const times = this.ringTime[h];
      const oldest = (this.ringHead[h] - this.ringCount[h] + 1 + RING) % RING;
      if (time < times[oldest] - HISTORY_SLACK) continue;
      const ring = this.ring[h];
      const a = this.older * JOINT_COUNT * 3;
      const b = this.newer * JOINT_COUNT * 3;
      const f = this.mixF;
      const start = n;
      for (let i = 0; i < JOINT_COUNT * 3; i++) out.points[n * 3 + i] = ring[a + i] + (ring[b + i] - ring[a + i]) * f;
      n += JOINT_COUNT;
      if (h === 0) {
        out.leftStart = start;
        out.leftCount = JOINT_COUNT;
      } else {
        out.rightStart = start;
        out.rightCount = JOINT_COUNT;
      }
      const arm = this.ringArm[h];
      const oa = this.older * 7;
      const ob = this.newer * 7;
      if (arm[oa + 6] > 0 && arm[ob + 6] > 0) {
        for (let i = 0; i < 6; i++) out.arms[h * 6 + i] = arm[oa + i] + (arm[ob + i] - arm[oa + i]) * f;
        out.armOk[h] = 1;
      }
      any = true;
    }
    return any ? out : null;
  }

  private hideArm(h: number): void {
    this.dummy.scale.set(0, 0, 0);
    this.dummy.updateMatrix();
    this.arm.setMatrixAt(h, this.dummy.matrix);
  }

  private place(index: number, x: number, y: number, z: number, radius: number): void {
    this.dummy.position.set(x, y, z);
    this.dummy.scale.set(radius, radius, radius);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(index, this.dummy.matrix);
  }

  private hideRange(start: number, count: number): void {
    this.dummy.scale.set(0, 0, 0);
    this.dummy.updateMatrix();
    for (let i = 0; i < count; i++) this.mesh.setMatrixAt(start + i, this.dummy.matrix);
  }
}

function isPinchJoint(i: number): boolean {
  return i === 3 || i === 4 || i === 8 || i === 9;
}

/**
 * The occluders made visible: depth-writing and opaque to three, so they still cut the room, but
 * writing premultiplied 30% green, so passthrough shows through them.
 */
function debugMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: /* glsl */ `
      void main() {
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      void main() {
        gl_FragColor = vec4(0.0, 0.3, 0.0, 0.3);
      }`,
    depthWrite: true,
    depthTest: true,
    transparent: false,
  });
}
