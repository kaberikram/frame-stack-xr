import { createComponent, Types } from '@iwsdk/core';

/**
 * Tunables for Sorang: a painting that gains depth, splits into 100 depth slices of
 * stock-photo tiles, and bursts into particles around the viewer.
 */
export const SorangLook = createComponent('SorangLook', {
  size: { type: Types.Float32, default: 1.83, min: 0.5, max: 4, step: 0.01, label: 'Painting size (m)' },
  tiles: {
    type: Types.Int16, default: 64, min: 16, max: 128, step: 1, label: 'Tiles across',
    help: 'Tiles along the long side. Each tile is one stock photo.',
  },
  dust: {
    type: Types.Int16, default: 256, min: 0, max: 384, step: 8, label: 'Dust across',
    help: 'Dust points along each side, for the streaks and the fine particles. 0 turns it off.',
  },
  relief: { type: Types.Float32, default: 0.35, min: 0, max: 1.2, step: 0.01, label: 'Relief depth (m)' },
  radial: { type: Types.Float32, default: 0.5, min: 0, max: 2, step: 0.05, label: 'Radial push' },
  fan: { type: Types.Float32, default: 0.6, min: 0, max: 1.5, step: 0.05, label: 'Slice fan (m)' },
  mosaic: { type: Types.Float32, default: 0.9, min: 0, max: 2, step: 0.05, label: 'Photo contrast' },
  parallax: { type: Types.Float32, default: 0.15, min: 0, max: 0.5, step: 0.01, label: 'Mouse parallax (m)' },
  pace: { type: Types.Float32, default: 1, min: 0.25, max: 3, step: 0.05, label: 'Pace' },
  reformSpeed: { type: Types.Float32, default: 3, min: 1, max: 8, step: 0.25, label: 'Reform speed' },
});
