/**
 * Sorang's soundtrack: one decoded song on its own AudioContext, and a clock that says which
 * second of it you are hearing now. Without audio (blocked, failed, or `?music=0`) a silent
 * clock runs in its place, so the piece still plays in time.
 */

/** Seconds the first sample is scheduled ahead, so playback starts on a known context time. */
const LEAD = 0.05;
/** How fast the visual clock eases onto the audio clock, per second. */
const SLEW = 6;
/** Further apart than this and the visual clock jumps instead of easing. */
const SNAP = 0.25;
/** Fade on stop and pause, seconds (time constant), so playback never ends on a click. */
const FADE = 0.03;
/** Until the song's own length is known. */
const DEFAULT_DURATION = 160;
/** How often the output latency is re-measured, context seconds. */
const LATENCY_EVERY = 0.5;

export class SorangMusic {
  /** Called once when audio gives up and the silent clock takes over. */
  onFail: ((why: string) => void) | null = null;
  duration = DEFAULT_DURATION;

  private ctx: AudioContext | null = null;
  /** Master gain: volume and mute only. */
  private gain: GainNode | null = null;
  private bytes: Promise<ArrayBuffer> | null = null;
  private decoding: Promise<void> | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  /** The playing source's own gain, so its fade-out never touches the next one's level. */
  private voice: GainNode | null = null;
  /** Context time at which song second 0 plays. */
  private zero = 0;
  /** Song second the current playback started from: the clock never shows less while it waits. */
  private from = 0;
  /** Context time minus what is leaving the speakers, re-measured every LATENCY_EVERY. */
  private latency = 0;
  private latencyAt = -Infinity;
  private silent: boolean;
  /** Silent only because no gesture came: a later gesture brings the music back for the next play. */
  private silentForGesture = false;
  private playing = false;
  private paused = false;
  private finished = false;
  /** The smoothed song time the visuals follow. */
  private clock = 0;
  private volume = 0.9;
  private muted = false;

  constructor(
    private readonly url: string,
    forceSilent: boolean,
  ) {
    this.silent = forceSilent;
  }

  /** The song can start now: decoded with a running context, or running silent. */
  get ready(): boolean {
    return this.silent || (this.buffer !== null && this.ctx?.state === 'running');
  }

  /** Waiting on a click or key before the browser lets the song play. */
  get needsGesture(): boolean {
    return !this.silent && this.ctx?.state !== 'running';
  }

  get isSilent(): boolean {
    return this.silent;
  }

  get isPlaying(): boolean {
    return this.playing && !this.paused;
  }

  get ended(): boolean {
    return this.finished;
  }

