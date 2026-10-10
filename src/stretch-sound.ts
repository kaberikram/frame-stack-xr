import { AudioContext as SharedAudio } from '@iwsdk/core';

/**
 * The stretch sings. A pinch strums an open sus2 chord; pulling walks up a C major pentatonic,
 * one note per step of visual pull (and back down as you ease off); tipping into streaks adds a
 * lydian glint and a soft glass hum; letting go falls down the home triad and lands on a major
 * chord as the spring passes rest, and its overshoot plays a quiet turn. The left hand plays an
 * octave lower, so two hands pulled together move in open fifths. Each hand's notes come from the
 * spot it grabbed. Runs on three's shared context, which IWSDK's listener already follows.
 * Silent until a user gesture unlocks audio.
 */

const VOLUME = Math.pow(10, -14 / 20); // −14 dB
const WET = 0.3;
const REVERB_DECAY = 1.6;
const PRE_DELAY = 0.02;
const EPS = 0.0001;
/** Starts a hair ahead so the render quantum in flight can't clip an attack. */
const LEAD = 0.01;
const ATTACK = 0.006;
const MAX_VOICES = 20;
/** The panner moves only when the grab point moved this far, to keep the automation list short. */
const MOVE = 0.02;

/** Radians of visual pull per scale step (about 3.5 cm of hand travel at arm's length), and the dead band either side of each step edge. */
const STEP = 0.08;
const BAND = STEP * 0.25;
/** Highest step, reached at about a 33 cm pull. */
const TOP = 9;
/** Fastest run, seconds per note. A fast pull skips ahead so the run never trails by more than MAX_LAG notes. */
const STEP_GAP = 0.07;
const MAX_LAG = 3;
/** Re-pinching this soon after letting go doesn't strum again. */
const GRAB_GAP = 0.35;
/** Letting go of less than this is silent. */
const QUIET_PULL = STEP * 0.4;
/** The fall waits a frame or two, so a pinch that flickers off and on cancels it cleanly. */
const FALL_DELAY = 0.02;
const FALL_GAP = 0.05;
const FALL_NOTES = 4;
/** No zero crossing by then (a stiff or overdamped spring): land anyway. */
const LAND_TIMEOUT = 0.45;
/** Overshoot shallower than this stays silent. */
const DIP_MIN = 0.012;
const SETTLE = 1.2;
const GLINT_ON = 0.6;
const GLINT_OFF = 0.3;
const GLINT_STEP = 3;
const GLINT_GAP = 0.8;
const GLINT_SPACING = 0.045;
/** The run holds back while the glint sparkles, so the two don't interleave. */
const GLINT_HUSH = 0.09;
const HUM_FADE = 0.06;
/** The hum fades out by itself unless the next frame renews it, so a stalled XR loop can't leave it droning. */
const HUM_WATCHDOG = 0.5;

const STEP_VEL = 0.36;
const GRAB_VEL = 0.26;
const FALL_VEL = 0.3;
const LAND_VEL = 0.34;
const GLINT_VEL = 0.11;
const DIP_VEL = 0.22;
const TINK_VEL = 0.12;
const HUM_VEL = 0.1;
const MISS_VEL = 0.12;

const C3 = 130.81;
const C4 = 261.63;
const C5 = 523.25;
const C6 = 1046.5;
/**
 * Left hand roots at C4 and starts its run two notes up (E4), right roots at C5: pulled together they
 * move in open fifths. A pushed-in box is the third voice, an octave under the left hand.
 */
const ROOTS = [C4, C5, C3] as const;
const OFFSETS = [2, 0, 0] as const;
/** 0 left hand, 1 right hand, 2 a pushed-in box. */
export type SoundSlot = 0 | 1 | 2;
const PENTATONIC = [0, 2, 4, 7, 9];
/** Semitones above the hand's root. */
const GRAB_CHORD = [0, 7, 14]; // C G D: open, waiting
const LAND_CHORD = [0, 7, 16]; // C G E: home
const GLINT = [7, 11, 14, 18]; // G B D F♯ over C6: the lydian colour, above the run
const DIP = -3; // A below as the spring dips past rest
const TINK = 12; // the octave as it comes back
const MISS = [4, 0]; // E then C, soft: nothing there to grab

type Phase = 'idle' | 'held' | 'falling' | 'bouncing';

