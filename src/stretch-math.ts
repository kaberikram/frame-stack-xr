/** Pure geometry and motion helpers, kept free of three.js so they can be tested on their own. */

/** Slab test in box-local space. Returns the entry distance along the ray, or -1 on a miss. */
export function rayBox(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  cx: number, cy: number, cz: number,
  hx: number, hy: number, hz: number,
): number {
  let near = -Infinity;
  let far = Infinity;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  const c = [cx, cy, cz];
  const h = [hx, hy, hz];
  for (let i = 0; i < 3; i++) {
    const lo = c[i] - h[i];
    const hi = c[i] + h[i];
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < lo || o[i] > hi) return -1; // parallel and outside this slab
      continue;
    }
    const inv = 1 / d[i];
    let t0 = (lo - o[i]) * inv;
    let t1 = (hi - o[i]) * inv;
    if (t0 > t1) [t0, t1] = [t1, t0];
    near = Math.max(near, t0);
    far = Math.min(far, t1);
    if (near > far) return -1;
  }
  if (far < 0) return -1;
  return near >= 0 ? near : far; // inside the box counts as a hit at the exit
}

export interface Pull {
  axis: 0 | 1 | 2;
  /** Where the grab landed along that axis, 0 at the -axis end and 1 at the +axis end. */
  along: number;
}

/**
 * Picks the axis to stretch from where the object was grabbed. Axes thinner than
 * `minSize` are skipped, so a wall never stretches through its own thickness, and the
 * axis you hit dead-on is skipped too: that one points at your face, so stretching
 * along it would only shove the object at you. Direction is left to the pull itself.
 */
export function pickPull(
  px: number, py: number, pz: number,
  sx: number, sy: number, sz: number,
  minSize = 0.15,
): Pull {
  const p = [px, py, pz];
  const s = [sx, sy, sz];
  const reach = [0, 0, 0];
  const biggest = Math.max(sx, sy, sz);
  const eligible: number[] = [];
  for (let i = 0; i < 3; i++) {
    reach[i] = Math.abs(p[i]) / Math.max(s[i] / 2, 1e-4);
    if (s[i] >= minSize || biggest < minSize) eligible.push(i);
  }
  if (!eligible.length) eligible.push(0, 1, 2);
  let face = eligible[0];
  for (const i of eligible) if (reach[i] > reach[face]) face = i;
  const candidates = eligible.length > 1 && reach[face] > 0.9 ? eligible.filter((i) => i !== face) : eligible;
  let axis = candidates[0];
  for (const i of candidates) if (reach[i] > reach[axis]) axis = i;
  const half = Math.max(s[axis] / 2, 1e-4);
  const along = Math.min(1, Math.max(0, (p[axis] / half) * 0.5 + 0.5));
  return { axis: axis as 0 | 1 | 2, along };
}

/**
 * Closest hit against a subset of an indexed triangle soup. `tris[from..to)` are
 * triangle numbers. The direction must be normalized. Returns the distance, or -1.
 * Two-sided, so a room mesh is grabbable from inside the scan.
 */
export function rayTriangleRange(
  positions: ArrayLike<number>,
  index: ArrayLike<number>,
  tris: ArrayLike<number>,
  from: number,
  to: number,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
): number {
  let best = Infinity;
  for (let i = from; i < to; i++) {
    const tri = tris[i] * 3;
    const t = rayTriangle(
      ox, oy, oz, dx, dy, dz,
      positions, index[tri] * 3, index[tri + 1] * 3, index[tri + 2] * 3,
    );
    if (t >= 0 && t < best) best = t;
  }
  return best === Infinity ? -1 : best;
}

export interface TriGrid {
  minX: number;
  minY: number;
  minZ: number;
  cell: number;
  dimX: number;
  dimY: number;
  dimZ: number;
  starts: Int32Array;
  tris: Int32Array;
}

/**
 * Bucket each triangle into every cell its bounds overlap, so a ray that clips a
 * large triangle still finds it. Rebuilt when the scan refreshes, not per frame.
 */
