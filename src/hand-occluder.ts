import { CapsuleGeometry, InstancedMesh, Matrix4, MeshBasicMaterial, Object3D, SphereGeometry, Vector3, Vector4 } from '@iwsdk/core';

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
/** One capsule up each forearm: one smooth edge where three spheres left a scalloped one. */
const FOREARM_RADIUS = 0.035;
const FOREARM_LENGTH = 0.24;
/** Capsule centre, metres up the arm from the wrist: it starts at the wrist and ends past 0.3 m. */
const FOREARM_CENTER = 0.15;
const WRIST = 0;
const MIDDLE_METACARPAL = 10;
const MIDDLE_TIP = 14;
const PER_HAND = JOINT_COUNT + BONES.length;
const HANDS = 2;
/** Joint frames kept per hand for drawing the occluders a little in the past. */
const RING = 8;
/** Where the depth cut may act around each hand: the hand itself, then the forearm. */
const HAND_REACH = 0.07;
const FOREARM_REACH = 0.06;
const FOREARM_GATE = 0.3;
const UP = new Vector3(0, 1, 0);

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
  /** Draw the forearm capsules. Off while headset depth cuts the real arm out instead. */
  capsules = true;
  /**
   * Where the depth cut may act, from the trailing joints: per hand a hand segment then a forearm
   * segment. `segA[i]` is the start and 1 in w while valid; `segB[i]` the end and the reach in w.
   */
  readonly segA = [new Vector4(), new Vector4(), new Vector4(), new Vector4()];
  readonly segB = [new Vector4(), new Vector4(), new Vector4(), new Vector4()];
  readonly indexTip = { left: new Vector3(), right: new Vector3() };
  readonly thumbTip = { left: new Vector3(), right: new Vector3() };
  readonly hasPinch = { left: false, right: false };

  private readonly mesh: InstancedMesh;
  private readonly arm: InstancedMesh;
  private readonly dummy = new Object3D();
  private readonly dir = new Vector3();
  private readonly ring = [new Float32Array(RING * JOINT_COUNT * 3), new Float32Array(RING * JOINT_COUNT * 3)];
  private readonly ringTime = [new Float64Array(RING), new Float64Array(RING)];
  private readonly ringHead = [-1, -1];
  private readonly ringCount = [0, 0];
  /** One hand's joints `lag` seconds ago, world space. */
  private readonly drawn = new Float32Array(JOINT_COUNT * 3);
  private readonly poses = new Float32Array(JOINT_COUNT * 16);
  private readonly spaces: Record<Side, XRSpace[]> = { left: [], right: [] };
  private readonly handRef: Record<Side, XRHand | null> = { left: null, right: null };
  private readonly local = new Float32Array(JOINT_COUNT * 3);

  constructor(parent: Object3D) {
    const mat = new MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: true });
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
      for (let i = 0; i < 4; i++) this.segA[i].w = 0;
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
    now: number,
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
    for (let s = 0; s < SIDES.length; s++) {
      const side = SIDES[s];
      const hand = hands[side];
      const base = s * PER_HAND;
      if (!hand || !this.fillJoints(frame, ref, side, hand)) {
        this.hasPinch[side] = false;
        this.ringCount[s] = 0;
        this.segA[s * 2].w = 0;
        this.segA[s * 2 + 1].w = 0;
        this.hideRange(base, PER_HAND);
        this.hideArm(s);
        continue;
      }
      const start = this.jointCount;
      this.writeHand(side, base, playerWorld, now);
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
    (this.mesh.material as MeshBasicMaterial).dispose();
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

  private writeHand(side: Side, base: number, playerWorld: Matrix4, now: number): void {
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
    this.thumbTip[side].set(this.local[4 * 3], this.local[4 * 3 + 1], this.local[4 * 3 + 2]);
    this.indexTip[side].set(this.local[9 * 3], this.local[9 * 3 + 1], this.local[9 * 3 + 2]);
    this.hasPinch[side] = true;
    const h = side === 'left' ? 0 : 1;
    this.armOk[h] = this.forearm(this.local, this.dir) ? 1 : 0;
    if (this.armOk[h]) {
      const o = h * 6;
      this.arms[o] = this.local[WRIST * 3];
      this.arms[o + 1] = this.local[WRIST * 3 + 1];
      this.arms[o + 2] = this.local[WRIST * 3 + 2];
      this.arms[o + 3] = this.dir.x;
      this.arms[o + 4] = this.dir.y;
      this.arms[o + 5] = this.dir.z;
    }

    this.record(h, now);
    const d = this.drawn;
    for (let i = 0; i < JOINT_COUNT; i++) {
      this.place(base + i, d[i * 3], d[i * 3 + 1], d[i * 3 + 2], i === 0 ? 0.02 : 0.013);
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
    const t = MIDDLE_TIP * 3;
    const hand = this.segA[h * 2];
    hand.set(d[w], d[w + 1], d[w + 2], 1);
    this.segB[h * 2].set(d[t], d[t + 1], d[t + 2], HAND_REACH);
    const arm = this.segA[h * 2 + 1];
    if (!this.forearm(d, this.dir)) {
      arm.w = 0;
      this.hideArm(h);
      return;
    }
    arm.set(d[w], d[w + 1], d[w + 2], 1);
    this.segB[h * 2 + 1].set(
      d[w] + this.dir.x * FOREARM_GATE,
      d[w + 1] + this.dir.y * FOREARM_GATE,
      d[w + 2] + this.dir.z * FOREARM_GATE,
      FOREARM_REACH,
    );
    if (!this.capsules) {
      this.hideArm(h);
      return;
    }
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

  /** Up the arm from the wrist, away from the knuckles, into `out`. Needs no joint orientation. */
  private forearm(joints: Float32Array, out: Vector3): boolean {
    const w = WRIST * 3;
    const m = MIDDLE_METACARPAL * 3;
    out.set(joints[w] - joints[m], joints[w + 1] - joints[m + 1], joints[w + 2] - joints[m + 2]);
    const len = out.length();
    if (len < 1e-4) return false;
    out.multiplyScalar(1 / len);
    return true;
  }

  /** Pushes this frame's joints for hand `h` and leaves the joints `lag` ago in `drawn`. */
  private record(h: number, now: number): void {
    const ring = this.ring[h];
    const times = this.ringTime[h];
    const head = (this.ringHead[h] + 1) % RING;
    this.ringHead[h] = head;
    this.ringCount[h] = Math.min(RING, this.ringCount[h] + 1);
    ring.set(this.local, head * JOINT_COUNT * 3);
    times[head] = now;
    const target = now - this.lag;
    const n = this.ringCount[h];
    let newer = head;
    let older = head;
    let f = 0;
    for (let i = 0; i < n; i++) {
      const idx = (head - i + RING) % RING;
      older = idx;
      if (times[idx] <= target) {
        const span = times[newer] - times[idx];
        f = span > 1e-6 ? (target - times[idx]) / span : 0;
        break;
      }
      newer = idx;
    }
    // Ring younger than the lag: `older` is the oldest frame and `f` stays 0.
    const a = older * JOINT_COUNT * 3;
    const b = newer * JOINT_COUNT * 3;
    for (let i = 0; i < JOINT_COUNT * 3; i++) this.drawn[i] = ring[a + i] + (ring[b + i] - ring[a + i]) * f;
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