interface Hand {
  root: number;
  /** Pentatonic steps the run starts above the root. */
  offset: number;
  out: PannerNode | null;
  px: number;
  py: number;
  pz: number;
  phase: Phase;
  /** The step last played. */
  step: number;
  /** Pull on the last held frame: how far the spring has to fall. */
  pull: number;
  lastNote: number;
  releasedAt: number;
  landedAt: number;
  /** Deepest overshoot past rest since landing (negative). */
  low: number;
  dipped: boolean;
  tinked: boolean;
  glint: boolean;
  lastGlint: number;
  hum: OscillatorNode | null;
  humGain: GainNode | null;
  vibrato: OscillatorNode | null;
}

interface Voice {
  osc: OscillatorNode | null;
  gain: GainNode | null;
  hand: number;
  start: number;
  end: number;
}

export class StretchSound {
  private ctx: AudioContext | null = null;
  private input: GainNode | null = null;
  private wave: PeriodicWave | null = null;
  private busy = false;
  private readonly hands: readonly Hand[] = ROOTS.map((root, i) => makeHand(root, OFFSETS[i]));
  private readonly voices: Voice[] = Array.from({ length: MAX_VOICES }, makeVoice);
  private readonly tones = new Int32Array(8);

  /** Call from a user gesture. Safe to call again; also resumes a context the session suspended. */
  unlock(): void {
    try {
      this.ctx ??= SharedAudio.getContext();
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
      this.ensureBus(this.ctx);
    } catch {
      this.ctx = null;
    }
  }

  /**
   * One hand, every frame. `pull` is radians of visual pull, negative while the spring overshoots
   * past rest; `streak` is how far the stretch has turned to streaks (0–1); x/y/z is the grab point.
   */
  track(slot: SoundSlot, holding: boolean, pull: number, streak: number, x: number, y: number, z: number): void {
    const h = this.hands[slot];
    if (!holding && h.phase === 'idle') return;
    const ctx = this.running();
    if (!ctx || !h.out) return;
    const now = ctx.currentTime;
    this.place(h, now, x, y, z);
    if (holding) {
      if (h.phase !== 'held') this.grab(h, slot, now);
      this.hold(h, slot, now, pull, streak);
      return;
    }
    if (h.phase === 'held') this.release(h, slot, now);
    if (h.phase === 'falling') {
      if (pull <= 0 || now - h.releasedAt > LAND_TIMEOUT) this.land(h, slot, now);
    } else if (h.phase === 'bouncing') {
      this.bounce(h, slot, now, pull);
    }
  }

  /**
   * A held voice let go where it stands (a pushed-in box staying in): the home chord, no falling run.
   * `track` with the pull past where it stays then rings the wobble.
   */
  settle(slot: SoundSlot, x: number, y: number, z: number): void {
    const ctx = this.running();
    const h = this.hands[slot];
    if (!ctx || !h.out || h.phase !== 'held') return;
    const now = ctx.currentTime;
    this.place(h, now, x, y, z);
    this.cancelPending(slot, now);
    this.endHum(h, now, 0.3);
    h.releasedAt = now;
    this.land(h, slot, now);
  }

  /**
   * A still voice let go from `pull` (a box sprung back out from rest): the fall a release plays,
   * then `track` lands and bounces it as usual.
   */
  fall(slot: SoundSlot, pull: number, x: number, y: number, z: number): void {
    const ctx = this.running();
    const h = this.hands[slot];
    if (!ctx || !h.out || h.phase === 'held') return;
    const now = ctx.currentTime;
    this.place(h, now, x, y, z);
    let step = 0;
    while (step < TOP && pull >= (step + 1) * STEP + BAND) step++;
    h.step = step;
    h.pull = pull;
    this.release(h, slot, now);
  }

  /** A pinch that found nothing to grab. */
  miss(slot: SoundSlot, x: number, y: number, z: number): void {
    const ctx = this.running();
    const h = this.hands[slot];
    if (!ctx || !h.out) return;
    const now = ctx.currentTime;
    this.place(h, now, x, y, z);
    for (let i = 0; i < MISS.length; i++) {
      this.note(slot, pitch(h.root, MISS[i]), now + LEAD + i * 0.07, MISS_VEL * (1 - i * 0.2), 0.5, false);
    }
  }

