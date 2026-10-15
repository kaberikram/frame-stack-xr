/** Rooms' files: the song, and per room a looping clip and its baked frame stack. */

const BASE = import.meta.env.BASE_URL;
/** The soundtrack. Its timing lives in `rooms-score.ts`. */
export const MUSIC_URL = `${BASE}rooms/music.mp3`;

/** Frames in each room's stack, and how many sit across a row of its frame sheet. */
export const LAYERS = 48;
export const SHEET_COLS = 8;

/** `01.mp4` for slot 0: the file a room looks for. */
export function videoName(slot: number): string {
  return `${String(slot + 1).padStart(2, '0')}.mp4`;
}

/** Where slot `slot`'s clip lives. `scripts/rooms/prep_clips.sh` writes these. */
export function videoUrl(slot: number): string {
  return `${BASE}rooms/videos/${videoName(slot)}`;
}

/**
 * Slot `slot`'s frame sheet: LAYERS frames sampled evenly through the loop, SHEET_COLS across.
 * `scripts/rooms/bake_frames.sh` writes these beside the clips.
 */
export function framesUrl(slot: number): string {
  return `${BASE}rooms/videos/${String(slot + 1).padStart(2, '0')}-frames.jpg`;
}
