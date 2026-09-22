/** Frame sources for the stack: the procedural demo clip and local video files. */

export const DEMO_SECONDS = 16;
export const DEFAULT_CLIP_NAME = 'WhatsApp Video 2026-09-20 at 5.59.52 PM.mp4';
/** Served from `public/`. Spaces stay encoded so the request matches the filename. */
export const DEFAULT_CLIP_URL = `/${encodeURIComponent(DEFAULT_CLIP_NAME)}`;
export const RATES = [1, 2, 4, 8, 15, 30] as const;

export interface FrameSource {
  kind: 'demo' | 'video';
  name: string;
  duration: number;
  aspect: number;
  draw(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, i: number): void | Promise<void>;
}

export const fmtTime = (t: number): string => {
  const cs = Math.round(t * 100);
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

// ---- demo clip: drawn procedurally so the page works with no assets

function mulberry32(a: number): () => number {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(7);
const STARS = Array.from({ length: 60 }, () => ({
  x: rand(),
  y: rand(),
  s: 0.6 + rand() * 1.6,
  a: 0.2 + rand() * 0.6,
}));
const ORBITERS: ReadonlyArray<readonly [number, string]> = [
  [0, '255, 96, 70'],
  [Math.PI, '96, 140, 255'],
];

function drawDemoFrame(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, i: number): void {
  const u = t / DEMO_SECONDS;
  const cx = w / 2;
  const cy = h / 2;
  const k = h / 252;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);

  for (const s of STARS) {
    // static pixels become straight lines through the volume
    ctx.fillStyle = `rgba(226, 232, 255, ${s.a})`;
    ctx.fillRect(s.x * w, s.y * h, s.s * k, s.s * k);
  }

  const sx = u * w; // a sweep becomes a diagonal plane
  const sweep = ctx.createLinearGradient(sx - w * 0.1, 0, sx, 0);
  sweep.addColorStop(0, 'rgba(140, 170, 255, 0)');
  sweep.addColorStop(1, 'rgba(140, 170, 255, 0.28)');
  ctx.fillStyle = sweep;
  ctx.fillRect(sx - w * 0.1, 0, w * 0.1, h);
  ctx.fillStyle = 'rgba(220, 230, 255, 0.85)';
  ctx.fillRect(sx - k, 0, 2 * k, h);

  const breath = 0.5 - 0.5 * Math.cos(u * Math.PI * 4); // a breathing ring becomes a vase
  ctx.lineWidth = 3 * k;
  ctx.strokeStyle = 'rgba(244, 238, 228, 0.8)';
  ctx.beginPath();
  ctx.arc(cx, cy, h * (0.09 + 0.15 * breath), 0, Math.PI * 2);
  ctx.stroke();

  for (const [phase, rgb] of ORBITERS) {
    // an orbiting pair becomes a double helix
    const a = u * Math.PI * 4 + phase;
    const ox = cx + Math.cos(a) * w * 0.3;
    const oy = cy + Math.sin(a) * h * 0.3;
    const r = h * 0.1;
    const g = ctx.createRadialGradient(ox, oy, 0, ox, oy, r);
    g.addColorStop(0, 'rgba(255, 255, 255, 1)');
    g.addColorStop(0.22, `rgba(${rgb}, 1)`);
    g.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(ox, oy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const pad = h * 0.06;
  ctx.font = `600 ${Math.round(h * 0.07)}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
  ctx.fillStyle = 'rgba(238, 241, 248, 0.9)';
  ctx.textAlign = 'left';
  ctx.fillText(fmtTime(t), pad, h - pad);
  ctx.textAlign = 'right';
  ctx.fillText(`#${String(i + 1).padStart(3, '0')}`, w - pad, h - pad);
}

export const demoSource = (): FrameSource => ({
  kind: 'demo',
  name: 'Demo clip',
  duration: DEMO_SECONDS,
  aspect: 16 / 9,
  draw: drawDemoFrame,
});

// ---- local video: seek + drawImage per slice, all on-device

export interface LoadedVideo {
  el: HTMLVideoElement;
  url: string;
  name: string;
}

function loadVideo(src: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.className = 'decoder';
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      v.removeAttribute('src');
      v.remove();
      reject(new Error('video'));
    };
    const timer = setTimeout(fail, 20000);
    v.addEventListener('error', fail, { once: true });
    v.addEventListener(
      'loadeddata',
      async () => {
        clearTimeout(timer);
        await ensureDuration(v);
        if (!Number.isFinite(v.duration) || v.duration <= 0 || !v.videoWidth) {
          fail();
          return;
        }
        settled = true;
        resolve(v);
      },
      { once: true },
    );
    v.src = src;
    document.body.appendChild(v);
  });
}

// Recorded WebM often reports Infinity until the end has been seeked once.
async function ensureDuration(v: HTMLVideoElement): Promise<void> {
  if (Number.isFinite(v.duration)) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      v.removeEventListener('durationchange', check);
      resolve();
    };
    const check = () => {
      if (Number.isFinite(v.duration)) done();
    };
    v.addEventListener('durationchange', check);
    v.currentTime = 1e7;
    setTimeout(done, 3000);
  });
  v.currentTime = 0;
}

function seekTo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      v.removeEventListener('seeked', done);
      resolve();
    };
    const timer = setTimeout(done, 4000);
    v.addEventListener('seeked', done);
    v.currentTime = Math.min(t, Math.max(0, v.duration - 0.001));
  });
}

const readAsDataURL = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

/** Opens a video already on the server, such as the default clip in `public/`. */
export async function loadVideoUrl(url: string, name: string): Promise<LoadedVideo | null> {
  const el = await loadVideo(url).catch(() => null);
  return el ? { el, url, name } : null;
}

/** Opens a local video. Some hosts allow data: media but not blob:, so it falls back. */
export async function loadVideoFile(file: File): Promise<LoadedVideo | null> {
  let url = URL.createObjectURL(file);
  let el = await loadVideo(url).catch(() => null);
  if (!el) {
    URL.revokeObjectURL(url);
    url = await readAsDataURL(file).catch(() => '');
    el = url ? await loadVideo(url).catch(() => null) : null;
  }
  return el ? { el, url, name: file.name } : null;
}

export function disposeVideo(video: LoadedVideo): void {
  video.el.removeAttribute('src');
  video.el.load();
  video.el.remove();
  if (video.url.startsWith('blob:')) URL.revokeObjectURL(video.url);
}

export const videoSource = ({ el, name }: LoadedVideo): FrameSource => ({
  kind: 'video',
  name,
  duration: el.duration,
  aspect: el.videoWidth / el.videoHeight,
  draw: async (ctx, w, h, t) => {
    await seekTo(el, t);
    ctx.drawImage(el, 0, 0, w, h);
  },
});

/** The densest sample rate that keeps a clip within the headset's slice budget. */
export const autoRate = (duration: number): number =>
  [...RATES].reverse().find((r) => duration * r <= 128) ?? 1;
