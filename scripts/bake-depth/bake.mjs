// Bakes per-frame depth for a clip (or a single still) so the app can skip the in-browser model.
// Usage: node bake.mjs [video|image] [outDir] [--fps 30] [--model onnx-community/depth-anything-v2-base] [--size 384]
// An input ending in .png/.jpg/.jpeg/.webp is baked as one frame (0000.png, manifest fps 1) without ffmpeg.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
const input = resolve(args[0] ?? join(root, 'public/WhatsApp Video 2026-09-20 at 5.59.52 PM.mp4'));
const outDir = resolve(args[1] ?? join(root, 'public/depth/default-clip'));
const isImage = /\.(png|jpe?g|webp)$/i.test(input);

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

/** Runs depth on one frame, resizes to --size long side, stretches, and writes outDir/NNNN.png. */
async function bakeFrame(depthPipe, image, index) {
  const { depth } = await depthPipe(image);
  const long = Math.max(depth.width, depth.height);
  const width = Math.round((depth.width / long) * size);
  const height = Math.round((depth.height / long) * size);
  const small = await depth.resize(width, height);
  const gray = stretch(small.data, small.channels, width * height);
  await new RawImage(gray, width, height, 1).save(join(outDir, `${String(index).padStart(4, '0')}.png`));
  return { width, height };
}

const writeManifest = (manifest) => writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

if (isImage) {
  console.log(`Reading still ${input}`);
  const image = await RawImage.read(input);

  console.log(`Loading ${model}`);
  const depthPipe = await pipeline('depth-estimation', model, { dtype: 'fp32' });

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const started = Date.now();
  const { width, height } = await bakeFrame(depthPipe, image, 0);
  writeManifest({ fps: 1, frames: 1, width, height, model, source: 'image' });
  console.log(`Wrote 1 depth frame (${width}x${height}) to ${outDir} in ${((Date.now() - started) / 1000).toFixed(2)} s`);
} else {
  const { default: ffmpeg } = await import('ffmpeg-static');
  const frameDir = mkdtempSync(join(tmpdir(), 'bake-depth-'));
  try {
    console.log(`Extracting ${fps} fps frames from ${input}`);
    execFileSync(ffmpeg, ['-v', 'error', '-i', input, '-vf', `fps=${fps},scale='if(gte(iw,ih),768,-2)':'if(gte(iw,ih),-2,768)'`, join(frameDir, '%05d.png')]);
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
      ({ width, height } = await bakeFrame(depthPipe, image, i));
      const per = (Date.now() - started) / (i + 1);
      process.stdout.write(`\r${i + 1}/${frames.length}  ${(per / 1000).toFixed(2)} s/frame  eta ${Math.round((per * (frames.length - i - 1)) / 1000)} s   `);
    }
    writeManifest({ fps, frames: frames.length, width, height, model });
    console.log(`\nWrote ${frames.length} depth frames (${width}x${height}) to ${outDir}`);
  } finally {
    rmSync(frameDir, { recursive: true, force: true });
  }
}
