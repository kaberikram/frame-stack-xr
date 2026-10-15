/**
 * Rooms' camera: turns the shot list into a pose at any song second. A pose orbits a target
 * (azimuth, elevation, distance, field of view), so a fly between two shots interpolates those
 * and swoops around the stack instead of cutting straight through it. Every vector is allocated
 * up front; `evaluate` allocates nothing.
 */
import { Vector3 } from '@iwsdk/core';
import { BOXES, FRONT_FILL, FRONT_FOV, ISO, boxHeight, type BoxSpec } from './rooms-layout.js';
import { SHOT_TIMES, shotAt, type SectionKind, type ShotState, type ShotView } from './rooms-score.js';

const DEG = Math.PI / 180;

export interface Pose {
  /** Root-local metres. */
  readonly target: Vector3;
  /** Radians from +z toward +x. */
  az: number;
  el: number;
  dist: number;
  /** Degrees, vertical. */
  fov: number;
}

export function createPose(): Pose {
  return { target: new Vector3(), az: 0, el: 0, dist: 10, fov: 24 };
}

const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

/** The front framing of a box held for `hold` seconds: 0 frames the glass front, 1 the video at the back. */
function frontFrame(hold: number, kind: SectionKind): number {
  if (kind === 'drop') return 0.45 + 0.4 * (1 - Math.exp(-hold / 0.18));
  // A slow push into the room for as long as it holds.
  return 0.12 + 0.55 * (1 - Math.exp(-hold / 3.2));
}

export class RoomsCamera {
  /** 0..1: how much of the frame is one box's front view (the others dim). */
  focus = 0;
  /** The box the front view belongs to, or -1. */
  focusSlot = -1;
  readonly state: ShotState = { from: 0, to: 0, u: 1 };
  private readonly a = createPose();
  private readonly b = createPose();
  private readonly centres: Vector3[] = BOXES.map((box) => new Vector3(box.pos[0], box.pos[1], box.pos[2]));

  /** The pose at song second `s` on a screen of this aspect. `kick` shakes it a little on the drops. */
  evaluate(s: number, aspect: number, kick: number, out: Pose): Pose {
    const st = shotAt(s, this.state);
    const to = SHOT_TIMES[st.to];
    this.poseFor(to.view, Math.max(0, s - to.at), to.kind, aspect, this.b);
    if (st.from === st.to) {
      copyPose(this.b, out);
      this.focus = typeof to.view === 'number' ? 1 : 0;
      this.focusSlot = typeof to.view === 'number' ? to.view : -1;
    } else {
      const from = SHOT_TIMES[st.from];
      // The shot it leaves keeps drifting as it goes, so the start of the fly has no seam.
      this.poseFor(from.view, Math.max(0, s - from.at), from.kind, aspect, this.a);
      const u = easeInOut(st.u);
      blendPose(this.a, this.b, u, out);
      const fa = typeof from.view === 'number' ? 1 : 0;
      const fb = typeof to.view === 'number' ? 1 : 0;
      this.focus = fa + (fb - fa) * u;
      this.focusSlot = typeof to.view === 'number' && u > 0.5 ? to.view : typeof from.view === 'number' ? from.view : typeof to.view === 'number' ? to.view : -1;
    }
    if (to.kind === 'drop' && kick > 0) {
      out.az += 0.004 * kick * Math.sin(s * 53);
      out.el += 0.003 * kick * Math.sin(s * 61 + 1);
    }
    return out;
  }

  /** Where `out`'s eye sits, root-local. */
  static eye(pose: Pose, out: Vector3): Vector3 {
    const c = Math.cos(pose.el);
    return out.set(Math.sin(pose.az) * c, Math.sin(pose.el), Math.cos(pose.az) * c).multiplyScalar(pose.dist).add(pose.target);
  }

