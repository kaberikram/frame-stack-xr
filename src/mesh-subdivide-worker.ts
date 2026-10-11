import {
  buildShards,
  clusterMesh,
  SHARD_EDGE,
  SHARD_MAX_TRIANGLES,
  snapToPlanes,
  subdivideMesh,
  type ShardReply,
  type SnapPlane,
} from './mesh-subdivide.js';

interface SubdivideRequest {
  kind: 'subdivide';
  id: number;
  positions: Float32Array;
  indices: Uint32Array;
  edge: number;
  maxTriangles: number;
  planes: SnapPlane[];
  /** Where you stood: edges are finest around it. */
  focus: number[] | null;
}

/** Re-snap the last dense mesh to a new set of planes. `id` is that mesh's subdivide id. */
interface SnapRequest {
  kind: 'snap';
  id: number;
  planes: SnapPlane[];
}

interface SubdivideReply {
  kind: 'subdivide' | 'snap';
  id: number;
  positions: Float32Array;
  /** Only on a subdivide reply; a snap keeps the mesh's triangles. */
  indices: Uint32Array | null;
  edge: number;
  triangles: number;
  moved: number;
  planes: number;
}

interface WorkerScope {
  postMessage(message: SubdivideReply | ShardReply, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<SubdivideRequest | SnapRequest>) => void) | null;
}

const scope = self as unknown as WorkerScope;

/** The last dense mesh before snapping, so new planes snap from the scan rather than from a snap. */
let rest: { id: number; positions: Float32Array; indices: Uint32Array; edge: number } | null = null;

scope.onmessage = (event) => {
  const request = event.data;
  if (request.kind === 'subdivide') {
    const out = subdivideMesh(request.positions, request.indices, request.edge, request.maxTriangles, request.focus);
    rest = { id: request.id, positions: out.positions, indices: out.indices, edge: out.edge };
  } else if (!rest || rest.id !== request.id) {
    return;
  }
  const positions = new Float32Array(rest.positions.length);
  const snap = snapToPlanes(rest.positions, rest.indices, request.planes, positions);
  const indices = request.kind === 'subdivide' ? rest.indices.slice() : null;
  const reply: SubdivideReply = {
    kind: request.kind,
    id: rest.id,
    positions,
    indices,
    edge: rest.edge,
    triangles: rest.indices.length / 3,
    moved: snap.moved,
    planes: snap.planes,
  };
  scope.postMessage(reply, indices ? [positions.buffer, indices.buffer] : [positions.buffer]);
  if (request.kind === 'subdivide') postShards(request);
};

/**
 * Builds the coarse mesh the fist tears into shards, from the same scan and planes, after the dense
 * room is posted so that never waits on it. The request's arrays are still whole here:
 * `subdivideMesh` only reads them, and the dense reply sends copies, never them.
 */
function postShards(request: SubdivideRequest): void {
  // A scan already denser than the cap is welded down first: subdividing never removes triangles.
  const base = clusterMesh(request.positions, request.indices, SHARD_EDGE / 2, SHARD_MAX_TRIANGLES);
  const coarse = subdivideMesh(base.positions, base.indices, SHARD_EDGE, SHARD_MAX_TRIANGLES, request.focus);
  const snapped = new Float32Array(coarse.positions.length);
  snapToPlanes(coarse.positions, coarse.indices, request.planes, snapped);
  const mesh = buildShards(snapped, coarse.indices);
  const reply: ShardReply = { kind: 'shards', id: request.id, ...mesh };
  scope.postMessage(reply, [mesh.position.buffer, mesh.shard.buffer, mesh.centres.buffer, mesh.bounds.buffer]);
}
