#!/usr/bin/env bash
# Bakes each Rooms clip's frame stack: frames sampled evenly through the loop, scaled to a fixed
# width and tiled 8 across into NN-frames.jpg next to the clip. Rooms cuts the sheet back into the
# stack's layers when it loads, so no frame has to be seeked out of the video in the browser.
# scripts/rooms/prep_clips.sh runs this for every clip it writes.
#
# Usage: scripts/rooms/bake_frames.sh [--layers N] [--width W] public/rooms/videos/01.mp4 [02.mp4 …]
#   --layers N  frames per clip (default 48; match LAYERS in src/rooms-assets.ts)
#   --width W   width of each frame in pixels (default 256; the height follows the clip's shape)
# Needs ffmpeg and ffprobe.
set -euo pipefail

layers=48
width=256
cols=8
clips=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --layers) layers="$2"; shift 2 ;;
    --width) width="$2"; shift 2 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) clips+=("$1"); shift ;;
  esac
done
if [[ ${#clips[@]} -eq 0 ]]; then
  sed -n '2,11p' "$0"
  exit 1
fi

rows=$(( (layers + cols - 1) / cols ))
for clip in "${clips[@]}"; do
  out="${clip%.*}-frames.jpg"
  dur=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$clip")
  # Layer i is the frame at i/N of the loop, which is where the stack puts it.
  rate=$(awk -v n="$layers" -v d="$dur" 'BEGIN { printf "%.6f", n / d }')
  ffmpeg -v error -y -i "$clip" -vf "fps=${rate},scale=${width}:-2,tile=${cols}x${rows}" -frames:v 1 -q:v 3 "$out"
  dims=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$out")
  echo "$out  ${layers} frames, ${cols}x${rows} sheet, ${dims}  ($(du -h "$out" | cut -f1))"
done
