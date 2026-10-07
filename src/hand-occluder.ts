import { InstancedMesh, Matrix4, MeshBasicMaterial, Object3D, SphereGeometry, Vector3 } from '@iwsdk/core';

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
/** Spheres up the forearm, metres from the wrist. A stretched wall must not paint over the arm. */
const FOREARM = [0.08, 0.16, 0.24] as const;
const FOREARM_RADIUS = 0.035;
const WRIST = 0;
const MIDDLE_METACARPAL = 10;
const PER_HAND = JOINT_COUNT + BONES.length + FOREARM.length;
const HANDS = 2;

type Side = 'left' | 'right';
const SIDES: readonly Side[] = ['left', 'right'];

interface FramePoses extends XRFrame {
  fillPoses?: (spaces: XRSpace[], baseSpace: XRSpace, transforms: Float32Array) => boolean;
}

/**
 * Depth-only spheres on the hand joints and forearms. Drawn before the room mesh so the real
 * hands and arms show through the virtual room. The same joints box the hands in camera frames.
 */
export class HandOccluder {
  /** Packed xyz of every tracked joint, world space. `jointCount` is how many are valid. */
  readonly points = new Float32Array(JOINT_COUNT * HANDS * 3);
  jointCount = 0;
  /** Where each hand's joints sit in `points`. A count of 0 means that hand isn't tracked. */
  leftStart = 0;
  leftCount = 0;
  rightStart = 0;
  rightCount = 0;
  /** Sphere scale. Raised while pulling to cover tracking and passthrough lag at the hand's edges. */
  inflate = 1;
  readonly indexTip = { left: new Vector3(), right: new Vector3() };
  readonly thumbTip = { left: new Vector3(), right: new Vector3() };
  readonly hasPinch = { left: false, right: false };

  private readonly mesh: InstancedMesh;
  private readonly dummy = new Object3D();
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
  }

  setActive(on: boolean): void {
    this.mesh.visible = on;
    if (!on) {
      this.jointCount = 0;
      this.leftCount = 0;
      this.rightCount = 0;
      this.hasPinch.left = false;
      this.hasPinch.right = false;
    }
  }

  update(
    frame: XRFrame | null,
    ref: XRReferenceSpace | null,
    playerWorld: Matrix4,
    hands: Record<Side, XRHand | null>,
  ): void {
    this.jointCount = 0;
    this.leftCount = 0;
    this.rightCount = 0;
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
        this.hideRange(base, PER_HAND);
        continue;
      }
      const start = this.jointCount;
      this.writeHand(side, base, playerWorld);
      if (side === 'left') {
        this.leftStart = start;
        this.leftCount = JOINT_COUNT;
      } else {
        this.rightStart = start;
        this.rightCount = JOINT_COUNT;
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicMaterial).dispose();
    this.mesh.removeFromParent();
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

  private writeHand(side: Side, base: number, playerWorld: Matrix4): void {
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
      this.place(base + i, x, y, z, (i === 0 ? 0.02 : 0.013) * this.inflate);
    }
    this.thumbTip[side].set(this.local[4 * 3], this.local[4 * 3 + 1], this.local[4 * 3 + 2]);
    this.indexTip[side].set(this.local[9 * 3], this.local[9 * 3 + 1], this.local[9 * 3 + 2]);
    this.hasPinch[side] = true;
    for (let i = 0; i < BONES.length; i++) {
      const [a, b] = BONES[i];
      const ax = this.local[a * 3];
      const ay = this.local[a * 3 + 1];
      const az = this.local[a * 3 + 2];
      this.place(
        base + JOINT_COUNT + i,
        (ax + this.local[b * 3]) * 0.5,
        (ay + this.local[b * 3 + 1]) * 0.5,
        (az + this.local[b * 3 + 2]) * 0.5,
        0.012 * this.inflate,
      );
    }
    this.writeForearm(base + JOINT_COUNT + BONES.length);
  }

  /** Up the arm from the wrist, away from the knuckles. Needs no joint orientation. */
  private writeForearm(base: number): void {
    const w = WRIST * 3;
    const m = MIDDLE_METACARPAL * 3;
    let dx = this.local[w] - this.local[m];
    let dy = this.local[w + 1] - this.local[m + 1];
    let dz = this.local[w + 2] - this.local[m + 2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) {
      this.hideRange(base, FOREARM.length);
      return;
    }
    dx /= len;
    dy /= len;
    dz /= len;
    for (let i = 0; i < FOREARM.length; i++) {
      const d = FOREARM[i];
      this.place(
        base + i,
        this.local[w] + dx * d,
        this.local[w + 1] + dy * d,
        this.local[w + 2] + dz * d,
        FOREARM_RADIUS * this.inflate,
      );
    }
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
