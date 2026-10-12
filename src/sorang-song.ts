/**
 * Sorang's song: the cues baked from the track by `scripts/sorang/bake_music.py`, and the map
 * that turns the song's time into the timeline's T. Pure: no audio and no three.js, so any
 * moment of the song can be rendered directly.
 */

/** Smoothed envelopes and onsets, as `music-cues.json` stores them once decoded. */
export interface MusicCues {
  duration: number;
  fps: number;
  bass: Uint8Array;
  high: Uint8Array;
  energy: Uint8Array;
  kickT: Float32Array;
  kickS: Float32Array;
  hitT: Float32Array;
  hitS: Float32Array;
}

/** What the music is doing at one moment, each 0..1. The system turns these into uniforms. */
export interface SongFeel {
  /** Decays from each kick. */
  kick: number;
  /** Decays from each broadband hit: the intro stabs, the build's snares. */
  hit: number;
  bass: number;
  high: number;
  energy: number;
  /** The long flare after each drop. */
  shock: number;
}

export function createFeel(): SongFeel {
  return { kick: 0, hit: 0, bass: 0, high: 0, energy: 0, shock: 0 };
}

/** The two drops the analysis found (the strongest kicks), with how hard each one throws. */
export const DROPS: ReadonlyArray<readonly [number, number]> = [
  [44.983, 0.55],
  [68.69, 1],
];
const KICK_TAU = 0.16;
const HIT_TAU = 0.12;
const SHOCK_TAU = 0.9;
/** Older onsets than this have decayed to nothing. */
const LOOKBACK = 0.8;

type Ease = 'lin' | 'in' | 'out' | 'inout';

/**
 * Song seconds → timeline T, with the easing of the segment that ends at each key. Read with the
 * stage windows in `sorang-timeline.ts`. Backward segments replay the same picture in reverse,
 * which is how the riser pulls the pieces back and the outro brings them home.
 */
export const SONG_MAP: ReadonlyArray<readonly [number, number, Ease]> = [
  [0, 3, 'lin'], // the painting is already held when the song starts
  [3.2, 3, 'lin'], // the first swell: the bright paint starts to push out
  [9, 6, 'out'], // the swell has passed: full relief
  [10.2, 6.5, 'lin'], // the hits at 9.8–10.2 snap it onto the 100 sheets
  [31.5, 11, 'lin'], // the quiet verse: the scan reveals the photos, sheet by sheet
  [42, 14.9, 'inout'], // the build: the sheets fan toward you
  [44.98, 15, 'lin'], // the breath before the drop: everything holds
  [47.5, 18, 'lin'], // drop 1: the burst
  [55, 21, 'out'], // into orbit
  [63.5, 21, 'lin'],
  [68.69, 15.4, 'in'], // the riser sucks the pieces back toward the painting
  [71.5, 21, 'out'], // drop 2: out again, harder
  [131.6, 21, 'lin'],
  [148, 3, 'inout'], // the outro: they come home and the painting is whole
];

/** From here the orbit clock runs: it only matters once the pieces drift. */
export const ORBIT_FROM = DROPS[0][0];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function ease(u: number, kind: Ease): number {
  switch (kind) {
    case 'in':
      return u * u * u;
    case 'out':
      return 1 - (1 - u) * (1 - u) * (1 - u);
    case 'inout':
      return u * u * (3 - 2 * u);
    default:
      return u;
  }
}

/** Timeline T at song second `s`. Before the first key or after the last it holds. */
export function songT(s: number): number {
  const map = SONG_MAP;
  if (s <= map[0][0]) return map[0][1];
  for (let i = 1; i < map.length; i++) {
    const s1 = map[i][0];
    if (s < s1) {
      const s0 = map[i - 1][0];
      const t0 = map[i - 1][1];
      return t0 + (map[i][1] - t0) * ease(clamp01((s - s0) / (s1 - s0)), map[i][2]);
    }
  }
  return map[map.length - 1][1];
}

