/**
 * Sorang's CPU side, run once per image or grid change: which depth slice and which stock
 * photo each tile gets, plus the dust and the link pairs. The GPU never samples depth.
 */
import type { DepthField } from './depth-model.js';
import { SLICES } from './sorang-timeline.js';

/** Working resolution for depth and brightness, along the long side. */
const MAP_LONG = 256;
/** How many photos nearest in brightness a tile chooses among. */
const NEAREST = 6;
/** Share of tiles drawn three times larger once they fly. */
const HERO_SHARE = 0.03;
/** Pull the depth halfway to its rank, so every one of the 100 slices carries tiles. */
const EQUALISE = 0.75;
export const LINK_PAIRS = 48;
/**
 * How much of the model's depth a flat plane must explain before it counts as a photo of a
 * flat painting: the default painting scores 0.99, a landscape photo about 0.9.
 */
const PLANAR_FROM = 0.93;
const PLANAR_TO = 0.985;

const LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

/** Integer hash (PCG output permutation); `salt` picks an independent stream. */
export function hash(id: number, salt: number): number {
  let state = (Math.imul(id ^ Math.imul(salt + 1, 0x9e3779b9), 747796405) + 2891336453) >>> 0;
  const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737) >>> 0;
  state = ((word >>> 22) ^ word) >>> 0;
  return state;
}
const rand = (id: number, salt: number) => hash(id, salt) / 4294967296;

export interface Grid {
  x: number;
  y: number;
}

/** Tiles along each side for `across` along the long side. */
export function gridFor(aspect: number, across: number, out: Grid): Grid {
  out.x = aspect >= 1 ? across : Math.max(1, Math.round(across * aspect));
  out.y = aspect >= 1 ? Math.max(1, Math.round(across / aspect)) : across;
  return out;
}

export interface TileBuffers {
  capacity: number;
  count: number;
  grid: Grid;
  /** Per tile: i, j (j = 0 is the bottom row), slice (99 nearest), photo layer. */
  tile: Float32Array;
  /** Per tile: equalised depth 0..1 (1 nearest), photo mean brightness, hero, 0. */
  info: Float32Array;
}

export interface DustBuffers {
  capacity: number;
  count: number;
  /** Painting uv, z = 0. A real position attribute, or three draws nothing. */
  position: Float32Array;
  /** Slice, equalised depth. */
  dust: Float32Array;
}

export interface LinkBuffers {
  position: Float32Array;
  tile: Float32Array;
  info: Float32Array;
}

export function tileBuffers(capacity: number): TileBuffers {
  return { capacity, count: 0, grid: { x: 1, y: 1 }, tile: new Float32Array(capacity * 4), info: new Float32Array(capacity * 4) };
}

export function dustBuffers(capacity: number): DustBuffers {
  return { capacity, count: 0, position: new Float32Array(capacity * 3), dust: new Float32Array(capacity * 2) };
}

export function linkBuffers(): LinkBuffers {
  const n = LINK_PAIRS * 2;
  return { position: new Float32Array(n * 3), tile: new Float32Array(n * 4), info: new Float32Array(n * 4) };
}

/** Depth and brightness on one working grid, rows top-down like the canvas. */
export interface DepthMap {
  w: number;
  h: number;
  /** 0..1, 1 nearest, before equalising. */
  depth: Float32Array;
  /** Perceptual brightness: sqrt of linear luma. */
  luma: Float32Array;
  /** How much of the model's depth was a flat tilted plane (0..1), for the console line. */
  planar: number;
  /** Sorted tile depths, for equalising the dust the same way as the tiles. */
  sorted: Float32Array;
}

