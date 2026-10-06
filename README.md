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

Finish **Space Setup** on the headset first, allow the camera when the browser asks, then pinch the room and pull, with one hand or both.

- The scanned room is drawn as a denser copy of the global mesh, tinted cooler than the camera until you pinch. Furniture boxes stay hidden.
- Each pinch grabs the surface behind that hand. The spot follows your fingers, and the mesh around it bends like rubber.
- A small pull looks stretched. A long pull turns the stretched part into stripes of the column you grabbed. Two hands blend in the middle.
- The snapshot is a frame from before your hands covered the camera, when one is available.
- Let go and that hand springs back. When both are at rest, the snapshot fades back to the idle tint.
- Without a headset the same material runs on a stand-in room. The wardrobe pulls apart on its own, and a webcam stands in for passthrough.

## Tuning

- `src/layout.ts`: stack size, strip length, touch and hover heights.
- The `FrameStack` component (scene JSON or the editor inspector): ghost, trail, length, lift, feather, glow.
- The `StretchLook` component: pull gain, sideways reach, stretch ramp, where stripes start, photo feather, wobble, spring stiffness and damping, and the idle tint (0 hides the mesh until you pull).
- `MAX_LAYERS` in `src/frame-stack-system.ts`: raise it if the headset holds frame rate.
