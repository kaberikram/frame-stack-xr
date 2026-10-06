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
  private saved: Material | Material[] | null = null;
  private dense: Mesh | null = null;
  private video: HTMLVideoElement | null = null;
  private videoTex: VideoTexture | null = null;

  constructor(
    photo: PassthroughPhoto,
    private readonly parent: Object3D,
  ) {
    this.uniforms = createRubberUniforms(photo.texture);
    this.material = rubberMaterial(this.uniforms);
  }

  /** Show the dense copy of `source`, or the coarse mesh until the worker answers. */
  sync(source: Mesh | null): void {
    if (!source) {
      this.hide(false);
      return;
    }
    if (source !== this.source) this.adopt(source);
    else if (!this.ready && source.material !== this.material && !this.saved) {
      this.saved = source.material;
      source.material = this.material;
    }
    const position = source.geometry?.getAttribute('position');
    if (position && position !== this.sourceKey) this.submit(source, position);
    if (this.dense && this.ready) {
      source.updateWorldMatrix(true, false);
      this.dense.visible = true;
      this.dense.matrixAutoUpdate = false;
      this.dense.matrix.copy(source.matrixWorld);
      this.dense.updateMatrixWorld(true);
      source.visible = false;
      return;
    }
    source.frustumCulled = false;
    source.renderOrder = 2;
    source.visible = true;
  }

  setLive(video: HTMLVideoElement | null, hasLive: boolean, liveToClip: Matrix4): void {
    this.attachVideo(video);
    this.uniforms.uHasLive.value = hasLive && this.videoTex ? 1 : 0;
    (this.uniforms.uLiveToClip.value as Matrix4).copy(liveToClip);
    if (this.videoTex) this.uniforms.uLive.value = this.videoTex;
  }

  hide(restore: boolean): void {
    if (this.dense) this.dense.visible = false;
    if (this.source) this.source.visible = false;
    if (restore) this.restoreSource();
  }

  dispose(): void {
    this.hide(true);
    this.worker?.terminate();
    this.worker = null;
    this.videoTex?.dispose();
    this.dense?.geometry.dispose();
    this.material.dispose();
  }

  private adopt(source: Mesh): void {
    this.restoreSource();
    if (this.dense) this.dense.visible = false;
    this.source = source;
    this.sourceKey = null;
    this.ready = false;
    this.triangles = 0;
    this.saved = source.material;
    source.material = this.material;
    source.frustumCulled = false;
    source.renderOrder = 2;
    source.visible = true;
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
    this.restoreSource();
    this.source.visible = false;
    this.ready = true;
    this.triangles = reply.triangles;
    const edge = reply.edge >= 0.1 ? reply.edge.toFixed(2) : reply.edge.toFixed(3);
    console.info(`[jonze] dense room: ${reply.triangles} triangles, ${edge} m edges`);
  }

  private restoreSource(): void {
    if (!this.source || !this.saved) return;
    if (this.source.material === this.material) this.source.material = this.saved;
    this.saved = null;
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
