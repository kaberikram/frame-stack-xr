/** A tiny synth for scrub detents and taps. It stays silent until a user gesture unlocks audio. */
export class TickSound {
  private ctx: AudioContext | null = null;
  private lastTick = 0;

  unlock(): void {
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      this.ctx = null; // no audio on this device; stay silent
    }
  }

  /** A detent as the scrub crosses a frame. Long ruler marks sound lower and firmer. */
  tick(major: boolean): void {
    const ctx = this.running();
    if (!ctx || ctx.currentTime - this.lastTick < 0.028) return; // fast scrubs purr instead of buzzing
    this.lastTick = ctx.currentTime;
    this.blip(ctx, major ? 1500 : 2600, major ? 0.07 : 0.035, 0.022);
  }

  /** Contact with a control. */
  tap(): void {
    const ctx = this.running();
    if (ctx) this.blip(ctx, 620, 0.08, 0.07);
  }

  private running(): AudioContext | null {
    return this.ctx && this.ctx.state === 'running' ? this.ctx : null;
  }

  private blip(ctx: AudioContext, freq: number, peak: number, dur: number): void {
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(peak, t + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.01);
  }
}
