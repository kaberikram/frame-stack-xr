#!/usr/bin/env bash
# Turns clips into Rooms' loops: public/rooms/videos/01.mp4, 02.mp4, … in the order given, each
# with its frame stack baked beside it (01-frames.jpg, by scripts/rooms/bake_frames.sh).
# Each one is centre-cropped to 16:9 (or kept at its own shape with --keep-aspect), scaled,
# stripped of sound and encoded as H.264 for the web, with a keyframe every second. --loop-fade
# crossfades the end into the start so the loop has no seam (the clip comes out that much shorter).
# A rotation flag (phone footage) is applied, so the output is upright.
#
# Usage: scripts/rooms/prep_clips.sh [--slot N] [--length S] [--from S] [--loop-fade S]
#                                    [--height H] [--keep-aspect] [--out DIR] clip.mov [clip2.mp4 …]
#   --slot N       first slot number (default 1); each further clip takes the next
#   --from S       start this many seconds into each clip (default 0)
#   --length S     keep at most this many seconds (default: to the end, at most 20)
#   --loop-fade S  crossfade the last S seconds into the start (default 0: none)
#   --height H     output height in pixels (default 540; width is 16:9 of it)
#   --keep-aspect  keep each clip's own shape instead of cropping to 16:9, no taller than
#                  --height or the clip itself; set the room's `aspect` in rooms-layout.ts to match
#   --out DIR      where to write (default public/rooms/videos)
# Needs ffmpeg and ffprobe.
set -euo pipefail

slot=1
from=0
length=20
fade=0
height=540
own_shape=no
out="public/rooms/videos"
clips=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --slot) slot="$2"; shift 2 ;;
    --from) from="$2"; shift 2 ;;
    --length) length="$2"; shift 2 ;;
    --loop-fade) fade="$2"; shift 2 ;;
    --height) height="$2"; shift 2 ;;
    --keep-aspect) own_shape=yes; shift ;;
    --out) out="$2"; shift 2 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) clips+=("$1"); shift ;;
  esac
done
if [[ ${#clips[@]} -eq 0 ]]; then
  sed -n '2,19p' "$0"
  exit 1
fi

# Even sizes, as H.264 in yuv420p needs.
h=$(( (height / 2) * 2 ))
w=$(( (h * 16 / 9 / 2) * 2 ))
mkdir -p "$out"

for clip in "${clips[@]}"; do
  name=$(printf '%02d.mp4' "$slot")
  dur=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$clip")
  # Seconds kept: what is left after --from, capped at --length.
  keep=$(awk -v d="$dur" -v f="$from" -v l="$length" 'BEGIN { k = d - f; if (k > l) k = l; if (k < 0.5) k = 0; printf "%.3f", k }')
  if [[ "$keep" == "0.000" ]]; then
    echo "skip $clip: nothing left after --from $from" >&2
    slot=$((slot + 1))
    continue
  fi
  if [[ "$own_shape" == yes ]]; then
    # Its own shape, never upscaled; both sides even.
    fit="scale=-2:'trunc(min(${h},ih)/2)*2',setsar=1,fps=30,format=yuv420p"
  else
    fit="scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=30,format=yuv420p"
  fi
  if awk -v f="$fade" -v k="$keep" 'BEGIN { exit !(f > 0 && 2 * f < k) }'; then
    # The tail fades over the head: playback starts at --from + fade and ends on that same frame.
    offset=$(awk -v k="$keep" -v f="$fade" 'BEGIN { printf "%.3f", k - 2 * f }')
    graph="[0:v]${fit},split[a][b];[a]trim=start=${fade},setpts=PTS-STARTPTS[main];[b]trim=end=${fade},setpts=PTS-STARTPTS[head];[main][head]xfade=transition=fade:duration=${fade}:offset=${offset},format=yuv420p[v]"
  else
    [[ "$fade" != "0" ]] && echo "note: --loop-fade $fade is too long for $clip (${keep}s kept); no fade" >&2
    graph="[0:v]${fit}[v]"
  fi
  ffmpeg -v error -y -ss "$from" -t "$keep" -i "$clip" -filter_complex "$graph" -map '[v]' -an \
    -c:v libx264 -pix_fmt yuv420p -profile:v high -preset slow -crf 23 -maxrate 3M -bufsize 6M -g 30 -keyint_min 30 \
    -movflags +faststart "$out/$name"
  size=$(du -h "$out/$name" | cut -f1)
  dims=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$out/$name")
  echo "$out/$name  ${dims}  from $clip  ($size)"
  "$(dirname "$0")/bake_frames.sh" "$out/$name"
  slot=$((slot + 1))
done
