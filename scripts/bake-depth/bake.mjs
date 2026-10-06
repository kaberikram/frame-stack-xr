// Bakes per-frame depth for a clip so the app can skip the in-browser model.
// Usage: node bake.mjs [video] [outDir] [--fps 30] [--model onnx-community/depth-anything-v2-base] [--size 384]
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { RawImage, pipeline } from '@huggingface/transformers';

const root = resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const fps = Number(flag('fps', '30'));
const model = flag('model', 'onnx-community/depth-anything-v2-base');
const size = Number(flag('size', '384'));
const video = resolve(args[0] ?? join(root, 'public/WhatsApp Video 2026-09-20 at 5.59.52 PM.mp4'));
const outDir = resolve(args[1] ?? join(root, 'public/depth/default-clip'));

/** Same 2nd–98th percentile stretch as the runtime worker, so baked and live relief match. */
function stretch(src, channels, count) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < count; i++) hist[src[i * channels]]++;
  const cutoff = Math.max(1, Math.round(count * 0.02));
  let lo = 0;
  let hi = 255;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= cutoff) {
      lo = v;
      break;
    }
  }
  acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= cutoff) {
      hi = v;
      break;
    }
  }
  const out = new Uint8ClampedArray(count);
  const spread = hi - lo;
  const scale = spread < 8 ? 1 : 255 / spread;
  const base = spread < 8 ? 0 : lo;
  for (let i = 0; i < count; i++) out[i] = (src[i * channels] - base) * scale;
  return out;
}

const frameDir = mkdtempSync(join(tmpdir(), 'bake-depth-'));
try {
  console.log(`Extracting ${fps} fps frames from ${video}`);
  execFileSync(ffmpeg, ['-v', 'error', '-i', video, '-vf', `fps=${fps},scale='if(gte(iw,ih),768,-2)':'if(gte(iw,ih),-2,768)'`, join(frameDir, '%05d.png')]);
  const frames = readdirSync(frameDir).filter((f) => f.endsWith('.png')).sort();
  if (!frames.length) throw new Error('ffmpeg produced no frames');

  console.log(`Loading ${model}`);
  const depthPipe = await pipeline('depth-estimation', model, { dtype: 'fp32' });

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  let width = 0;
  let height = 0;
  const started = Date.now();
  for (let i = 0; i < frames.length; i++) {
    const image = await RawImage.read(join(frameDir, frames[i]));
    const { depth } = await depthPipe(image);
    const long = Math.max(depth.width, depth.height);
    width = Math.round((depth.width / long) * size);
    height = Math.round((depth.height / long) * size);
    const small = await depth.resize(width, height);
    const gray = stretch(small.data, small.channels, width * height);
    await new RawImage(gray, width, height, 1).save(join(outDir, `${String(i).padStart(4, '0')}.png`));
    const per = (Date.now() - started) / (i + 1);
    process.stdout.write(`\r${i + 1}/${frames.length}  ${(per / 1000).toFixed(2)} s/frame  eta ${Math.round((per * (frames.length - i - 1)) / 1000)} s   `);
  }
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify({ fps, frames: frames.length, width, height, model }, null, 2)}\n`);
  console.log(`\nWrote ${frames.length} depth frames (${width}x${height}) to ${outDir}`);
} finally {
  rmSync(frameDir, { recursive: true, force: true });
}
