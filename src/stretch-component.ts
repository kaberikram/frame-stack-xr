import { createComponent, Types } from '@iwsdk/core';

/**
 * Tunables for the rubber pull, on one node so they can be nudged from the editor
 * inspector while wearing the headset's output on a desk screen.
 */
export const StretchLook = createComponent('StretchLook', {
  gain: { type: Types.Float32, default: 1, min: 0.2, max: 4, step: 0.05, label: 'Pull gain' },
  reach: { type: Types.Float32, default: 0.45, min: 0.05, max: 2, step: 0.01, label: 'Sideways reach' },
  ramp: { type: Types.Float32, default: 0.35, min: 0.05, max: 2, step: 0.01, label: 'Stretch ramp' },
  stripes: { type: Types.Float32, default: 0.5, min: 0, max: 3, step: 0.05, label: 'Stripes start' },
  feather: { type: Types.Float32, default: 0.06, min: 0, max: 0.25, step: 0.005, label: 'Photo feather' },
  wobble: { type: Types.Float32, default: 0.04, min: 0, max: 0.2, step: 0.005, label: 'Wobble' },
  waveLength: { type: Types.Float32, default: 0.45, min: 0.05, max: 2, step: 0.05, label: 'Wobble wavelength' },
  waveSpeed: { type: Types.Float32, default: 7, min: 0, max: 30, step: 0.5, label: 'Wobble speed' },
  stiffness: { type: Types.Float32, default: 90, min: 10, max: 400, step: 5, label: 'Spring stiffness' },
  damping: { type: Types.Float32, default: 9, min: 1, max: 40, step: 0.5, label: 'Spring damping' },
  meshTint: { type: Types.Float32, default: 0.85, min: 0, max: 1, step: 0.01, label: 'Idle tint' },
});
