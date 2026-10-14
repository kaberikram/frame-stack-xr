/** Rooms' files: the song, and one looping clip per box. */

const BASE = import.meta.env.BASE_URL;
/** The soundtrack. Its timing lives in `rooms-score.ts`. */
export const MUSIC_URL = `${BASE}rooms/music.mp3`;

/** `01.mp4` for slot 0: the file a box looks for. */
export function videoName(slot: number): string {
  return `${String(slot + 1).padStart(2, '0')}.mp4`;
}

/** Where slot `slot`'s clip lives. `scripts/rooms/prep_clips.sh` writes these. */
export function videoUrl(slot: number): string {
  return `${BASE}rooms/videos/${videoName(slot)}`;
}
