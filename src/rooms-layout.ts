/**
 * Rooms' composition: the frame (a grid floor, two grid walls and a vault arch), the glass boxes
 * stacked inside it, the fog cubes, and the overview camera presets. Pure data in root-local
 * metres: +y up, the floor centred on the origin, every box's front facing roughly +z.
 *
 * Positions are written as `at(u, y, v)`: `u` runs left to right and `v` toward the viewer as
 * seen from the default overview (looking at the walls' corner from 45°), so the stack can be
 * read off the reference picture.
 */

/** Floor side, metres. The walls stand on its two far edges. */
export const FLOOR = 10;
export const WALL = 10;
/** Grid cells along each floor edge and up each wall. */
export const CELLS = 12;
/** The floor slab's thickness, drawn as its outline. */
export const SLAB = 0.35;

const R2 = Math.SQRT1_2;
/** Screen-aligned (u right, v toward the viewer) to root-local x/z, for the 45° overview. */
const at = (u: number, y: number, v: number): readonly [number, number, number] => [(u + v) * R2, y, (v - u) * R2];

export interface BoxSpec {
  /** Video slot: `public/rooms/videos/NN.mp4` with NN = slot + 1. */
  slot: number;
  name: string;
  /** Centre, root-local metres. */
  pos: readonly [number, number, number];
  /** Front width, metres; the front is 16:9 for landscape clips. */
  w: number;
  /** Depth front to back, metres. */
  d: number;
  /** Where the front faces, degrees from +z toward +x. */
  yaw: number;
  /** Glass tint, linear RGB. */
  tint: readonly [number, number, number];
  /** Rank from the top of the stack: boxes and fog cubes appear and leave in this order. */
  order: number;
}

/** Front height from width: the boxes frame landscape 16:9 video. */
export const ASPECT = 16 / 9;

const PINK = [1, 0.62, 0.78] as const;
const LILAC = [0.78, 0.68, 1] as const;
const ICE = [0.7, 0.85, 1] as const;
const WARM = [1, 0.75, 0.6] as const;
const VIOLET = [0.9, 0.5, 1] as const;

export const BOXES: readonly BoxSpec[] = [
  { slot: 0, name: 'bedroom', pos: at(0.5, 8.1, -0.6), w: 2.2, d: 1.6, yaw: 14, tint: LILAC, order: 1 },
  { slot: 1, name: 'living room', pos: at(-1.5, 6.7, 0.3), w: 3.0, d: 2.1, yaw: 10, tint: PINK, order: 2 },
  { slot: 2, name: 'bunk room', pos: at(2.1, 5.5, -0.9), w: 2.4, d: 1.8, yaw: 18, tint: ICE, order: 4 },
  { slot: 3, name: 'kitchen', pos: at(-3.0, 4.4, 0.7), w: 2.7, d: 2.0, yaw: 8, tint: WARM, order: 5 },
  { slot: 4, name: 'office', pos: at(3.4, 3.8, 0.4), w: 2.4, d: 1.8, yaw: 20, tint: WARM, order: 7 },
  { slot: 5, name: 'gallery', pos: at(-0.5, 2.9, 1.4), w: 2.4, d: 1.8, yaw: 12, tint: ICE, order: 8 },
  { slot: 6, name: 'lounge', pos: at(1.5, 2.2, -0.5), w: 2.8, d: 2.0, yaw: 16, tint: LILAC, order: 9 },
  { slot: 7, name: 'bathroom', pos: at(-3.5, 1.5, 0.1), w: 2.2, d: 1.6, yaw: 10, tint: ICE, order: 10 },
  { slot: 8, name: 'purple lounge', pos: at(2.6, 0.72, 2.0), w: 2.4, d: 1.8, yaw: 16, tint: VIOLET, order: 11 },
];

export interface FogSpec {
  pos: readonly [number, number, number];
  size: number;
  yaw: number;
  /** Linear RGB of the smoke. */
  color: readonly [number, number, number];
  order: number;
}

export const FOG: readonly FogSpec[] = [
  { pos: at(-2.7, 9.0, -1.6), size: 1.5, yaw: 12, color: [0.25, 0.75, 0.68], order: 0 },
  { pos: at(3.3, 6.9, -1.4), size: 1.4, yaw: 15, color: [0.6, 0.62, 0.66], order: 3 },
  { pos: at(-0.1, 4.6, -2.0), size: 1.5, yaw: 10, color: [0.35, 0.55, 1], order: 6 },
];

/** Every box and fog cube, for the reveal order. */
export const PIECES = BOXES.length + FOG.length;

export interface IsoPreset {
  /** What it looks at, root-local metres. */
  target: readonly [number, number, number];
  /** Degrees from +z toward +x; 45 looks straight at the walls' corner. */
  az: number;
  /** Degrees above the horizon. */
  el: number;
  /** Metres of the stack the frame holds top to bottom, and side to side on a tall screen. */
  fitH: number;
  fitW: number;
  fov: number;
  /** Degrees per second it turns while held. */
  spin: number;
}

export const ISO: Record<'rise' | 'wide' | 'mid' | 'high' | 'low' | 'side' | 'orbit' | 'pull', IsoPreset> = {
  rise: { target: [0, 10.5, 0], az: 45, el: 38, fitH: 10, fitW: 8, fov: 24, spin: 1.5 },
  wide: { target: [0, 7.4, 0], az: 45, el: 18, fitH: 19.5, fitW: 14, fov: 24, spin: 0.8 },
  mid: { target: [0, 5, 0], az: 42, el: 16, fitH: 11, fitW: 9, fov: 24, spin: 1.2 },
  high: { target: [0, 7.4, 0], az: 36, el: 10, fitH: 7.5, fitW: 7.5, fov: 26, spin: -1.2 },
  low: { target: [0, 2.4, 0], az: 54, el: 24, fitH: 7.5, fitW: 7.5, fov: 26, spin: 1.2 },
  side: { target: [0, 5, 0], az: 72, el: 8, fitH: 12, fitW: 10, fov: 24, spin: -1.5 },
  orbit: { target: [0, 5, 0], az: 30, el: 15, fitH: 12.5, fitW: 10, fov: 24, spin: 5 },
  pull: { target: [0, 8, 0], az: 45, el: 30, fitH: 30, fitW: 22, fov: 24, spin: 0.6 },
};

/** Field of view for a box's front view, degrees. */
export const FRONT_FOV = 26;
/** Share of the frame the framed plane fills in a front view. */
export const FRONT_FILL = 0.92;
