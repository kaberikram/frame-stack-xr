# Rooms clips

One looping clip per box, named by slot: `01.mp4` … `09.mp4`. A box whose file is missing shows a numbered test card.

| File | Box |
|---|---|
| 01.mp4 | bedroom (top of the stack) |
| 02.mp4 | living room |
| 03.mp4 | bunk room |
| 04.mp4 | kitchen |
| 05.mp4 | office |
| 06.mp4 | gallery |
| 07.mp4 | lounge |
| 08.mp4 | bathroom |
| 09.mp4 | purple lounge (bottom) |

The names are only labels for the layout in `src/rooms-layout.ts`; any footage works in any slot.

Make them with `scripts/rooms/prep_clips.sh`: it crops to 16:9, scales to 960×540, removes the sound, and encodes H.264 that loops cleanly in a browser:

```
scripts/rooms/prep_clips.sh --loop-fade 0.4 a.mov b.mov c.mov   # → 01.mp4, 02.mp4, 03.mp4
scripts/rooms/prep_clips.sh --slot 5 --from 3 --length 8 d.mp4  # → 05.mp4, 3 s in, 8 s long
```

Keep each clip short (5–15 s) and under about 5 MB. All nine decode at once.