export function buildTriGrid(
  positions: ArrayLike<number>,
  index: ArrayLike<number>,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
  cell = 0.8,
): TriGrid {
  const dimX = Math.max(1, Math.ceil((maxX - minX) / cell));
  const dimY = Math.max(1, Math.ceil((maxY - minY) / cell));
  const dimZ = Math.max(1, Math.ceil((maxZ - minZ) / cell));
  const cells = dimX * dimY * dimZ;
  const triCount = Math.floor(index.length / 3);
  const counts = new Int32Array(cells);
  const clamp = (v: number, hi: number) => Math.min(hi - 1, Math.max(0, v));
  let x0 = 0;
  let y0 = 0;
  let z0 = 0;
  let x1 = 0;
  let y1 = 0;
  let z1 = 0;
  const bounds = (tri: number) => {
    const base = tri * 3;
    const ia = index[base] * 3;
    const ib = index[base + 1] * 3;
    const ic = index[base + 2] * 3;
    x0 = Math.min(positions[ia], positions[ib], positions[ic]);
    y0 = Math.min(positions[ia + 1], positions[ib + 1], positions[ic + 1]);
    z0 = Math.min(positions[ia + 2], positions[ib + 2], positions[ic + 2]);
    x1 = Math.max(positions[ia], positions[ib], positions[ic]);
    y1 = Math.max(positions[ia + 1], positions[ib + 1], positions[ic + 1]);
    z1 = Math.max(positions[ia + 2], positions[ib + 2], positions[ic + 2]);
  };
  let inserts = 0;
  for (let tri = 0; tri < triCount; tri++) {
    bounds(tri);
    const ix0 = clamp(Math.floor((x0 - minX) / cell), dimX);
    const iy0 = clamp(Math.floor((y0 - minY) / cell), dimY);
    const iz0 = clamp(Math.floor((z0 - minZ) / cell), dimZ);
    const ix1 = clamp(Math.floor((x1 - minX) / cell), dimX);
    const iy1 = clamp(Math.floor((y1 - minY) / cell), dimY);
    const iz1 = clamp(Math.floor((z1 - minZ) / cell), dimZ);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          counts[ix + dimX * (iy + dimY * iz)]++;
          inserts++;
        }
      }
    }
  }
  const starts = new Int32Array(cells + 1);
  for (let i = 0; i < cells; i++) starts[i + 1] = starts[i] + counts[i];
  const cursor = new Int32Array(starts);
  const tris = new Int32Array(Math.max(inserts, 1));
  for (let tri = 0; tri < triCount; tri++) {
    bounds(tri);
    const ix0 = clamp(Math.floor((x0 - minX) / cell), dimX);
    const iy0 = clamp(Math.floor((y0 - minY) / cell), dimY);
    const iz0 = clamp(Math.floor((z0 - minZ) / cell), dimZ);
    const ix1 = clamp(Math.floor((x1 - minX) / cell), dimX);
    const iy1 = clamp(Math.floor((y1 - minY) / cell), dimY);
    const iz1 = clamp(Math.floor((z1 - minZ) / cell), dimZ);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let iz = iz0; iz <= iz1; iz++) tris[cursor[ix + dimX * (iy + dimY * iz)]++] = tri;
      }
    }
  }
  return { minX, minY, minZ, cell, dimX, dimY, dimZ, starts, tris };
}

/**
 * Ray through a triangle grid, in the same space as the vertices. Direction must
 * be normalized. Returns the distance, or -1. A miss of the grid bounds is -1,
 * and a ray that starts inside begins in its own cell.
 */
