import { createComponent, Types } from '@iwsdk/core';

/**
 * Tunables for Rooms: five clips floating in a grid frame, each as a stack of its own frames
 * with the clip itself travelling through it, filmed by a camera that cuts and flies between them
 * on the song's beats. The look mirrors Frame stack's (ghost, trail, feather, glow). Where the
 * frame stands is the node's position; the rooms are `rooms-layout.ts` and the edit is
 * `rooms-score.ts`.
 */
export const RoomsLook = createComponent('RoomsLook', {
  ghost: {
    type: Types.Float32, default: 0.6, min: 0, max: 1, step: 0.01, label: 'Ghost frames',
    help: 'How strongly the stack of frames shows behind the playing one.',
  },
  trail: {
    type: Types.Float32, default: 5, min: 0, max: 16, step: 1, label: 'Trail',
    help: 'Frames either side of the playing one that light up with it.',
  },
  feather: { type: Types.Float32, default: 0.2, min: 0, max: 0.4, step: 0.01, label: 'Feather' },
  glow: { type: Types.Float32, default: 0.4, min: 0, max: 1, step: 0.01, label: 'Glow' },
  kick: {
    type: Types.Float32, default: 1, min: 0, max: 2, step: 0.05, label: 'Beat response',
    help: 'How hard the trail, glow, rulers, floor ring and camera answer each beat.',
  },
  focusDim: {
    type: Types.Float32, default: 0.75, min: 0, max: 1, step: 0.05, label: 'Front-view dim',
    help: 'How far the other rooms darken while the camera is on one.',
  },
  flash: {
    type: Types.Float32, default: 1, min: 0, max: 2, step: 0.05, label: 'Cut flash',
    help: 'How hard the glow, rulers and grid flare on a cut.',
  },
  parallax: {
    type: Types.Float32, default: 1, min: 0, max: 3, step: 0.1, label: 'Mouse parallax',
    help: 'How far the overview leans with the mouse, in degrees per unit.',
  },
  bloom: {
    type: Types.Float32, default: 0.8, min: 0, max: 4, step: 0.05, label: 'Bloom',
    help: 'Glow strength. 0 turns bloom off.',
  },
  bloomThreshold: {
    type: Types.Float32, default: 0.6, min: 0, max: 1, step: 0.01, label: 'Bloom threshold',
    help: 'Linear brightness something needs before it glows.',
  },
  volume: { type: Types.Float32, default: 0.9, min: 0, max: 1, step: 0.01, label: 'Music volume' },
});
