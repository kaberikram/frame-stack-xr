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

/**
 * Splits every edge longer than `edge` at its midpoint, and each triangle by how many of its
 * edges split (1 → 2, 2 → 3, 3 → 4). Deciding per edge rather than per triangle keeps
 * neighbours agreeing, so there are no T-junctions to crack open once the mesh bends.
 */
function splitPass(pos: Float32Array, idx: Uint32Array, edge: number, maxTriangles: number): Split {
  const triCount = Math.floor(idx.length / 3);
  const edge2 = edge * edge;
  const mids = new Map<number, number>();
  let outTris = 0;
  for (let tri = 0; tri < triCount; tri++) {
    const base = tri * 3;
    const i0 = idx[base];
    const i1 = idx[base + 1];
    const i2 = idx[base + 2];
    let long = 0;
    if (dist2(pos, i0, i1) > edge2) {
      long++;
      mids.set(edgeKey(i0, i1), -1);
    }
    if (dist2(pos, i1, i2) > edge2) {
      long++;
      mids.set(edgeKey(i1, i2), -1);
    }
    if (dist2(pos, i2, i0) > edge2) {
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
