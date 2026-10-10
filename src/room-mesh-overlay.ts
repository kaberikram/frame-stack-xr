import {
  BufferAttribute,
  BufferGeometry,
  LinearFilter,
  Matrix4,
  Mesh,
  ShaderMaterial,
  Vector3,
  VideoTexture,
  type Material,
  type Object3D,
} from '@iwsdk/core';
import { MAX_TRIANGLES, TARGET_EDGE, type SnapPlane } from './mesh-subdivide.js';
import type { RoomPlanes } from './room-planes.js';
import { createRubberUniforms, roomDepthMaterial, rubberMaterial, type RubberUniformSet } from './stretch-material.js';

interface WorkerReply {
  kind: 'subdivide' | 'snap';
  id: number;
  positions: Float32Array;
  indices: Uint32Array | null;
  edge: number;
  triangles: number;
  moved: number;
  planes: number;
}

/** Re-snapping the dense room to changed planes waits at least this long after the last one. */
const SNAP_GAP = 1;
/** A plane counts as moved past these: 5 mm, or its normal turned 0.5°. Tracking jitter stays under. */
const PLANE_MOVE = 0.005;
const PLANE_TURN = Math.cos((0.5 * Math.PI) / 180);
/** A scanned mesh that moves more than this rebuilds the merged room. */
const MESH_MOVE = 0.01;
/** The room is rebuilt around you once you are this far from where it was last built. */
const FOCUS_MOVE = 1.5;
/** A snap is logged again only when the vertices it moved change by more than this share. */
const SNAP_LOG_SHARE = 0.01;

/** Writes `visible` only when it changes. On scanned meshes each write is an ECS update. */
function setShown(object: Object3D, on: boolean): void {
  if (object.visible !== on) object.visible = on;
}

/** What the dense room was last built from, per scanned mesh. */
interface Built {
  mesh: Mesh;
  position: object | null;
  readonly world: Float32Array;
}

/**
 * The room the rubber pull draws. Every scanned mesh is merged into world space and subdivided in
 * a worker, finest near you, so a falloff bends instead of creasing on walls and furniture alike,
 * then snapped flat onto the detected planes. Nothing draws unless a pull is active: at rest the
 * headset shows plain passthrough. Until the dense room is ready, the scans draw coarse.
 */
export class RoomMeshOverlay {
  readonly uniforms: RubberUniformSet;
  /** Headset program. It samples video only for the `?lens=overlay` check. */
  readonly material: ShaderMaterial;
  /** Desk stand-in program, with the webcam as the unmoved backdrop. It always cuts a box's opening. */
  readonly previewMaterial: ShaderMaterial;
  /** The headset program that also cuts a pushed-in box's opening, only while there is one. */
  readonly holeMaterial: ShaderMaterial;
  /** Depth and the opening only, for a box with nothing else in the room moving. */
  readonly depthMaterial: ShaderMaterial;
  triangles = 0;
  ready = false;

  private worker: Worker | null = null;
  private requestId = 0;
  /** A subdivide request is in the worker. */
  private building = false;
  private readonly built: Built[] = [];
  private readonly focus = new Vector3();
  private dense: Mesh | null = null;
  private active = false;
  /** Frames left to draw a new dense mesh while invisible, so its compile and upload don't land on a pinch. */
  private warm = 0;
  private readonly painted = new Map<Mesh, Material | Material[]>();
  private readonly keep = new Set<Mesh>();
  private readonly dropList: Mesh[] = [];
  private video: HTMLVideoElement | null = null;
  private videoTex: VideoTexture | null = null;
  /** Detected planes in world space as last sent to the worker, and what they were built from. */
  private snapPlanes: SnapPlane[] = [];
  private readonly sentWorld: Float32Array[] = [];
  private readonly sentShape: number[] = [];
  private sentCount = -1;
  private planesDirty = false;
  private snapBusy = false;
  private snapAt = -Infinity;
  private loggedMoved = -1;
  private loggedPlanes = -1;
  private readonly tmp = new Vector3();
  private readonly pendingClip = new Matrix4();
  /** What the room draws with: the plain program, or one that cuts a box's opening. */
  private current: ShaderMaterial;
  /** One degenerate triangle per extra program, drawn from the start so neither compiles on a push. */
  private readonly warmers: Mesh[] = [];

