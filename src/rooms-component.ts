import { createComponent, Types } from '@iwsdk/core';

/**
 * Tunables for Rooms: glass boxes stacked in a grid frame, each looping its own clip, filmed by
 * a camera that cuts and flies between them on the song's beats. Where the frame stands is the
 * node's position; the stack itself is `rooms-layout.ts` and the edit is `rooms-score.ts`.
 */
export const RoomsLook = createComponent('RoomsLook', {
  glass: {
    type: Types.Float32, default: 0.7, min: 0, max: 2, step: 0.05, label: 'Glass',
    help: 'How bright the glass shells read at grazing angles, and their mist.',
  },
  dust: {
    type: Types.Float32, default: 1, min: 0, max: 1, step: 0.05, label: 'Dust',
    help: 'Share of the dust plume and box sparkles drawn. 0 turns them off.',
  },
  kick: {
    type: Types.Float32, default: 1, min: 0, max: 2, step: 0.05, label: 'Beat response',
    help: 'How hard edges, dust, fog and the camera answer each beat.',
  },
  focusDim: {
    type: Types.Float32, default: 0.75, min: 0, max: 1, step: 0.05, label: 'Front-view dim',
    help: 'How far the other boxes darken while the camera faces one.',
  },
  flash: {
    type: Types.Float32, default: 1, min: 0, max: 2, step: 0.05, label: 'Cut flash',
    help: 'How hard the edges, grid and glow flare on a cut.',
  },
  parallax: {
    type: Types.Float32, default: 1, min: 0, max: 3, step: 0.1, label: 'Mouse parallax',
    help: 'How far the overview leans with the mouse, in degrees per unit.',
  },
  bloom: {
    type: Types.Float32, default: 1.1, min: 0, max: 4, step: 0.05, label: 'Bloom',
    help: 'Glow strength. 0 turns bloom off.',
  },
  bloomThreshold: {
    type: Types.Float32, default: 0.35, min: 0, max: 1, step: 0.01, label: 'Bloom threshold',
    help: 'Linear brightness something needs before it glows.',
  },
  volume: { type: Types.Float32, default: 0.9, min: 0, max: 1, step: 0.01, label: 'Music volume' },
});
