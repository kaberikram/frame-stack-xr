/**
 * Rooms' composition: the frame (a grid floor and two grid walls), the five rooms
 * floating inside it (each a stack of its clip's frames), and the overview camera presets. Pure
 * data in root-local metres: +y up, the floor centred on the origin, every stack's first frame
 * facing roughly +z with time running away from it.
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
  /** Frame width, metres. */
  w: number;
  /** Frame width over height: its clip's own shape, so the frames show it uncropped. */
  aspect: number;
  /** The stack's length along its time axis, first frame to last, metres. */
  d: number;
  /** Where the front faces, degrees from +z toward +x. */
  yaw: number;
  /** The test card's tint, linear RGB, for a room without its clip. */
  tint: readonly [number, number, number];
  /** Rank from the top of the stack: rooms appear and leave in this order. */
  order: number;
}

/** Frame height, metres. */
export const boxHeight = (box: BoxSpec): number => box.w / box.aspect;

const PINK = [1, 0.62, 0.78] as const;
const LILAC = [0.78, 0.68, 1] as const;
const ICE = [0.7, 0.85, 1] as const;
const WARM = [1, 0.75, 0.6] as const;
const VIOLET = [0.9, 0.5, 1] as const;

/** One room per clip, each the shape of its clip (`scripts/rooms/prep_clips.sh --keep-aspect`). */
export const BOXES: readonly BoxSpec[] = [
  { slot: 0, name: 'car park', pos: at(-2.2, 6.05, 0.4), w: 4.0, aspect: 16 / 9, d: 3.3, yaw: 10, tint: LILAC, order: 1 },
  { slot: 1, name: 'hallway', pos: at(2.4, 5.0, -0.9), w: 3.0, aspect: 448 / 352, d: 2.8, yaw: 18, tint: WARM, order: 2 },
  { slot: 2, name: 'dark room', pos: at(-1.8, 2.9, 1.1), w: 2.9, aspect: 592 / 480, d: 2.7, yaw: 12, tint: PINK, order: 3 },
  { slot: 3, name: 'rooftop', pos: at(0.8, 8.6, -0.6), w: 3.8, aspect: 16 / 9, d: 3.2, yaw: 14, tint: ICE, order: 0 },
  { slot: 4, name: 'train', pos: at(2.2, 1.5, 1.3), w: 3.1, aspect: 576 / 480, d: 2.8, yaw: 16, tint: VIOLET, order: 4 },
];

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
  mid: { target: [0, 4.7, 0], az: 42, el: 16, fitH: 10.5, fitW: 9, fov: 24, spin: 1.2 },
  high: { target: [0, 7.0, 0], az: 36, el: 10, fitH: 6.5, fitW: 7.5, fov: 26, spin: -1.2 },
  low: { target: [0, 2.4, 0], az: 54, el: 24, fitH: 6.5, fitW: 7.5, fov: 26, spin: 1.2 },
  side: { target: [0, 4.7, 0], az: 72, el: 8, fitH: 11, fitW: 10, fov: 24, spin: -1.5 },
  orbit: { target: [0, 4.7, 0], az: 30, el: 15, fitH: 11.5, fitW: 10, fov: 24, spin: 5 },
  pull: { target: [0, 8, 0], az: 45, el: 30, fitH: 30, fitW: 22, fov: 24, spin: 0.6 },
};

/** Field of view for a close-up of one room, degrees. */
export const ROOM_FOV = 30;
