import { BufferAttribute, BufferGeometry, Mesh, Sphere, type Object3D, type ShaderMaterial } from '@iwsdk/core';
import type { ShardMesh } from './mesh-subdivide.js';
import { createVoidUniforms, voidMaterial, type RubberUniformSet, type VoidRole, type VoidUniformSet } from './stretch-material.js';

/** The draws that share the shard geometry, in the order they draw. The backstop has its own triangle. */
const SHARD_ROLES: readonly VoidRole[] = ['rest', 'torn', 'fly'];
const ROLES: readonly VoidRole[] = ['rest', 'torn', 'fly', 'backstop'];
/**
 * Hands (0) first, so nothing black covers them. Untouched shards write depth (2), then the black
 * where shards have left (2.1, depth test only, so it never clips a shard in flight), then the
 * shards in flight (3), then the black past the scan (3.5) wherever nothing nearer was drawn.
 */
const ORDER: Record<VoidRole, number> = { rest: 2, torn: 2.1, fly: 3, backstop: 3.5 };

/**
 * The fist's black hole: the room torn into shards that fly into your fist, black where they were.
 * One de-indexed copy of the room, cut into flat shards in the worker (mesh-subdivide.ts
 * buildShards), drawn three ways from the same buffers; every shard's state comes from its centre,
 * its seed and the tear front's uniforms, so the CPU never touches a vertex once it is uploaded.
 */
export class RoomVoid {
  readonly uniforms: VoidUniformSet;
  /** The shards being drawn: their centres feed the front and the photo choice. Null until the room is cut. */
  shards: ShardMesh | null = null;
  /** The dense room build these shards were cut from. */
  buildId = -1;

  private geometry: BufferGeometry | null = null;
  private pending: ShardMesh | null = null;
  private pendingId = -1;
  private readonly meshes: Mesh[] = [];
  private readonly backstop: Mesh;
  private readonly headset: ShaderMaterial[] = [];
  private readonly preview: ShaderMaterial[] = [];
  private readonly warmers: Mesh[] = [];
  private readonly speck: BufferGeometry;
  /** Frames left to draw a new set collapsed, so its upload doesn't land on the fist. */
  private warm = 0;
  private previewMode = false;

  constructor(private readonly parent: Object3D, room: RubberUniformSet) {
    this.uniforms = createVoidUniforms(room);
    for (const role of ROLES) {
      this.headset.push(voidMaterial(this.uniforms, false, role));
      this.preview.push(voidMaterial(this.uniforms, true, role));
    }
    // One degenerate triangle per program, drawn through all of stretch mode, so none compiles on a fist.
    this.speck = new BufferGeometry();
    this.speck.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
    this.speck.setAttribute('aShard', new BufferAttribute(new Float32Array(12), 4));
    for (let i = 0; i < ROLES.length; i++) {
      const warmer = this.place(new Mesh(this.speck, this.headset[i]), ORDER[ROLES[i]]);
      this.warmers.push(warmer);
    }
    // A triangle past the screen's corners, in clip space: the vertex shader puts it at the far plane.
    const cover = new BufferGeometry();
    cover.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.backstop = this.place(new Mesh(cover, this.headset[3]), ORDER.backstop);
  }

  /** A new cut of the room. Taken up the next time the void is off; until then the old one draws. */
  offer(set: ShardMesh, buildId: number): void {
    this.pending = set;
    this.pendingId = buildId;
  }

  /**
   * Every stretch-mode frame. `on` draws the void; otherwise only the warmers draw (and a new set,
   * collapsed, for two frames). `flying` off leaves the black alone, once every shard is gone.
   * A new set is taken up only while `idle`, so its upload never lands on a pinch or a push.
   * `preview` picks the desk programs.
   */
  sync(on: boolean, preview: boolean, flying = on, idle = true): void {
    if (!on && idle && this.pending) this.adopt();
    if (preview !== this.previewMode) {
      this.previewMode = preview;
      const list = preview ? this.preview : this.headset;
      for (let i = 0; i < this.meshes.length; i++) this.meshes[i].material = list[i];
      for (let i = 0; i < this.warmers.length; i++) this.warmers[i].material = list[i];
      this.backstop.material = list[3];
    }
    this.uniforms.uVoidOn.value = on ? 1 : 0;
    const ready = !!this.geometry;
    const warming = this.warm > 0;
    if (this.warm > 0) this.warm--;
    // Untouched and flying shards only while some are; the black stays drawn with the void, so each
    // surface keeps its own hand cut.
    for (let i = 0; i < this.meshes.length; i++) {
      const black = SHARD_ROLES[i] === 'torn';
      this.meshes[i].visible = ready && (warming || (on && (black || flying)));
    }
    this.backstop.visible = on;
    for (let i = 0; i < this.warmers.length; i++) this.warmers[i].visible = true;
  }

  hide(): void {
    this.uniforms.uVoidOn.value = 0;
    for (let i = 0; i < this.meshes.length; i++) this.meshes[i].visible = false;
    this.backstop.visible = false;
    for (let i = 0; i < this.warmers.length; i++) this.warmers[i].visible = false;
  }

  dispose(): void {
    this.hide();
    for (const mesh of [...this.meshes, ...this.warmers, this.backstop]) mesh.removeFromParent();
    this.geometry?.dispose();
    this.speck.dispose();
    this.backstop.geometry.dispose();
    for (const material of [...this.headset, ...this.preview]) material.dispose();
  }

  private adopt(): void {
    const set = this.pending!;
    this.pending = null;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(set.position, 3));
    geometry.setAttribute('aShard', new BufferAttribute(set.shard, 4));
    // From the worker's bounds: computing it here would walk every vertex on the main thread.
    const b = set.bounds;
    const sphere = new Sphere();
    sphere.center.set((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
    sphere.radius = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2;
    geometry.boundingSphere = sphere;
    if (this.meshes.length === 0) {
      const list = this.previewMode ? this.preview : this.headset;
      for (let i = 0; i < SHARD_ROLES.length; i++) this.meshes.push(this.place(new Mesh(geometry, list[i]), ORDER[SHARD_ROLES[i]]));
    } else {
      for (let i = 0; i < this.meshes.length; i++) this.meshes[i].geometry = geometry;
      this.geometry?.dispose();
    }
    this.geometry = geometry;
    this.shards = set;
    this.buildId = this.pendingId;
    this.warm = 2;
  }

  private place(mesh: Mesh, order: number): Mesh {
    // World space, like the dense room: the shards carry the room's pose in their vertices.
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    mesh.matrixAutoUpdate = false;
    mesh.matrix.identity();
    mesh.visible = false;
    this.parent.add(mesh);
    mesh.updateMatrixWorld(true);
    return mesh;
  }
}
