# Frame stack and Jonze stretch

Two passthrough modes in one page.

**Frame stack** cuts a video into slices and stacks them along a time axis on a real table, with a filmstrip you scrub by touch.

**Jonze stretch** pinches the scanned room and pulls. The spot under your fingers follows your hand, the surface behind it stretches like taffy with its real texture, and a long pull smears into streaks of the column you grabbed. One hand or both. Let go and it springs back.

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
- Pull sideways, up or down and the spot under your fingers slides along the surface. What's behind it stretches like taffy and keeps its real texture. Past about 15 cm the part nearest your fingers starts smearing into streaks along the pull, and by about half a metre they are long stripes in the surface's own colours.
- Pull a table edge toward yourself and it stretches toward you the same way. Pull a wall, or a table straight up off itself, and the surface also bursts outward from your fingers, with a slight lift toward you.
- Let go and that hand springs back with a wobble. Two hands work together: the second one grabs what you see after the first one has stretched it.
- The pull plays notes. A pinch strums a chord, pulling climbs a pentatonic scale, a soft hum and a sparkle join as the streaks bloom, and letting go falls back and lands on a home chord. Each hand's notes come from the spot it grabbed.
- The picture comes from a small bank of camera frames taken while your head was steady, with your hands boxed out. A grab picks the cleanest recent frame that covers the spot, so your own hand doesn't end up in the stretch. If no frame covers the spot, the pinch lets go instead of bending something you can't see. Look around for a second after entering.
- Tables, floors and walls that Quest detected as planes are flat. Where the scanned mesh lies within about 2 cm of a plane, facing the same way and inside its outline, it is snapped onto the plane. A pinch on a plane grabs the plane's point and normal. The console's `pinch …` line says `hit=plane:table` or `hit=mesh`.
- Your real hands and arms stay in front of a stretch. The headset's depth map cuts them out of the stretched surface around each tracked hand, so their edges are the real ones. Where depth sensing is unavailable, depth-only spheres on the joints and a capsule on each forearm do it instead. Those trail tracking by 30 ms, the delay of passthrough's own image of the hand.
- Without a headset, `?preview=1` (or any browser without passthrough) runs the same material on a stand-in room. The wardrobe pulls apart on its own, and a webcam stands in for passthrough.
- A small console panel at the upper left of the headset view shows the page's console: camera, photo and pull lines, warnings and errors. It is on under `npm run dev`; `?debug=0` hides it for recordings, `?debug=1` forces it on in a build.

## Tuning

- `src/layout.ts`: stack size, strip length, touch and hover heights.
- The `FrameStack` component (scene JSON or the editor inspector): ghost, trail, length, lift, feather, glow.
- The `StretchLook` component: pull gain, sideways reach, stretch ramp, where streaks start (metres of pull; 3 turns them off), photo feather, wobble, spring stiffness and damping, the burst and lift, and the pinch ripple.
- Matching the camera to passthrough: the lens model is measured for Quest 3 (851 px at 1280 wide, tilted 11.8° down, in front of its own eye) and the left room camera is used. `StretchLook` has photo exposure and warmth, plus developer-only lens trims (focal, pitch/yaw/roll, offset, side) and camera latency; any non-neutral trim is printed to the console.
- Checking that alignment: `?debug=1&lens=overlay` draws the live camera in 48-px diagonal stripes over the room while nothing is pinched. Hold still and look along an edge: where it continues straight across the stripes, the camera model matches passthrough. A copy that is bigger everywhere points at focal length, bigger only up close at the forward offset, a constant shift at the mount angles or side, and an error only while turning at timing.
- Checking the hand cut: `?debug=1&occ=debug` paints what the depth map cuts out around your hands magenta instead of cutting it. The console's `depth …` line says whether depth arrived and how it is aligned. `StretchLook` has the occluder lag as a developer trim.
- `MAX_LAYERS` in `src/frame-stack-system.ts`: raise it if the headset holds frame rate.