  constructor(private readonly parent: Object3D, lensOverlay = false) {
    this.uniforms = createRubberUniforms();
    this.material = rubberMaterial(this.uniforms, false, lensOverlay);
    this.previewMaterial = rubberMaterial(this.uniforms, true, false, 'hole');
    this.holeMaterial = rubberMaterial(this.uniforms, false, lensOverlay, 'hole');
    this.depthMaterial = roomDepthMaterial(this.uniforms);
    this.current = this.material;
    const speck = new BufferGeometry();
    speck.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
    for (const material of [this.holeMaterial, this.depthMaterial]) {
      const warmer = new Mesh(speck, material);
      warmer.frustumCulled = false;
      warmer.renderOrder = 2;
      warmer.visible = false;
      this.warmers.push(warmer);
      parent.add(warmer);
    }
  }

  /**
   * `full` draws the room as always; `hole` also leaves a pushed-in box's opening undrawn; `depth`
   * only writes depth around the opening, for a box with nothing else moving.
   */
  setVariant(variant: 'full' | 'hole' | 'depth'): void {
    this.current = variant === 'hole' ? this.holeMaterial : variant === 'depth' ? this.depthMaterial : this.material;
  }

  /** Draw the room this frame. Off at rest, so nothing renders or uploads. */
  setActive(on: boolean): void {
    this.active = on;
  }

  /**
   * Draw every scanned mesh, from the merged dense room once it is ready. `eye` is where you are:
   * the room is finest around it and rebuilt when you have walked away from where it was built.
   */
  sync(sources: readonly Mesh[], eye: Vector3): void {
    this.keep.clear();
    for (let i = 0; i < sources.length; i++) this.keep.add(sources[i]);
    const drop = this.dropList;
    drop.length = 0;
    for (const mesh of this.painted.keys()) {
      if (!this.keep.has(mesh)) drop.push(mesh);
    }
    for (let i = 0; i < drop.length; i++) this.release(drop[i]);
    for (let i = 0; i < sources.length; i++) this.paint(sources[i]);

    if (sources.length === 0) {
      if (this.dense) setShown(this.dense, false);
      this.built.length = 0;
      this.ready = false;
      this.triangles = 0;
      return;
    }
    if (this.changed(sources)) {
      // The merged room carries the old poses in its vertices: draw the scans themselves until it's rebuilt.
      this.ready = false;
      this.submit(sources, eye);
    } else if (!this.building && this.ready && eye.distanceTo(this.focus) > FOCUS_MOVE) this.submit(sources, eye);

    const showing = this.active || this.warm > 0;
    if (this.warm > 0) this.warm--;
    for (let i = 0; i < this.warmers.length; i++) this.warmers[i].visible = true;
    if (this.dense && this.dense.material !== this.current) this.dense.material = this.current;
    const denseOn = !!this.dense && this.ready;
    for (let i = 0; i < sources.length; i++) setShown(sources[i], showing && !denseOn);
    if (this.dense) setShown(this.dense, showing && denseOn);
  }

  /**
   * Keeps the dense room snapped flat onto the detected planes. A plane that appears, goes, moves
   * 5 mm, turns 0.5° or changes its outline is sent to the worker, which re-snaps the unsnapped
   * room; at most once a second. Tracking jitter below that never re-snaps.
   */
  syncPlanes(planes: RoomPlanes): void {
    if (this.planesChanged(planes)) {
      const list: SnapPlane[] = [];
      for (let i = 0; i < planes.count; i++) {
        const plane = planes.planes[i];
        if (!this.sentWorld[i]) this.sentWorld[i] = new Float32Array(16);
        this.sentWorld[i].set(plane.world.elements);
        this.sentShape[i] = plane.shape;
        list.push({
          matrix: Float32Array.from(plane.world.elements),
          polygon: plane.polygon.slice(0, plane.points * 2),
          points: plane.points,
          horizontal: plane.horizontal,
        });
      }
      this.sentCount = planes.count;
      this.snapPlanes = list;
      this.planesDirty = true;
    }
    const now = performance.now() / 1000;
    if (!this.planesDirty || !this.ready || this.building || this.snapBusy || now - this.snapAt < SNAP_GAP) return;
    this.planesDirty = false;
    this.snapBusy = true;
    this.snapAt = now;
    this.thread().postMessage({ kind: 'snap', id: this.requestId, planes: this.snapPlanes });
  }

