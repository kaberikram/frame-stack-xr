import {
  BUTTON_R,
  BUTTON_SLOP,
  MOVE_H,
  MOVE_W,
  MOVE_X,
  PLAY_X,
  SPEED_X,
  STRIP_DEPTH,
  STRIP_LENGTH,
  STRIP_PAD_X,
  STRIP_PAD_Z,
  TOUCH_DOWN,
  TOUCH_UP,
} from './layout.js';

export type Target = 'strip' | 'play' | 'speed' | 'move';
const ORDER: readonly Target[] = ['strip', 'play', 'speed', 'move'];

/** Whether a rig-local table point (x, z) is on a control. `slop` widens the zone while a press is held. */
export function inZone(target: Target, x: number, z: number, slop = 0): boolean {
  switch (target) {
    case 'strip':
      return (
        Math.abs(x) <= STRIP_LENGTH / 2 + STRIP_PAD_X + slop &&
        Math.abs(z) <= STRIP_DEPTH / 2 + STRIP_PAD_Z + slop
      );
    case 'play':
      return Math.hypot(x - PLAY_X, z) <= BUTTON_R + BUTTON_SLOP + slop;
    case 'speed':
      return Math.hypot(x - SPEED_X, z) <= BUTTON_R + BUTTON_SLOP + slop;
    case 'move':
      return (
        Math.abs(x - MOVE_X) <= MOVE_W / 2 + BUTTON_SLOP + slop &&
        Math.abs(z) <= MOVE_H / 2 + BUTTON_SLOP + slop
      );
  }
}

/** The control under a rig-local table point, if any. The strip wins where zones meet. */
export function hitTest(x: number, z: number): Target | null {
  for (let i = 0; i < ORDER.length; i++) {
    if (inZone(ORDER[i], x, z)) return ORDER[i];
  }
  return null;
}

/** Position along the strip: 0 at its left end, 1 at its right. */
export const stripU = (x: number): number =>
  Math.min(1, Math.max(0, (x + STRIP_LENGTH / 2) / STRIP_LENGTH));

/** Touch state for one fingertip, with hysteresis so tracking jitter can't chatter. */
export class Contact {
  touching = false;

  /** Reports the edge when contact starts or ends this frame. */
  update(height: number, tracked: boolean): 'down' | 'up' | null {
    if (!tracked) {
      if (!this.touching) return null;
      this.touching = false;
      return 'up';
    }
    if (!this.touching && height < TOUCH_DOWN) {
      this.touching = true;
      return 'down';
    }
    if (this.touching && height > TOUCH_UP) {
      this.touching = false;
      return 'up';
    }
    return null;
  }
}

/** Measures how long a point has stayed within `radius` of where it settled. */
export class Stillness {
  private ax = 0;
  private ay = 0;
  private az = 0;
  private held = 0;
  private active = false;

  constructor(
    private readonly radius = 0.006,
    private readonly hold = 0.8,
  ) {}

  reset(): void {
    this.active = false;
    this.held = 0;
  }

  /** Returns progress toward a completed hold, 0..1. */
  update(x: number, y: number, z: number, dt: number): number {
    if (!this.active || Math.hypot(x - this.ax, y - this.ay, z - this.az) > this.radius) {
      this.ax = x;
      this.ay = y;
      this.az = z;
      this.held = 0;
      this.active = true;
    } else {
      this.held += dt;
    }
    return Math.min(1, this.held / this.hold);
  }
}

/** One Euro filter (Casiez et al.): steady when the finger is slow, responsive when it's fast. */
export class OneEuro {
  private x = 0;
  private dx = 0;
  private primed = false;

  constructor(
    private readonly minCutoff = 1.2,
    private readonly beta = 10,
    private readonly dCutoff = 1,
  ) {}

  reset(): void {
    this.primed = false;
  }

  filter(value: number, dt: number): number {
    if (!this.primed || dt <= 0) {
      this.x = value;
      this.dx = 0;
      this.primed = true;
      return value;
    }
    this.dx += this.alpha(this.dCutoff, dt) * ((value - this.x) / dt - this.dx);
    this.x += this.alpha(this.minCutoff + this.beta * Math.abs(this.dx), dt) * (value - this.x);
    return this.x;
  }

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
}