export function rayTriGrid(
  positions: ArrayLike<number>,
  index: ArrayLike<number>,
  grid: TriGrid,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
): number {
  const { minX, minY, minZ, cell, dimX, dimY, dimZ, starts, tris } = grid;
  const maxX = minX + dimX * cell;
  const maxY = minY + dimY * cell;
  const maxZ = minZ + dimZ * cell;
  const inside = ox >= minX && ox <= maxX && oy >= minY && oy <= maxY && oz >= minZ && oz <= maxZ;
  let t = 0;
  if (!inside) {
    t = rayBox(
      ox, oy, oz, dx, dy, dz,
      (minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2,
      (maxX - minX) / 2, (maxY - minY) / 2, (maxZ - minZ) / 2,
    );
    if (t < 0) return -1;
  }
  const clamp = (v: number, hi: number) => Math.min(hi - 1, Math.max(0, v));
  let ix = clamp(Math.floor((ox + dx * t - minX) / cell), dimX);
  let iy = clamp(Math.floor((oy + dy * t - minY) / cell), dimY);
  let iz = clamp(Math.floor((oz + dz * t - minZ) / cell), dimZ);
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;
  const tDeltaX = Math.abs(dx) < 1e-9 ? Infinity : Math.abs(cell / dx);
  const tDeltaY = Math.abs(dy) < 1e-9 ? Infinity : Math.abs(cell / dy);
  const tDeltaZ = Math.abs(dz) < 1e-9 ? Infinity : Math.abs(cell / dz);
  const boundary = (i: number, min: number, step: number, origin: number, dir: number) => {
    if (Math.abs(dir) < 1e-9) return Infinity;
    const edge = min + (step > 0 ? i + 1 : i) * cell;
    return t + (edge - (origin + dir * t)) / dir;
  };
  let tMaxX = boundary(ix, minX, stepX, ox, dx);
  let tMaxY = boundary(iy, minY, stepY, oy, dy);
  let tMaxZ = boundary(iz, minZ, stepZ, oz, dz);
  let best = Infinity;
  const maxSteps = dimX + dimY + dimZ + 3;
  for (let n = 0; n < maxSteps; n++) {
    const id = ix + dimX * (iy + dimY * iz);
    const hit = rayTriangleRange(positions, index, tris, starts[id], starts[id + 1], ox, oy, oz, dx, dy, dz);
    if (hit >= 0 && hit < best) best = hit;
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      if (best <= tMaxX) break;
      ix += stepX;
      if (ix < 0 || ix >= dimX) break;
      tMaxX += tDeltaX;
    } else if (tMaxY <= tMaxZ) {
      if (best <= tMaxY) break;
      iy += stepY;
      if (iy < 0 || iy >= dimY) break;
      tMaxY += tDeltaY;
    } else {
      if (best <= tMaxZ) break;
      iz += stepZ;
      if (iz < 0 || iz >= dimZ) break;
      tMaxZ += tDeltaZ;
    }
  }
  return best === Infinity ? -1 : best;
}

/** Distance from a point to an AABB. Zero when the point is inside. */
export function pointAabbGap(
  px: number, py: number, pz: number,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): number {
  const dx = px < minX ? minX - px : px > maxX ? px - maxX : 0;
  const dy = py < minY ? minY - py : py > maxY ? py - maxY : 0;
  const dz = pz < minZ ? minZ - pz : pz > maxZ ? pz - maxZ : 0;
  return Math.hypot(dx, dy, dz);
}

function rayTriangle(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  positions: ArrayLike<number>,
  ia: number, ib: number, ic: number,
): number {
  const ax = positions[ia];
  const ay = positions[ia + 1];
  const az = positions[ia + 2];
  const e1x = positions[ib] - ax;
  const e1y = positions[ib + 1] - ay;
  const e1z = positions[ib + 2] - az;
  const e2x = positions[ic] - ax;
  const e2y = positions[ic + 1] - ay;
  const e2z = positions[ic + 2] - az;
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-8 && det < 1e-8) return -1;
  const inv = 1 / det;
  const tx = ox - ax;
  const ty = oy - ay;
  const tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 1e-4 ? t : -1;
}

/** A damped spring. Underdamped on purpose: letting go should wobble, not glide. */
export class Spring {
  value = 0;
  velocity = 0;

  reset(value = 0): void {
    this.value = value;
    this.velocity = 0;
  }

  /** Steps toward `target`, substepping so a dropped frame can't make it explode. */
  step(target: number, dt: number, stiffness: number, damping: number): number {
    let left = Math.min(dt, 0.1);
    while (left > 0) {
      const h = Math.min(left, 1 / 120);
      this.velocity += (-stiffness * (this.value - target) - damping * this.velocity) * h;
      this.value += this.velocity * h;
      left -= h;
    }
    return this.value;
  }

  /** True once it has settled near the target. */
  atRest(target: number, epsilon = 0.004): boolean {
    return Math.abs(this.value - target) < epsilon && Math.abs(this.velocity) < epsilon * 8;
  }
}