  /**
   * The live camera and its projection: the webcam behind the desk stand-in room, or the stripes of
   * the headset's `?lens=overlay` check.
   */
  setLive(video: HTMLVideoElement | null, hasLive: boolean, liveToClip: Matrix4): void {
    this.attachVideo(video);
    this.uniforms.uHasLive.value = hasLive && this.videoTex ? 1 : 0;
    // Committed when the frame actually uploads (deferred a frame under multiview), so the stripes
    // pair each picture with the pose it was taken from, the way a frozen photo is paired.
    this.pendingClip.copy(liveToClip);
    this.uniforms.uLive.value = this.videoTex;
  }

  hide(restore: boolean): void {
    if (this.dense) setShown(this.dense, false);
    for (let i = 0; i < this.warmers.length; i++) this.warmers[i].visible = false;
    if (!restore) {
      for (const mesh of this.painted.keys()) setShown(mesh, false);
      return;
    }
    const drop = this.dropList;
    drop.length = 0;
    for (const mesh of this.painted.keys()) drop.push(mesh);
    for (let i = 0; i < drop.length; i++) this.release(drop[i]);
    this.built.length = 0;
    this.ready = false;
  }

  dispose(): void {
    this.hide(true);
    this.worker?.terminate();
    this.worker = null;
    this.videoTex?.dispose();
    this.dense?.geometry.dispose();
    this.material.dispose();
    this.previewMaterial.dispose();
    this.holeMaterial.dispose();
    this.depthMaterial.dispose();
    for (let i = 0; i < this.warmers.length; i++) this.warmers[i].removeFromParent();
    this.warmers[0]?.geometry.dispose();
  }

  private paint(mesh: Mesh): void {
    if (!this.painted.has(mesh)) this.painted.set(mesh, mesh.material);
    if (mesh.material !== this.current) mesh.material = this.current;
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
  }

  private release(mesh: Mesh): void {
    const saved = this.painted.get(mesh);
    const ours = mesh.material === this.material || mesh.material === this.holeMaterial || mesh.material === this.depthMaterial;
    if (saved && ours) mesh.material = saved;
    this.painted.delete(mesh);
    setShown(mesh, false);
  }

  /** True when the set of scans, any scan's vertices, or any scan's pose changed since the last build. */
  private changed(sources: readonly Mesh[]): boolean {
    const built = this.built;
    if (built.length !== sources.length) return true;
    for (let i = 0; i < sources.length; i++) {
      const mesh = sources[i];
      const b = built[i];
      if (b.mesh !== mesh || b.position !== (mesh.geometry.getAttribute('position') ?? null)) return true;
      mesh.updateWorldMatrix(true, false);
      const e = mesh.matrixWorld.elements;
      const w = b.world;
      if (Math.hypot(e[12] - w[12], e[13] - w[13], e[14] - w[14]) > MESH_MOVE) return true;
      for (let k = 0; k < 11; k++) if (Math.abs(e[k] - w[k]) > MESH_MOVE) return true;
    }
    return false;
  }

  /** True when a plane appeared, went, moved past the tolerances, or changed its outline. */
  private planesChanged(planes: RoomPlanes): boolean {
    if (planes.count !== this.sentCount) return true;
    for (let i = 0; i < planes.count; i++) {
      const plane = planes.planes[i];
      const w = this.sentWorld[i];
      if (!w || this.sentShape[i] !== plane.shape) return true;
      const e = plane.world.elements;
      if (Math.hypot(e[12] - w[12], e[13] - w[13], e[14] - w[14]) > PLANE_MOVE) return true;
      const dot = (e[4] * w[4] + e[5] * w[5] + e[6] * w[6]) / Math.max(1e-9, Math.hypot(e[4], e[5], e[6]) * Math.hypot(w[4], w[5], w[6]));
      if (dot < PLANE_TURN) return true;
    }
    return false;
  }

