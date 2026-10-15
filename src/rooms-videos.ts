/**
 * Rooms' clips: per room, one muted, looping, inline video from `public/rooms/videos/NN.mp4`
 * (the sharp frame that travels through the stack) and its baked frame sheet `NN-frames.jpg`,
 * cut into the stack's layers. A slot with no clip shows a numbered test card in every layer,
 * so the piece plays in full before any footage exists.
 */
import {
  CanvasTexture,
  DataArrayTexture,
  LinearFilter,
  SRGBColorSpace,
  VideoTexture,
  type Texture,
} from '@iwsdk/core';
import { LAYERS, SHEET_COLS, framesUrl, videoName, videoUrl } from './rooms-assets.js';
import type { BoxSpec } from './rooms-layout.js';

export interface VideoSlot {
  readonly slot: number;
  readonly card: CanvasTexture;
  video: HTMLVideoElement | null;
  texture: VideoTexture | null;
  /** A clip decoded and plays here; otherwise the card shows. */
  live: boolean;
  /** Width over height of what the slot shows. */
  aspect: number;
  /** The room's own shape, shown until a clip says otherwise. */
  readonly roomAspect: number;
  /** The stack: LAYERS frames, one per layer, rows stored top-down. The card until the sheet lands. */
  readonly frames: DataArrayTexture;
  /** Per layer: the frame's mean linear colour, three floats each, for its glow. */
  readonly means: Float32Array;
  /** The frame sheet has landed in `frames`. */
  stacked: boolean;
}

/** A frozen frame is re-seeked only when it is further off than this, seconds. */
const HOLD_SLOP = 0.04;
/** Width of each stack layer, pixels; the height follows the room's shape. */
const LAYER_W = 256;
/** A slot without a clip cycles its card's stack over this many seconds. */
const CARD_LOOP = 6;

const LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

export class RoomsVideos {
  /** Called when a slot's clip or frame sheet starts to show, so its materials can follow. */
  onChange: ((slot: VideoSlot) => void) | null = null;
  readonly slots: VideoSlot[];
  private loading = false;
  private sheetsLoading = false;
  private playing = false;
  private readonly cleanups: Array<() => void> = [];
  private readonly sheetCleanups: Array<() => void> = [];

  constructor(boxes: readonly BoxSpec[]) {
    this.slots = boxes.map((box) => {
      const card = testCard(box);
      const frames = layerTexture(box.aspect);
      const means = new Float32Array(LAYERS * 3);
      fillWithCard(frames, means, card.image as HTMLCanvasElement);
      return {
        slot: box.slot,
        card,
        video: null,
        texture: null,
        live: false,
        aspect: box.aspect,
        roomAspect: box.aspect,
        frames,
        means,
        stacked: false,
      };
    });
  }

  get liveCount(): number {
    let n = 0;
    for (const s of this.slots) if (s.live) n++;
    return n;
  }

  get stackedCount(): number {
    let n = 0;
    for (const s of this.slots) if (s.stacked) n++;
    return n;
  }

  texture(slot: VideoSlot): Texture {
    return slot.live && slot.texture ? slot.texture : slot.card;
  }

  /**
   * 0..1 through the slot's loop: where the sharp frame sits in its stack. The clip's own time
   * while it plays; without a clip, the song second `s` cycles the card.
   */
  phase(slot: VideoSlot, s: number): number {
    const v = slot.video;
    if (slot.live && v && v.duration > 0) return Math.min(0.9999, Math.max(0, v.currentTime / v.duration));
    return (s / CARD_LOOP) % 1;
  }

  /** Start fetching every slot's clip and frame sheet. Sheets stay once loaded; clips reopen after `unload`. */
  load(): void {
    if (!this.sheetsLoading) {
      this.sheetsLoading = true;
      for (const slot of this.slots) this.openSheet(slot);
    }
    if (this.loading) return;
    this.loading = true;
    for (const slot of this.slots) this.open(slot);
  }

  play(): void {
    this.playing = true;
    for (const s of this.slots) if (s.live && s.video?.paused) s.video.play().catch(() => {});
  }

  pause(): void {
    this.playing = false;
    for (const s of this.slots) if (s.live && s.video && !s.video.paused) s.video.pause();
  }

  /** Every clip back to its first frame, so each play of the song starts the loops together. */
  restart(): void {
    for (const s of this.slots) if (s.live && s.video) s.video.currentTime = 0;
  }

  /** Hold every clip still on the frame it would show at song second `s` (for frozen captures). */
  hold(s: number): void {
    this.playing = false;
    for (const slot of this.slots) {
      const v = slot.video;
      if (!slot.live || !v || !(v.duration > 0)) continue;
      if (!v.paused) v.pause();
      const at = s % v.duration;
      if (Math.abs(v.currentTime - at) > HOLD_SLOP && !v.seeking) v.currentTime = at;
    }
  }

  /** Let go of every clip and its decoder. The stacks keep their frames; `load` opens the clips again. */
  unload(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
    this.loading = false;
    this.playing = false;
    for (const slot of this.slots) {
      slot.texture?.dispose();
      slot.texture = null;
      slot.live = false;
      slot.aspect = slot.roomAspect;
      const v = slot.video;
      slot.video = null;
      if (v) {
        v.pause();
        v.removeAttribute('src');
        v.load();
      }
    }
  }

  dispose(): void {
    this.unload();
    for (const cleanup of this.sheetCleanups) cleanup();
    this.sheetCleanups.length = 0;
    for (const slot of this.slots) {
      slot.card.dispose();
      slot.frames.dispose();
    }
  }

