# Frame stack, on your table

A video cut into slices and stacked along a time axis, sitting on a real table in
Quest passthrough, with a filmstrip slider you scrub by touching the table.

## Run

```
npm install
npm run dev
```

Open the HTTPS URL it prints in the Meta Quest browser (same network), press
**Enter passthrough**, then rest an index fingertip on a table and hold still for
about a second. The slider appears under your finger with the stack behind it.

- Hover just above the strip to preview frames. Touch and slide to scrub. Lift to stay on that frame.
- The round button on the left plays and pauses; the one on the right changes speed.
- **Move** puts it somewhere else. Your real hand occludes the table graphics.
- **Load video** on the 2D page slices your own clip (up to 128 frames).

## Tuning

- `src/layout.ts`: stack size, strip length, touch and hover heights.
- The `FrameStack` component (scene JSON or the editor inspector): ghost, trail,
  length, lift, feather, glow, same as the browser version's sliders.
- `MAX_LAYERS` in `src/frame-stack-system.ts`: raise it if the headset holds frame rate.
