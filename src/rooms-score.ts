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
/** Everything fades to black across these song seconds. */
export const FADE_OUT: readonly [number, number] = [barTime(72), SONG_LENGTH];

// ---------------------------------------------------------------- shots

/** An overview preset: see `ISO` in `rooms-layout.ts`. */
export type IsoView = 'rise' | 'wide' | 'mid' | 'high' | 'low' | 'side' | 'orbit' | 'pull';

/**
 * How the camera sees one room's frame stack:
 * - `front`: face on, the clip in full at the front of its stack, the layers glowing out behind it.
 * - `quarter` / `quarterL`: a 3/4 view from the right / left, turning slowly round the stack.
 * - `oblique` / `obliqueL`: low and steep along the stack, gliding down its time axis.
 * - `top`: from above, looking down the layers.
 */
export type Angle = 'front' | 'quarter' | 'quarterL' | 'oblique' | 'obliqueL' | 'top';

export interface RoomView {
  room: number;
  angle: Angle;
}

export type ShotView = IsoView | RoomView;

export const isRoom = (view: ShotView): view is RoomView => typeof view === 'object';

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
const cut = (bar: number, view: ShotView, beat = 0, flash = 0.45): ShotCue => ({ bar, beat, view, move: 'cut', flash });
/** One cut per beat of `bar`, through `views`. */
const everyBeat = (bar: number, views: readonly ShotView[]): ShotCue[] => views.map((v, i) => cut(bar, v, i));
/** One cut every two beats of `bar`. */
const halfBars = (bar: number, a: ShotView, b: ShotView): ShotCue[] => [cut(bar, a), cut(bar, b, 2)];
const front = (room: number): RoomView => ({ room, angle: 'front' });
const q = (room: number): RoomView => ({ room, angle: 'quarter' });
const ql = (room: number): RoomView => ({ room, angle: 'quarterL' });
const ob = (room: number): RoomView => ({ room, angle: 'oblique' });
const obl = (room: number): RoomView => ({ room, angle: 'obliqueL' });
const top = (room: number): RoomView => ({ room, angle: 'top' });

/**
 * The edit. Rooms (one per clip): 0 car park, 1 hallway, 2 dark room, 3 rooftop (top of the
 * stack), 4 train (bottom). `front(r)` shows the clip in full; `q`/`ql`, `ob`/`obl` and `top` show
 * its stack of frames from the side, below and above. Reorder freely: each cue lands on its own
 * bar, so changing one never shifts the rest.
 */
export const SHOTS: readonly ShotCue[] = [
  // Intro: high above the stack, craning down as the rooms build up frame by frame.
  cut(0, 'rise', 0, 0),
  fly(2, 'wide', 6),
  // Verse: eased flights every two bars, round a stack and then face on to see the memory in full.
  fly(4, q(0), 3),
  fly(6, front(0), 2),
  fly(8, 'high', 2),
  fly(10, ob(1), 3),
  fly(12, front(1), 2),
  fly(14, ql(2), 3),
  fly(16, front(4), 3), // and a slow push into it across the build
  // Drop 1: a short glide every bar, then every beat. Each lands on the beat.
  cut(18, 'wide', 0, 1),
  cut(19, front(3)),
  cut(20, q(1)),
  cut(21, 'high'),
  cut(22, front(4)),
  cut(23, ob(0)),
  cut(24, front(2)),
  cut(25, 'low'),
  cut(26, ql(3)),
  cut(27, front(1)),
  cut(28, top(4)),
  cut(29, 'side'),
  cut(30, front(0)),
  cut(31, q(2)),
  ...everyBeat(32, [front(3), front(1), front(4), front(0)]),
  ...halfBars(33, 'wide', top(2)),
  // Break: back to flights, with the overview turning slowly around the stack.
  cut(34, 'orbit', 0, 0.35),
  fly(36, q(1), 3),
  fly(38, front(1), 2),
  fly(40, obl(4), 3),
  fly(42, front(3), 2),
  fly(44, ql(0), 3),
  fly(46, 'mid', 2),
  fly(48, front(2), 2), // pushing in across the build
  // Drop 2: glides every bar, then every two beats, then every beat.
  cut(50, 'wide', 0, 1),
  cut(51, front(4)),
  cut(52, q(0)),
  cut(53, 'low'),
  cut(54, front(1)),
  cut(55, top(3)),
  cut(56, front(2)),
  cut(57, 'high'),
  ...halfBars(58, ob(4), front(0)),
  ...halfBars(59, q(1), front(3)),
  ...halfBars(60, 'side', front(2)),
  ...halfBars(61, ql(4), front(1)),
  ...halfBars(62, front(0), 'wide'),
  ...halfBars(63, q(3), front(2)),
  ...everyBeat(64, [front(4), front(0), front(1), front(3)]),
  ...everyBeat(65, [q(2), front(4), obl(0), front(1)]),
  // Outro: the wide view, then one long pull back and up while the rooms come apart.
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

/** Longest glide that replaces a cut, in beats. About 0.8 s at this tempo. */
const GLIDE_BEATS = 1.5;
/** A glide never takes more of the gap than this, so the angle just landed stays readable. */
const GLIDE_SHARE = 2 / 3;

/** The cues on the clock, checked in order. A fly that would start before its previous shot lands is shortened. A cut after the opening becomes a short glide and does not flash. */
export const SHOT_TIMES: readonly ShotTiming[] = (() => {
  const out: ShotTiming[] = [];
  for (const cue of SHOTS) {
    const at = barTime(cue.bar, cue.beat ?? 0);
    const prev = out.length > 0 ? out[out.length - 1].at : -Infinity;
    let move = cue.move;
    let flash = cue.flash ?? 0;
    let start = cue.move === 'fly' ? at - (cue.beats ?? 2) * BEAT : at;
    if (cue.move === 'cut' && out.length > 0) {
      const gap = at - prev;
      const glide = Math.min(GLIDE_BEATS * BEAT, Math.max(0, gap) * GLIDE_SHARE);
      start = at - glide;
      move = 'fly';
      flash = 0;
    }
    if (start < prev) {
      if (typeof console !== 'undefined') console.warn(`[rooms] shot at bar ${cue.bar} starts before the previous one lands; shortened`);
      start = prev;
    }
    out.push({ view: cue.view, move, start, at, flash, kind: sectionAt(at).kind });
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

/** 0 while the song plays, rising to 1 by its end: everything fades out with it. */
export function fadeAt(s: number): number {
  return smooth(clamp01((s - FADE_OUT[0]) / (FADE_OUT[1] - FADE_OUT[0])));
}

/** Beats between one room appearing and the next, through the intro. */
const REVEAL_STEP = 1.4;

/** Beats a room takes to build up, frame by frame. */
const BUILD = 1.6;

/**
 * 0..1 how present the room ranked `index` from the top is: they build up one after another
 * through the intro, top first, and come apart one a bar through the outro, top first. The
 * system shows this share of the stack's frames, so 0.5 is its first half.
 */
export function presenceAt(s: number, index: number): number {
  const inAt = barTime(0, 0.5 + index * REVEAL_STEP);
  const outAt = barTime(67 + index);
  const fadeIn = smooth(clamp01((s - inAt) / (BUILD * BEAT)));
  const fadeOut = smooth(clamp01((s - outAt) / BAR));
  return fadeIn * (1 - fadeOut);
}

/** 0..1 for a room's glow flaring as it starts to build. */
export function arrivalFlareAt(s: number, index: number): number {
  const since = s - barTime(0, 0.5 + index * REVEAL_STEP);
  return since < 0 ? 0 : Math.exp(-since / 0.35);
}
