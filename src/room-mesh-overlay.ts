import {
  BufferAttribute,
  BufferGeometry,
  LinearFilter,
  Matrix4,
  Mesh,
  ShaderMaterial,
  SRGBColorSpace,
  VideoTexture,
  type InterleavedBufferAttribute,
  type Material,
  type Object3D,
} from '@iwsdk/core';
import { MAX_TRIANGLES, TARGET_EDGE } from './mesh-subdivide.js';
import { PassthroughPhoto } from './passthrough-photo.js';
import { createRubberUniforms, rubberMaterial, type RubberUniformSet } from './stretch-material.js';

interface WorkerReply {
  id: number;
  positions: Float32Array;
  indices: Uint32Array;
  edge: number;
  triangles: number;
}

export interface RoomMeshStats {
  triangles: number;
  ready: boolean;
  hasPhoto: boolean;
}

/**
 * The room the rubber pull draws. Quest's global mesh is subdivided once in a worker
 * so a falloff can bend instead of crease, and that copy follows the scan's pose.
 * Bounded furniture boxes stay hidden. Depth testing is on.
 */
export class RoomMeshOverlay {
  readonly uniforms: RubberUniformSet;
  readonly material: ShaderMaterial;
  triangles = 0;
  ready = false;

  private worker: Worker | null = null;
  private requestId = 0;
  private source: Mesh | null = null;
  private sourceKey: object | null = null;
  private dense: Mesh | null = null;
  private readonly painted = new Map<Mesh, Material | Material[]>();
  private readonly keep = new Set<Mesh>();
  private readonly dropList: Mesh[] = [];
  private video: HTMLVideoElement | null = null;
  private videoTex: VideoTexture | null = null;

  constructor(
    photo: PassthroughPhoto,
    private readonly parent: Object3D,
  ) {
    this.uniforms = createRubberUniforms(photo.texture);
    this.material = rubberMaterial(this.uniforms);
  }

  /**
   * Draw every scanned mesh. The largest one is subdivided in the worker;
   * the others stay coarse so a room made of separate objects is still visible.
   */
  sync(sources: readonly Mesh[]): void {
    this.keep.clear();
    for (let i = 0; i < sources.length; i++) this.keep.add(sources[i]);
    const drop = this.dropList;
    drop.length = 0;
    for (const mesh of this.painted.keys()) {
      if (!this.keep.has(mesh)) drop.push(mesh);
    }
    for (let i = 0; i < drop.length; i++) this.release(drop[i]);

    let primary: Mesh | null = null;
    let primaryCount = -1;
    for (let i = 0; i < sources.length; i++) {
      const mesh = sources[i];
      this.paint(mesh);
      const count = mesh.geometry.getAttribute('position')?.count ?? 0;
      if (count > primaryCount) {
        primary = mesh;
        primaryCount = count;
      }
    }
    if (!primary) {
      if (this.dense) this.dense.visible = false;
      this.source = null;
      this.sourceKey = null;
      this.ready = false;
      this.triangles = 0;
      return;
    }
    if (primary !== this.source) {
      if (this.source) this.source.visible = true;
      this.source = primary;
      this.sourceKey = null;
      this.ready = false;
      this.triangles = 0;
      if (this.dense) this.dense.visible = false;
    }
    const position = primary.geometry.getAttribute('position');
    if (position && position !== this.sourceKey) this.submit(primary, position);
    if (this.dense && this.ready) {
      primary.updateWorldMatrix(true, false);
      this.dense.visible = true;
      this.dense.matrixAutoUpdate = false;
      this.dense.matrix.copy(primary.matrixWorld);
      this.dense.updateMatrixWorld(true);
      primary.visible = false;
    }
  }

  setLive(video: HTMLVideoElement | null, hasLive: boolean, liveToClip: Matrix4): void {
    this.attachVideo(video);
    this.uniforms.uHasLive.value = hasLive && this.videoTex ? 1 : 0;
    (this.uniforms.uLiveToClip.value as Matrix4).copy(liveToClip);
    if (this.videoTex) this.uniforms.uLive.value = this.videoTex;
  }

