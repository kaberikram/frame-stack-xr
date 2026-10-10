import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  ShaderMaterial,
  Vector3,
  VideoTexture,
  type Material,
  type Object3D,
} from '@iwsdk/core';
import { CHUNK_STRIDE, MAX_TRIANGLES, TARGET_EDGE, type SnapPlane } from './mesh-subdivide.js';
import type { RoomPlanes } from './room-planes.js';
import { createRubberUniforms, rubberMaterial, type RubberUniformSet } from './stretch-material.js';

interface WorkerReply {
  kind: 'subdivide' | 'snap';
  id: number;
  positions: Float32Array;
  indices: Uint32Array | null;
  chunks: Float32Array | null;
  edge: number;
  triangles: number;
  moved: number;
  planes: number;
}

/**
 * Where one grab can move the room this frame, in world space: a slab around its plane cut by a
 * sphere at the grab (slide, burst, ripple), plus a sphere where the lift rises. Filled by the
 * stretch system from the same values it hands the shader, with a margin.
 */
export class StretchBound {
  on = false;
  readonly centre = new Vector3();
  readonly normal = new Vector3();
  slab = 0;
  radius = 0;
  readonly lift = new Vector3();
  /** Negative when the grab has no lift. */
  liftRadius = -1;
}

/** The dense room draws in at most this many runs once gaps are folded in; gaps this short always fold. */
const MAX_GROUPS = 8;
const SMALL_GAP = 6000;
/** Room chunks: the shader's widest band off the grabbed plane (burst and ripple), and the lift's. */
const BOUND_SLAB = 0.3;
const LIFT_SLAB = 0.75;
/** Chunk bounds grow by this share and this many metres past the shader's own reach. */
const BOUND_SHARE = 1.1;
const BOUND_MARGIN = 0.1;

/** One grab as the shader gets it (uG, uN, uD, uE, uB, uA, uRamp). */
export interface BoundPull {
  readonly worldG: Vector3;
  readonly normal: Vector3;
  readonly D: Vector3;
  readonly E: number;
  readonly B: number;
  readonly A: number;
  readonly ramp: number;
}

/** The look values the deformation reads: uReach, uCore, uRipple, uWobble. */
export interface BoundLook {
  reach: number;
  core: number;
  ripple: number;
  wobble: number;
}

/**
 * Where pinch() in stretch-material.ts can move a rest point, with a margin: the slide, burst and
 * ripple stay within BOUND_SLAB of the grabbed plane and within `radius` of the grab; the lift within
 * `liftRadius` of where the pinch slid to. `grow` widens both, for a chained grab.
 */
export function fillBound(bound: StretchBound, pull: BoundPull, look: BoundLook, grow: number): void {
  const len = pull.D.length();
  const e = Math.max(pull.E, 0);
  const squash = 0.15 + 2 * (len + e);
  const core = look.core + 0.35 * e;
  const edge = core + 0.1 + 0.2 * e;
  const taffy = Math.max(pull.ramp, pull.A + squash) + look.reach + 0.5 * len;
  const radius = Math.max(taffy, core + squash, look.reach) + BOUND_SLAB;
  bound.on = true;
  bound.centre.copy(pull.worldG);
  bound.normal.copy(pull.normal);
  bound.slab = (BOUND_SLAB + grow) * BOUND_SHARE + BOUND_MARGIN;
  bound.radius = (radius + grow) * BOUND_SHARE + BOUND_MARGIN;
  bound.lift.copy(pull.worldG).add(pull.D);
  // A point reaches the lift's zone after the slide has moved it by up to the whole pull.
  const lift = Math.abs(pull.B) > 1e-5 ? Math.hypot(edge + e, LIFT_SLAB) + moveReach(pull, look) : 0;
  bound.liftRadius = lift > 0 ? (lift + grow) * BOUND_SHARE + BOUND_MARGIN : -1;
}

/** The most a grab moves any point: slide, burst, lift, ripple and sway. */
export function moveReach(pull: BoundPull, look: BoundLook): number {
  return pull.D.length() + Math.max(pull.E, 0) + Math.abs(pull.B) + 2 * look.ripple + look.wobble;
}