/** Brightness of the painting on the working grid. */
function lumaMap(paint: HTMLCanvasElement, w: number, h: number): Float32Array {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const out = new Float32Array(w * h);
  if (!ctx) return out.fill(0.5);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(paint, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  for (let i = 0; i < out.length; i++) {
    const j = i * 4;
    out[i] = Math.sqrt(0.2126 * LINEAR[px[j]] + 0.7152 * LINEAR[px[j + 1]] + 0.0722 * LINEAR[px[j + 2]]);
  }
  return out;
}

/** Box-average a depth field onto the working grid. */
function resampleDepth(field: DepthField, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const sx = field.width / w;
  const sy = field.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1 && yy < field.height; yy++) {
        for (let xx = x0; xx < x1 && xx < field.width; xx++) {
          sum += field.data[yy * field.width + xx];
          n++;
        }
      }
      out[y * w + x] = n ? sum / n / 255 : 0.5;
    }
  }
  return out;
}

/**
 * Remove the best-fit plane when it explains nearly all of the depth. A photo of a flat
 * painting comes back from the model as a tilted card; its leftover bulge, plus the paint's
 * own brightness, is the relief worth showing. Returns the plane's share of the variance.
 */
function detrend(depth: Float32Array, w: number, h: number): number {
  // Least squares for z = a + b·x + c·y on centred coordinates (the cross terms vanish).
  let mean = 0;
  for (let i = 0; i < depth.length; i++) mean += depth[i];
  mean /= depth.length;
  let sxz = 0;
  let syz = 0;
  let sxx = 0;
  let syy = 0;
  for (let y = 0; y < h; y++) {
    const cy = y - (h - 1) / 2;
    for (let x = 0; x < w; x++) {
      const cx = x - (w - 1) / 2;
      const z = depth[y * w + x] - mean;
      sxz += cx * z;
      syz += cy * z;
      sxx += cx * cx;
      syy += cy * cy;
    }
  }
  const b = sxx > 0 ? sxz / sxx : 0;
  const c = syy > 0 ? syz / syy : 0;
  let total = 0;
  let resid = 0;
  const residual = new Float32Array(depth.length);
  for (let y = 0; y < h; y++) {
    const cy = y - (h - 1) / 2;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const z = depth[i] - mean;
      const r = z - b * (x - (w - 1) / 2) - c * cy;
      residual[i] = r;
      total += z * z;
      resid += r * r;
    }
  }
  const planar = total > 1e-9 ? 1 - resid / total : 1;
  const flat = smoothstep(PLANAR_FROM, PLANAR_TO, planar);
  if (flat <= 0) return planar;
  const [lo, hi] = percentiles(residual, 0.02, 0.98);
  const span = Math.max(1e-6, hi - lo);
  for (let i = 0; i < depth.length; i++) {
    const r = Math.min(1, Math.max(0, (residual[i] - lo) / span));
    depth[i] += (r - depth[i]) * flat;
  }
  return planar;
}

function smoothstep(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function percentiles(values: Float32Array, a: number, b: number): [number, number] {
  const sorted = Float32Array.from(values).sort();
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
  return [at(a), at(b)];
}

/**
 * Depth and brightness for one painting. Without a depth field (still loading, or failed)
 * the centre stands nearest and brightness does the rest.
 */
export function depthMap(paint: HTMLCanvasElement, field: DepthField | null): DepthMap {
  const aspect = paint.width / Math.max(1, paint.height);
  const w = aspect >= 1 ? MAP_LONG : Math.max(8, Math.round(MAP_LONG * aspect));
  const h = aspect >= 1 ? Math.max(8, Math.round(MAP_LONG / aspect)) : MAP_LONG;
  const luma = lumaMap(paint, w, h);
  let depth: Float32Array;
  let planar = 0;
  let lumaShare: number;
  if (field) {
    depth = resampleDepth(field, w, h);
    planar = detrend(depth, w, h);
    // A real photo keeps its own depth: bright sky must not come forward.
    lumaShare = 0.1 + 0.65 * smoothstep(PLANAR_FROM, PLANAR_TO, planar);
  } else {
    depth = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const r = Math.hypot((x + 0.5) / w - 0.5, (y + 0.5) / h - 0.5) / Math.SQRT1_2;
        depth[y * w + x] = 1 - r;
      }
    }
    lumaShare = 0.6;
  }
  // Bright paint stands forward on a flat painting: in the reference the white strokes streak out first.
  for (let i = 0; i < depth.length; i++) depth[i] += (luma[i] - depth[i]) * lumaShare;
  return { w, h, depth, luma, planar, sorted: new Float32Array(0) };
}

