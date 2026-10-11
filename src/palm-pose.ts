import { Vector3 } from '@iwsdk/core';

/**
 * An open palm read from WebXR hand joints (positions only, as HandOccluder packs them: 25 per hand,
 * wrist 0, then thumb, index, middle, ring and pinky, each metacarpal to tip).
 */
export interface PalmPose {
  /** The OpenXR palm point: halfway along the middle metacarpal, from its base to the knuckle. */
  readonly centre: Vector3;
  /** Out of the palm, away from the back of the hand. */
  readonly normal: Vector3;
  /** Wrist toward the middle knuckle. */
  readonly up: Vector3;
  /** Index, middle, ring and pinky: knuckle-to-tip distance over the length of the finger, 1 when straight. */
  readonly straight: Float32Array;
  /** Thumb tip to index tip, metres. */
  thumbGap: number;
}

const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 9;
const MIDDLE_BASE = 10;
const MIDDLE_KNUCKLE = 11;
/** The proximal joint (knuckle) of index, middle, ring and pinky; distal and tip follow it. */
const KNUCKLES = [6, 11, 16, 21] as const;

export function makePalmPose(): PalmPose {
  return {
    centre: new Vector3(),
    normal: new Vector3(0, 0, -1),
    up: new Vector3(0, 1, 0),
    straight: new Float32Array(4),
    thumbGap: 0,
  };
}

function gap(p: Float32Array, a: number, b: number): number {
  return Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
}

/**
 * Reads one hand's palm. `start` is the hand's first joint index in `points`. False when the joints
 * are degenerate (no palm to speak of), leaving `out` as it was.
 */
export function readPalm(points: Float32Array, start: number, right: boolean, out: PalmPose): boolean {
  const o = start * 3;
  const at = (j: number) => o + j * 3;
  const w = at(WRIST);
  const mb = at(MIDDLE_BASE);
  const mk = at(MIDDLE_KNUCKLE);
  const ik = at(KNUCKLES[0]);
  const pk = at(KNUCKLES[3]);
  const ux = points[mk] - points[w];
  const uy = points[mk + 1] - points[w + 1];
  const uz = points[mk + 2] - points[w + 2];
  const ax = points[pk] - points[ik];
  const ay = points[pk + 1] - points[ik + 1];
  const az = points[pk + 2] - points[ik + 2];
  // Up across the knuckles: right hand, palm away and fingers up, has its thumb on the left, so the
  // index-to-pinky line points right and up x right points away. A left hand mirrors it.
  const nx = uy * az - uz * ay;
  const ny = uz * ax - ux * az;
  const nz = ux * ay - uy * ax;
  const nl = Math.hypot(nx, ny, nz);
  const ul = Math.hypot(ux, uy, uz);
  if (nl < 1e-6 || ul < 1e-4) return false;
  const s = (right ? 1 : -1) / nl;
  out.normal.set(nx * s, ny * s, nz * s);
  out.up.set(ux / ul, uy / ul, uz / ul);
  out.centre.set(
    0.5 * (points[mb] + points[mk]),
    0.5 * (points[mb + 1] + points[mk + 1]),
    0.5 * (points[mb + 2] + points[mk + 2]),
  );
  for (let f = 0; f < 4; f++) {
    const k = at(KNUCKLES[f]);
    const chain = gap(points, k, k + 3) + gap(points, k + 3, k + 6) + gap(points, k + 6, k + 9);
    out.straight[f] = chain > 1e-4 ? gap(points, k, k + 9) / chain : 0;
  }
  out.thumbGap = gap(points, at(THUMB_TIP), at(INDEX_TIP));
  return true;
}

/** How many of the four fingers are at least `min` straight. */
export function countStraight(pose: PalmPose, min: number): number {
  let n = 0;
  for (let f = 0; f < 4; f++) if (pose.straight[f] >= min) n++;
  return n;
}

/** Index, middle, ring and pinky tips. */
const TIPS = [9, 14, 19, 24] as const;
/** Where a fist's thumb rests: across the index's middle or end bone, or the middle finger's middle bone. */
const THUMB_RESTS = [7, 8, 12] as const;

/** How closed a hand is beyond what `readPalm` measures: each fingertip's distance to the palm. */
export interface FistShape {
  /** The middle metacarpal, metres: the hand's own size, so the test fits any hand. */
  metacarpal: number;
  /** Index, middle, ring and pinky: tip to `PalmPose.centre`, in metacarpal lengths. */
  readonly tips: Float32Array;
  /** Thumb tip to the nearest place a fist's thumb rests (or the palm, tucked in), in metacarpal lengths. */
  thumb: number;
}

export function makeFistShape(): FistShape {
  return { metacarpal: 0, tips: new Float32Array(4), thumb: 0 };
}

/** Reads the fingertips against a palm `readPalm` has just read from the same joints. */
export function readFist(points: Float32Array, start: number, pose: PalmPose, out: FistShape): void {
  const o = start * 3;
  const base = o + MIDDLE_BASE * 3;
  const knuckle = o + MIDDLE_KNUCKLE * 3;
  const length = Math.max(1e-4, Math.hypot(points[knuckle] - points[base], points[knuckle + 1] - points[base + 1], points[knuckle + 2] - points[base + 2]));
  out.metacarpal = length;
  const c = pose.centre;
  for (let f = 0; f < 4; f++) {
    const t = o + TIPS[f] * 3;
    out.tips[f] = Math.hypot(points[t] - c.x, points[t + 1] - c.y, points[t + 2] - c.z) / length;
  }
  const th = o + THUMB_TIP * 3;
  let thumb = Math.hypot(points[th] - c.x, points[th + 1] - c.y, points[th + 2] - c.z);
  for (let r = 0; r < THUMB_RESTS.length; r++) {
    const q = o + THUMB_RESTS[r] * 3;
    thumb = Math.min(thumb, Math.hypot(points[th] - points[q], points[th + 1] - points[q + 1], points[th + 2] - points[q + 2]));
  }
  out.thumb = thumb / length;
}

/**
 * A fist: index and middle curled under `curl` with their tips within `tips` metacarpal lengths of
 * the palm, ring or pinky curled too, and the thumb within `thumb` of where a fist's thumb rests.
 * `straight` only sees bend past the knuckle, so the tips are what tell a fist from a point, a cup
 * or a pinch with the other fingers tucked; the thumb tells it from a thumbs-up.
 */
export function isFist(pose: PalmPose, shape: FistShape, curl: number, tips: number, thumb: number): boolean {
  const s = pose.straight;
  if (s[0] >= curl || s[1] >= curl || (s[2] >= curl && s[3] >= curl)) return false;
  return shape.tips[0] < tips && shape.tips[1] < tips && shape.thumb < thumb;
}
