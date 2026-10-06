/** Longest edge the dense room mesh aims for. Raised automatically when the cap would overflow. */
export const TARGET_EDGE = 0.05;
/** Hard stop so a large scan can't turn into a million triangles on the headset. */
export const MAX_TRIANGLES = 250_000;

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
): DenseMesh {
  let pos = positions instanceof Float32Array ? positions : Float32Array.from(positions);
  let idx = indices instanceof Uint32Array ? indices : Uint32Array.from(indices);
  let limit = Math.max(edge, 1e-3);
  for (let pass = 0; pass < 10; pass++) {
    if (idx.length / 3 >= maxTriangles) break;
    const next = splitPass(pos, idx, limit, maxTriangles);
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

function splitPass(pos: Float32Array, idx: Uint32Array, edge: number, maxTriangles: number): Split {
  const triCount = Math.floor(idx.length / 3);
  const edge2 = edge * edge;
  let splits = 0;
  for (let tri = 0; tri < triCount; tri++) {
    if (needsSplit(pos, idx, tri, edge2)) splits++;
  }
  if (splits === 0) return 'stop';
  const outTris = triCount + splits * 3;
  if (outTris > maxTriangles) return 'raise';

  const mids = new Map<number, number>();
  const outPos = new Float32Array(pos.length + splits * 9);
  outPos.set(pos);
  let verts = pos.length / 3;
  const outIdx = new Uint32Array(outTris * 3);
  let w = 0;
  const mid = (a: number, b: number): number => {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const key = lo * 1048573 + hi;
    const found = mids.get(key);
    if (found !== undefined) return found;
    const v = verts++;
    const ia = lo * 3;
    const ib = hi * 3;
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
    const i0 = idx[base];
    const i1 = idx[base + 1];
    const i2 = idx[base + 2];
    if (!needsSplit(pos, idx, tri, edge2)) {
      push(i0, i1, i2);
      continue;
    }
    const m01 = mid(i0, i1);
    const m12 = mid(i1, i2);
    const m20 = mid(i2, i0);
    push(i0, m01, m20);
    push(m01, i1, m12);
    push(m20, m12, i2);
    push(m01, m12, m20);
  }
  return { positions: outPos.slice(0, verts * 3), indices: outIdx, edge };
}

function needsSplit(pos: Float32Array, idx: Uint32Array, tri: number, edge2: number): boolean {
  const base = tri * 3;
  const i0 = idx[base];
  const i1 = idx[base + 1];
  const i2 = idx[base + 2];
  return dist2(pos, i0, i1) > edge2 || dist2(pos, i1, i2) > edge2 || dist2(pos, i2, i0) > edge2;
}

function dist2(pos: Float32Array, a: number, b: number): number {
  const ia = a * 3;
  const ib = b * 3;
  const dx = pos[ia] - pos[ib];
  const dy = pos[ia + 1] - pos[ib + 1];
  const dz = pos[ia + 2] - pos[ib + 2];
  return dx * dx + dy * dy + dz * dz;
}
