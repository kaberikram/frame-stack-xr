/**
 * Sorang's clock. One timeline value `T` drives every stage, so any moment can be rendered
 * directly, and running T backwards replays the picture in reverse (R). The song drives T
 * forward through `SONG_MAP` in `sorang-song.ts`; before it starts, a short pre-roll fades the
 * painting in, and as the song dies away everything fades out with it.
 * No three.js here: the system turns these plain numbers into uniforms.
 */
import { ORBIT_FROM, fadeOutAt, songT } from './sorang-song.js';

/**
 * Stage windows in T units. Each stage ramps a 0..1 clock across its window; the shader
 * staggers within it. They follow one another so the song map can give each its own section.
 */
export const SCHEDULE = {
  show: [0, 1],
  relief: [3, 6],
  quant: [6, 6.5],
  scan: [6.5, 11],
  fan: [11, 15],
  arcIn: [11, 14],
  arcOut: [15, 17],
  burst: [15, 18],
  drift: [17, 21],
} as const;

/** The pre-roll waits here, on the clean painting, until everything has landed and the song can start. */
export const HOLD_AT = 3;
/** Past this the pieces only orbit. */
export const END = 21;
/** The orbit clock wraps here; every orbit frequency is a whole number of turns per wrap. */
export const ORBIT_WRAP = 600;
/** The 100 depth slices. */
export const SLICES = 100;
/** T units per second while R rewinds the pieces into the painting before the song restarts. */
const REWIND_RATE = 12;

export type SorangStage = 'fade' | 'hold' | 'rest' | 'relief' | 'fan' | 'burst' | 'drift' | 'orbit' | 'reform';

/** `preroll` fades in and holds, `playing` follows the song, `rewind` runs home for a restart, `ended` rests in the dark. */
export type SorangPhase = 'preroll' | 'playing' | 'rewind' | 'ended';

export interface SorangClocks {
  show: number;
  relief: number;
  quant: number;
  fan: number;
  /** Slice index the scan contour sits on: from past the nearest sheet down past the farthest. */
  scan: number;
  burst: number;
  drift: number;
  dim: number;
  /** -1..1 share of the scripted eye arc. */
  arc: number;
  /** 0..1 amplitude of the idle sway. */
  sway: number;
  /** Orbit clock, seconds, wrapped. */
  orbit: number;
}

export function createClocks(): SorangClocks {
  return { show: 0, relief: 0, quant: 0, fan: 0, scan: SLICES + 10, burst: 0, drift: 0, dim: 1, arc: 0, sway: 0, orbit: 0 };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number) => v * v * (3 - 2 * v);
const ramp = (t: number, w: readonly [number, number]) => clamp01((t - w[0]) / (w[1] - w[0]));

/** The clocks at timeline time `t`. Pure: the same `t` always gives the same picture. */
export function clocksAt(t: number, orbit: number, out: SorangClocks): SorangClocks {
  out.show = smooth(ramp(t, SCHEDULE.show));
  out.relief = smooth(ramp(t, SCHEDULE.relief));
  out.quant = ramp(t, SCHEDULE.quant);
  out.fan = ramp(t, SCHEDULE.fan);
  out.scan = SLICES + 10 - ramp(t, SCHEDULE.scan) * (SLICES + 20);
  out.burst = ramp(t, SCHEDULE.burst);
  out.drift = ramp(t, SCHEDULE.drift);
  out.dim = 1 - 0.25 * smooth(out.drift);
  out.arc = smooth(ramp(t, SCHEDULE.arcIn)) - smooth(ramp(t, SCHEDULE.arcOut));
  out.sway = out.relief;
  out.orbit = orbit;
  return out;
}

/** The orbit clock at song second `s`: deterministic, so a frozen moment always orbits the same. */
export function orbitAt(s: number, rate: number): number {
  return (Math.max(0, s - ORBIT_FROM) * rate) % ORBIT_WRAP;
}

