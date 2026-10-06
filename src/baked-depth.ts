/** Depth maps baked offline by `scripts/bake-depth`, one grayscale PNG per frame. */
import type { DepthField } from './depth-model.js';

interface BakedManifest {
  fps: number;
  frames: number;
}

const manifests = new Map<string, Promise<BakedManifest>>();

function manifest(base: string): Promise<BakedManifest> {
  let pending = manifests.get(base);
  if (pending) return pending;
  pending = fetch(`${base}/manifest.json`).then((res) => {
    if (!res.ok) throw new Error(`baked depth manifest ${res.status}`);
    return res.json() as Promise<BakedManifest>;
  });
  pending.catch(() => manifests.delete(base));
  manifests.set(base, pending);
  return pending;
}

/** The baked frame nearest to `time` seconds into the clip. */
export async function loadBakedDepth(base: string, time: number): Promise<DepthField> {
  const { fps, frames } = await manifest(base);
  const index = Math.min(frames - 1, Math.max(0, Math.round(time * fps)));
  const res = await fetch(`${base}/${String(index).padStart(4, '0')}.png`);
  if (!res.ok) throw new Error(`baked depth frame ${index}: ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('baked depth decode failed');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4];
  return { width, height, data };
}
