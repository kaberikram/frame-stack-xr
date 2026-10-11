# Frame stack, Jonze stretch and Sorang

Two passthrough modes and a desktop preview in one page.

**Frame stack** cuts a video into slices and stacks them along a time axis on a real table, with a filmstrip you scrub by touch.

**Jonze stretch** pinches the scanned room and pulls. The spot under your fingers follows your hand, the surface behind it stretches like taffy with its real texture, and a long pull smears into streaks of the column you grabbed. One hand or both. Let go and it springs back.

**Sorang** hangs a painting in the dark, as tall as you. It takes on depth, splits into 100 slices by depth, turns out to be a mosaic of 100 stock photos, and then the pieces fly out and orbit you. Desktop only for now.

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
- Pull toward yourself and the pinched spot comes with your fingers like cloth pinched between them. Pinch a surface right under your fingers (a table, the paper on it) and the spot follows your fingertips whichever way they go: drag it toward your chest and it leans after them as a pointed tent while its base drags along behind (only 40% of a pull toward you slides; sideways still slides in full), and lift your hand and it rises. Pinch a far wall and the tip sits on your line of sight through your fingers, just behind them, coming the same share of its way as your hand came of its own (up to 70%, and 1.2 m). In between it blends the two. Its sides run taut to a soft hem, five folds crease down them (shaded, so they read in a flat photo), and the hem is drawn in a little toward the pinch. Past the photo frozen for it, it shows the real room. The `pull …` line says what held it, `lift.30(hand)`, `(tip)` when it sits just behind your fingers, or `(cap)`, and how near the surface was, from `n1` (on it) to `n0` (across the room). A drag toward you streaks like a slide of the same size, and very long pulls also carry the pinched spot's colours up into the tip. Walls, and tables pulled straight up off themselves, also burst a little outward from your fingers.
- Hold an index fingertip within about 25 cm of a surface without pinching, and the surface is sucked up toward it: a narrow neck rising out of a wide base, drawn in hard toward the point under your finger. About 5 cm at 20 cm away, 10 cm at 15 cm, then reaching to just short of your fingertip up close. It follows your finger across the surface and springs back with a wobble when you move away. It rises from whatever is under the finger (a book on the table, not the table under it). It shows a recent clean photo of that spot, or after half a second without one, the live view with your hands cut out (your finger covers the cut). Pinch from there and it becomes a normal pull. Each one prints a `hover … from … to … photo bank|live|none` line.
- Push a wall in like a box. Look at a wall, raise an open palm facing it in front of your eyes (ready for a high five) and hold it still for a moment: the section of wall in front of you is captured, about a third of what you see (1.2 m wide on a wall 2 m away), and gives a couple of centimetres so you see its outline. Push your palm forward and that rectangle sinks into the wall as a box: its back is the wall itself, and its sides are the rim's colours drawn out along the depth into streaks, darker the deeper they go. About 20 cm of push takes it 0.8 m in, the same look at any distance, up to 2.5 m. Lower or close your hand and it stays in. Raise a palm on it again to push it deeper, or pull your palm back toward you to bring it out (let go nearly flat and it pops back). Pinch inside it and it springs back out of the wall with a wobble. A second palm on the box joins the push. Raising a palm on another stretch of wall springs the old box back first, then captures the new one. The box shows a clean photo with no hand anywhere on it, shrinking to fit what the camera saw and the wall's detected outline; anything standing in front of the wall stays in front of it. The console prints `push R wall 2.1m 1.20x.96 …` when it captures, `push R rest .92m …` when you let go, and `push R? …` when an open palm won't capture (no wall, too far, not facing it, touching it).
- Let go and that hand springs back with a wobble. Two hands work together. Pinch with both at once and each stretches the surface as it was, so pulling them apart stretches what is between them. Pinch with the second hand after the first has stretched something, and it grabs what you see.
- The pull plays notes. A pinch strums a chord, pulling climbs a pentatonic scale, a soft hum and a sparkle join as the streaks bloom, and letting go falls back and lands on a home chord. Each hand's notes come from the spot it grabbed.
- The picture comes from a small bank of camera frames taken while your head was steady, with your hands and forearms cut out of each one. A grab picks the best recent frame that covers the spot with no hand on it, plus a second frame behind it that fills whatever the first is missing. Where neither has the picture, you see the real room. If no frame covers the spot at all, the pinch lets go instead of bending something you can't see. Look around for a second after entering.
- Every scanned mesh, walls and furniture alike, is merged and subdivided to about 5 cm within 1.5 m of you, coarser further away, so anything bends smoothly. Tables, floors and walls that Quest detected as planes are flat: where the mesh lies within about 2 cm of a plane, facing the same way and inside its outline, it is snapped onto the plane. A pinch on a plane grabs the plane's point and normal, including through clutter up to 8 cm high on a table. The console's `pinch …` line says `hit=plane:table`, or `hit=mesh` with the nearest plane it rejected, and which scan was hit.
- Your real hands and arms stay in front of a stretch. Depth-only spheres on the joints and a capsule up each forearm, aimed at the elbow from a shoulder model, hide the stretch behind them. They trail tracking by 30 ms, the delay of passthrough's own image of the hand, except the pinching fingertips. Where the headset's depth map is available it also cuts the stretch wherever the real surface is at a tracked hand's depth along your line of sight, so the hand's real edge shows. A mug or a lamp beside your hand is not cut.
- Without a headset, `?preview=1` (or any browser without passthrough) runs the same material on a stand-in room. The wardrobe pulls apart on its own, and a webcam stands in for passthrough. `?preview=1&demo=push` loops a box pushed into the stand-in wall instead.
- A small console panel at the upper left of the headset view shows the page's console: camera, photo and pull lines, warnings and errors. It is on under `npm run dev`; `?debug=0` hides it for recordings, `?debug=1` forces it on in a build.

