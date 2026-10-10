/** Longest edge the dense room mesh aims for. Raised automatically when the cap would overflow. */
export const TARGET_EDGE = 0.05;
/** Hard stop so a large scan can't turn into a million triangles on the headset. */
export const MAX_TRIANGLES = 250_000;
/**
 * Within this far of the focus (where you stand) edges aim for the target; beyond, the target grows
 * in proportion, so far walls and the ceiling don't spend the budget the furniture near you needs.
 */
const FOCUS_NEAR = 1.5;

export interface DenseMesh {
  positions: Float32Array;
  indices: Uint32Array;
  /** Edge length actually used. Larger than `TARGET_EDGE` when the cap got in the way. */
  edge: number;
}

/**
 * Midpoint-subdivide an indexed triangle soup until edges are near `edge` metres,
 * or the triangle cap says to stop. Pure: no Three, safe to run in a worker.
 * A pass that would pass the cap is thrown away and retried with a longer edge.
 */
export function subdivideMesh(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  edge = TARGET_EDGE,
  maxTriangles = MAX_TRIANGLES,
  focus: ArrayLike<number> | null = null,
): DenseMesh {
  let pos = positions instanceof Float32Array ? positions : Float32Array.from(positions);
  let idx = indices instanceof Uint32Array ? indices : Uint32Array.from(indices);
  let limit = Math.max(edge, 1e-3);
  for (let pass = 0; pass < 10; pass++) {
    if (idx.length / 3 >= maxTriangles) break;
    const next = splitPass(pos, idx, limit, maxTriangles, focus);
    if (next === 'stop') break;
    if (next === 'raise') {
      limit *= 1.4;
      if (limit > 0.6) break;
      continue;
    }
    pos = next.positions;
    idx = next.indices;
  }
  return { positions: pos, indices: idx, edge: limit };
}

type Split = DenseMesh | 'stop' | 'raise';

/**
 * Splits every edge longer than `edge` at its midpoint, and each triangle by how many of its
 * edges split (1 → 2, 2 → 3, 3 → 4). Deciding per edge rather than per triangle keeps
 * neighbours agreeing, so there are no T-junctions to crack open once the mesh bends.
 */
