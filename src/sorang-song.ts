/**
 * Sorang's song timing: which moment of the timeline plays at each second of the song. One slow
 * arc, always forward: the painting takes on depth, slices, shows its photos, bursts once on the
 * first drop, drifts, and fades out with the song. Pure: no audio and no three.js, so any moment
 * of the song can be rendered directly.
 */

/**
 * Song seconds → timeline T (read with the stage windows in `sorang-timeline.ts`). Between keys
 * T follows a monotone cubic, so it never runs backwards and its speed never jumps: the motion
 * flows from one stage into the next. `scripts/sorang/song_map.py` prints a song's sections for
 * re-timing these.
 */
export const SONG_MAP: ReadonlyArray<readonly [number, number]> = [
  [0, 3], // the painting is already held when the song starts
  [3.2, 3], // the first swell: the bright paint starts to push out
  [12, 6], // full relief as the opening swell passes
  [14, 6.5], // it settles onto the 100 sheets
  [31.5, 11], // the quiet verse: the scan reveals the photos, sheet by sheet
  [44.98, 15], // the build: the sheets fan toward you, into the drop
  [48.5, 18], // the first drop: the burst
  [58, 21], // the pieces ease into slow orbits, and stay there
];

/** From here the orbit clock runs: it only matters once the pieces drift. */
export const ORBIT_FROM = 44.98;
/** The song dies away over these seconds, and the pieces fade out with it. */
export const FADE_OUT: readonly [number, number] = [136, 152];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Fritsch–Carlson tangents: a cubic through every key that never overshoots between them. */
function monotoneTangents(map: ReadonlyArray<readonly [number, number]>): Float64Array {
  const n = map.length;
  const slope = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) slope[i] = (map[i + 1][1] - map[i][1]) / (map[i + 1][0] - map[i][0]);
  const m = new Float64Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    const a = slope[i - 1];
    const b = slope[i];
    // Flat on either side, or turning: stop there. Otherwise a weighted harmonic mean.
    if (a * b <= 0) m[i] = 0;
    else {
      const ha = map[i][0] - map[i - 1][0];
      const hb = map[i + 1][0] - map[i][0];
      m[i] = (3 * (ha + hb)) / ((2 * hb + ha) / a + (hb + 2 * ha) / b);
    }
  }
  // The ends hold still: the first key is the held painting, the last the steady orbit.
  m[0] = 0;
  m[n - 1] = 0;
  return m;
}

const TANGENTS = monotoneTangents(SONG_MAP);

/** Timeline T at song second `s`. Before the first key or after the last it holds. */
export function songT(s: number): number {
  const map = SONG_MAP;
  if (s <= map[0][0]) return map[0][1];
  for (let i = 1; i < map.length; i++) {
    const s1 = map[i][0];
    if (s < s1) {
      const s0 = map[i - 1][0];
      const t0 = map[i - 1][1];
      const t1 = map[i][1];
      const h = s1 - s0;
      const u = (s - s0) / h;
      const u2 = u * u;
      const u3 = u2 * u;
      return (
        (2 * u3 - 3 * u2 + 1) * t0 + (u3 - 2 * u2 + u) * h * TANGENTS[i - 1] + (-2 * u3 + 3 * u2) * t1 + (u3 - u2) * h * TANGENTS[i]
      );
    }
  }
  return map[map.length - 1][1];
}

/** 0 while the song plays on, rising to 1 as it dies away: everything fades out with it. */
export function fadeOutAt(s: number): number {
  const u = clamp01((s - FADE_OUT[0]) / (FADE_OUT[1] - FADE_OUT[0]));
  return u * u * (3 - 2 * u);
}
