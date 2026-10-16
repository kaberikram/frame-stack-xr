# Rooms clips

Each room floats as a frame stack: its clip plays sharp through a stack of its own frames. Per room there are two files, named by slot:

| Clip | Frame sheet | Room | Shape |
|---|---|---|---|
| 01.mp4 | 01-frames.jpg | car park | 960×540 (16:9) |
| 02.mp4 | 02-frames.jpg | hallway | 832×464 |
| 03.mp4 | 03-frames.jpg | dark room | 656×480 |
| 04.mp4 | 04-frames.jpg | rooftop (top of the stack) | 1024×576 (16:9) |
| 05.mp4 | 05-frames.jpg | train (bottom) | 576×480 |

- **The clip** plays muted on a loop as the sharp frame travelling through the stack.
- **The frame sheet** holds the stack's 48 layers: frames sampled evenly through the loop, 256 px wide, eight across. The page cuts it back into layers when it loads.
- A room missing its files shows a numbered test card.

Each room in `src/rooms-layout.ts` has an `aspect` that matches its clip, so nothing is cropped. If you replace a clip with one of another shape, change that room's `aspect` too.

`scripts/rooms/prep_clips.sh` makes both files. It keeps each clip's own shape, scales it to at most 540 px high (never upscaling), applies a phone's rotation flag, removes the sound, crossfades the end into the start so the loop has no seam, and bakes the frame sheet:

```
scripts/rooms/prep_clips.sh --keep-aspect --loop-fade 0.4 1.mp4 2.mp4 3.mp4 4.mp4 5.mp4   # → 01.mp4 … 05.mp4 and their sheets
scripts/rooms/prep_clips.sh --keep-aspect --slot 3 --from 2 --length 6 new.mp4            # → 03.mp4, 2 s in, 6 s long
scripts/rooms/bake_frames.sh public/rooms/videos/03.mp4                                   # just the sheet again
```

Without `--keep-aspect` it crops to 16:9 at 960×540. Keep each clip short (5–15 s) and under about 5 MB, because they all decode at once.
