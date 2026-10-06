import { createComponent, Types } from '@iwsdk/core';

/**
 * Tunables for the stretch, on one node so they can be nudged from the editor
 * inspector while wearing the headset's output on a desk screen.
 */
export const StretchLook = createComponent('StretchLook', {
  gain: { type: Types.Float32, default: 3, min: 1, max: 8, step: 0.1, label: 'Pull gain' },
  band: { type: Types.Float32, default: 1, min: 0.02, max: 1, step: 0.01, label: 'Stretch cover' },
  wobble: { type: Types.Float32, default: 0.05, min: 0, max: 0.2, step: 0.005, label: 'Wobble' },
  waveLength: { type: Types.Float32, default: 0.45, min: 0.05, max: 2, step: 0.05, label: 'Wobble wavelength' },
  waveSpeed: { type: Types.Float32, default: 7, min: 0, max: 30, step: 0.5, label: 'Wobble speed' },
  ringSpacing: { type: Types.Float32, default: 0.22, min: 0.03, max: 1, step: 0.01, label: 'Ring spacing' },
  ringSpeed: { type: Types.Float32, default: 0.5, min: -3, max: 3, step: 0.05, label: 'Ring speed' },
  glow: { type: Types.Float32, default: 0.8, min: 0, max: 2, step: 0.05, label: 'Glow' },
  grain: { type: Types.Float32, default: 16, min: 2, max: 64, step: 1, label: 'Grain' },
  stiffness: { type: Types.Float32, default: 90, min: 10, max: 400, step: 5, label: 'Spring stiffness' },
  damping: { type: Types.Float32, default: 9, min: 1, max: 40, step: 0.5, label: 'Spring damping' },
});
