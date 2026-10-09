import { createComponent, Types } from '@iwsdk/core';

/** Which visor camera the photos are posed from. Auto trusts the device label. */
export const CameraSide = { Auto: 'auto', Left: 'left', Right: 'right' } as const;

/**
 * Tunables for the rubber pull, on one node so they can be nudged from the editor
 * inspector while wearing the headset's output on a desk screen.
 */
export const StretchLook = createComponent('StretchLook', {
  gain: { type: Types.Float32, default: 1, min: 0.2, max: 4, step: 0.05, label: 'Pull gain' },
  reach: { type: Types.Float32, default: 0.45, min: 0.05, max: 2, step: 0.01, label: 'Sideways reach' },
  ramp: { type: Types.Float32, default: 0.35, min: 0.05, max: 2, step: 0.01, label: 'Stretch ramp' },
  stripes: {
    type: Types.Float32, default: 0.15, min: 0, max: 3, step: 0.01, label: 'Streaks start (m)',
    help: 'Metres of pull before the grabbed column smears into streaks; full 0.35 m later. 3 turns them off.',
  },
  feather: { type: Types.Float32, default: 0.04, min: 0, max: 0.25, step: 0.005, label: 'Photo feather' },
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
  exposure: { type: Types.Float32, default: 1.1, min: 0.5, max: 2, step: 0.01, label: 'Photo exposure' },
  warmth: {
    type: Types.Float32, default: -0.1, min: -0.5, max: 0.5, step: 0.01, label: 'Photo warmth',
    help: 'Negative cools the camera photo toward the passthrough look.',
  },
  tint: {
    type: Types.Float32, default: 0, min: -0.5, max: 0.5, step: 0.01, label: 'Photo tint',
    help: 'Positive adds green, negative adds magenta.',
  },
  // The camera model is measured (851 px, 11.8° down, in front of its own eye). These are developer
  // trims on top of it, all neutral by default; any non-neutral value is printed to the console.
  lensScale: { type: Types.Float32, default: 1, min: 0.9, max: 1.1, step: 0.002, label: 'Lens focal trim (x)' },
  lensPitchTrim: { type: Types.Float32, default: 0, min: -5, max: 5, step: 0.05, label: 'Lens pitch trim (deg)' },
  lensYawTrim: { type: Types.Float32, default: 0, min: -3, max: 3, step: 0.05, label: 'Lens yaw trim (deg)' },
  lensRollTrim: { type: Types.Float32, default: 0, min: -3, max: 3, step: 0.05, label: 'Lens roll trim (deg)' },
  lensDx: { type: Types.Float32, default: 0, min: -0.05, max: 0.05, step: 0.001, label: 'Lens x trim (m, outward)' },
  lensDy: { type: Types.Float32, default: 0, min: -0.05, max: 0.05, step: 0.001, label: 'Lens y trim (m)' },
  lensDz: { type: Types.Float32, default: 0, min: -0.05, max: 0.05, step: 0.001, label: 'Lens z trim (m, back)' },
  cameraSide: {
    type: Types.Enum, enum: CameraSide, default: CameraSide.Auto, label: 'Camera side',
    help: 'Which visor camera the photos come from. Auto trusts the device label.',
  },
  cameraLatency: { type: Types.Float32, default: 0.07, min: 0, max: 0.2, step: 0.005, label: 'Camera latency (s)' },
  linearBlend: {
    type: Types.Boolean, default: true, label: 'Linear edge blend',
    help: 'Premultiply in linear light. Turn off only to compare edges on a new headset build.',
  },
});