function sampleMap(map: Float32Array, w: number, h: number, u: number, v: number): number {
  // u, v with v up; map rows run top-down.
  const fx = Math.min(w - 1, Math.max(0, u * w - 0.5));
  const fy = Math.min(h - 1, Math.max(0, (1 - v) * h - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = map[y0 * w + x0] + (map[y0 * w + x1] - map[y0 * w + x0]) * tx;
  const b = map[y1 * w + x0] + (map[y1 * w + x1] - map[y1 * w + x0]) * tx;
  return a + (b - a) * ty;
}

/** Share of tile depths below `d`, by binary search. */
function rankOf(sorted: Float32Array, d: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < d) lo = mid + 1;
    else hi = mid;
  }
  return sorted.length > 1 ? lo / (sorted.length - 1) : 0.5;
}

/**
 * Fill the tile attributes. Tiles are written nearest slice first so the near sheets
 * fill the depth buffer before the far ones are shaded.
 */
export function buildTiles(map: DepthMap, aspect: number, across: number, photoMeans: Float32Array, out: TileBuffers): void {
  const grid = gridFor(aspect, across, out.grid);
  const gx = grid.x;
  const gy = grid.y;
  const n = Math.min(out.capacity, gx * gy);
  out.count = n;
  const depth = new Float32Array(gx * gy);
  const luma = new Float32Array(gx * gy);
  // Cell averages; tile row j = 0 is the bottom, map row 0 is the top.
  for (let j = 0; j < gy; j++) {
    const my0 = Math.floor(((gy - 1 - j) * map.h) / gy);
    const my1 = Math.max(my0 + 1, Math.floor(((gy - j) * map.h) / gy));
    for (let i = 0; i < gx; i++) {
      const mx0 = Math.floor((i * map.w) / gx);
      const mx1 = Math.max(mx0 + 1, Math.floor(((i + 1) * map.w) / gx));
      let sd = 0;
      let sl = 0;
      let c = 0;
      for (let y = my0; y < my1; y++) {
        for (let x = mx0; x < mx1; x++) {
          sd += map.depth[y * map.w + x];
          sl += map.luma[y * map.w + x];
          c++;
        }
      }
      depth[j * gx + i] = sd / Math.max(1, c);
      luma[j * gx + i] = sl / Math.max(1, c);
    }
  }
  // 1-2-1 blur in tile space so neighbouring tiles rarely land many sheets apart.
  const blurred = new Float32Array(gx * gy);
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      let s = 0;
      let wsum = 0;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = Math.min(gy - 1, Math.max(0, j + dj));
        for (let di = -1; di <= 1; di++) {
          const ii = Math.min(gx - 1, Math.max(0, i + di));
          const wgt = (2 - Math.abs(di)) * (2 - Math.abs(dj));
          s += depth[jj * gx + ii] * wgt;
          wsum += wgt;
        }
      }
      blurred[j * gx + i] = s / wsum;
    }
  }
  map.sorted = Float32Array.from(blurred).sort();

  // Photos sorted by brightness, for the nearest-brightness pick.
  const order = Array.from(photoMeans, (_, k) => k).sort((a, b) => photoMeans[a] - photoMeans[b]);
  const sortedMeans = Float32Array.from(order, (k) => photoMeans[k]);
  const chosen = new Int16Array(gx * gy).fill(-1);
  const slices = new Uint8Array(gx * gy);
  const eq = new Float32Array(gx * gy);
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      const t = j * gx + i;
      const d = blurred[t];
      const e = d + (rankOf(map.sorted, d) - d) * EQUALISE;
      eq[t] = e;
      slices[t] = Math.min(SLICES - 1, Math.floor(e * SLICES));
      if (!order.length) continue;
      // The window of NEAREST photos around this tile's brightness.
      let lo = 0;
      let hi = sortedMeans.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedMeans[mid] < luma[t]) lo = mid + 1;
        else hi = mid;
      }
      const k = Math.min(NEAREST, order.length);
      const start = Math.max(0, Math.min(order.length - k, lo - (k >> 1)));
      const left = i > 0 ? chosen[t - 1] : -1;
      const below = j > 0 ? chosen[t - gx] : -1;
      const first = hash(t, 11) % k;
      let pick = order[start + first];
      for (let step = 0; step < k; step++) {
        const candidate = order[start + ((first + step) % k)];
        if (candidate !== left && candidate !== below) {
          pick = candidate;
          break;
        }
      }
      chosen[t] = pick;
    }
  }

  // Nearest slice first.
  const draw = Array.from({ length: gx * gy }, (_, t) => t).sort((a, b) => slices[b] - slices[a] || a - b);
  for (let k = 0; k < n; k++) {
    const t = draw[k];
    const i = t % gx;
    const j = (t - i) / gx;
    const o = k * 4;
    out.tile[o] = i;
    out.tile[o + 1] = j;
    out.tile[o + 2] = slices[t];
    out.tile[o + 3] = Math.max(0, chosen[t]);
    out.info[o] = eq[t];
    out.info[o + 1] = chosen[t] >= 0 ? photoMeans[chosen[t]] : 0.5;
    out.info[o + 2] = rand(t, 23) < HERO_SHARE ? 1 : 0;
    out.info[o + 3] = 0;
  }
}