  /** Fades everything out, for leaving the mode or the session. Cheap when already quiet. */
  stop(): void {
    const ctx = this.ctx;
    if (!ctx || !this.busy) return;
    this.busy = false;
    const now = ctx.currentTime;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (!v.gain || v.end <= now) continue;
      this.fade(v, now, 0.05);
      v.end = now + 0.06;
    }
    for (let i = 0; i < this.hands.length; i++) {
      const h = this.hands[i];
      this.endHum(h, now, 0.08);
      h.phase = 'idle';
      h.step = 0;
      h.glint = false;
    }
  }

  /** Leaves the shared context running for everything else; only this synth's nodes go. */
  dispose(): void {
    this.stop();
    for (let i = 0; i < this.hands.length; i++) {
      this.hands[i].out?.disconnect();
      this.hands[i].out = null;
    }
    this.input?.disconnect();
    this.input = null;
    this.wave = null;
    this.ctx = null;
    for (let i = 0; i < this.voices.length; i++) {
      this.voices[i].osc = null;
      this.voices[i].gain = null;
    }
  }

  // ---------------------------------------------------------------- phrases

  private grab(h: Hand, slot: SoundSlot, now: number): void {
    this.cancelPending(slot, now);
    const fresh = now - h.releasedAt > GRAB_GAP;
    h.phase = 'held';
    h.step = 0;
    h.pull = 0;
    h.lastNote = now;
    h.glint = false;
    this.startHum(h, now);
    if (!fresh) return;
    // A second voice joins with root and fifth only, so the two never crowd.
    let others = false;
    for (let i = 0; i < this.hands.length; i++) if (i !== slot && this.hands[i].phase === 'held') others = true;
    const count = others ? 2 : GRAB_CHORD.length;
    for (let i = 0; i < count; i++) {
      this.note(slot, pitch(h.root, GRAB_CHORD[i]), now + LEAD + i * 0.012, GRAB_VEL * (1 - i * 0.15), 1.6, true);
    }
  }

  private hold(h: Hand, slot: SoundSlot, now: number, pull: number, streak: number): void {
    h.pull = pull;
    let want = h.step;
    while (want < TOP && pull >= (want + 1) * STEP + BAND) want++;
    while (want > 0 && pull < want * STEP - BAND) want--;
    if (want !== h.step && now - h.lastNote >= STEP_GAP) {
      const dir = want > h.step ? 1 : -1;
      if ((want - h.step) * dir > MAX_LAG) h.step = want - dir * MAX_LAG;
      h.step += dir;
      h.lastNote = now;
      const f = pitch(h.root, scale(h.step + h.offset));
      this.note(slot, f, now + LEAD, (dir > 0 ? STEP_VEL : STEP_VEL * 0.7) * tilt(h.step), 0.9, true);
      h.hum?.frequency.setTargetAtTime(f * 0.5, now + LEAD, 0.03);
    }
    if (h.glint) {
      if (streak < GLINT_OFF) h.glint = false;
    } else if (streak >= GLINT_ON && h.step >= GLINT_STEP && now - h.lastGlint > GLINT_GAP) {
      h.glint = true;
      h.lastGlint = now;
      h.lastNote = now + GLINT_HUSH;
      // Right hand sparkles up, left hand down, so a two-handed pull spreads both ways.
      for (let i = 0; i < GLINT.length; i++) {
        const tone = GLINT[slot === 1 ? i : GLINT.length - 1 - i];
        this.note(slot, pitch(C6, tone), now + LEAD + i * GLINT_SPACING, GLINT_VEL * (1 - i * 0.12), 0.8, false);
      }
    }
    this.humTo(h, now, HUM_VEL * streak * tilt(h.step));
  }

  /** Falls down the home triad from the note now sounding toward the root, at most four notes. */
  private release(h: Hand, slot: SoundSlot, now: number): void {
    this.endHum(h, now, 0.3);
    h.releasedAt = now;
    if (h.pull < QUIET_PULL) {
      h.phase = 'idle';
      return;
    }
    h.phase = 'falling';
    const tones = this.tones;
    let n = 0;
    for (let s = scale(h.step + h.offset) - 1; s >= 0 && n < tones.length; s--) if (isHome(s)) tones[n++] = s;
    const count = Math.min(FALL_NOTES, n);
    const at = now + LEAD + FALL_DELAY;
    for (let k = 0; k < count; k++) {
      const pick = count === n ? k : Math.round((k * (n - 1)) / Math.max(1, count - 1));
      this.note(slot, pitch(h.root, tones[pick]), at + k * FALL_GAP, FALL_VEL * (1 - k * 0.12) * tilt(h.step), 0.7, true);
    }
  }

  /** The spring passes rest: a soft major chord, louder after a longer pull. */
  private land(h: Hand, slot: SoundSlot, now: number): void {
    h.phase = 'bouncing';
    h.landedAt = now;
    h.low = 0;
    h.dipped = false;
    h.tinked = false;
    const velocity = LAND_VEL * Math.min(1, 0.35 + h.step / 6);
    for (let i = 0; i < LAND_CHORD.length; i++) {
      this.note(slot, pitch(h.root, LAND_CHORD[i]), now + LEAD + i * 0.018, velocity * (1 - i * 0.2), 1.8, true);
    }
  }

  /** Overshoot past rest dips to the sixth below; coming back rings the octave. Depth sets loudness. */
  private bounce(h: Hand, slot: SoundSlot, now: number, pull: number): void {
    if (pull < h.low) h.low = pull;
    const depth = -h.low;
    const loud = Math.min(1, depth / STEP);
    if (!h.dipped && depth > DIP_MIN && pull > h.low + depth * 0.25) {
      h.dipped = true;
      this.note(slot, pitch(h.root, DIP), now + LEAD, DIP_VEL * loud, 1, true);
    } else if (h.dipped && !h.tinked && pull >= 0) {
      h.tinked = true;
      this.note(slot, pitch(h.root, TINK), now + LEAD, TINK_VEL * loud, 1.2, false);
    }
    if (now - h.landedAt > SETTLE) h.phase = 'idle';
  }

  // ---------------------------------------------------------------- voices

  private place(h: Hand, now: number, x: number, y: number, z: number): void {
    const out = h.out;
    if (!out) return;
    const dx = x - h.px;
    const dy = y - h.py;
    const dz = z - h.pz;
    if (dx * dx + dy * dy + dz * dz < MOVE * MOVE) return;
    h.px = x;
    h.py = y;
    h.pz = z;
    out.positionX.setTargetAtTime(x, now, 0.03);
    out.positionY.setTargetAtTime(y, now, 0.03);
    out.positionZ.setTargetAtTime(z, now, 0.03);
  }

  private note(slot: number, freq: number, at: number, velocity: number, decay: number, warm: boolean): void {
    const ctx = this.ctx;
    const out = this.hands[slot]?.out;
    if (!ctx || !out || velocity < EPS) return;
    const v = this.claim(ctx.currentTime);
    const osc = ctx.createOscillator();
    if (warm && this.wave) osc.setPeriodicWave(this.wave);
    else osc.type = 'sine';
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(EPS, at);
    gain.gain.linearRampToValueAtTime(velocity, at + ATTACK);
    gain.gain.exponentialRampToValueAtTime(EPS, at + ATTACK + decay);
    osc.connect(gain).connect(out);
    v.osc = osc;
    v.gain = gain;
    v.hand = slot;
    v.start = at;
    v.end = at + ATTACK + decay + 0.02;
    osc.start(at);
    osc.stop(v.end);
    this.busy = true;
  }

  /** A free voice, or the one that started longest ago, faded out to make room. */
  private claim(now: number): Voice {
    let oldest = this.voices[0];
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (!v.gain || v.end <= now) {
        v.gain?.disconnect();
        return v;
      }
      if (v.start < oldest.start) oldest = v;
    }
    this.fade(oldest, now, 0.015);
    return oldest;
  }

  /** Drops this hand's notes that haven't started yet, so a quick re-pinch cancels the fall. */
  private cancelPending(slot: number, now: number): void {
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (!v.gain || v.hand !== slot || v.start <= now) continue;
      this.fade(v, now, 0.01);
      v.end = now + 0.02;
    }
  }

  private fade(v: Voice, now: number, time: number): void {
    if (!v.gain || !v.osc) return;
    const g = v.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(v.start > now ? 0 : g.value, now);
    g.linearRampToValueAtTime(0, now + time);
    v.osc.stop(now + time + 0.005);
  }

  private startHum(h: Hand, now: number): void {
    const ctx = this.ctx;
    if (!ctx || !h.out || h.hum) return;
    const hum = ctx.createOscillator();
    hum.type = 'sine';
    hum.frequency.value = pitch(h.root, scale(h.offset)) * 0.5;
    const vibrato = ctx.createOscillator();
    vibrato.frequency.value = 5.2;
    const depth = ctx.createGain();
    depth.gain.value = 7; // cents
    vibrato.connect(depth).connect(hum.detune);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    hum.connect(gain).connect(h.out);
    hum.start(now);
    vibrato.start(now);
    h.hum = hum;
    h.vibrato = vibrato;
    h.humGain = gain;
    this.busy = true;
  }

  private humTo(h: Hand, now: number, level: number): void {
    const g = h.humGain?.gain;
    if (!g || (level < EPS && g.value < EPS)) return;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(level, now + HUM_FADE);
    g.linearRampToValueAtTime(0, now + HUM_WATCHDOG);
  }

  private endHum(h: Hand, now: number, fade: number): void {
    if (h.hum && h.vibrato && h.humGain) {
      const g = h.humGain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + fade);
      h.hum.stop(now + fade + 0.02);
      h.vibrato.stop(now + fade + 0.02);
    }
    h.hum = null;
    h.vibrato = null;
    h.humGain = null;
  }

  private running(): AudioContext | null {
    return this.ctx && this.input && this.ctx.state === 'running' ? this.ctx : null;
  }

  /** Each hand's panner feeds one bus; a long dark room and a soft limiter sit after it. */
  private ensureBus(ctx: AudioContext): void {
    if (this.input) return;
    const input = ctx.createGain();
    input.gain.value = VOLUME;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 6;
    limiter.ratio.value = 4;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    dry.gain.value = 1 - WET;
    wet.gain.value = WET;
    const reverb = ctx.createConvolver();
    reverb.channelCount = 1; // mono send halves the convolution work; the room still comes back stereo
    reverb.channelCountMode = 'explicit';
    reverb.normalize = true;
    reverb.buffer = impulse(ctx);
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 3800;
    input.connect(dry).connect(limiter);
    input.connect(reverb).connect(tone).connect(wet).connect(limiter);
    limiter.connect(ctx.destination);
    // Fundamental plus a faint octave, twelfth and double octave: a soft celesta.
    this.wave = ctx.createPeriodicWave([0, 0, 0, 0, 0], [0, 1, 0.16, 0.05, 0.025]);
    for (let i = 0; i < this.hands.length; i++) {
      const out = ctx.createPanner();
      out.panningModel = 'HRTF';
      out.distanceModel = 'inverse';
      out.refDistance = 1.5;
      out.rolloffFactor = 0.3;
      out.connect(input);
      this.hands[i].out = out;
    }
    this.input = input;
  }
}

