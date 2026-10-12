import { createComponent, Types } from '@iwsdk/core';

/**
 * Tunables for Sorang: a painting that gains depth, splits into 100 depth slices of
 * stock-photo tiles, and bursts into particles around the viewer, in time with its song.
 */
export const SorangLook = createComponent('SorangLook', {
  size: {
    type: Types.Float32, default: 4, min: 0.5, max: 8, step: 0.01, label: 'Painting size (m)',
    help: 'The long side. The relief, fan, burst and orbits all scale with it.',
  },
  tiles: {
    type: Types.Int16, default: 96, min: 16, max: 128, step: 1, label: 'Tiles across',
    help: 'Tiles along the long side. Each tile is one stock photo.',
  },
  dust: {
    type: Types.Int16, default: 256, min: 0, max: 384, step: 8, label: 'Dust across',
    help: 'Dust points along each side, for the streaks and the fine particles. 0 turns it off.',
  },
  relief: {
    type: Types.Float32, default: 0.19, min: 0, max: 0.6, step: 0.01, label: 'Relief depth (× size)',
    help: 'How far the brightest paint stands forward, as a share of the painting size.',
  },
  radial: { type: Types.Float32, default: 0.5, min: 0, max: 2, step: 0.05, label: 'Radial push' },
  fan: {
    type: Types.Float32, default: 0.33, min: 0, max: 0.8, step: 0.01, label: 'Slice fan (× size)',
    help: 'How far the nearest sheet fans toward you, as a share of the painting size.',
  },
  mosaic: { type: Types.Float32, default: 0.9, min: 0, max: 2, step: 0.05, label: 'Photo contrast' },
  parallax: { type: Types.Float32, default: 0.15, min: 0, max: 0.5, step: 0.01, label: 'Mouse parallax (m)' },
  bloom: {
    type: Types.Float32, default: 1.4, min: 0, max: 4, step: 0.05, label: 'Bloom',
    help: 'Glow strength, once the pieces fly. Softer on the whole painting. 0 turns bloom off.',
  },
  bloomThreshold: {
    type: Types.Float32, default: 0.3, min: 0, max: 1, step: 0.01, label: 'Bloom threshold',
    help: 'Linear brightness a piece needs before it glows.',
  },
  volume: { type: Types.Float32, default: 0.9, min: 0, max: 1, step: 0.01, label: 'Music volume' },
});