function splitPass(pos: Float32Array, idx: Uint32Array, edge: number, maxTriangles: number, focus: ArrayLike<number> | null): Split {
  const triCount = Math.floor(idx.length / 3);
  const edge2 = edge * edge;
  const mids = new Map<number, number>();
  // An edge's limit depends only on its own midpoint, so both triangles sharing it agree.
  const tooLong = (a: number, b: number): boolean => {
    const d2 = dist2(pos, a, b);
    if (d2 <= edge2) return false;
    if (!focus) return true;
    const ia = a * 3;
    const ib = b * 3;
    const far = Math.hypot(
      (pos[ia] + pos[ib]) * 0.5 - focus[0],
      (pos[ia + 1] + pos[ib + 1]) * 0.5 - focus[1],
      (pos[ia + 2] + pos[ib + 2]) * 0.5 - focus[2],
    ) / FOCUS_NEAR;
    return far <= 1 || d2 > edge2 * far * far;
  };
  let outTris = 0;
  for (let tri = 0; tri < triCount; tri++) {
    const base = tri * 3;
    const i0 = idx[base];
    const i1 = idx[base + 1];
    const i2 = idx[base + 2];
    let long = 0;
    if (tooLong(i0, i1)) {
      long++;
      mids.set(edgeKey(i0, i1), -1);
    }
    if (tooLong(i1, i2)) {
      long++;
      mids.set(edgeKey(i1, i2), -1);
    }
    if (tooLong(i2, i0)) {
      long++;
      mids.set(edgeKey(i2, i0), -1);
    }
    outTris += 1 + long;
  }
  if (mids.size === 0) return 'stop';
  if (outTris > maxTriangles) return 'raise';

  const outPos = new Float32Array(pos.length + mids.size * 3);
  outPos.set(pos);
  let verts = pos.length / 3;
  const outIdx = new Uint32Array(outTris * 3);
  let w = 0;
  const mid = (a: number, b: number): number => {
    const key = edgeKey(a, b);
    const found = mids.get(key);
    if (found !== undefined && found >= 0) return found;
    const v = verts++;
    const ia = a * 3;
    const ib = b * 3;
    outPos[v * 3] = (pos[ia] + pos[ib]) * 0.5;
    outPos[v * 3 + 1] = (pos[ia + 1] + pos[ib + 1]) * 0.5;
    outPos[v * 3 + 2] = (pos[ia + 2] + pos[ib + 2]) * 0.5;
    mids.set(key, v);
    return v;
  };
  const push = (a: number, b: number, c: number) => {
    outIdx[w++] = a;
    outIdx[w++] = b;
    outIdx[w++] = c;
  };
  for (let tri = 0; tri < triCount; tri++) {
    const base = tri * 3;
    const v0 = idx[base];
    const v1 = idx[base + 1];
    const v2 = idx[base + 2];
    const l0 = mids.has(edgeKey(v0, v1));
    const l1 = mids.has(edgeKey(v1, v2));
    const l2 = mids.has(edgeKey(v2, v0));
    const count = (l0 ? 1 : 0) + (l1 ? 1 : 0) + (l2 ? 1 : 0);
    if (count === 0) {
      push(v0, v1, v2);
    } else if (count === 3) {
      const m01 = mid(v0, v1);
      const m12 = mid(v1, v2);
      const m20 = mid(v2, v0);
      push(v0, m01, m20);
      push(m01, v1, m12);
      push(m20, m12, v2);
      push(m01, m12, m20);
    } else if (count === 1) {
      // Rotate so the split edge is a→b; winding stays a, b, c.
      const [a, b, c] = l0 ? [v0, v1, v2] : l1 ? [v1, v2, v0] : [v2, v0, v1];
      const m = mid(a, b);
      push(a, m, c);
      push(m, b, c);
    } else {
      // Rotate so the unsplit edge is c→a, then cut the quad a, m0, m1, c on its shorter diagonal.
      const [a, b, c] = !l2 ? [v0, v1, v2] : !l0 ? [v1, v2, v0] : [v2, v0, v1];
      const m0 = mid(a, b);
      const m1 = mid(b, c);
      push(m0, b, m1);
      if (dist2(outPos, a, m1) <= dist2(outPos, m0, c)) {
        push(a, m0, m1);
        push(a, m1, c);
      } else {
        push(a, m0, c);
        push(m0, m1, c);
      }
    }
  }
  return { positions: outPos.slice(0, verts * 3), indices: outIdx.slice(0, w), edge };
}

/** Chunk cell size, metres. A pull's reach spans a few cells, a room a few hundred. */
const CHUNK_CELL = 0.5;
/** Chunk boxes grow by this, so a later snap onto a plane (a few centimetres) stays inside them. */
const CHUNK_PAD = 0.05;
/** Floats per chunk: first index, index count, box min xyz, box max xyz. */
export const CHUNK_STRIDE = 8;

export interface ChunkedMesh {
  indices: Uint32Array;
  /** CHUNK_STRIDE floats per chunk, in index order. */
  chunks: Float32Array;
}

/**
 * Reorders triangles by the half-metre cell their centroid falls in, cells in Morton order, so each
 * cell is one contiguous index range and neighbouring cells tend to sit next to each other. The
 * renderer then draws only the cells a pull can reach with the stretch program, in a few runs.
 */
