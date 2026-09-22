/**
 * Rig-local layout, in meters. The rig's origin sits on the table surface where the
 * fingertip rested, at the slider's center: +x is the user's right, -z points away.
 */

/** Slice height on the table. The browser version used 1.2 world units. */
export const FRAME_H = 0.16;
/** Browser-version units to meters, so every original constant keeps its proportion. */
export const UNIT = FRAME_H / 1.2;
/** Gap between the slices and the box outline. */
export const PAD = 0.035 * UNIT;
/** Time axis runs left to right with the film strip, ruler on the near side. */
export const STACK_YAW = -Math.PI / 2;

export const STRIP_LENGTH = 0.4;
export const STRIP_DEPTH = 0.032;
/** Clearance between the strip's far edge and the stack's footprint. */
export const STRIP_GAP = 0.05;
/** Table graphics float this far above the surface. */
export const SURFACE_Y = 0.0015;

export const BUTTON_R = 0.017;
export const PLAY_X = -STRIP_LENGTH / 2 - 0.038;
export const SPEED_X = STRIP_LENGTH / 2 + 0.038;
export const MOVE_W = 0.052;
export const MOVE_H = 0.024;
export const MOVE_X = SPEED_X + BUTTON_R + 0.016 + MOVE_W / 2;

/** Touch tuning. Heights are the fingertip joint above where it rested on the table. */
export const TOUCH_DOWN = 0.01;
export const TOUCH_UP = 0.02;
export const HOVER_MAX = 0.05;
/** A fingertip this close to the frame volume is touching the stack. */
export const STACK_TOUCH = 0.02;
/** A drag keeps scrubbing until the finger is this far outside the volume. */
export const STACK_DRAG = 0.06;
/** Extra reach around controls, so a finger that lands slightly off still counts. */
export const STRIP_PAD_X = 0.012;
export const STRIP_PAD_Z = 0.025;
export const BUTTON_SLOP = 0.012;
