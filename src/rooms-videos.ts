/**
 * Rooms' clips: one muted, looping, inline video per box from `public/rooms/videos/NN.mp4`.
 * A slot with no clip (or one that won't decode) shows a numbered test card instead, so the
 * piece plays in full before any footage exists.
 */
import { CanvasTexture, SRGBColorSpace, VideoTexture, type Texture } from '@iwsdk/core';
import { videoName, videoUrl } from './rooms-assets.js';
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
}

/** A frozen frame is re-seeked only when it is further off than this, seconds. */
const HOLD_SLOP = 0.04;

export class RoomsVideos {
  /** Called when a slot's clip starts to show, so its material can switch textures. */
  onChange: ((slot: VideoSlot) => void) | null = null;
  readonly slots: VideoSlot[];
  private loading = false;
  private playing = false;
  private readonly cleanups: Array<() => void> = [];

  constructor(boxes: readonly BoxSpec[]) {
    this.slots = boxes.map((box) => ({
      slot: box.slot,
      card: testCard(box),
      video: null,
      texture: null,
      live: false,
      aspect: box.aspect,
      roomAspect: box.aspect,
    }));
  }

  get liveCount(): number {
    let n = 0;
    for (const s of this.slots) if (s.live) n++;
    return n;
  }

  texture(slot: VideoSlot): Texture {
    return slot.live && slot.texture ? slot.texture : slot.card;
  }

  /** Start fetching every slot's clip. Once is enough. */
  load(): void {
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

  /** Let go of every clip and its decoder; the cards show until `load` opens them again. */
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
    for (const slot of this.slots) slot.card.dispose();
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
}

/** A numbered card for an empty slot: colour bars, the room's name, and the file it wants. */
function testCard(box: BoxSpec): CanvasTexture {
  const w = 640;
  // The room's own shape, so the card fills its back wall unstretched.
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
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, w - 2, h - 2);
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}