export function chunkMesh(pos: Float32Array, idx: Uint32Array): ChunkedMesh {
  const triCount = Math.floor(idx.length / 3);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i] < minX) minX = pos[i];
    if (pos[i + 1] < minY) minY = pos[i + 1];
    if (pos[i + 2] < minZ) minZ = pos[i + 2];
  }
  // Key and triangle packed in one double, so one native numeric sort orders both: keys need 30 bits,
  // triangles 20 (MAX_TRIANGLES is a quarter of that).
  const order = new Float64Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const a = idx[t * 3] * 3;
    const b = idx[t * 3 + 1] * 3;
    const c = idx[t * 3 + 2] * 3;
    const cx = Math.floor(((pos[a] + pos[b] + pos[c]) / 3 - minX) / CHUNK_CELL);
    const cy = Math.floor(((pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3 - minY) / CHUNK_CELL);
    const cz = Math.floor(((pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3 - minZ) / CHUNK_CELL);
    order[t] = morton(Math.min(cx, 1023), Math.min(cy, 1023), Math.min(cz, 1023)) * 1048576 + t;
  }
  order.sort();
  const out = new Uint32Array(triCount * 3);
  const boxes: number[] = [];
  let key = -1;
  let box = -1;
  for (let i = 0; i < triCount; i++) {
    const t = order[i] % 1048576;
    const k = Math.floor(order[i] / 1048576);
    if (k !== key) {
      key = k;
      box = boxes.length;
      boxes.push(i * 3, 0, Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
    }
    boxes[box + 1] += 3;
    for (let j = 0; j < 3; j++) {
      const v = idx[t * 3 + j];
      out[i * 3 + j] = v;
      const o = v * 3;
      for (let axis = 0; axis < 3; axis++) {
        const x = pos[o + axis];
        if (x < boxes[box + 2 + axis]) boxes[box + 2 + axis] = x;
        if (x > boxes[box + 5 + axis]) boxes[box + 5 + axis] = x;
      }
    }
  }
  const chunks = new Float32Array(boxes.length);
  for (let i = 0; i < boxes.length; i += CHUNK_STRIDE) {
    chunks[i] = boxes[i];
    chunks[i + 1] = boxes[i + 1];
    for (let axis = 0; axis < 3; axis++) {
      chunks[i + 2 + axis] = boxes[i + 2 + axis] - CHUNK_PAD;
      chunks[i + 5 + axis] = boxes[i + 5 + axis] + CHUNK_PAD;
    }
  }
  return { indices: out, chunks };
}

/** Interleaves three 10-bit cell coordinates. */
function morton(x: number, y: number, z: number): number {
  let key = 0;
  for (let bit = 0; bit < 10; bit++) {
    key += (((x >> bit) & 1) + ((y >> bit) & 1) * 2 + ((z >> bit) & 1) * 4) * 2 ** (bit * 3);
  }
  return key;
}

function edgeKey(a: number, b: number): number {
  return a < b ? a * 1048573 + b : b * 1048573 + a;
}

function dist2(pos: Float32Array, a: number, b: number): number {
  const ia = a * 3;
  const ib = b * 3;
  const dx = pos[ia] - pos[ib];
  const dy = pos[ia + 1] - pos[ib + 1];
  const dz = pos[ia + 2] - pos[ib + 2];
  return dx * dx + dy * dy + dz * dz;
}

/** Signed distance from (x, z) to a polygon's outline (x, z pairs): positive inside, negative outside. */
export function polygonDepth(polygon: ArrayLike<number>, points: number, x: number, z: number): number {
  let inside = false;
  let nearSq = Infinity;
  for (let i = 0, j = points - 1; i < points; j = i++) {
    const xi = polygon[i * 2];
    const zi = polygon[i * 2 + 1];
    const xj = polygon[j * 2];
    const zj = polygon[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    const ex = xj - xi;
    const ez = zj - zi;
    const lenSq = ex * ex + ez * ez;
    const t = lenSq > 1e-12 ? Math.max(0, Math.min(1, ((x - xi) * ex + (z - zi) * ez) / lenSq)) : 0;
    const dx = x - (xi + ex * t);
    const dz = z - (zi + ez * t);
    nearSq = Math.min(nearSq, dx * dx + dz * dz);
  }
  const d = Math.sqrt(nearSq);
  return inside ? d : -d;
}

/** A detected plane in the dense mesh's local space. */
export interface SnapPlane {
  /** Plane space to mesh space, column-major and rigid. Plane-space +Y is the plane's normal. */
  matrix: ArrayLike<number>;
  /** Outline in plane space, x and z pairs. */
  polygon: ArrayLike<number>;
  points: number;
  horizontal: boolean;
}

/** Vertices within this far of a table or floor snap onto it; walls are rougher scans. */
const SNAP_HORIZONTAL = 0.02;
const SNAP_VERTICAL = 0.025;
/** Only surfaces facing within 35° of the plane's normal: a table's front edge keeps its shape. */
const SNAP_FACING = Math.cos((35 * Math.PI) / 180);
/** The snap starts this far inside the outline and is full this much further in. */
const SNAP_INSET = 0.01;
const SNAP_FADE = 0.03;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Pulls the vertices that lie on a detected plane exactly onto it, so a table is flat instead of
 * lumpy by a centimetre or two. A vertex snaps when it is near the plane, its surface faces the
 * same way and it sits inside the outline. The pull fades toward the outline and with distance
 * from the plane, so nothing creases. Writes `rest` moved into `out`. Pure: safe in a worker.
 */
export function snapToPlanes(
  rest: Float32Array,
  indices: Uint32Array,
  planes: readonly SnapPlane[],
  out: Float32Array,
): { moved: number; planes: number } {
  out.set(rest);
  if (planes.length === 0) return { moved: 0, planes: 0 };
  const count = rest.length / 3;
  const normals = new Float32Array(rest.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const ux = rest[b] - rest[a];
    const uy = rest[b + 1] - rest[a + 1];
    const uz = rest[b + 2] - rest[a + 2];
    const vx = rest[c] - rest[a];
    const vy = rest[c + 1] - rest[a + 1];
    const vz = rest[c + 2] - rest[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    normals[a] += nx;
    normals[a + 1] += ny;
    normals[a + 2] += nz;
    normals[b] += nx;
    normals[b + 1] += ny;
    normals[b + 2] += nz;
    normals[c] += nx;
    normals[c + 1] += ny;
    normals[c + 2] += nz;
  }
  for (let v = 0; v < count; v++) {
    const o = v * 3;
    const len = Math.hypot(normals[o], normals[o + 1], normals[o + 2]);
    if (len > 1e-12) {
      normals[o] /= len;
      normals[o + 1] /= len;
      normals[o + 2] /= len;
    }
  }
  const weight = new Float32Array(count);
  const shift = new Float32Array(count);
  const owner = new Int16Array(count).fill(-1);
  for (let k = 0; k < planes.length; k++) {
    const plane = planes[k];
    const m = plane.matrix;
    const tol = plane.horizontal ? SNAP_HORIZONTAL : SNAP_VERTICAL;
    // The scan's winding is unknown: the side most nearby surfaces face is the plane's front.
    let front = 0;
    let back = 0;
    for (let v = 0; v < count; v++) {
      const o = v * 3;
      const dist = (rest[o] - m[12]) * m[4] + (rest[o + 1] - m[13]) * m[5] + (rest[o + 2] - m[14]) * m[6];
      if (Math.abs(dist) > tol) continue;
      const facing = normals[o] * m[4] + normals[o + 1] * m[5] + normals[o + 2] * m[6];
      if (facing >= SNAP_FACING) front++;
      else if (facing <= -SNAP_FACING) back++;
    }
    const side = front >= back ? 1 : -1;
    for (let v = 0; v < count; v++) {
      const o = v * 3;
      const rx = rest[o] - m[12];
      const ry = rest[o + 1] - m[13];
      const rz = rest[o + 2] - m[14];
      const dist = rx * m[4] + ry * m[5] + rz * m[6];
      if (Math.abs(dist) > tol) continue;
      const facing = side * (normals[o] * m[4] + normals[o + 1] * m[5] + normals[o + 2] * m[6]);
      if (facing < SNAP_FACING) continue;
      const depth = polygonDepth(plane.polygon, plane.points, rx * m[0] + ry * m[1] + rz * m[2], rx * m[8] + ry * m[9] + rz * m[10]);
      const w = Math.max(0, Math.min(1, (depth - SNAP_INSET) / SNAP_FADE)) * (1 - smoothstep(tol * 0.75, tol, Math.abs(dist)));
      if (w <= weight[v]) continue;
      weight[v] = w;
      shift[v] = dist;
      owner[v] = k;
    }
  }
  let moved = 0;
  const used = new Uint8Array(planes.length);
  for (let v = 0; v < count; v++) {
    const k = owner[v];
    if (k < 0) continue;
    const m = planes[k].matrix;
    const s = shift[v] * weight[v];
    const o = v * 3;
    out[o] -= m[4] * s;
    out[o + 1] -= m[5] * s;
    out[o + 2] -= m[6] * s;
    moved++;
    used[k] = 1;
  }
  let usedPlanes = 0;
  for (let k = 0; k < used.length; k++) usedPlanes += used[k];
  return { moved, planes: usedPlanes };
}