/** -1 while T runs backwards at `s`, 1 while it runs forwards, 0 while it holds. */
export function songDirection(s: number): -1 | 0 | 1 {
  const map = SONG_MAP;
  for (let i = 1; i < map.length; i++) {
    if (s >= map[i - 1][0] && s < map[i][0]) {
      const d = map[i][1] - map[i - 1][1];
      return d > 0 ? 1 : d < 0 ? -1 : 0;
    }
  }
  return 0;
}

function bytes(b64: unknown, name: string): Uint8Array {
  if (typeof b64 !== 'string') throw new Error(`music cues: ${name} missing`);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function onsets(list: unknown, name: string): [Float32Array, Float32Array] {
  if (!Array.isArray(list)) throw new Error(`music cues: ${name} missing`);
  const t = new Float32Array(list.length);
  const s = new Float32Array(list.length);
  let last = -Infinity;
  for (let i = 0; i < list.length; i++) {
    const pair = list[i] as unknown;
    if (!Array.isArray(pair) || typeof pair[0] !== 'number' || typeof pair[1] !== 'number' || pair[0] < last) {
      throw new Error(`music cues: ${name}[${i}] malformed`);
    }
    last = pair[0];
    t[i] = pair[0];
    s[i] = pair[1];
  }
  return [t, s];
}

/** Checks and decodes `music-cues.json`. Throws on anything malformed. */
export function parseCues(json: unknown): MusicCues {
  const o = json as Record<string, unknown> | null;
  if (!o || o.version !== 1 || typeof o.duration !== 'number' || typeof o.fps !== 'number' || o.fps <= 0) {
    throw new Error('music cues: unknown format');
  }
  const [kickT, kickS] = onsets(o.kicks, 'kicks');
  const [hitT, hitS] = onsets(o.hits, 'hits');
  return {
    duration: o.duration,
    fps: o.fps,
    bass: bytes(o.bass, 'bass'),
    high: bytes(o.high, 'high'),
    energy: bytes(o.energy, 'energy'),
    kickT,
    kickS,
    hitT,
    hitS,
  };
}

function envelope(values: Uint8Array, fps: number, s: number): number {
  const n = values.length;
  if (!n) return 0;
  const x = s * fps;
  if (x <= 0) return values[0] / 255;
  if (x >= n - 1) return values[n - 1] / 255;
  const i = Math.floor(x);
  const f = x - i;
  return (values[i] * (1 - f) + values[i + 1] * f) / 255;
}

/** Index of the last onset at or before `s`, or -1. */
function lastAtOrBefore(times: Float32Array, s: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= s) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** The strongest recent onset, decayed. Weak onsets count for little, so only real hits show. */
function pulse(times: Float32Array, strengths: Float32Array, s: number, tau: number): number {
  let best = 0;
  for (let i = lastAtOrBefore(times, s); i >= 0; i--) {
    const age = s - times[i];
    if (age > LOOKBACK) break;
    const w = clamp01((strengths[i] - 0.2) / 0.7);
    const v = w * w * (3 - 2 * w) * Math.exp(-age / tau);
    if (v > best) best = v;
  }
  return best;
}

/** The music at song second `s`. Pure: the same `s` always gives the same feel. */
export function feelAt(cues: MusicCues | null, s: number, out: SongFeel): SongFeel {
  let shock = 0;
  // Indexed, not for-of: this runs every frame and an iterator is an allocation.
  for (let i = 0; i < DROPS.length; i++) {
    const t = DROPS[i][0];
    if (s >= t) shock = Math.max(shock, DROPS[i][1] * Math.exp(-(s - t) / SHOCK_TAU));
  }
  out.shock = shock;
  if (!cues || s < 0 || s > cues.duration) {
    out.kick = 0;
    out.hit = 0;
    out.bass = 0;
    out.high = 0;
    out.energy = 0;
    return out;
  }
  out.kick = pulse(cues.kickT, cues.kickS, s, KICK_TAU);
  out.hit = pulse(cues.hitT, cues.hitS, s, HIT_TAU);
  out.bass = envelope(cues.bass, cues.fps, s);
  out.high = envelope(cues.high, cues.fps, s);
  out.energy = envelope(cues.energy, cues.fps, s);
  return out;
}
