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
- Pull sideways, up or down and the spot under your fingers slides along the surface. What's behind it stretches like taffy and keeps its real texture. Past about 11° of pull, as seen from your head, the part nearest your fingers starts smearing into streaks along the pull, and by about 35° they are long stripes in the surface's own colours. In angle, so a far table streaks after the same hand move as a near one.
- Pull a table edge toward yourself and it stretches toward you the same way. Pull a wall, or a table straight up off itself, and the surface also bursts outward from your fingers, with a slight lift toward you.
- Let go and that hand springs back with a wobble. Two hands work together. Pinch with both at once and each stretches the surface as it was, so pulling them apart stretches what is between them. Pinch with the second hand after the first has stretched something, and it grabs what you see.
- The pull plays notes. A pinch strums a chord, pulling climbs a pentatonic scale, a soft hum and a sparkle join as the streaks bloom, and letting go falls back and lands on a home chord. Each hand's notes come from the spot it grabbed.
- The picture comes from a small bank of camera frames taken while your head was steady, with your hands and forearms cut out of each one. A grab picks the best recent frame that covers the spot with no hand on it, plus a second frame behind it that fills whatever the first is missing. Where neither has the picture, you see the real room. If no frame covers the spot at all, the pinch lets go instead of bending something you can't see. Look around for a second after entering.
- Every scanned mesh, walls and furniture alike, is merged and subdivided to about 5 cm within 1.5 m of you, coarser further away, so anything bends smoothly. Tables, floors and walls that Quest detected as planes are flat: where the mesh lies within about 2 cm of a plane, facing the same way and inside its outline, it is snapped onto the plane. A pinch on a plane grabs the plane's point and normal, including through clutter up to 8 cm high on a table. The console's `pinch …` line says `hit=plane:table`, or `hit=mesh` with the nearest plane it rejected, and which scan was hit.
- Experimental, `?raise=1`: things the scan missed (a lamp, a plush toy, the glass of a door) come from the headset's depth. At a pinch it is frozen, with your hands filled in from around them, and scanned points 3-80 cm behind a real surface slide onto it before they bend. Off by default: the depth map is coarse, so it lifts some points and not their neighbours, and a pull tears there. The `pinch …` line says `raise=y` when it ran.
- Only what a pull can reach is drawn with the stretch program: the room is split into half-metre chunks, and the rest draws depth only, so a nearer real surface still hides a stretch. `?cull=0` draws all of it, to compare frame times.
- Your real hands and arms stay in front of a stretch. Depth-only spheres on the joints and a capsule up each forearm, aimed at the elbow from a shoulder model, hide the stretch behind them. They trail tracking by 30 ms, the delay of passthrough's own image of the hand, except the pinching fingertips. Where the headset's depth map is available it also cuts the stretch wherever the real surface is at a tracked hand's depth along your line of sight, so the hand's real edge shows. A mug or a lamp beside your hand is not cut.
- Without a headset, `?preview=1` (or any browser without passthrough) runs the same material on a stand-in room. The wardrobe pulls apart on its own, and a webcam stands in for passthrough.
- A small console panel at the upper left of the headset view shows the page's console: camera, photo and pull lines, warnings and errors. It is on under `npm run dev`; `?debug=0` hides it for recordings, `?debug=1` forces it on in a build. Its header shows, once a second, the frame rate and 95th-percentile frame time (ms), the stretch update's mean/max ms, three's render call on the CPU, that render's GPU time where the browser has timer queries, draw calls, triangles, and room chunks drawn with the stretch program.

## Tuning

- `src/layout.ts`: stack size, strip length, touch and hover heights.
- The `FrameStack` component (scene JSON or the editor inspector): ghost, trail, length, lift, feather, glow.
- The `StretchLook` component: pull gain, sideways reach, stretch ramp (it grows with distance past 0.8 m), where streaks start (degrees of pull; 90 turns them off), photo feather, wobble, spring stiffness and damping, the burst and lift, and the pinch ripple.
- Matching the camera to passthrough: the lens model is measured for Quest 3 (863 px at 1280 wide, tilted 11.8° down, in front of its own eye) and the left room camera is used. Frames are posed 25 ms before their capture stamp. `StretchLook` has photo exposure and warmth, plus developer-only lens trims (focal, pitch/yaw/roll, offset, side) and camera latency; any non-neutral trim is printed to the console. For a quick headset check without a build, the URL can set the focal length, yaw, pitch and frame delay: `?lensf=863&yaw=-0.23&pitch=-11.77&tau=0.025`. The `lens …` line shows which came from the URL.
- Checking that alignment: `?debug=1&lens=overlay` draws the live camera in 48-px diagonal stripes over the room while nothing is pinched, each frame paired with the pose it was taken from, like a photo. Hold still and look along an edge: where it continues straight across the stripes, the camera model matches passthrough. A copy that is bigger everywhere points at focal length, bigger only up close at the forward offset, a constant shift at the mount angles or side, and an error only while turning at timing. With `?raise=1` the stripes also show the depth-raised objects, refreshed live.
- Checking the hand cut: `?debug=1&occ=debug` shows the hand occluders 30% green, where the depth cut may act faint cyan, and what it cuts magenta instead of cutting it. `?debug=1&occ=delta` paints the real depth against the scanned room: white where they agree, red where the real surface is nearer, blue where it is farther, over 8 cm. The console keeps its `depth …`, `xr multiview …`, `camera pick …` and `lens …` lines on screen. `StretchLook` has the occluder lag as a developer trim.
- Timing a pull: each pull prints two `onset` lines at release, with its first 12 frames: frame times, how long the photo freeze and that frame's update took, how far the surface had moved (cm) and the fade (0-9). A hitch is one long frame; a pop is a jump in D.
- `MAX_LAYERS` in `src/frame-stack-system.ts`: raise it if the headset holds frame rate.
