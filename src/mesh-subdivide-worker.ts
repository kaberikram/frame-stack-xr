import { subdivideMesh } from './mesh-subdivide.js';

interface SubdivideRequest {
  id: number;
  positions: Float32Array;
  indices: Uint32Array;
  edge: number;
  maxTriangles: number;
}

interface SubdivideReply {
  id: number;
  positions: Float32Array;
  indices: Uint32Array;
  edge: number;
  triangles: number;
}

interface WorkerScope {
  postMessage(message: SubdivideReply, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<SubdivideRequest>) => void) | null;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const { id, positions, indices, edge, maxTriangles } = event.data;
  const out = subdivideMesh(positions, indices, edge, maxTriangles);
  const reply: SubdivideReply = {
    id,
    positions: out.positions,
    indices: out.indices,
    edge: out.edge,
    triangles: out.indices.length / 3,
  };
  scope.postMessage(reply, [out.positions.buffer, out.indices.buffer]);
};
