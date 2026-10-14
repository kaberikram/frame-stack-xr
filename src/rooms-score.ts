/**
 * Rooms' score: the song's beat grid, its sections, and the shot list the camera plays. Pure: no
 * audio and no three.js, so any moment of the song can be rendered directly (`?roomsT=`).
 *
 * The song (`public/rooms/music.mp3`) is 110 BPM on a straight grid with beat 1 at 0.045 s: a
 * 2-bar intro, a 16-bar verse, a 16-bar drop at 39.3 s, a 16-bar break at 74.2 s, a 16-bar drop
 * at 109.1 s, and an 8-bar outro from 144.0 s. `scripts/sorang/song_map.py` prints any song's
 * loudness by section, for re-timing these to a different track.
 */

export const BPM = 110;
export const BEAT = 60 / BPM;
export const BAR = 4 * BEAT;
/** Song second of beat 1 (the encoder's lead-in). */
export const OFFSET = 0.045;
/** The song's own length; the decoded buffer replaces it once the music loads. */
export const SONG_LENGTH = 162.19;

/** Song second of `beat` beats into bar `bar` (both zero-based; fractions allowed). */
export function barTime(bar: number, beat = 0): number {
  return OFFSET + (bar * 4 + beat) * BEAT;
}

/** Beats since beat 1 at song second `s` (fractional). */
export function beatsAt(s: number): number {
  return (s - OFFSET) / BEAT;
}

export type SectionKind = 'intro' | 'verse' | 'drop' | 'outro';

export interface Section {
  name: string;
  kind: SectionKind;
  bar: number;
  /** 0..1: how hard the visuals hit in it. */
  energy: number;
}

export const SECTIONS: readonly Section[] = [
  { name: 'intro', kind: 'intro', bar: 0, energy: 0.15 },
  { name: 'verse', kind: 'verse', bar: 2, energy: 0.45 },
  { name: 'drop 1', kind: 'drop', bar: 18, energy: 1 },
  { name: 'break', kind: 'verse', bar: 34, energy: 0.45 },
  { name: 'drop 2', kind: 'drop', bar: 50, energy: 1 },
  { name: 'outro', kind: 'outro', bar: 66, energy: 0.2 },
];

/** The last bar before each drop, where the hats build: energy climbs across it. */
const BUILDS: readonly number[] = [17, 49];
/** Dust bursts: [bar, strength]. The drops throw it hardest. */
const BURSTS: ReadonlyArray<readonly [number, number]> = [
  [18, 1],
  [34, 0.35],
  [50, 1],
  [66, 0.5],
];

/** Everything fades to black across these song seconds. */
export const FADE_OUT: readonly [number, number] = [barTime(72), SONG_LENGTH];

// ---------------------------------------------------------------- shots

/** An overview preset (see `ISO` in `rooms-layout.ts`) or a box's front view by slot index. */
export type ShotView = 'rise' | 'wide' | 'mid' | 'high' | 'low' | 'side' | 'orbit' | 'pull' | number;

export interface ShotCue {
  /** Arrival: bar, plus beats into it. A fly lands here, so it lands on the beat. */
  bar: number;
  beat?: number;
  view: ShotView;
  move: 'cut' | 'fly';
  /** Beats a fly takes; it starts this long before the arrival. */
  beats?: number;
  /** 0..1 flare of the edges, grid and glow on a cut. */
  flash?: number;
}

const fly = (bar: number, view: ShotView, beats = 2, beat = 0): ShotCue => ({ bar, beat, view, move: 'fly', beats });
const cut = (bar: number, view: ShotView, beat = 0, flash = 0.18): ShotCue => ({ bar, beat, view, move: 'cut', flash });
/** One cut per beat of `bar`, through `views`. */
const everyBeat = (bar: number, views: readonly ShotView[]): ShotCue[] => views.map((v, i) => cut(bar, v, i));
/** One cut every two beats of `bar`. */
const halfBars = (bar: number, a: ShotView, b: ShotView): ShotCue[] => [cut(bar, a), cut(bar, b, 2)];

