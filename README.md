# Frame stack and Jonze stretch

Two passthrough modes in one page.

**Frame stack** cuts a video into slices and stacks them along a time axis on a real table, with a filmstrip you scrub by touch.

**Jonze stretch** pinches the scanned room and pulls. The spot under your fingers follows your hand, the mesh around it bends, and a long pull turns into stripes of the column you grabbed. One hand or both. Let go and it springs back.

## Run

```
npm install
npm run dev
```

Open the HTTPS URL it prints in the Meta Quest browser (same network). Pick a mode, then press **Enter passthrough**.

### Frame stack

Rest an index fingertip on a table and hold still for about a second. The slider appears under your finger with the stack behind it.

- Hover just above the strip to preview frames. Touch and slide to scrub. Lift to stay on that frame.
- The round button on the left plays and pauses; the one on the right changes speed.
- **Move** puts it somewhere else. Your real hand occludes the table graphics.
- **Load video** on the 2D page slices your own clip (up to 128 frames).

### Jonze stretch

Finish **Space Setup** on the headset first, allow the camera when the page asks, then pinch the room and pull, with one hand or both.

- At rest nothing is drawn: you see plain passthrough. Only the surface you pull is drawn, and it feathers back into the real room at its edges.
- Pull sideways, up or down and the spot under your fingers slides along the surface. What's behind it stretches like taffy, and a longer pull turns into streaks of the column you grabbed.
- Pull toward yourself and the surface bursts outward from your fingers in streaks, with a slight lift toward you.
- Let go and that hand springs back with a wobble. Two hands work together: the second one grabs what you see after the first one has stretched it.
- The pull plays notes. A pinch strums a chord, pulling climbs a pentatonic scale, streaks add a sparkle, and letting go falls back and lands on a home chord. Each hand's notes come from the spot it grabbed.
- The picture comes from a small bank of camera frames taken while your head was steady, with your hands boxed out. A grab picks the cleanest recent frame that covers the spot, so your own hand doesn't end up in the streaks. Look around for a second after entering.
- Without a headset, `?preview=1` (or any browser without passthrough) runs the same material on a stand-in room. The wardrobe pulls apart on its own, and a webcam stands in for passthrough.

## Tuning

- `src/layout.ts`: stack size, strip length, touch and hover heights.
- The `FrameStack` component (scene JSON or the editor inspector): ghost, trail, length, lift, feather, glow.
- The `StretchLook` component: pull gain, sideways reach, stretch ramp, where stripes start, photo feather, wobble, spring stiffness and damping, the toward-you burst and lift, and the pinch ripple.
- Matching the camera to passthrough, also in `StretchLook`: photo exposure and warmth, camera focal scale and pitch, and camera latency.
- `MAX_LAYERS` in `src/frame-stack-system.ts`: raise it if the headset holds frame rate.