  private poseFor(view: ShotView, hold: number, kind: SectionKind, aspect: number, out: Pose): void {
    if (typeof view === 'number') {
      this.frontPose(BOXES[view] ?? BOXES[0], this.centres[view] ?? this.centres[0], hold, kind, aspect, out);
      return;
    }
    const p = ISO[view];
    out.target.set(p.target[0], p.target[1], p.target[2]);
    out.fov = p.fov;
    out.az = (p.az + p.spin * hold) * DEG;
    out.el = p.el * DEG;
    // A slow dolly in while held; a drop lands a little wide and punches in.
    let scale = Math.max(0.85, 1 - 0.008 * hold);
    if (kind === 'drop') scale *= 1 + 0.1 * Math.exp(-hold / 0.2);
    const t = Math.tan((p.fov * DEG) / 2);
    out.dist = Math.max((p.fitH * scale) / 2 / t, (p.fitW * scale) / 2 / (t * aspect));
  }

  private frontPose(box: BoxSpec, centre: Vector3, hold: number, kind: SectionKind, aspect: number, out: Pose): void {
    const h = boxHeight(box);
    const f = frontFrame(hold, kind);
    // The plane that fills the frame, from the glass front (+d/2) to the video at the back (-d/2).
    const plane = (0.5 - f) * box.d;
    const t = Math.tan((FRONT_FOV * DEG) / 2);
    const fill = Math.max(h / 2 / (FRONT_FILL * t), box.w / 2 / (FRONT_FILL * t * aspect));
    out.target.copy(centre);
    out.az = box.yaw * DEG;
    out.el = 1.5 * DEG;
    out.dist = fill + plane;
    out.fov = FRONT_FOV;
  }
}

function copyPose(src: Pose, out: Pose): void {
  out.target.copy(src.target);
  out.az = src.az;
  out.el = src.el;
  out.dist = src.dist;
  out.fov = src.fov;
}

function blendPose(a: Pose, b: Pose, u: number, out: Pose): void {
  out.target.lerpVectors(a.target, b.target, u);
  let daz = b.az - a.az;
  while (daz > Math.PI) daz -= 2 * Math.PI;
  while (daz < -Math.PI) daz += 2 * Math.PI;
  out.az = a.az + daz * u;
  out.el = a.el + (b.el - a.el) * u;
  out.dist = Math.exp(Math.log(a.dist) + (Math.log(b.dist) - Math.log(a.dist)) * u);
  out.fov = a.fov + (b.fov - a.fov) * u;
}

const local = new Vector3();
const dirL = new Vector3();

/**
 * Does the segment from `p0` to `p1` (root-local) pass through `box`, grown by `margin` metres?
 * Used to fade a box that stands between the camera and the one it is looking at.
 */
export function segmentHitsBox(p0: Vector3, p1: Vector3, box: BoxSpec, margin: number): boolean {
  const yaw = box.yaw * DEG;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // Into the box's frame: undo its yaw about its centre.
  local.set(p0.x - box.pos[0], p0.y - box.pos[1], p0.z - box.pos[2]);
  local.set(local.x * c - local.z * s, local.y, local.x * s + local.z * c);
  dirL.set(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
  dirL.set(dirL.x * c - dirL.z * s, dirL.y, dirL.x * s + dirL.z * c);
  slab.t0 = 0;
  slab.t1 = 1;
  return (
    clip(local.x, dirL.x, box.w / 2 + margin) &&
    clip(local.y, dirL.y, boxHeight(box) / 2 + margin) &&
    clip(local.z, dirL.z, box.d / 2 + margin)
  );
}

const slab = { t0: 0, t1: 1 };

/** Narrow the segment's [t0, t1] to one slab of the box; false once it is empty. */
function clip(o: number, d: number, half: number): boolean {
  if (Math.abs(d) < 1e-9) return o >= -half && o <= half;
  const a = (-half - o) / d;
  const b = (half - o) / d;
  slab.t0 = Math.max(slab.t0, Math.min(a, b));
  slab.t1 = Math.min(slab.t1, Math.max(a, b));
  return slab.t0 <= slab.t1;
}