  /** Song seconds the visuals should show this frame. */
  get time(): number {
    return this.clock;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Start downloading. The context waits for a gesture. */
  prefetch(): void {
    if (this.silent || this.bytes) return;
    this.bytes = fetch(this.url).then((res) => {
      if (!res.ok) throw new Error(`music ${res.status}`);
      return res.arrayBuffer();
    });
    this.bytes.catch((err: unknown) => this.fail('download', err));
  }

  /** From a user gesture: create or resume the context, then decode the song. */
  unlock(): void {
    if (this.silentForGesture) {
      // A run already under way stays silent (it has no source); the next play() has sound.
      this.silent = false;
      this.silentForGesture = false;
    }
    if (this.silent) return;
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch (err) {
      this.fail('context', err);
      return;
    }
    if (!this.gain) {
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
      this.gain.gain.value = this.level();
    }
    this.decode(this.ctx);
  }

  setVolume(volume: number): void {
    if (volume === this.volume) return;
    this.volume = volume;
    this.applyLevel();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyLevel();
  }

  /** Play from song second `from`. Anything still playing fades out on its own gain. */
  play(from = 0): void {
    this.stopSource(true);
    this.playing = true;
    this.paused = false;
    this.finished = false;
    this.clock = Math.max(0, from);
    this.from = this.clock;
    if (this.silent || !this.ctx || !this.buffer || !this.gain) return;
    const ctx = this.ctx;
    const source = ctx.createBufferSource();
    const voice = ctx.createGain();
    source.buffer = this.buffer;
    source.connect(voice);
    voice.connect(this.gain);
    source.onended = () => voice.disconnect();
    const when = ctx.currentTime + LEAD;
    source.start(when, Math.min(this.clock, this.buffer.duration));
    this.zero = when - this.clock;
    this.source = source;
    this.voice = voice;
  }

  pause(): void {
    if (!this.playing || this.paused) return;
    this.paused = true;
    this.stopSource(true);
  }

  resume(): void {
    if (!this.playing || !this.paused) return;
    this.play(this.clock);
  }

  /** Jump to song second `s`, playing on if it was playing. */
  seek(s: number): void {
    if (this.playing && !this.paused) this.play(s);
    else this.clock = Math.max(0, s);
  }

  stop(): void {
    this.stopSource(true);
    this.playing = false;
    this.paused = false;
    this.finished = false;
    this.clock = 0;
  }

  /** No gesture came: play on the silent clock until one does. */
  goSilent(why: string): void {
    if (this.silent) return;
    console.warn(`[sorang] music ${why}; playing on a silent clock`);
    this.silent = true;
    this.silentForGesture = true;
    this.stopSource(false);
  }

  /**
   * Once per frame. The visual clock runs on the frame delta and eases toward what the speakers
   * are playing, so motion stays smooth while the beats still land. Returns the song time.
   */
  tick(dt: number): number {
    if (!this.playing || this.paused || this.finished) return this.clock;
    const heard = this.heard();
    // Until the first scheduled sample is audible, hold where playback starts: never run backwards.
    if (heard !== null && heard < this.from) {
      this.clock = this.from;
      return this.clock;
    }
    this.clock += dt;
    if (heard !== null) {
      const error = heard - this.clock;
      if (Math.abs(error) > SNAP) this.clock = heard;
      else this.clock += error * Math.min(1, dt * SLEW);
    }
    if (this.clock < 0) this.clock = 0;
    if (this.clock >= this.duration) {
      this.clock = this.duration;
      this.finished = true;
      this.playing = false;
      this.source = null;
      this.voice = null;
    }
    return this.clock;
  }

  dispose(): void {
    this.stopSource(false);
    this.playing = false;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.gain = null;
    this.buffer = null;
  }

  // ----------------------------------------------------------------

  /** The song second leaving the speakers now, or null without audio. */
  private heard(): number | null {
    const ctx = this.ctx;
    if (this.silent || !ctx || !this.source) return null;
    const now = ctx.currentTime;
    // getOutputTimestamp allocates, so the latency is measured now and then, not every frame.
    if (now - this.latencyAt >= LATENCY_EVERY || now < this.latencyAt) {
      this.latencyAt = now;
      this.latency = ctx.outputLatency || ctx.baseLatency || 0;
      // The output timestamp already counts the device latency; extrapolate it to this moment.
      const stamp = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
      if (stamp && stamp.contextTime !== undefined && stamp.performanceTime !== undefined && stamp.performanceTime > 0) {
        this.latency = Math.max(0, now - (stamp.contextTime + (performance.now() - stamp.performanceTime) / 1000));
      }
    }
    return now - this.latency - this.zero;
  }

  private decode(ctx: AudioContext): void {
    if (this.decoding) return;
    this.prefetch();
    const bytes = this.bytes;
    if (!bytes) return;
    this.decoding = bytes
      .then((data) => ctx.decodeAudioData(data))
      .then((buffer) => {
        if (this.silent) return;
        this.buffer = buffer;
        this.duration = buffer.duration;
        console.info(`[sorang] music ${buffer.duration.toFixed(1)} s at ${buffer.sampleRate} Hz`);
      })
      .catch((err: unknown) => this.fail('decode', err));
  }

  /** Stop the current source, fading only its own voice so a following play() starts at full level. */
  private stopSource(fade: boolean): void {
    const source = this.source;
    const voice = this.voice;
    this.source = null;
    this.voice = null;
    if (!source || !this.ctx) return;
    const now = this.ctx.currentTime;
    try {
      if (fade && voice) {
        voice.gain.setTargetAtTime(0, now, FADE);
        source.stop(now + FADE * 6);
      } else {
        source.stop();
      }
    } catch {
      // Already stopped.
    }
  }

  private level(): number {
    return this.muted ? 0 : this.volume;
  }

  /** The master gain carries only volume and mute; fades live on each voice. */
  private applyLevel(): void {
    if (!this.gain || !this.ctx) return;
    this.gain.gain.cancelScheduledValues(0);
    this.gain.gain.setTargetAtTime(this.level(), this.ctx.currentTime, FADE);
  }

  private fail(stage: string, err: unknown): void {
    if (this.silent) return;
    console.warn(`[sorang] music ${stage} failed; playing on a silent clock`, err);
    this.silent = true;
    this.stopSource(false);
    // A song already under way carries on silently from where it was.
    this.onFail?.(stage);
  }
}