  hide(restore: boolean): void {
    if (this.dense) this.dense.visible = false;
    if (!restore) {
      for (const mesh of this.painted.keys()) mesh.visible = false;
      return;
    }
    const drop = this.dropList;
    drop.length = 0;
    for (const mesh of this.painted.keys()) drop.push(mesh);
    for (let i = 0; i < drop.length; i++) this.release(drop[i]);
    this.source = null;
    this.sourceKey = null;
    this.ready = false;
  }

  dispose(): void {
    this.hide(true);
    this.worker?.terminate();
    this.worker = null;
    this.videoTex?.dispose();
    this.dense?.geometry.dispose();
    this.material.dispose();
  }

  private paint(mesh: Mesh): void {
    if (!this.painted.has(mesh)) this.painted.set(mesh, mesh.material);
    if (mesh.material !== this.material) mesh.material = this.material;
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    if (mesh !== this.source || !this.ready) mesh.visible = true;
  }

  private release(mesh: Mesh): void {
    const saved = this.painted.get(mesh);
    if (saved && mesh.material === this.material) mesh.material = saved;
    this.painted.delete(mesh);
    mesh.visible = false;
    if (mesh === this.source) {
      this.source = null;
      this.sourceKey = null;
      this.ready = false;
      this.triangles = 0;
      if (this.dense) this.dense.visible = false;
    }
  }

  private submit(source: Mesh, position: BufferAttribute | InterleavedBufferAttribute): void {
    const geometry = source.geometry;
    const index = geometry.getIndex();
    if (!geometry) return;
    this.sourceKey = position;
    const positions = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      positions[i * 3] = position.getX(i);
      positions[i * 3 + 1] = position.getY(i);
      positions[i * 3 + 2] = position.getZ(i);
    }
    const count = index ? index.count : position.count;
    const indices = new Uint32Array(count);
    if (index) {
      for (let i = 0; i < count; i++) indices[i] = index.getX(i);
    } else {
      for (let i = 0; i < count; i++) indices[i] = i;
    }
    const id = ++this.requestId;
    this.thread().postMessage(
      { id, positions, indices, edge: TARGET_EDGE, maxTriangles: MAX_TRIANGLES },
      [positions.buffer, indices.buffer],
    );
  }

  private thread(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./mesh-subdivide-worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<WorkerReply>) => this.apply(event.data));
    this.worker = worker;
    return worker;
  }

  private apply(reply: WorkerReply): void {
    if (reply.id !== this.requestId || !this.source) return;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(reply.positions, 3));
    geometry.setIndex(new BufferAttribute(reply.indices, 1));
    geometry.computeBoundingSphere();
    if (!this.dense) {
      this.dense = new Mesh(geometry, this.material);
      this.dense.frustumCulled = false;
      this.dense.renderOrder = 2;
      this.dense.matrixAutoUpdate = false;
      this.parent.add(this.dense);
    } else {
      this.dense.geometry.dispose();
      this.dense.geometry = geometry;
    }
    this.source.updateWorldMatrix(true, false);
    this.dense.matrix.copy(this.source.matrixWorld);
    this.dense.updateMatrixWorld(true);
    this.dense.visible = true;
    this.source.visible = false;
    this.ready = true;
    this.triangles = reply.triangles;
    const edge = reply.edge >= 0.1 ? reply.edge.toFixed(2) : reply.edge.toFixed(3);
    console.info(`[jonze] dense room: ${reply.triangles} triangles, ${edge} m edges`);
  }

  private attachVideo(video: HTMLVideoElement | null): void {
    if (!video || video === this.video) return;
    this.videoTex?.dispose();
    const tex = new VideoTexture(video);
    tex.colorSpace = SRGBColorSpace;
    tex.minFilter = LinearFilter;
    tex.magFilter = LinearFilter;
    tex.generateMipmaps = false;
    this.video = video;
    this.videoTex = tex;
  }
}
