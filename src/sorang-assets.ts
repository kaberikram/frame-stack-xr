/** Sorang's files: the default painting, its baked depth, and the stock-photo atlas. */
import { DataArrayTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace } from '@iwsdk/core';

const BASE = import.meta.env.BASE_URL;
export const PAINTING_URL = `${BASE}sorang/painting.jpg`;
export const PAINTING_NAME = 'Sorang painting';
/** Baked by `scripts/bake-depth` from the painting; re-run it if the painting changes. */
export const PAINTING_DEPTH = `${BASE}depth/sorang-painting`;
/** Built by `scripts/sorang/build_atlas.py`: 100 Lorem Picsum photos, darkest first. */
export const PHOTOS_URL = `${BASE}sorang/photos.jpg`;
export const PHOTOS_META_URL = `${BASE}sorang/photos.json`;

const DISPLAY_LONG = 1024;
const DEPTH_LONG = 768;
const MIN_ASPECT = 0.25;
const MAX_ASPECT = 4;

const LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

export interface Painting {
  name: string;
  /** Shown on the tiles, up to 1024 px on the long side. */
  display: HTMLCanvasElement;
  /** Handed to the depth model, up to 768 px. */
  depth: HTMLCanvasElement;
}

export interface PhotoAtlas {
  texture: DataArrayTexture;
  /** Per layer: mean of sqrt(linear luma), in the same space as the shader's tint. */
  means: Float32Array;
}

type Source = ImageBitmap | HTMLImageElement;

function sizeOf(source: Source): { w: number; h: number } {
  return source instanceof HTMLImageElement ? { w: source.naturalWidth, h: source.naturalHeight } : { w: source.width, h: source.height };
}

/** Centre-crop outside the 0.25–4 aspect range, then scale so the long side is `long`. */
function drawTo(source: Source, long: number): HTMLCanvasElement {
  const { w, h } = sizeOf(source);
  let sw = w;
  let sh = h;
  if (sw / sh > MAX_ASPECT) sw = sh * MAX_ASPECT;
  if (sw / sh < MIN_ASPECT) sh = sw / MIN_ASPECT;
  const sx = (w - sw) / 2;
  const sy = (h - sh) / 2;
  const scale = Math.min(1, long / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(sw * scale));
  canvas.height = Math.max(2, Math.round(sh * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('canvas unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function painting(source: Source, name: string): Painting {
  return { name, display: drawTo(source, DISPLAY_LONG), depth: drawTo(source, DEPTH_LONG) };
}

async function decodeBlob(blob: Blob): Promise<Source> {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    // Older engines decode some formats only through an <img>.
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function release(source: Source): void {
  if (!(source instanceof HTMLImageElement)) source.close();
}

export async function loadPainting(url = PAINTING_URL, name = PAINTING_NAME): Promise<Painting> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`painting ${res.status}`);
  const source = await decodeBlob(await res.blob());
  try {
    return painting(source, name);
  } finally {
    release(source);
  }
}

/** A picture the viewer picked. Throws if it can't be decoded. */
export async function decodeImageFile(file: File): Promise<Painting> {
  const source = await decodeBlob(file);
  try {
    if (sizeOf(source).w < 2 || sizeOf(source).h < 2) throw new Error('empty image');
    return painting(source, file.name);
  } finally {
    release(source);
  }
}

interface AtlasMeta {
  tile: number;
  cols: number;
  rows: number;
  count: number;
}

/**
 * The 100 photos as layers of one texture array, rows top-down like the frame stack's
 * slices (the shader samples them at 1 − v).
 */
export async function loadPhotoAtlas(): Promise<PhotoAtlas> {
  const metaRes = await fetch(PHOTOS_META_URL);
  if (!metaRes.ok) throw new Error(`photo atlas meta ${metaRes.status}`);
  const meta = (await metaRes.json()) as AtlasMeta;
  const res = await fetch(PHOTOS_URL);
  if (!res.ok) throw new Error(`photo atlas ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const { tile, cols, count } = meta;
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('photo atlas decode failed');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const src = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const data = new Uint8Array(tile * tile * 4 * count);
  const means = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    const cx = (k % cols) * tile;
    const cy = Math.floor(k / cols) * tile;
    let sum = 0;
    for (let y = 0; y < tile; y++) {
      const from = ((cy + y) * canvas.width + cx) * 4;
      const to = (k * tile * tile + y * tile) * 4;
      data.set(src.subarray(from, from + tile * 4), to);
      for (let x = 0; x < tile; x++) {
        const j = from + x * 4;
        sum += Math.sqrt(0.2126 * LINEAR[src[j]] + 0.7152 * LINEAR[src[j + 1]] + 0.0722 * LINEAR[src[j + 2]]);
      }
    }
    means[k] = sum / (tile * tile);
  }
  const texture = new DataArrayTexture(data, tile, tile, count);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return { texture, means };
}