export class SorangTimeline {
  T = 0;
  /** Song seconds the picture is showing. */
  song = 0;
  phase: SorangPhase = 'preroll';
  paused = false;
  /** A frozen timeline (`?sorangT=`, in song seconds) ignores the music, gates and input. */
  frozen: number | null = null;

  /** Back to black: fade in, then hold for the song. */
  restart(): void {
    this.T = 0;
    this.song = 0;
    this.phase = 'preroll';
    this.paused = false;
  }

  /**
   * Run the pieces home, then start the song again from the top. Ignored before anything has
   * moved. After the song has faded out there is nothing to see fly home, so it fades the painting
   * back in from black instead.
   */
  rewind(): void {
    if (this.frozen !== null) return;
    this.paused = false;
    if (this.phase === 'preroll') return;
    if (this.phase === 'ended') {
      this.restart();
      return;
    }
    // The orbit clock keeps its song time through the rewind, so orbiting pieces don't jump.
    this.phase = this.T > HOLD_AT ? 'rewind' : 'preroll';
    if (this.phase === 'preroll') this.song = 0;
  }

  /** The T on screen: the frozen moment's, or the running one. */
  get shownT(): number {
    return this.frozen !== null ? songT(this.frozen) : this.T;
  }

  /** 0..1: how far everything has faded out with the end of the song. */
  get fade(): number {
    if (this.frozen !== null) return fadeOutAt(this.frozen);
    if (this.phase === 'ended') return 1;
    return this.phase === 'playing' ? fadeOutAt(this.song) : 0;
  }

  /** The pre-roll has reached the clean painting and waits for the song. */
  get waiting(): boolean {
    return this.frozen === null && this.phase === 'preroll' && this.T >= HOLD_AT;
  }

  /** The song has started; T follows it from the held painting. */
  start(): void {
    this.phase = 'playing';
    this.paused = false;
    this.song = 0;
    this.T = songT(0);
  }

  /** The song has finished and everything has faded out: rest in the dark until asked again. */
  finish(): void {
    if (this.phase !== 'playing') return;
    this.phase = 'ended';
  }

  togglePause(): void {
    if (this.frozen === null) this.paused = !this.paused;
  }

  freeze(s: number | null): void {
    this.frozen = s === null ? null : Math.max(0, s);
  }

  /**
   * `dt` is the ECS frame delta, so `ecs_step` advances the pre-roll and the rewind exactly.
   * `song` is the song's playback time, read by the system from the music. `orbitRate` slows the
   * orbits under reduced motion.
   */
  update(dt: number, song: number, orbitRate: number, out: SorangClocks): SorangClocks {
    if (this.frozen !== null) {
      const s = this.frozen;
      return clocksAt(songT(s), orbitAt(s, orbitRate), out);
    }
    if (!this.paused) {
      if (this.phase === 'preroll') {
        this.T = Math.min(HOLD_AT, this.T + dt);
      } else if (this.phase === 'rewind') {
        this.T -= dt * REWIND_RATE;
        if (this.T <= HOLD_AT) {
          this.T = HOLD_AT;
          this.song = 0;
          this.phase = 'preroll';
        }
      } else if (this.phase === 'playing') {
        this.song = song;
        this.T = songT(song);
      }
    }
    return clocksAt(this.T, orbitAt(this.song, orbitRate), out);
  }

  get stage(): SorangStage {
    if (this.frozen === null) {
      if (this.phase === 'ended') return 'rest';
      if (this.phase === 'rewind') return 'reform';
      if (this.phase === 'preroll') return this.T < SCHEDULE.show[1] ? 'fade' : 'hold';
    }
    const t = this.frozen !== null ? songT(this.frozen) : this.T;
    if (t <= HOLD_AT) return 'hold';
    if (t < SCHEDULE.fan[0]) return 'relief';
    if (t < SCHEDULE.burst[0]) return 'fan';
    if (t < SCHEDULE.drift[0]) return 'burst';
    if (t < END) return 'drift';
    return 'orbit';
  }
}