interface Group {
  start: number;
  count: number;
  materialIndex: number;
}

/** Re-snapping the dense room to changed planes waits at least this long after the last one. */
const SNAP_GAP = 3;
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
  /** Desk stand-in program, with the webcam as the unmoved backdrop. */
  readonly previewMaterial: ShaderMaterial;
  triangles = 0;
  ready = false;
  /** Chunks in the dense room, and how many drew with the stretch program last frame. */
  chunkCount = 0;
  chunksDrawn = 0;
  /** Per grab, what it can reach; read when culling is on. */
  readonly bounds = [new StretchBound(), new StretchBound()];

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
  /** Draws chunks no pull can reach: depth only, so a nearer real surface still hides a stretch. */
  private readonly depthMaterial = new MeshBasicMaterial({ colorWrite: false, side: DoubleSide });
  private chunks: Float32Array | null = null;
  private readonly groupPool: Group[] = [];
  private readonly groups: Group[] = [];
  private cull = false;
  private pulling = false;
  /** A finished snap waiting for the room to be idle: uploading 2.6 MB mid-pull drops frames. */
  private heldSnap: WorkerReply | null = null;

  constructor(private readonly parent: Object3D, lensOverlay = false) {
    this.uniforms = createRubberUniforms();
    this.material = rubberMaterial(this.uniforms, false, lensOverlay);
    this.previewMaterial = rubberMaterial(this.uniforms, true);
  }

  /**
   * Draw the room this frame. Off at rest, so nothing renders or uploads. `pulling` is false when
   * only a debug view keeps it drawn: snaps then still land.
   */
  setActive(on: boolean, pulling = on): void {
    this.active = on;
    this.pulling = pulling;
  }

  /** Draw only the chunks a pull can reach with the stretch program; the rest depth only. */
  setCull(on: boolean): void {
    this.cull = on;
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

    if (this.heldSnap && !this.pulling) {
      const held = this.heldSnap;
      this.heldSnap = null;
      this.apply(held);
    }
    const showing = this.active || this.warm > 0;
    const warming = this.warm > 0;
    if (this.warm > 0) this.warm--;
    const denseOn = !!this.dense && this.ready;
    for (let i = 0; i < sources.length; i++) setShown(sources[i], showing && !denseOn);
    if (this.dense) setShown(this.dense, showing && denseOn);
    if (showing && denseOn) this.chooseChunks(warming);
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
    this.depthMaterial.dispose();
  }

  /**
   * Splits the dense room's draw into runs of chunks: the stretch program where a pull can reach,
   * depth only elsewhere. Neighbouring chunks of one kind merge, and short depth-only gaps between
   * stretch runs draw with the stretch program, so a frame has at most a few draws. Warming at rest
   * draws chunk 0 depth only and the rest stretched, so both programs compile before the first pinch.
   */
  private chooseChunks(warming: boolean): void {
    const chunks = this.chunks;
    if (!chunks) return;
    const count = chunks.length / CHUNK_STRIDE;
    const groups = this.groups;
    // Mid-pull a rebuilt room warms by drawing as culled: it is on screen.
    const warmOnly = warming && !this.active;
    let used = 0;
    let drawn = 0;
    for (let c = 0; c < count; c++) {
      const o = c * CHUNK_STRIDE;
      const stretch = warmOnly ? c > 0 || count === 1 : !this.cull || this.reaches(chunks, o);
      const kind = stretch ? 0 : 1;
      if (stretch) drawn++;
      const start = chunks[o];
      const length = chunks[o + 1];
      const last = used > 0 ? groups[used - 1] : null;
      if (last && last.materialIndex === kind && last.start + last.count === start) {
        last.count += length;
        continue;
      }
      const group = this.groupPool[used];
      group.start = start;
      group.count = length;
      group.materialIndex = kind;
      groups[used++] = group;
    }
    groups.length = this.mergeGaps(used);
    this.chunksDrawn = drawn;
  }

  /**
   * Morton order keeps cells local only in blocks, so a pull's reach leaves dozens of runs. Folds
   * the smallest depth-only run between two stretch runs into them, while more than MAX_GROUPS
   * remain or the gap is under SMALL_GAP indices: stretching a few unmoved chunks costs less than a
   * draw call each. Returns the new run count.
   */
  private mergeGaps(used: number): number {
    const g = this.groups;
    while (used > 2) {
      let best = -1;
      let smallest = Infinity;
      for (let i = 1; i < used - 1; i++) {
        if (g[i].materialIndex === 1 && g[i].count < smallest) {
          best = i;
          smallest = g[i].count;
        }
      }
      if (best < 0 || (used <= MAX_GROUPS && smallest > SMALL_GAP)) break;
      g[best - 1].count += g[best].count + g[best + 1].count;
      for (let i = best; i + 2 < used; i++) g[i] = g[i + 2];
      used -= 2;
    }
    return used;
  }

  private reaches(chunks: Float32Array, o: number): boolean {
    for (let k = 0; k < this.bounds.length; k++) {
      const b = this.bounds[k];
      if (!b.on) continue;
      // Raised points need nothing extra: they bend by their scanned position, which the box holds.
      if (b.liftRadius > 0 && boxSphere(chunks, o, b.lift, b.liftRadius)) return true;
      if (boxSphere(chunks, o, b.centre, b.radius) && boxSlab(chunks, o, b.centre, b.normal, b.slab)) return true;
    }
    return false;
  }

  private paint(mesh: Mesh): void {
    if (!this.painted.has(mesh)) this.painted.set(mesh, mesh.material);
    if (mesh.material !== this.material) mesh.material = this.material;
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
  }

  private release(mesh: Mesh): void {
    const saved = this.painted.get(mesh);
    if (saved && mesh.material === this.material) mesh.material = saved;
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
      if (this.pulling) {
        // Mid-pull: keep the newest snap and land it once the pull is over.
        this.heldSnap = reply;
        return;
      }
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
    // A held snap belongs to the mesh being replaced.
    this.heldSnap = null;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(reply.positions, 3));
    geometry.setIndex(new BufferAttribute(reply.indices, 1));
    geometry.computeBoundingSphere();
    const chunks = reply.chunks ?? new Float32Array([0, reply.indices.length, -1e9, -1e9, -1e9, 1e9, 1e9, 1e9]);
    this.chunks = chunks;
    this.chunkCount = chunks.length / CHUNK_STRIDE;
    while (this.groupPool.length < this.chunkCount) this.groupPool.push({ start: 0, count: 0, materialIndex: 0 });
    this.groups.length = 0;
    geometry.groups = this.groups;
    if (!this.dense) {
      // World space: the merged room carries every scan's pose in its vertices.
      this.dense = new Mesh(geometry, [this.material, this.depthMaterial]);
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

/** True when the chunk's box comes within `r` of `c`. */
function boxSphere(b: Float32Array, o: number, c: Vector3, r: number): boolean {
  const dx = Math.max(b[o + 2] - c.x, 0, c.x - b[o + 5]);
  const dy = Math.max(b[o + 3] - c.y, 0, c.y - b[o + 6]);
  const dz = Math.max(b[o + 4] - c.z, 0, c.z - b[o + 7]);
  return dx * dx + dy * dy + dz * dz <= r * r;
}

/** True when the chunk's box reaches within `half` of the plane through `c` with unit normal `n`. */
function boxSlab(b: Float32Array, o: number, c: Vector3, n: Vector3, half: number): boolean {
  const s = ((b[o + 2] + b[o + 5]) * 0.5 - c.x) * n.x + ((b[o + 3] + b[o + 6]) * 0.5 - c.y) * n.y + ((b[o + 4] + b[o + 7]) * 0.5 - c.z) * n.z;
  const reach = (b[o + 5] - b[o + 2]) * 0.5 * Math.abs(n.x) + (b[o + 6] - b[o + 3]) * 0.5 * Math.abs(n.y) + (b[o + 7] - b[o + 4]) * 0.5 * Math.abs(n.z);
  return Math.abs(s) <= half + reach;
}

