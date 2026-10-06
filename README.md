# Frame stack and Jonze stretch

Two passthrough modes in one page.

**Frame stack** cuts a video into slices and stacks them along a time axis on a real table, with a filmstrip you scrub by touch.

**Jonze stretch** pulls a chunk of the scanned room like taffy. The pinch freezes a passthrough snapshot across that mesh — a couch and the wall behind it together — and the pull widens it into stripes. Let go and it springs back.

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

Finish **Space Setup** on the headset first, allow the camera when the browser asks, then point anywhere in the scan and pinch.

- In the headset the scanned triangles stay visible, tinted cooler than the passthrough, so you can check that the mesh sits on the room. Flat plane boxes stay hidden.
- The face you grab decides the stretch direction.
- The snapshot is what the passthrough camera saw at the pinch. The whole chunk's pixels widen into stripes along the pull.
- Let go and it springs back, wobbling.
- Without a headset the same motion runs on two stand-in boxes. A webcam snapshot stands in for passthrough so the smear can be tuned on a laptop.

## Tuning

- `src/layout.ts`: stack size, strip length, touch and hover heights.
- The `FrameStack` component (scene JSON or the editor inspector): ghost, trail, length, lift, feather, glow.
- The `StretchLook` component: pull gain, stretch cover (1 stretches the whole chunk), wobble, rings, glow, grain, spring stiffness and damping.
- `MAX_LAYERS` in `src/frame-stack-system.ts`: raise it if the headset holds frame rate.
