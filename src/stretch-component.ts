import { createComponent, Types } from '@iwsdk/core';

/**
 * Tunables for the rubber pull, on one node so they can be nudged from the editor
 * inspector while wearing the headset's output on a desk screen.
 */
export const StretchLook = createComponent('StretchLook', {
  gain: { type: Types.Float32, default: 1, min: 0.2, max: 4, step: 0.05, label: 'Pull gain' },
  reach: { type: Types.Float32, default: 0.45, min: 0.05, max: 2, step: 0.01, label: 'Sideways reach' },
  ramp: { type: Types.Float32, default: 0.35, min: 0.05, max: 2, step: 0.01, label: 'Stretch ramp' },
  stripes: { type: Types.Float32, default: 0.2, min: 0, max: 3, step: 0.05, label: 'Stripes start' },
  feather: { type: Types.Float32, default: 0.12, min: 0, max: 0.25, step: 0.005, label: 'Photo feather' },
  wobble: { type: Types.Float32, default: 0.035, min: 0, max: 0.06, step: 0.005, label: 'Wobble' },
  waveLength: { type: Types.Float32, default: 0.45, min: 0.05, max: 2, step: 0.05, label: 'Wobble wavelength' },
  waveSpeed: { type: Types.Float32, default: 7, min: 0, max: 30, step: 0.5, label: 'Wobble speed' },
  stiffness: { type: Types.Float32, default: 90, min: 10, max: 400, step: 5, label: 'Spring stiffness' },
  damping: { type: Types.Float32, default: 9, min: 1, max: 40, step: 0.5, label: 'Spring damping' },
  depthPull: {
    type: Types.Float32, default: 0.35, min: 0, max: 1, step: 0.05, label: 'Toward-you lift',
    help: 'How much of a pull toward you lifts the surface. The rest bursts outward along it.',
  },
  radial: {
    type: Types.Float32, default: 2.5, min: 0, max: 6, step: 0.1, label: 'Toward-you burst',
    help: 'Metres of outward burst per metre the hand comes toward you.',
  },
  ripple: { type: Types.Float32, default: 0.015, min: 0, max: 0.02, step: 0.001, label: 'Pinch ripple' },
  exposure: { type: Types.Float32, default: 1, min: 0.5, max: 2, step: 0.01, label: 'Photo exposure' },
  warmth: {
    type: Types.Float32, default: -0.06, min: -0.5, max: 0.5, step: 0.01, label: 'Photo warmth',
    help: 'Negative cools the camera photo toward the passthrough look.',
  },
  tint: {
    type: Types.Float32, default: 0, min: -0.5, max: 0.5, step: 0.01, label: 'Photo tint',
    help: 'Positive adds green, negative adds magenta.',
  },
  saturation: { type: Types.Float32, default: 0.9, min: 0, max: 2, step: 0.01, label: 'Saturation' },
  contrast: { type: Types.Float32, default: 0.95, min: 0.5, max: 1.6, step: 0.01, label: 'Contrast' },
  blackLift: {
    type: Types.Float32, default: 0.02, min: 0, max: 0.25, step: 0.005, label: 'Black lift',
    help: 'Raises photo shadows. Passthrough shadows are lifted.',
  },
  grain: { type: Types.Float32, default: 0.04, min: 0, max: 0.2, step: 0.005, label: 'Grain' },
  edgeNoise: { type: Types.Float32, default: 0.5, min: 0, max: 2, step: 0.05, label: 'Edge noise' },
  softness: { type: Types.Float32, default: 0.8, min: 0, max: 3, step: 0.05, label: 'Photo softness' },
  shadow: { type: Types.Float32, default: 0.32, min: 0, max: 1, step: 0.02, label: 'Contact shadow' },
  shade: { type: Types.Float32, default: 0.45, min: 0, max: 1, step: 0.02, label: 'Bend shading' },
  lensScale: { type: Types.Float32, default: 1, min: 0.8, max: 1.2, step: 0.005, label: 'Camera focal scale' },
  lensPitch: { type: Types.Float32, default: -15, min: -30, max: 0, step: 0.25, label: 'Camera pitch (deg)' },
  cameraLatency: { type: Types.Float32, default: 0.07, min: 0, max: 0.2, step: 0.005, label: 'Camera latency (s)' },
  calibrate: {
    type: Types.Boolean, default: false, label: 'Calibrate',
    help: 'Checker the live camera over the room to line up focal scale, pitch, exposure and warmth.',
  },
  linearBlend: {
    type: Types.Boolean, default: true, label: 'Linear edge blend',
    help: 'Premultiply in linear light. Turn off only to compare edges on a new headset build.',
  },
});
