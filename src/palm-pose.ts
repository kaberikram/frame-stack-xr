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