### Sorang

Pick **Sorang** on the 2D page. The card folds down to a **Show card** button and the painting plays in the window.

- It opens as the clean painting, 1.83 m square, filling most of the window. Then the bright paint pushes toward you and the edges between near and far break into stepped slits.
- The relief snaps onto 100 sheets, one per band of depth, and they fan about 0.6 m toward you, nearest first, while the view swings about 20° to the side so you see them as layers. A bright contour sweeps from the nearest sheet to the farthest, and behind it each tile turns out to be a stock photo, darkened or lightened to match the paint. From the front it still reads as the painting.
- Then the tiles burst outward from a point behind the centre, nearest sheets first, and settle into slow orbits around you with fine dust and a few faint lines. About 3% fly three times larger.
- Click the window or press **R** to bring the pieces back to the painting, and again to send them out. Space pauses, Esc shows or hides the card, and moving the mouse shifts the view a little so the depth shows.
- **Load image** plays any JPEG, PNG or WebP instead. Its depth comes from the in-browser model, which downloads the first time (about 25 MB), so it waits on the flat picture until depth arrives. If the model can't load, brightness stands in for depth.
- The default painting's depth is baked, so it never needs the model. Depth Anything reads a photo of a flat painting as a tilted card, so where a flat plane explains nearly all of the depth Sorang removes the tilt and lets brightness carry most of the relief: bright paint stands forward. Real photos keep the model's depth.
- With reduced motion the view doesn't swing or sway, the burst is shorter and the orbits are slow.
- `?mode=sorang` opens straight into it. `?sorangT=<seconds>` freezes the timeline at that moment (no parallax or sway), and `?ui=0` hides the card, for repeatable screenshots. `window.__sorang` has `seek`, `freeze`, `reform`, `stage` and `stats()` for tests.

Assets: `public/sorang/painting.jpg` is the painting, perspective-cropped from a screenshot by `scripts/sorang/crop_painting.py`. Its depth was baked with `node scripts/bake-depth/bake.mjs public/sorang/painting.jpg public/depth/sorang-painting --size 512` (stills skip ffmpeg). `public/sorang/photos.jpg` and `photos.json` are 100 photos from [Lorem Picsum](https://picsum.photos), by Unsplash photographers under the Unsplash License, built by `scripts/sorang/build_atlas.py` with fixed seeds. `photos.json` credits each one.

## Tuning

- `src/layout.ts`: stack size, strip length, touch and hover heights.
- The `FrameStack` component (scene JSON or the editor inspector): ghost, trail, length, lift, feather, glow.
- The `StretchLook` component: pull gain, sideways reach, stretch ramp (it grows with distance past 0.8 m), where streaks start (degrees of pull; 90 turns them off), photo feather, wobble, spring stiffness and damping, the burst and lift, and the pinch ripple.
- Matching the camera to passthrough: the lens model is measured for Quest 3 (863 px at 1280 wide, tilted 11.8° down, in front of its own eye) and the left room camera is used. Frames are posed 25 ms before their capture stamp. `StretchLook` has photo exposure and warmth, plus developer-only lens trims (focal, pitch/yaw/roll, offset, side) and camera latency; any non-neutral trim is printed to the console. For a quick headset check without a build, the URL can set the focal length, yaw, pitch and frame delay: `?lensf=863&yaw=-0.23&pitch=-11.77&tau=0.025`. The `lens …` line shows which came from the URL.
- Checking that alignment: `?debug=1&lens=overlay` draws the live camera in 48-px diagonal stripes over the room while nothing is pinched, each frame paired with the pose it was taken from, like a photo. Hold still and look along an edge: where it continues straight across the stripes, the camera model matches passthrough. A copy that is bigger everywhere points at focal length, bigger only up close at the forward offset, a constant shift at the mount angles or side, and an error only while turning at timing.
- Checking the hand cut: `?debug=1&occ=debug` shows the hand occluders 30% green, where the depth cut may act faint cyan, and what it cuts magenta instead of cutting it. `?debug=1&occ=delta` paints the real depth against the scanned room: white where they agree, red where the real surface is nearer, blue where it is farther, over 8 cm. The console keeps its `depth …`, `xr multiview …`, `camera pick …` and `lens …` lines on screen. `StretchLook` has the occluder lag as a developer trim.
- Timing a pull: each pull prints two `onset` lines at release, with its first 12 frames: frame times, how long the photo freeze and that frame's update took, how far the surface had moved (cm) and the fade (0-9). A hitch is one long frame; a pop is a jump in D.
- `MAX_LAYERS` in `src/frame-stack-system.ts`: raise it if the headset holds frame rate.
- The `SorangLook` component (the "Sorang painting" node): painting size, tiles across (each one photo), dust, relief depth, radial push, slice fan, photo contrast, mouse parallax, pace and reform speed. The stage timings are in `src/sorang-timeline.ts`.