function makeHand(root: number, offset: number): Hand {
  return {
    root,
    offset,
    out: null,
    px: Infinity,
    py: Infinity,
    pz: Infinity,
    phase: 'idle',
    step: 0,
    pull: 0,
    lastNote: 0,
    releasedAt: -Infinity,
    landedAt: 0,
    low: 0,
    dipped: false,
    tinked: false,
    glint: false,
    lastGlint: -Infinity,
    hum: null,
    humGain: null,
    vibrato: null,
  };
}

function makeVoice(): Voice {
  return { osc: null, gain: null, hand: 0, start: 0, end: 0 };
}

/** Semitones above the root for a pentatonic step. */
function scale(step: number): number {
  return 12 * Math.floor(step / 5) + PENTATONIC[step % 5];
}

function pitch(root: number, semitones: number): number {
  return root * Math.pow(2, semitones / 12);
}

/** C, E or G in any octave. */
function isHome(semitones: number): boolean {
  const m = semitones % 12;
  return m === 0 || m === 4 || m === 7;
}

/** Sines sound louder as they climb; ease off a little per step. */
function tilt(step: number): number {
  return 1 / (1 + 0.05 * step);
}

/** Decaying noise that darkens as it fades. Leading silence is the pre-delay. */
function impulse(ctx: BaseAudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const pre = Math.floor(rate * PRE_DELAY);
  const length = Math.floor(rate * REVERB_DECAY);
  const buffer = ctx.createBuffer(2, pre + length, rate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let soft = 0;
    for (let i = 0; i < length; i++) {
      const fade = 1 - i / length;
      soft += (Math.random() * 2 - 1 - soft) * (0.25 + 0.6 * fade);
      data[pre + i] = soft * fade * fade * fade;
    }
  }
  return buffer;
}
