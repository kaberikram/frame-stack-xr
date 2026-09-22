import { createComponent, Types } from '@iwsdk/core';

/**
 * A frame stack rig: a video cut into slices and stacked along a time axis on the
 * table, with a filmstrip slider in front of it. These mirror the browser version's
 * sliders, so they can be tuned from the scene editor's inspector.
 */
export const FrameStack = createComponent('FrameStack', {
  ghost: { type: Types.Float32, default: 1, min: 0, max: 1, step: 0.01, label: 'Ghost frames' },
  trail: { type: Types.Float32, default: 16, min: 0, max: 16, step: 1, label: 'Trail' },
  length: { type: Types.Float32, default: 2, min: 0.3, max: 3, step: 0.05, label: 'Length' },
  lift: { type: Types.Float32, default: 0.15, min: 0, max: 1, step: 0.01, label: 'Lift current frame' },
  feather: { type: Types.Float32, default: 0.4, min: 0, max: 0.4, step: 0.01, label: 'Feather' },
  glow: { type: Types.Float32, default: 1, min: 0, max: 1, step: 0.01, label: 'Glow' },
});
