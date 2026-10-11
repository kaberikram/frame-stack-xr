/**
 * Sorang's clock. One timeline value `T` (seconds at pace 1) drives every stage, so any
 * moment can be rendered directly, and reform is the same timeline played backwards.
 * No three.js here: the system turns these plain numbers into uniforms.
 */

/** Seconds. Each stage ramps a 0..1 clock across its window; the shader staggers within it. */
export const SCHEDULE = {
  show: [0, 1],
  relief: [3, 5.5],
  quant: [5.5, 6],
  fan: [5.5, 10],
  scan: [6, 10],
  arcIn: [5.5, 9],
  arcOut: [9, 12],
  burst: [9.5, 12.5],
  drift: [11.5, 15],
} as const;

/** The timeline waits here until the painting, depth and photos have each landed or given up. */
export const HOLD_AT = 3;
/** Past this the pieces only orbit: T stops and the orbit clock runs on. */
export const END = 15;
/** The orbit clock wraps here; every orbit frequency is a whole number of turns per wrap. */
export const ORBIT_WRAP = 600;
/** The 100 depth slices. */
export const SLICES = 100;

export type SorangStage = 'fade' | 'hold' | 'rest' | 'relief' | 'fan' | 'burst' | 'drift' | 'orbit' | 'reform';

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

export interface SorangGates {
  /** All of painting, depth and photos have landed or given up. */
  ready: boolean;
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

export class SorangTimeline {
  T = 0;
  /** 1 plays forward, -1 reforms. */
  dir: 1 | -1 = 1;
  paused = false;
  /** Reformed and waiting on the clean painting for the next click. */
  resting = false;
  orbit = 0;
  /** A frozen timeline (`?sorangT=`) ignores pace, gates and input. */
  frozen: number | null = null;
  private holding = false;

  restart(): void {
    this.T = 0;
    this.dir = 1;
    this.paused = false;
    this.resting = false;
    this.orbit = 0;
    this.holding = false;
  }

  /** Click or R: send the pieces out, or bring them back. Ignored before the painting has played. */
  toggle(): boolean {
    // T sits exactly at HOLD_AT only while holding for the gates (paused or not) or resting.
    if (this.frozen !== null || this.T < HOLD_AT || this.holding || (this.T === HOLD_AT && !this.resting)) return false;
    this.paused = false;
    if (this.resting) {
      this.resting = false;
      this.dir = 1;
      return true;
    }
    this.dir = this.dir > 0 ? -1 : 1;
    return true;
  }

  togglePause(): void {
    if (this.frozen === null) this.paused = !this.paused;
  }

  freeze(t: number | null): void {
    this.frozen = t === null ? null : Math.max(0, Math.min(t, END + ORBIT_WRAP));
  }

  /** Jump to `t` and keep playing forward from there. */
  seek(t: number): void {
    this.frozen = null;
    this.T = Math.max(0, Math.min(t, END + ORBIT_WRAP));
    this.orbit = Math.max(0, this.T - SCHEDULE.drift[0]) % ORBIT_WRAP;
    this.T = Math.min(this.T, END);
    this.dir = 1;
    this.resting = false;
    this.paused = false;
  }

  /**
   * `dt` is the ECS frame delta, so `ecs_step` advances it exactly. `orbitRate` slows
   * the orbits under reduced motion.
   */
  update(dt: number, gates: SorangGates, pace: number, reformSpeed: number, orbitRate: number, out: SorangClocks): SorangClocks {
    if (this.frozen !== null) {
      const t = this.frozen;
      return clocksAt(Math.min(t, END), Math.max(0, t - SCHEDULE.drift[0]) % ORBIT_WRAP, out);
    }
    if (!this.paused && !this.resting) {
      // Re-evaluated only while time moves, so a paused hold still reads as a hold.
      this.holding = false;
      if (this.dir > 0) {
        const next = this.T + dt * pace;
        if (!gates.ready && this.T <= HOLD_AT && next > HOLD_AT) {
          this.T = HOLD_AT;
          this.holding = true;
        } else {
          this.T = Math.min(END, next);
        }
      } else {
        this.T -= dt * pace * reformSpeed;
        if (this.T <= HOLD_AT) {
          this.T = HOLD_AT;
          this.dir = 1;
          this.resting = true;
        }
      }
      if (this.T >= SCHEDULE.drift[0]) this.orbit = (this.orbit + dt * orbitRate) % ORBIT_WRAP;
    }
    return clocksAt(this.T, this.orbit, out);
  }

  get stage(): SorangStage {
    if (this.frozen === null) {
      if (this.resting) return 'rest';
      if (this.dir < 0) return 'reform';
    }
    const t = this.frozen ?? this.T;
    if (t < SCHEDULE.show[1]) return 'fade';
    if (t < HOLD_AT) return 'hold';
    if (t <= HOLD_AT && this.holding) return 'hold';
    if (t < SCHEDULE.fan[0]) return 'relief';
    if (t < SCHEDULE.burst[0]) return 'fan';
    if (t < SCHEDULE.drift[0]) return 'burst';
    if (t < END) return 'drift';
    return 'orbit';
  }
}
