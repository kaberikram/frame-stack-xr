# Rooms clips

One looping clip per room, named by slot. A room whose file is missing shows a numbered test card.

| File | Room | Shape |
|---|---|---|
| 01.mp4 | car park | 960×540 (16:9) |
| 02.mp4 | hallway | 448×352 |
| 03.mp4 | dark room | 592×480 |
| 04.mp4 | rooftop (top of the stack) | 960×540 (16:9) |
| 05.mp4 | train (bottom) | 576×480 |

Each room in `src/rooms-layout.ts` has an `aspect` that matches its clip, so the clip fills the back wall uncropped. If you replace a clip with one of another shape, change that room's `aspect` too, or the clip is cropped to fit.

These were made with `scripts/rooms/prep_clips.sh`. It keeps each clip's own shape, scales it to at most 540 px high (never upscaling), applies a phone's rotation flag, removes the sound, and crossfades the end into the start so the loop has no seam:

```
scripts/rooms/prep_clips.sh --keep-aspect --loop-fade 0.4 1.mp4 2.mp4 3.mp4 4.mp4 5.mp4   # → 01.mp4 … 05.mp4
scripts/rooms/prep_clips.sh --keep-aspect --slot 3 --from 2 --length 6 new.mp4            # → 03.mp4, 2 s in, 6 s long
```

Without `--keep-aspect` it crops to 16:9 at 960×540. Keep each clip short (5–15 s) and under about 5 MB, because they all decode at once.
