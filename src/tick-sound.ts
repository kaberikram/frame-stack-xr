/**
 * Soft clicks: sine chords with a short decay and a quiet octave tick on the
 * front. A little reverb (0.35 s, 12% wet) takes the edge off without a tail.
 * Stays silent until a user gesture unlocks audio.
 */

const ATTACK = 0.004;
const DECAY = 0.05;
const SUSTAIN = 0;
const RELEASE = 0.045;
const VOLUME = Math.pow(10, -12 / 20); // −12 dB
const WET = 0.12;
const REVERB_DECAY = 0.35;
const PRE_DELAY = 0.01;
const EPS = 0.0001;

const C5 = 523.25;
const E5 = 659.25;
const A4 = 440;
const D5 = 587.33;
const A5 = 880;

interface Cue {
  notes: number[];
  gate: number;
  velocity: number;
  release?: number;
}

export class TickSound {
  private ctx: AudioContext | null = null;
  private input: GainNode | null = null;
  private lastTick = 0;

  unlock(): void {
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      this.ensureBus(this.ctx);
    } catch {
      this.ctx = null;
    }
  }

  /** Play, speed, and move. C5 + E5. */
  button(): void {
    this.play({ notes: [C5, E5], gate: 0.04, velocity: 0.2 });
  }

  /** A finger landing on the stack or the filmstrip. A4 + E5. */
  select(): void {
    this.play({ notes: [A4, E5], gate: 0.035, velocity: 0.16 });
  }

  /** The stack appearing on the table. D5 + A5. */
  appear(): void {
    this.play({ notes: [D5, A5], gate: 0.05, velocity: 0.12 });
  }

  /** A detent as the scrub crosses a frame. Major marks are a quieter fifth. */
  tick(major: boolean): void {
    const ctx = this.running();
    if (!ctx || ctx.currentTime - this.lastTick < 0.045) return;
    this.lastTick = ctx.currentTime;
    this.play(
      major
        ? { notes: [A4, E5], gate: 0.028, velocity: 0.09, release: 0.03 }
        : { notes: [E5], gate: 0.016, velocity: 0.055, release: 0.025 },
    );
  }

  private play(cue: Cue): void {
    const ctx = this.running();
    if (!ctx || !this.input) return;
    const t = ctx.currentTime;
    const release = cue.release ?? RELEASE;
    const peak = VOLUME * cue.velocity;
    const gain = ctx.createGain();
    schedule(gain.gain, t, peak, cue.gate, release);
    gain.connect(this.input);

    const click = ctx.createGain();
    click.gain.setValueAtTime(EPS, t);
    click.gain.linearRampToValueAtTime(peak * 0.45, t + 0.002);
    click.gain.exponentialRampToValueAtTime(EPS, t + 0.016);
    click.connect(this.input);

    let pending = cue.notes.length + 1;
    const done = (): void => {
      if (--pending > 0) return;
      gain.disconnect();
      click.disconnect();
    };
    const stopAt = t + cue.gate + release + 0.02;
    for (let i = 0; i < cue.notes.length; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = cue.notes[i]!;
      osc.connect(gain);
      osc.onended = done;
      osc.start(t);
      osc.stop(stopAt);
    }

    const tick = ctx.createOscillator();
    const root = cue.notes[0]!;
    tick.type = 'sine';
    tick.frequency.setValueAtTime(root * 2, t);
    tick.frequency.exponentialRampToValueAtTime(root, t + 0.014);
    tick.connect(click);
    tick.onended = done;
    tick.start(t);
    tick.stop(t + 0.02);
  }

  private running(): AudioContext | null {
    return this.ctx && this.ctx.state === 'running' ? this.ctx : null;
  }

  private ensureBus(ctx: AudioContext): void {
    if (this.input) return;
    const input = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    dry.gain.value = 1 - WET;
    wet.gain.value = WET;
    const reverb = ctx.createConvolver();
    reverb.normalize = true;
    reverb.buffer = impulse(ctx);
    input.connect(dry).connect(ctx.destination);
    input.connect(reverb).connect(wet).connect(ctx.destination);
    this.input = input;
  }
}

function schedule(gain: AudioParam, t: number, peak: number, gate: number, release: number): void {
  const releaseAt = t + gate;
  const attackEnd = t + ATTACK;
  const decayEnd = attackEnd + DECAY;
  gain.setValueAtTime(EPS, t);

  if (releaseAt <= attackEnd) {
    gain.linearRampToValueAtTime(Math.max(EPS, peak * (gate / ATTACK)), releaseAt);
    gain.exponentialRampToValueAtTime(EPS, releaseAt + release);
    return;
  }

  gain.linearRampToValueAtTime(Math.max(EPS, peak), attackEnd);

  if (releaseAt <= decayEnd) {
    const u = (releaseAt - attackEnd) / DECAY;
    const level = peak * (1 + (SUSTAIN - 1) * u);
    gain.linearRampToValueAtTime(Math.max(EPS, level), releaseAt);
    gain.exponentialRampToValueAtTime(EPS, releaseAt + release);
    return;
  }

  const held = Math.max(EPS, peak * SUSTAIN);
  gain.linearRampToValueAtTime(held, decayEnd);
  gain.setValueAtTime(held, releaseAt);
  gain.exponentialRampToValueAtTime(EPS, releaseAt + release);
}

/** Short decaying noise. Leading silence is the pre-delay. */
function impulse(ctx: AudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const pre = Math.floor(rate * PRE_DELAY);
  const length = Math.floor(rate * REVERB_DECAY);
  const buffer = ctx.createBuffer(2, pre + length, rate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      data[pre + i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2);
    }
  }
  return buffer;
}