/** Fill the dust: a jittered grid over the painting, equalised like the tiles. */
export function buildDust(map: DepthMap, aspect: number, across: number, out: DustBuffers): void {
  if (across <= 0) {
    out.count = 0;
    return;
  }
  const dx = aspect >= 1 ? across : Math.max(1, Math.round(across * aspect));
  const dy = aspect >= 1 ? Math.max(1, Math.round(across / aspect)) : across;
  const n = Math.min(out.capacity, dx * dy);
  out.count = n;
  for (let k = 0; k < n; k++) {
    const x = k % dx;
    const y = (k - x) / dx;
    const u = (x + rand(k, 31)) / dx;
    const v = (y + rand(k, 37)) / dy;
    const d = sampleMap(map.depth, map.w, map.h, u, v);
    const e = map.sorted.length ? d + (rankOf(map.sorted, d) - d) * EQUALISE : d;
    out.position[k * 3] = u;
    out.position[k * 3 + 1] = v;
    out.position[k * 3 + 2] = 0;
    out.dust[k * 2] = Math.min(SLICES - 1, Math.floor(e * SLICES));
    out.dust[k * 2 + 1] = e;
  }
}

/** Pairs of nearby tiles, drawn as faint lines once the pieces orbit. */
export function buildLinks(tiles: TileBuffers, out: LinkBuffers): void {
  const n = tiles.count;
  if (!n) return;
  // Tile index by grid cell, since the buffers are in draw order.
  const gx = tiles.grid.x;
  const gy = tiles.grid.y;
  const at = new Int32Array(gx * gy).fill(-1);
  for (let k = 0; k < n; k++) at[tiles.tile[k * 4 + 1] * gx + tiles.tile[k * 4]] = k;
  for (let p = 0; p < LINK_PAIRS; p++) {
    const a = hash(p, 41) % n;
    const ai = tiles.tile[a * 4];
    const aj = tiles.tile[a * 4 + 1];
    const bi = Math.min(gx - 1, Math.max(0, ai + (hash(p, 43) % 17) - 8));
    const bj = Math.min(gy - 1, Math.max(0, aj + (hash(p, 47) % 17) - 8));
    const b = at[bj * gx + bi] >= 0 ? at[bj * gx + bi] : a;
    for (let e = 0; e < 2; e++) {
      const src = e === 0 ? a : b;
      const v = p * 2 + e;
      out.position[v * 3] = tiles.tile[src * 4];
      out.position[v * 3 + 1] = tiles.tile[src * 4 + 1];
      out.position[v * 3 + 2] = 0;
      for (let c = 0; c < 4; c++) {
        out.tile[v * 4 + c] = tiles.tile[src * 4 + c];
        out.info[v * 4 + c] = tiles.info[src * 4 + c];
      }
    }
  }
}
