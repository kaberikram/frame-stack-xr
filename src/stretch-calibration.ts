/**
 * In-headset grade for the stretch photo. Open the link with `?calibrate=1`.
 * Left pinch steps to the next setting. Right pinch, dragged sideways, changes it.
 * Values stay on this headset and are printed as JSON so they can be baked into defaults.
 */

const STORAGE_KEY = 'jonze-stretch-grade';

export const CALIBRATE_URL = new URLSearchParams(window.location.search).get('calibrate') === '1';

export interface StretchGrade {
  exposure: number;
  warmth: number;
  tint: number;
  saturation: number;
  contrast: number;
  blackLift: number;
  lensScale: number;
  lensPitch: number;
}

interface Knob {
  key: keyof StretchGrade;
  label: string;
  min: number;
  max: number;
  step: number;
}

const KNOBS: readonly Knob[] = [
  { key: 'exposure', label: 'Exposure', min: 0.5, max: 2, step: 0.02 },
  { key: 'warmth', label: 'Warmth', min: -0.5, max: 0.5, step: 0.02 },
  { key: 'tint', label: 'Tint', min: -0.5, max: 0.5, step: 0.02 },
  { key: 'saturation', label: 'Saturation', min: 0, max: 2, step: 0.02 },
  { key: 'contrast', label: 'Contrast', min: 0.5, max: 1.6, step: 0.02 },
  { key: 'blackLift', label: 'Black lift', min: 0, max: 0.25, step: 0.005 },
  { key: 'lensScale', label: 'Focal scale', min: 0.8, max: 1.2, step: 0.005 },
  { key: 'lensPitch', label: 'Pitch', min: -30, max: 0, step: 0.25 },
];

let stored: StretchGrade | null | undefined;

function readStored(): StretchGrade | null {
  if (stored !== undefined) return stored;
  stored = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StretchGrade>;
    const grade = {} as StretchGrade;
    for (let i = 0; i < KNOBS.length; i++) {
      const knob = KNOBS[i];
      const value = parsed[knob.key];
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      grade[knob.key] = clamp(value, knob.min, knob.max);
    }
    stored = grade;
  } catch {
    stored = null;
  }
  return stored;
}

/** Copies a saved grade onto `look`. No-op until this headset has calibrated once. */
export function applyStoredGrade(look: StretchGrade): void {
  const grade = readStored();
  if (!grade) return;
  for (let i = 0; i < KNOBS.length; i++) {
    const key = KNOBS[i].key;
    look[key] = grade[key];
  }
}

function writeStored(look: StretchGrade, log: boolean): void {
  const grade = {} as StretchGrade;
  for (let i = 0; i < KNOBS.length; i++) {
    const key = KNOBS[i].key;
    grade[key] = look[key];
  }
  stored = grade;
  const json = JSON.stringify(grade);
  try {
    localStorage.setItem(STORAGE_KEY, json);
  } catch {
    // Private mode can refuse storage. The console line is still the copy to bake in.
  }
  if (log) console.info('[jonze] grade', json);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class StretchCalibration {
  readonly card = { title: 'Exposure', body: '1.00' };
  private index = 0;
  private leftWas = false;
  private leftArmed = false;
  private rightWas = false;
  private rightArmed = false;
  private drag = 0;
  private moved = 0;

  /**
   * Left pinch (rising, after the fingers have been seen apart) selects the next setting.
   * Right pinch drags along `travel`, which is the pinch measured on the head's right axis.
   */
  steer(leftClosed: boolean, rightClosed: boolean, travel: number, look: StretchGrade): void {
    if (!leftClosed) this.leftArmed = true;
    if (leftClosed && this.leftArmed && !this.leftWas) {
      this.index = (this.index + 1) % KNOBS.length;
      writeStored(look, true);
    }
    this.leftWas = leftClosed;

    if (!rightClosed) this.rightArmed = true;
    if (rightClosed && this.rightArmed) {
      if (!this.rightWas) this.drag = travel;
      const delta = travel - this.drag;
      this.drag = travel;
      const knob = KNOBS[this.index];
      const next = clamp(look[knob.key] + delta * ((knob.max - knob.min) / 0.22), knob.min, knob.max);
      if (next !== look[knob.key]) {
        look[knob.key] = next;
        this.moved += Math.abs(delta);
        writeStored(look, this.moved > 0.01);
        if (this.moved > 0.01) this.moved = 0;
      }
    } else if (this.rightWas && this.moved > 0) {
      this.moved = 0;
      writeStored(look, true);
    }
    this.rightWas = rightClosed;
  }

  /** Refreshes the card from the current knob. Cheap when nothing changed. */
  present(look: StretchGrade): void {
    const knob = KNOBS[this.index];
    const digits = knob.step < 0.01 ? 3 : 2;
    const body = look[knob.key].toFixed(digits);
    if (this.card.title === knob.label && this.card.body === body) return;
    this.card.title = knob.label;
    this.card.body = body;
  }
}