  /** Merges every scan into world space and sends it to the worker to subdivide and snap. */
  private submit(sources: readonly Mesh[], eye: Vector3): void {
    let vertices = 0;
    let corners = 0;
    for (let i = 0; i < sources.length; i++) {
      const geometry = sources[i].geometry;
      const position = geometry.getAttribute('position');
      if (!position) continue;
      vertices += position.count;
      corners += geometry.getIndex()?.count ?? position.count;
    }
    const positions = new Float32Array(vertices * 3);
    const indices = new Uint32Array(corners);
    const built = this.built;
    built.length = 0;
    let vBase = 0;
    let iBase = 0;
    const v = this.tmp;
    for (let i = 0; i < sources.length; i++) {
      const mesh = sources[i];
      const geometry = mesh.geometry;
      const position = geometry.getAttribute('position');
      mesh.updateWorldMatrix(true, false);
      const record: Built = { mesh, position: position ?? null, world: Float32Array.from(mesh.matrixWorld.elements) };
      built.push(record);
      if (!position) continue;
      for (let k = 0; k < position.count; k++) {
        v.fromBufferAttribute(position, k).applyMatrix4(mesh.matrixWorld);
        positions[(vBase + k) * 3] = v.x;
        positions[(vBase + k) * 3 + 1] = v.y;
        positions[(vBase + k) * 3 + 2] = v.z;
      }
      const index = geometry.getIndex();
      const count = index ? index.count : position.count;
      for (let k = 0; k < count; k++) indices[iBase + k] = vBase + (index ? index.getX(k) : k);
      vBase += position.count;
      iBase += count;
    }
    this.focus.copy(eye);
    const id = ++this.requestId;
    this.building = true;
    this.planesDirty = false;
    this.snapBusy = false;
    this.thread().postMessage(
      {
        kind: 'subdivide', id, positions, indices, edge: TARGET_EDGE, maxTriangles: MAX_TRIANGLES,
        planes: this.snapPlanes, focus: [eye.x, eye.y, eye.z],
      },
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
    if (reply.kind === 'snap') this.snapBusy = false;
    if (reply.id !== this.requestId) return;
    const snapped = `snapped ${reply.moved} verts to ${reply.planes} planes`;
    if (reply.kind === 'snap' || !reply.indices) {
      const position = this.dense?.geometry.getAttribute('position');
      if (!position || position.array.length !== reply.positions.length) return;
      (position.array as Float32Array).set(reply.positions);
      position.needsUpdate = true;
      // Upload while drawing alpha 0 for a couple of frames, not on the next pinch.
      this.warm = 2;
      this.noteSnap(reply, snapped);
      return;
    }
    this.building = false;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(reply.positions, 3));
    geometry.setIndex(new BufferAttribute(reply.indices, 1));
    geometry.computeBoundingSphere();
    if (!this.dense) {
      // World space: the merged room carries every scan's pose in its vertices.
      this.dense = new Mesh(geometry, this.current);
      this.dense.frustumCulled = false;
      this.dense.renderOrder = 2;
      this.dense.matrixAutoUpdate = false;
      this.dense.matrix.identity();
      this.dense.visible = false;
      this.parent.add(this.dense);
      this.dense.updateMatrixWorld(true);
    } else {
      this.dense.geometry.dispose();
      this.dense.geometry = geometry;
    }
    this.ready = true;
    this.warm = 2;
    this.triangles = reply.triangles;
    const edge = reply.edge >= 0.1 ? reply.edge.toFixed(2) : reply.edge.toFixed(3);
    console.info(`[jonze] dense room: ${reply.triangles} triangles, ${edge} m near edges, ${this.built.length} scans`);
    this.noteSnap(reply, snapped);
  }

  /** Logs a snap only when its result changed: re-snaps that land the same push useful lines off the console. */
  private noteSnap(reply: WorkerReply, line: string): void {
    const same = reply.planes === this.loggedPlanes && Math.abs(reply.moved - this.loggedMoved) <= SNAP_LOG_SHARE * Math.max(1, this.loggedMoved);
    if (same) return;
    this.loggedMoved = reply.moved;
    this.loggedPlanes = reply.planes;
    console.info(`[jonze] dense room: ${line}`);
  }

  private attachVideo(video: HTMLVideoElement | null): void {
    if (!video || video === this.video) return;
    this.videoTex?.dispose();
    const tex = new VideoTexture(video);
    tex.minFilter = LinearFilter;
    tex.magFilter = LinearFilter;
    tex.generateMipmaps = false;
    tex.onUpdate = () => {
      this.uniforms.uLiveToClip.value.copy(this.pendingClip);
    };
    this.video = video;
    this.videoTex = tex;
  }
}