/**
 * The edit. Box slots (top of the stack to the bottom): 0 bedroom, 1 living room, 2 bunk room,
 * 3 kitchen, 4 office, 5 gallery, 6 lounge, 7 bathroom, 8 purple lounge. Reorder freely: each
 * cue lands on its own bar, so changing one never shifts the rest.
 */
export const SHOTS: readonly ShotCue[] = [
  // Intro: high above the stack, craning down as the boxes appear.
  cut(0, 'rise', 0, 0),
  fly(2, 'wide', 6),
  // Verse: eased flights between the overview and single rooms, every two bars.
  fly(4, 1, 3),
  fly(6, 'high', 2),
  fly(8, 0, 2),
  fly(10, 2, 3),
  fly(12, 'low', 3),
  fly(14, 3, 2),
  fly(16, 5, 3), // and a slow push into it across the build
  // Drop 1: hard cuts, one a bar, then one a beat.
  cut(18, 'wide', 0, 1),
  cut(19, 4),
  cut(20, 6),
  cut(21, 'high'),
  cut(22, 7),
  cut(23, 8),
  cut(24, 1),
  cut(25, 'low'),
  cut(26, 3),
  cut(27, 0),
  cut(28, 2),
  cut(29, 'side'),
  cut(30, 5),
  cut(31, 6),
  ...everyBeat(32, [4, 8, 7, 3]),
  ...halfBars(33, 'wide', 1),
  // Break: back to flights, with the overview turning slowly around the stack.
  cut(34, 'orbit', 0, 0.35),
  fly(36, 6, 3),
  fly(38, 8, 3),
  fly(40, 'orbit', 3),
  fly(42, 7, 2),
  fly(44, 3, 3),
  fly(46, 'mid', 2),
  fly(48, 2, 2), // pushing in across the build
  // Drop 2: cuts every bar, then every two beats, then every beat.
  cut(50, 'wide', 0, 1),
  cut(51, 0),
  cut(52, 5),
  cut(53, 'low'),
  cut(54, 1),
  cut(55, 4),
  cut(56, 7),
  cut(57, 'high'),
  ...halfBars(58, 6, 3),
  ...halfBars(59, 8, 2),
  ...halfBars(60, 'side', 0),
  ...halfBars(61, 5, 1),
  ...halfBars(62, 4, 'wide'),
  ...halfBars(63, 7, 6),
  ...everyBeat(64, [3, 8, 2, 5]),
  ...everyBeat(65, [1, 4, 0, 6]),
  // Outro: the wide view, then one long pull back and up while the rooms go out.
  cut(66, 'wide', 0, 0.5),
  fly(74, 'pull', 30),
];

export interface ShotTiming {
  view: ShotView;
  move: 'cut' | 'fly';
  /** Song second it starts to take over (a fly's start; a cut's arrival). */
  start: number;
  /** Song second it arrives. */
  at: number;
  flash: number;
  /** The section it arrives in: drops punch in, verses drift. */
  kind: SectionKind;
}

export function sectionAt(s: number): Section {
  let found = SECTIONS[0];
  for (const section of SECTIONS) if (s >= barTime(section.bar)) found = section;
  return found;
}

/** The cues on the clock, checked in order. A fly that would start before its previous shot lands is shortened. */
export const SHOT_TIMES: readonly ShotTiming[] = (() => {
  const out: ShotTiming[] = [];
  for (const cue of SHOTS) {
    const at = barTime(cue.bar, cue.beat ?? 0);
    const prev = out.length > 0 ? out[out.length - 1].at : -Infinity;
    let start = cue.move === 'fly' ? at - (cue.beats ?? 2) * BEAT : at;
    if (start < prev) {
      if (typeof console !== 'undefined') console.warn(`[rooms] shot at bar ${cue.bar} starts before the previous one lands; shortened`);
      start = prev;
    }
    out.push({ view: cue.view, move: cue.move, start, at, flash: cue.flash ?? 0, kind: sectionAt(at).kind });
  }
  return out;
})();

export interface ShotState {
  /** Index into SHOT_TIMES the camera comes from (equal to `to` while holding). */
  from: number;
  to: number;
  /** 0..1 through the fly; 1 while holding. */
  u: number;
}