  // ----------------------------------------------------------------

  private open(slot: VideoSlot): void {
    const v = document.createElement('video');
    v.muted = true;
    v.defaultMuted = true;
    v.setAttribute('muted', '');
    v.loop = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    slot.video = v;
    const onData = () => {
      if (slot.live) return;
      slot.texture = new VideoTexture(v);
      slot.texture.colorSpace = SRGBColorSpace;
      slot.aspect = v.videoWidth > 0 && v.videoHeight > 0 ? v.videoWidth / v.videoHeight : slot.roomAspect;
      slot.live = true;
      console.info(`[rooms] slot ${videoName(slot.slot)} ${v.videoWidth}x${v.videoHeight} ${v.duration.toFixed(1)} s`);
      this.onChange?.(slot);
      if (this.playing) v.play().catch(() => {});
    };
    const onError = () => {
      if (slot.live) return;
      console.info(`[rooms] slot ${videoName(slot.slot)}: no clip, showing its test card`);
    };
    v.addEventListener('loadeddata', onData);
    v.addEventListener('error', onError);
    this.cleanups.push(() => {
      v.removeEventListener('loadeddata', onData);
      v.removeEventListener('error', onError);
    });
    v.src = videoUrl(slot.slot);
  }

  /** Cut the slot's frame sheet into its stack's layers once it lands. */
  private openSheet(slot: VideoSlot): void {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    let gone = false;
    const onLoad = () => {
      if (gone || !(img.naturalWidth > 0)) return;
      fillFromSheet(slot.frames, slot.means, img);
      slot.stacked = true;
      console.info(`[rooms] slot ${videoName(slot.slot)} stack of ${LAYERS} frames`);
      this.onChange?.(slot);
    };
    const onError = () => {
      if (!gone) console.info(`[rooms] slot ${videoName(slot.slot)}: no frame sheet, its stack shows the card`);
    };
    img.addEventListener('load', onLoad);
    img.addEventListener('error', onError);
    this.sheetCleanups.push(() => {
      gone = true;
      img.removeEventListener('load', onLoad);
      img.removeEventListener('error', onError);
    });
    img.src = framesUrl(slot.slot);
  }
}

/** An empty LAYERS-deep stack at the room's shape. */
function layerTexture(aspect: number): DataArrayTexture {
  const w = LAYER_W;
  const h = Math.max(2, Math.round(LAYER_W / Math.max(0.2, aspect) / 2) * 2);
  const tex = new DataArrayTexture(new Uint8Array(w * h * 4 * LAYERS), w, h, LAYERS);
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Paint every layer with `draw`, keep the pixels in the texture's data, and record each layer's mean colour. */
function paintLayers(
  tex: DataArrayTexture,
  means: Float32Array,
  draw: (ctx: CanvasRenderingContext2D, i: number, w: number, h: number) => void,
): void {
  const { width: w, height: h } = tex.image;
  const data = tex.image.data as Uint8Array;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  for (let i = 0; i < LAYERS; i++) {
    ctx.clearRect(0, 0, w, h);
    draw(ctx, i, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    data.set(px, i * w * h * 4);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let p = 0; p < px.length; p += 4 * 17) {
      r += LINEAR[px[p]];
      g += LINEAR[px[p + 1]];
      b += LINEAR[px[p + 2]];
      n++;
    }
    means[i * 3] = r / n;
    means[i * 3 + 1] = g / n;
    means[i * 3 + 2] = b / n;
  }
  tex.needsUpdate = true;
}

function fillWithCard(tex: DataArrayTexture, means: Float32Array, card: HTMLCanvasElement): void {
  paintLayers(tex, means, (ctx, _i, w, h) => ctx.drawImage(card, 0, 0, w, h));
}

/** The sheet holds LAYERS frames SHEET_COLS across, top-left first (`bake_frames.sh`). */
function fillFromSheet(tex: DataArrayTexture, means: Float32Array, sheet: HTMLImageElement): void {
  const rows = Math.ceil(LAYERS / SHEET_COLS);
  const tw = sheet.naturalWidth / SHEET_COLS;
  const th = sheet.naturalHeight / rows;
  paintLayers(tex, means, (ctx, i, w, h) => {
    ctx.drawImage(sheet, (i % SHEET_COLS) * tw, Math.floor(i / SHEET_COLS) * th, tw, th, 0, 0, w, h);
  });
}

/** A numbered card for an empty slot: colour bars, the room's name, and the file it wants. */
function testCard(box: BoxSpec): CanvasTexture {
  const w = 640;
  // The room's own shape, so the card fills its frame unstretched.
  const h = Math.round(w / box.aspect);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const tint = box.tint.map((c) => Math.round(255 * Math.sqrt(c)));
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, `rgb(${tint.map((c) => Math.round(c * 0.28)).join(',')})`);
    grad.addColorStop(1, 'rgb(8,9,14)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    const bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
    const bw = w / bars.length;
    ctx.globalAlpha = 0.55;
    bars.forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.fillRect(i * bw, 0, Math.ceil(bw), h * 0.36);
    });
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '700 120px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(String(box.slot + 1).padStart(2, '0'), 36, h * 0.36 + 128);
    ctx.font = '600 30px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(box.name, 40, h - 64);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '400 20px ui-monospace, monospace';
    ctx.fillText(`add public/rooms/videos/${videoName(box.slot)}`, 40, h - 30);
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}
