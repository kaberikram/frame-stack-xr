/** Canvas painting for everything text-like in the rig, in the browser version's dark palette. */

export const INK = {
  stage: '#000000',
  surface: '#141822',
  well: '#1C212C',
  line: '#242A37',
  text: '#E5E8EE',
  muted: '#8B92A3',
  red: '#EE5F4B',
  blue: '#6E96FF',
} as const;

const SANS = '"Recursive", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, "Roboto Mono", monospace';

export interface Canvas2D {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

export function makeCanvas(w: number, h: number, willReadFrequently = false): Canvas2D {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently });
  if (!ctx) throw new Error('2D canvas is unavailable');
  return { canvas, ctx };
}

/** The floating instruction card shown while placing the rig. */
export function drawHint({ canvas, ctx }: Canvas2D, title: string, body: string): void {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.beginPath();
  ctx.roundRect(3, 3, w - 6, h - 6, 40);
  ctx.fillStyle = 'rgba(20, 24, 34, 0.92)';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = INK.line;
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = INK.text;
  ctx.font = `700 56px ${SANS}`;
  ctx.fillText(title, 60, 110);
  ctx.fillStyle = INK.muted;
  ctx.font = `500 42px ${SANS}`;
  ctx.fillText(body, 60, 182);
}

/** White outline only. A press thickens the stroke; the plate itself stays empty. */
function strokeOutline(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, pressed: boolean): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.lineWidth = Math.max(2, h * (pressed ? 0.05 : 0.032));
  ctx.strokeStyle = '#FFFFFF';
  ctx.stroke();
}

function paintWhiteLabel(ctx: CanvasRenderingContext2D, label: string, x: number, y: number, font: string): void {
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = font;
  ctx.fillText(label, x, y);
}

/** Round play button: white ring and white icon, with the browser version's 24-unit paths. */
export function drawPlay({ canvas, ctx }: Canvas2D, playing: boolean, pressed: boolean): void {
  const s = canvas.width;
  ctx.clearRect(0, 0, s, s);
  const inset = 5;
  strokeOutline(ctx, inset, inset, s - inset * 2, s - inset * 2, pressed);
  const k = (s * 0.42) / 24;
  ctx.save();
  ctx.translate(s / 2 - 12 * k, s / 2 - 12 * k);
  ctx.scale(k, k);
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  if (playing) {
    ctx.roundRect(6.5, 5, 4, 14, 1);
    ctx.roundRect(13.5, 5, 4, 14, 1);
  } else {
    ctx.moveTo(8, 5.2);
    ctx.lineTo(8, 18.8);
    ctx.lineTo(19, 12);
    ctx.closePath();
  }
  ctx.fill();
  ctx.restore();
}

export function drawSpeed({ canvas, ctx }: Canvas2D, speed: number, pressed: boolean): void {
  const s = canvas.width;
  ctx.clearRect(0, 0, s, s);
  const inset = 5;
  strokeOutline(ctx, inset, inset, s - inset * 2, s - inset * 2, pressed);
  paintWhiteLabel(ctx, `${speed}×`, s / 2, s / 2 + s * 0.01, `600 ${Math.round(s * 0.28)}px ${MONO}`);
}

export function drawMove({ canvas, ctx }: Canvas2D, pressed: boolean): void {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const inset = 4;
  strokeOutline(ctx, inset, inset, w - inset * 2, h - inset * 2, pressed);
  paintWhiteLabel(ctx, 'Move', w / 2, h / 2 + h * 0.02, `600 ${Math.round(h * 0.4)}px ${SANS}`);
}

export interface Atlas {
  canvas: HTMLCanvasElement;
  w: number;
  h: number;
  cols: number;
}

/** The filmstrip: thumbnails at strip height, one per tile, as in the browser version's scrubber. */
export function drawStrip({ canvas, ctx }: Canvas2D, atlas: Atlas, N: number, loaded: number, aspect: number): void {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, h * 0.17);
  ctx.clip();
  ctx.fillStyle = 'rgba(28, 33, 44, 0.92)';
  ctx.fillRect(0, 0, w, h);
  if (N > 0) {
    const tw = Math.max(8, Math.round(h * aspect));
    for (let x = 0; x < w; x += tw) {
      const i = Math.min(N - 1, Math.floor(((x + tw / 2) / w) * N));
      if (i >= loaded) continue;
      const sx = (i % atlas.cols) * atlas.w;
      const sy = Math.floor(i / atlas.cols) * atlas.h;
      ctx.drawImage(atlas.canvas, sx, sy, atlas.w, atlas.h, x, 0, tw - 3, h);
    }
  }
  ctx.restore();
}