/** Which shot is on screen at song second `s`, and how far through its fly. Writes `out`. */
export function shotAt(s: number, out: ShotState): ShotState {
  const shots = SHOT_TIMES;
  let lo = 0;
  let hi = shots.length - 1;
  // The last shot whose takeover has begun.
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (shots[mid].start <= s) lo = mid;
    else hi = mid - 1;
  }
  const shot = shots[lo];
  if (lo > 0 && shot.move === 'fly' && s < shot.at) {
    out.from = lo - 1;
    out.to = lo;
    out.u = (s - shot.start) / Math.max(1e-6, shot.at - shot.start);
  } else {
    out.from = lo;
    out.to = lo;
    out.u = 1;
  }
  return out;
}

// ---------------------------------------------------------------- pulses

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number) => v * v * (3 - 2 * v);

/** 0..1: how hard the visuals hit at song second `s`. Eases across a beat at section edges and climbs through each build. */
export function energyAt(s: number): number {
  let e = SECTIONS[0].energy;
  for (let i = 1; i < SECTIONS.length; i++) {
    const at = barTime(SECTIONS[i].bar);
    // Into a drop it snaps on the downbeat; out of one it eases over a beat.
    const rise = SECTIONS[i].energy > SECTIONS[i - 1].energy;
    const u = rise ? (s >= at ? 1 : 0) : smooth(clamp01((s - at) / BEAT));
    e += (SECTIONS[i].energy - SECTIONS[i - 1].energy) * u;
  }
  for (const bar of BUILDS) {
    const u = clamp01((s - barTime(bar)) / BAR);
    if (u > 0 && u < 1) e += 0.3 * u * u;
  }
  return e * (1 - fadeAt(s));
}

/**
 * 0..1 kick on the beat grid: a sharp attack decaying over about a tenth of a second. Every beat
 * in the drops; in the verses the off-beats are half strength. Scaled by the energy.
 */
export function kickAt(s: number): number {
  if (s < OFFSET) return 0;
  const b = beatsAt(s);
  const n = Math.floor(b);
  const since = (b - n) * BEAT;
  const kind = sectionAt(s).kind;
  const weight = kind === 'drop' ? 1 : n % 2 === 0 ? 1 : 0.5;
  return Math.exp(-since / 0.11) * weight * energyAt(s);
}

/** 0..1 flare from the latest cut, gone within a quarter of a second. */
export function flashAt(s: number, state: ShotState): number {
  const shot = SHOT_TIMES[state.to];
  if (shot.move !== 'cut' || shot.flash <= 0 || s < shot.at) return 0;
  return shot.flash * Math.exp(-(s - shot.at) / 0.12);
}

/** Seconds since the latest dust burst, and its strength (0 before the first). */
export function burstAt(s: number, out: { age: number; amp: number }): { age: number; amp: number } {
  out.age = 1e3;
  out.amp = 0;
  for (const [bar, amp] of BURSTS) {
    const at = barTime(bar);
    if (s >= at) {
      out.age = s - at;
      out.amp = amp;
    }
  }
  return out;
}

/** 0 while the song plays, rising to 1 by its end: everything fades out with it. */
export function fadeAt(s: number): number {
  return smooth(clamp01((s - FADE_OUT[0]) / (FADE_OUT[1] - FADE_OUT[0])));
}

/**
 * 0..1 how present box `slot` (or fog cube, numbered after the boxes) is: they appear one after
 * another through the intro, top first, and go out one a bar through the outro, top first.
 */
export function presenceAt(s: number, index: number): number {
  const inAt = barTime(0, 0.5 + index * 0.55);
  const outAt = barTime(67 + index * 0.55);
  const fadeIn = smooth(clamp01((s - inAt) / (0.6 * BEAT)));
  const fadeOut = smooth(clamp01((s - outAt) / BAR));
  return fadeIn * (1 - fadeOut);
}

/** 0..1 for a box's edges flaring as it appears. */
export function arrivalFlareAt(s: number, index: number): number {
  const since = s - barTime(0, 0.5 + index * 0.55);
  return since < 0 ? 0 : Math.exp(-since / 0.35);
}
