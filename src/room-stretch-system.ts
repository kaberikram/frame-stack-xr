import {
  BoxGeometry,
  CameraFacing,
  CameraSource,
  CameraState,
  CameraUtils,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  XRMesh,
  XRPlane,
  CanvasTexture,
  createSystem,
  type CameraDeviceInfo,
  type Entity,
  type Object3D,
} from '@iwsdk/core';
import { getMode } from './experience.js';
import { INK, drawHint, makeCanvas, type Canvas2D } from './labels.js';
import { cameraMount, PassthroughPhoto, type CameraMount } from './passthrough-photo.js';
import { RoomMeshOverlay, type RoomMeshStats } from './room-mesh-overlay.js';
import { StretchLook } from './stretch-component.js';
import { Spring, buildTriGrid, pickPull, pointAabbGap, rayBox, rayTriGrid, type TriGrid } from './stretch-math.js';
import { createStretchUniforms, shellMaterial, stretchMaterial, type StretchUniformSet } from './stretch-material.js';

type Side = 'left' | 'right';
const SIDES: readonly Side[] = ['left', 'right'];
/** Anything thinner than this can't be a stretch axis, so walls don't stretch through themselves. */
const MIN_AXIS = 0.15;
const MAX_STRETCH = 4;
/** Vertices of the room mesh this close to the pinch join the stretch, so a couch takes the wall behind it. */
const REGION_RADIUS = 1.7;
/** A scanned box this close to the hit is included whole. The chunk is clamped after that. */
const REGION_NEAR = 0.8;
/** A wall plane should not drag the rest of the apartment into the pull. */
const REGION_SPAN = 3.2;
const AXES = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];

interface Target {
  object: Object3D;
  /** Box centre and size in the object's own space. */
  center: Vector3;
  size: Vector3;
  label: string;
}

interface GlobalMesh {
  object: Object3D;
  positions: ArrayLike<number>;
  index: ArrayLike<number>;
  grid: TriGrid;
}

interface Grab {
  side: Side | 'demo';
  target: Target;
  axis: 0 | 1 | 2;
  /** Where the grab landed along the axis, 0..1. Becomes the seam once a direction is locked. */
  along: number;
  /** 0 until the first real pull says which way this is going. */
  dir: 0 | 1 | -1;
  start: Vector3;
}

interface Look {
  gain: number;
  band: number;
  wobble: number;
  waveLength: number;
  waveSpeed: number;
  ringSpacing: number;
  ringSpeed: number;
  glow: number;
  grain: number;
  stiffness: number;
  damping: number;
}
const LOOK_KEYS = [
  'gain', 'band', 'wobble', 'waveLength', 'waveSpeed',
  'ringSpacing', 'ringSpeed', 'glow', 'grain', 'stiffness', 'damping',
] as const;

const CARD = {
  point: { title: 'Point at the room', body: 'Pinch and pull. The mesh around your hand stretches, then springs back.' },
  scan: { title: 'No room mesh yet', body: 'Finish Space Setup, then enter again.' },
};

/**
 * Stretches a chunk of the scanned room. Planes and furniture boxes say what you
 * pointed at; the global mesh around that point is pulled in too, so a couch and
 * the wall behind it stretch as one volume. A passthrough snapshot covers the
 * chunk and widens into stripes along the pull. Outside XR it runs on two stand-in boxes.
 */
export class RoomStretchSystem extends createSystem({
  settings: { required: [StretchLook] },
  meshes: { required: [XRMesh] },
  planes: { required: [XRPlane] },
}) {
  private readonly targets: Target[] = [];
  private readonly standIns: Target[] = [];
  private readonly roomMeshes: GlobalMesh[] = [];
  private readonly region: Target = {
    object: new Group(),
    center: new Vector3(),
    size: new Vector3(1, 1, 1),
    label: 'room',
  };
  private readonly frozen: Target = {
    object: new Group(),
    center: new Vector3(),
    size: new Vector3(1, 1, 1),
    label: 'room',
  };
  private nextScan = 0;
  private hover: { side: Side; target: Target; local: Vector3 } | null = null;
  private grab: Grab | null = null;
  private active: Target | null = null;
  private readonly spring = new Spring();
  /** Kept after a release so the slab springs back along the same axis it was pulled. */
  private readonly last = { axis: 0 as 0 | 1 | 2, dir: 1 as 1 | -1 };
  private pull = 0;
  private reveal = 0;
  private demoT = 0;
  private sawTargets = false;
  private cardShown = CARD.point;
  private cardOpacity = 0;
  private cardSettled = false;
  private session: XRSession | null = null;
  private readonly look: Look = {
    gain: 3, band: 1, wobble: 0.05, waveLength: 0.45, waveSpeed: 7,
    ringSpacing: 0.22, ringSpeed: 0.5, glow: 0.8, grain: 16, stiffness: 90, damping: 9,
  };

  private readonly photo = new PassthroughPhoto();
  private readonly roomMesh = new RoomMeshOverlay(this.photo);
  private roomStats: RoomMeshStats = { meshes: 0, triangles: 0, hasPhoto: false };
  private cardKey = '';
  private cameraEntity: Entity | null = null;
  private mount: CameraMount = 'view';
  private arming: Promise<boolean> | null = null;

  private U!: StretchUniformSet;
  private rig!: Group;
  private slab!: Mesh;
  private shell!: Mesh;
  private outline!: LineSegments;
  private hud!: Group;
  private hudEntity!: Entity;
  private card!: Mesh;
  private cardMat!: MeshBasicMaterial;
  private cardPaint!: Canvas2D;
  private cardTex!: CanvasTexture;
  private tag!: Mesh;
  private tagPaint!: Canvas2D;
  private tagTex!: CanvasTexture;
  private tagKey = '';

  private readonly head = new Vector3();
  private readonly headQuat = new Quaternion();
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();
  private readonly tmpC = new Vector3();
  private readonly tmpQ = new Quaternion();
  private readonly axisWorld = new Vector3();
  private readonly aim = new Vector3();
  private readonly hoverPoint = new Vector3();
  private readonly grabStart = new Vector3();
  private readonly hitLocal = new Vector3();
  private readonly hitWorld = new Vector3();
  private readonly lastFit = new Vector3(Infinity, Infinity, Infinity);
  private lastFitAt = -1;
  private readonly inv = new Matrix4();
  private readonly aimed: { side: Side; target: Target; local: Vector3 } = {
    side: 'right',
    target: this.region,
    local: this.hoverPoint,
  };
  private wMinX = 0;
  private wMinY = 0;
  private wMinZ = 0;
  private wMaxX = 0;
  private wMaxY = 0;
  private wMaxZ = 0;

  init(): void {
    this.U = createStretchUniforms(this.photo.texture);
    this.rig = new Group();
    this.rig.visible = false;
    const box = new BoxGeometry(1, 1, 1, 40, 40, 40); // enough vertices for the wobble to read
    this.slab = new Mesh(box, stretchMaterial(this.U));
    this.shell = new Mesh(box, shellMaterial(this.U));
    this.slab.frustumCulled = false; // it grows well past its own bounds
    this.shell.frustumCulled = false;
    this.shell.renderOrder = 2;
    this.slab.renderOrder = 3;
    this.outline = new LineSegments(
      new EdgesGeometry(new BoxGeometry(1, 1, 1)),
      new LineBasicMaterial({ color: INK.red, transparent: true, opacity: 0.9 }),
    );
    this.outline.renderOrder = 4;
    this.outline.visible = false;
    this.rig.add(this.shell, this.slab, this.outline);

    this.hud = new Group();
    this.hud.visible = false;
    this.cardPaint = makeCanvas(1024, 256);
    this.cardTex = new CanvasTexture(this.cardPaint.canvas);
    this.cardTex.colorSpace = SRGBColorSpace;
    this.cardMat = new MeshBasicMaterial({ map: this.cardTex, transparent: true, depthWrite: false, depthTest: false, opacity: 0 });
    this.card = new Mesh(new PlaneGeometry(0.28, 0.07), this.cardMat);
    this.card.renderOrder = 10;
    this.card.visible = false;
    this.tagPaint = makeCanvas(640, 96);
    this.tagTex = new CanvasTexture(this.tagPaint.canvas);
    this.tagTex.colorSpace = SRGBColorSpace;
    this.tag = new Mesh(
      new PlaneGeometry(0.19, 0.0285),
      new MeshBasicMaterial({ map: this.tagTex, transparent: true, depthWrite: false }),
    );
    this.tag.renderOrder = 9;
    this.tag.visible = false;
    this.hud.add(this.card, this.tag, this.rig, this.region.object, this.frozen.object);
    this.hudEntity = this.world.createTransformEntity(this.hud);

    this.buildStandIns();
    this.cleanupFuncs.push(() => this.dispose());
    void document.fonts.ready.then(() => {
      this.tagKey = '';
      drawHint(this.cardPaint, this.cardShown.title, this.cardShown.body);
      this.cardTex.needsUpdate = true;
    });
    drawHint(this.cardPaint, CARD.point.title, CARD.point.body);
    this.cardTex.needsUpdate = true;
  }

  /**
   * Open the passthrough camera. Call from the mode or Enter click so the permission
   * prompt keeps the user gesture. Safe to call again.
   */
  armCamera(): Promise<boolean> {
    if (this.cameraEntity) return Promise.resolve(true);
    if (this.arming) return this.arming;
    this.arming = CameraUtils.getDevices()
      .then((devices) => {
        this.arming = null;
        return this.attachCamera(devices);
      })
      .catch(() => {
        this.arming = null;
        return false;
      });
    return this.arming;
  }

  update(delta: number, time: number): void {
    if (getMode() !== 'stretch') {
      this.hud.visible = false;
      this.roomMesh.hide();
      this.stopCamera();
      if (this.grab) this.release();
      this.active = null;
      this.rig.visible = false;
      return;
    }
    this.hud.visible = true;
    if (this.cameraEntity && this.cameraEntity.getValue(CameraSource, 'state') === CameraState.Error) this.stopCamera();

    const dt = Math.min(0.1, delta);
    this.readLook();
    this.syncSession();
    const presenting = this.renderer.xr.isPresenting;
    if (presenting) {
      this.player.head.getWorldPosition(this.head);
      this.player.head.getWorldQuaternion(this.headQuat);
      const video = this.cameraVideo();
      this.roomStats = this.roomMesh.show(this.queries.meshes.entities, {
        renderer: this.renderer,
        presenting: true,
        frame: this.world.xrFrame,
        refSpace: this.world.xrReferenceSpace,
        video,
        track: this.cameraTrack(video),
        mount: this.mount,
        viewCamera: this.camera,
      });
    } else {
      this.roomMesh.hide();
    }
    if (time > this.nextScan) {
      this.collectTargets(presenting);
      this.nextScan = time + 0.5; // the scan keeps refining; re-read it now and then
    }
    if (presenting) this.updateAim(time);
    else this.updateDemo(dt);
    this.updateStretch(dt, time);
    this.updateHud(dt, presenting);
  }

  // ---------------------------------------------------------------- targets

  private collectTargets(presenting: boolean): void {
    this.targets.length = 0;
    this.roomMeshes.length = 0;
    if (!presenting) {
      for (const t of this.standIns) this.targets.push(t);
      return;
    }
    for (const entity of this.queries.meshes.entities) {
      const object = entity.object3D;
      if (!object) continue;
      if (!entity.getValue(XRMesh, 'isBounded3D')) {
        const global = this.readGlobal(object);
        if (global) this.roomMeshes.push(global);
        continue;
      }
      const min = entity.getVectorView(XRMesh, 'min');
      const max = entity.getVectorView(XRMesh, 'max');
      const size = new Vector3(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
      if (Math.max(size.x, size.y, size.z) < 0.25) continue; // ignore scraps
      this.targets.push({
        object,
        center: new Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2),
        size,
        label: String(entity.getValue(XRMesh, 'semanticLabel') ?? 'object'),
      });
    }
    for (const entity of this.queries.planes.entities) {
      const object = entity.object3D as Mesh | undefined;
      if (!object?.geometry) continue;
      if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
      const bounds = object.geometry.boundingBox;
      if (!bounds) continue;
      const size = new Vector3().subVectors(bounds.max, bounds.min);
      if (Math.max(size.x, size.y, size.z) < 0.4) continue;
      size.set(Math.max(size.x, 0.03), Math.max(size.y, 0.03), Math.max(size.z, 0.03)); // give flat planes a skin
      const plane = entity.getValue(XRPlane, '_plane') as { semanticLabel?: string } | undefined;
      this.targets.push({
        object,
        center: new Vector3().addVectors(bounds.min, bounds.max).multiplyScalar(0.5),
        size,
        label: plane?.semanticLabel ?? 'surface',
      });
    }
    if (this.targets.length || this.roomMeshes.length) this.sawTargets = true;
  }

  private readGlobal(object: Object3D): GlobalMesh | null {
    const geometry = (object as Mesh).geometry;
    const position = geometry?.getAttribute?.('position');
    const index = geometry?.getIndex?.();
    if (!position || !index || !('array' in position) || !('array' in index)) return null;
    const positions = position.array;
    const indices = index.array;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i];
      const y = positions[i + 1];
      const z = positions[i + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    if (!Number.isFinite(minX) || indices.length < 3) return null;
    return { object, positions, index: indices, grid: buildTriGrid(positions, indices, minX, minY, minZ, maxX, maxY, maxZ) };
  }

  private buildStandIns(): void {
    const make = (label: string, size: Vector3, x: number, z: number, yaw: number) => {
      const object = new Group();
      object.position.set(x, size.y / 2, z);
      object.rotation.y = yaw;
      this.hud.add(object);
      const wire = new LineSegments(
        new EdgesGeometry(new BoxGeometry(size.x, size.y, size.z)),
        new LineBasicMaterial({ color: INK.line, transparent: true, opacity: 0.8 }),
      );
      object.add(wire);
      this.standIns.push({ object, center: new Vector3(), size, label });
    };
    // Stand-ins for the desktop preview, roughly wardrobe and table sized.
    make('wardrobe', new Vector3(0.95, 2, 0.6), -0.75, -1.9, 0.12);
    make('table', new Vector3(1.2, 0.74, 0.7), 0.8, -1.5, -0.2);
  }

  // ---------------------------------------------------------------- pointing and pinching

  private syncSession(): void {
    const session = this.xrManager.getSession() ?? null;
    if (session === this.session) return;
    this.session?.removeEventListener('selectstart', this.onSelectStart);
    this.session?.removeEventListener('selectend', this.onSelectEnd);
    session?.addEventListener('selectstart', this.onSelectStart);
    session?.addEventListener('selectend', this.onSelectEnd);
    this.session = session;
  }

  private readonly onSelectStart = (event: Event): void => {
    if (getMode() !== 'stretch') return;
    const side = (event as XRInputSourceEvent).inputSource?.handedness;
    if (side !== 'left' && side !== 'right') return;
    if (this.grab || !this.hover || this.hover.side !== side) return;
    this.adoptFrozen();
    const target = this.frozen;
    const { local } = this.hover;
    this.tmpA.copy(local).sub(target.center);
    const pull = pickPull(this.tmpA.x, this.tmpA.y, this.tmpA.z, target.size.x, target.size.y, target.size.z, MIN_AXIS);
    this.player.raySpaces[side].getWorldPosition(this.grabStart);
    this.photo.invalidate();
    this.grab = {
      side,
      target,
      axis: pull.axis,
      along: pull.along,
      dir: 0,
      start: this.grabStart,
    };
    this.last.axis = pull.axis;
    this.active = target;
    this.spring.reset(this.spring.value);
    this.capturePhoto(target);
  };

  private readonly onSelectEnd = (event: Event): void => {
    const side = (event as XRInputSourceEvent).inputSource?.handedness;
    if (this.grab && this.grab.side === side) this.release();
  };

  private release(): void {
    this.grab = null;
    this.pull = 0; // springs back, wobbling on the way
  }

  private updateAim(time: number): void {
    if (this.grab) return;
    let bestSide: Side | null = null;
    let bestTarget: Target | null = null;
    let bestT = Infinity;
    for (let i = 0; i < SIDES.length; i++) {
      const side = SIDES[i];
      const ray = this.player.raySpaces[side];
      ray.getWorldPosition(this.tmpA);
      this.tmpB.set(0, 0, -1).applyQuaternion(ray.getWorldQuaternion(this.tmpQ));
      for (let j = 0; j < this.targets.length; j++) {
        const target = this.targets[j];
        target.object.updateWorldMatrix(true, false);
        this.tmpC.copy(this.tmpA);
        target.object.worldToLocal(this.tmpC); // ray origin in the object's own space
        this.aim.copy(this.tmpA).add(this.tmpB);
        target.object.worldToLocal(this.aim).sub(this.tmpC).normalize();
        const t = rayBox(
          this.tmpC.x, this.tmpC.y, this.tmpC.z,
          this.aim.x, this.aim.y, this.aim.z,
          target.center.x, target.center.y, target.center.z,
          target.size.x / 2, target.size.y / 2, target.size.z / 2,
        );
        if (t < 0 || t >= bestT) continue;
        bestT = t;
        this.hitLocal.copy(this.tmpC).addScaledVector(this.aim, t);
        target.object.localToWorld(this.hitLocal);
        this.hitWorld.copy(this.hitLocal);
        bestSide = side;
        bestTarget = target;
      }
      const meshT = this.closestGlobal(this.tmpA.x, this.tmpA.y, this.tmpA.z, this.tmpB.x, this.tmpB.y, this.tmpB.z, bestT);
      if (meshT >= 0) {
        bestT = meshT;
        bestSide = side;
        bestTarget = null;
        this.hitWorld.copy(this.tmpA).addScaledVector(this.tmpB, meshT);
      }
    }
    if (!bestSide) {
      this.hover = null;
      return;
    }
    // Walking every vertex of the room mesh is the expensive part, so hold the chunk until the hand moves.
    const moved = this.hitWorld.distanceToSquared(this.lastFit) > 0.02;
    if (moved || time - this.lastFitAt > 0.45) {
      this.fitRegion(this.hitWorld.x, this.hitWorld.y, this.hitWorld.z, bestTarget);
      this.lastFit.copy(this.hitWorld);
      this.lastFitAt = time;
    }
    this.hoverPoint.copy(this.hitWorld).sub(this.region.object.position);
    this.aimed.side = bestSide;
    this.aimed.target = this.region;
    this.hover = this.aimed;
  }

  private closestGlobal(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, limit: number): number {
    let best = limit;
    for (let i = 0; i < this.roomMeshes.length; i++) {
      const t = this.rayGlobal(this.roomMeshes[i], ox, oy, oz, dx, dy, dz);
      if (t >= 0 && t < best) best = t;
    }
    return best < limit ? best : -1;
  }

  /** World-space distance to a global room mesh. Scale on these meshes stays 1, so local distance matches. */
  private rayGlobal(mesh: GlobalMesh, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
    mesh.object.updateWorldMatrix(true, false);
    this.inv.copy(mesh.object.matrixWorld).invert();
    const e = this.inv.elements;
    const lx = e[0] * ox + e[4] * oy + e[8] * oz + e[12];
    const ly = e[1] * ox + e[5] * oy + e[9] * oz + e[13];
    const lz = e[2] * ox + e[6] * oy + e[10] * oz + e[14];
    const ldx = e[0] * dx + e[4] * dy + e[8] * dz;
    const ldy = e[1] * dx + e[5] * dy + e[9] * dz;
    const ldz = e[2] * dx + e[6] * dy + e[10] * dz;
    const len = Math.hypot(ldx, ldy, ldz);
    if (len < 1e-8) return -1;
    const t = rayTriGrid(mesh.positions, mesh.index, mesh.grid, lx, ly, lz, ldx / len, ldy / len, ldz / len);
    return t < 0 ? -1 : t / len;
  }

  private worldAabb(target: Target): void {
    target.object.updateWorldMatrix(true, false);
    const e = target.object.matrixWorld.elements;
    const hx = target.size.x / 2;
    const hy = target.size.y / 2;
    const hz = target.size.z / 2;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < 8; i++) {
      const x = target.center.x + (i & 1 ? hx : -hx);
      const y = target.center.y + (i & 2 ? hy : -hy);
      const z = target.center.z + (i & 4 ? hz : -hz);
      const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
      const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
      const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
      if (wx < minX) minX = wx;
      if (wy < minY) minY = wy;
      if (wz < minZ) minZ = wz;
      if (wx > maxX) maxX = wx;
      if (wy > maxY) maxY = wy;
      if (wz > maxZ) maxZ = wz;
    }
    this.wMinX = minX;
    this.wMinY = minY;
    this.wMinZ = minZ;
    this.wMaxX = maxX;
    this.wMaxY = maxY;
    this.wMaxZ = maxZ;
  }

  /** Fit one world-aligned chunk around the hit: the object you pointed at, its neighbours, and the room mesh. */
  private fitRegion(hx: number, hy: number, hz: number, primary: Target | null): void {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < this.targets.length; i++) {
      const target = this.targets[i];
      this.worldAabb(target);
      const gap = pointAabbGap(hx, hy, hz, this.wMinX, this.wMinY, this.wMinZ, this.wMaxX, this.wMaxY, this.wMaxZ);
      if (target !== primary && gap > REGION_NEAR) continue;
      if (this.wMinX < minX) minX = this.wMinX;
      if (this.wMinY < minY) minY = this.wMinY;
      if (this.wMinZ < minZ) minZ = this.wMinZ;
      if (this.wMaxX > maxX) maxX = this.wMaxX;
      if (this.wMaxY > maxY) maxY = this.wMaxY;
      if (this.wMaxZ > maxZ) maxZ = this.wMaxZ;
    }
    const r2 = REGION_RADIUS * REGION_RADIUS;
    for (let g = 0; g < this.roomMeshes.length; g++) {
      const mesh = this.roomMeshes[g];
      mesh.object.updateWorldMatrix(true, false);
      const e = mesh.object.matrixWorld.elements;
      const p = mesh.positions;
      for (let i = 0; i < p.length; i += 3) {
        const wx = e[0] * p[i] + e[4] * p[i + 1] + e[8] * p[i + 2] + e[12];
        const wy = e[1] * p[i] + e[5] * p[i + 1] + e[9] * p[i + 2] + e[13];
        const wz = e[2] * p[i] + e[6] * p[i + 1] + e[10] * p[i + 2] + e[14];
        const dx = wx - hx;
        const dy = wy - hy;
        const dz = wz - hz;
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        if (wx < minX) minX = wx;
        if (wy < minY) minY = wy;
        if (wz < minZ) minZ = wz;
        if (wx > maxX) maxX = wx;
        if (wy > maxY) maxY = wy;
        if (wz > maxZ) maxZ = wz;
      }
    }
    if (!Number.isFinite(minX)) {
      minX = hx - 0.7;
      maxX = hx + 0.7;
      minY = hy - 0.5;
      maxY = hy + 0.5;
      minZ = hz - 0.7;
      maxZ = hz + 0.7;
    }
    this.clampSpan(minX, maxX, hx);
    minX = this.spanMin;
    maxX = this.spanMax;
    this.clampSpan(minY, maxY, hy);
    minY = this.spanMin;
    maxY = this.spanMax;
    this.clampSpan(minZ, maxZ, hz);
    minZ = this.spanMin;
    maxZ = this.spanMax;
    if (maxX - minX < 0.08) { const mid = (minX + maxX) / 2; minX = mid - 0.04; maxX = mid + 0.04; }
    if (maxY - minY < 0.08) { const mid = (minY + maxY) / 2; minY = mid - 0.04; maxY = mid + 0.04; }
    if (maxZ - minZ < 0.08) { const mid = (minZ + maxZ) / 2; minZ = mid - 0.04; maxZ = mid + 0.04; }
    this.region.object.position.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    this.region.object.quaternion.identity();
    this.region.object.scale.set(1, 1, 1);
    this.region.object.updateWorldMatrix(true, false);
    this.region.size.set(maxX - minX, maxY - minY, maxZ - minZ);
    this.region.label = 'room';
  }

  private spanMin = 0;
  private spanMax = 0;

  private clampSpan(min: number, max: number, hit: number): void {
    if (max - min <= REGION_SPAN) {
      this.spanMin = min;
      this.spanMax = max;
      return;
    }
    let a = hit - REGION_SPAN / 2;
    let b = a + REGION_SPAN;
    if (a < min) { b += min - a; a = min; }
    if (b > max) { a -= b - max; b = max; }
    this.spanMin = Math.max(min, a);
    this.spanMax = Math.min(max, b);
  }

  private adoptFrozen(): void {
    const src = this.region.object;
    const dst = this.frozen.object;
    dst.position.copy(src.position);
    dst.quaternion.identity();
    dst.scale.set(1, 1, 1);
    dst.updateWorldMatrix(true, false);
    this.frozen.size.copy(this.region.size);
    this.frozen.label = this.region.label;
  }

  private updateDemo(dt: number): void {
    const target = this.standIns[0];
    if (!target) return;
    this.demoT = (this.demoT + dt) % 8;
    const t = this.demoT;
    if (t < 0.8) {
      if (this.grab) this.release();
      return;
    }
    if (!this.grab) {
      this.grabStart.set(0, 0, 0);
      this.photo.invalidate();
      this.grab = { side: 'demo', target, axis: 0, along: 0.82, dir: 1, start: this.grabStart };
      this.last.axis = 0;
      this.last.dir = 1;
      this.active = target;
    }
    // ease out, hold, then let go at t = 5.2
    const ramp = Math.min(1, (t - 0.8) / 1.6);
    this.pull = t < 5.2 ? 1.1 * (1 - (1 - ramp) ** 3) : 0;
    if (t >= 5.2 && this.grab) this.release();
  }

  // ---------------------------------------------------------------- the stretch itself

  private updateStretch(dt: number, time: number): void {
    const U = this.U;
    const grab = this.grab;
    if (grab && !this.photo.ready) this.capturePhoto(grab.target);
    if (grab && grab.side !== 'demo') {
      const hand = this.player.raySpaces[grab.side];
      hand.getWorldPosition(this.tmpA).sub(grab.start);
      grab.target.object.getWorldQuaternion(this.tmpQ);
      this.axisWorld.copy(AXES[grab.axis]).applyQuaternion(this.tmpQ);
      const signed = this.tmpA.dot(this.axisWorld) * this.look.gain;
      if (grab.dir === 0) {
        // Whichever way you pull first becomes the direction, so grabbing the middle still works.
        if (Math.abs(signed) > 0.06) {
          grab.dir = signed > 0 ? 1 : -1;
          this.last.dir = grab.dir;
        }
        this.pull = 0;
      } else {
        this.pull = Math.max(0, signed * grab.dir);
      }
    }
    const target = Math.min(MAX_STRETCH, this.pull);
    const stretch = this.spring.step(target, dt, this.look.stiffness, this.look.damping);
    const active = this.active;
    if (!active) {
      this.rig.visible = false;
      return;
    }
    // Stay visible through the whole spring-back, so the last wobble is seen, then fade.
    const settled = !grab && this.spring.atRest(0);
    if (settled && this.reveal < 0.02) {
      this.active = null;
      this.rig.visible = false;
      this.reveal = 0;
      return;
    }

    // ride the real object's pose, so a wardrobe that the scan nudges stays covered
    active.object.updateWorldMatrix(true, false);
    active.object.matrixWorld.decompose(this.tmpA, this.tmpQ, this.tmpB);
    this.rig.position.copy(this.tmpA);
    this.rig.quaternion.copy(this.tmpQ);
    this.rig.scale.copy(this.tmpB);
    this.rig.visible = true;
    this.slab.position.copy(active.center);
    this.shell.position.copy(active.center);
    this.outline.position.copy(active.center);
    this.outline.scale.copy(active.size);
    this.outline.visible = false;

    (U.uSize.value as Vector3).copy(active.size);
    (U.uAxis.value as Vector3).copy(AXES[this.last.axis]);
    U.uDir.value = this.last.dir;
    U.uBand.value = this.look.band;
    U.uStretch.value = Math.max(stretch, 0);
    U.uWaveK.value = 1 / Math.max(this.look.waveLength, 0.05);
    U.uWaveSpeed.value = this.look.waveSpeed;
    U.uTime.value = time;
    U.uRingSpacing.value = this.look.ringSpacing;
    U.uRingSpeed.value = this.look.ringSpeed;
    U.uGlow.value = this.look.glow;
    U.uGrain.value = this.look.grain;
    // wobble follows how hard the slab is moving, so a yank whips and a slow pull doesn't
    U.uWobble.value = this.look.wobble * Math.min(1, Math.abs(this.spring.velocity) / 2.5);
    U.uRings.value = Math.min(1, stretch / 0.25);
    const revealTarget = grab || !settled ? 1 : 0;
    this.reveal += (revealTarget - this.reveal) * (1 - Math.exp(-dt * 10));
    U.uReveal.value = this.reveal;
    U.uHasPhoto.value = this.photo.ready ? 1 : 0;
    U.uPhoto.value = this.photo.texture;
    (U.uMeshToClip.value as Matrix4).copy(this.photo.meshToClip);
    (U.uCamMesh.value as Vector3).copy(this.photo.camMesh);
  }

  private capturePhoto(target: Target): void {
    target.object.updateWorldMatrix(true, false);
    const video = this.cameraVideo();
    this.photo.capture({
      renderer: this.renderer,
      presenting: this.renderer.xr.isPresenting,
      frame: this.world.xrFrame,
      refSpace: this.world.xrReferenceSpace,
      objectWorld: target.object.matrixWorld,
      center: target.center,
      video,
      track: this.cameraTrack(video),
      mount: this.mount,
      viewCamera: this.camera,
    });
  }

  // ---------------------------------------------------------------- hint card and label

  private updateHud(dt: number, presenting: boolean): void {
    // The box outline was the unmapped square. The scan's own triangles are the thing to look at.
    this.tag.visible = false;
    this.outline.visible = false;
    if (!this.active) this.rig.visible = false;
    this.slab.visible = true;
    this.shell.visible = true;

    const wantCard = presenting && !this.active && this.cardOpacity < 1.01;
    const copy = this.meshCopy(presenting);
    const key = `${copy.title}|${copy.body}`;
    if (key !== this.cardKey) {
      this.cardKey = key;
      this.cardShown = copy;
      drawHint(this.cardPaint, copy.title, copy.body);
      this.cardTex.needsUpdate = true;
    }
    this.cardOpacity += ((wantCard ? 1 : 0) - this.cardOpacity) * (1 - Math.exp(-dt * 6));
    this.card.visible = this.cardOpacity > 0.01;
    this.cardMat.opacity = this.cardOpacity;
    if (!this.card.visible) {
      this.cardSettled = false;
      return;
    }
    this.tmpA.set(0, 0, -1).applyQuaternion(this.headQuat);
    this.tmpA.y = 0;
    if (this.tmpA.lengthSq() < 1e-6) this.tmpA.set(0, 0, -1);
    this.tmpA.normalize().multiplyScalar(0.6).add(this.head);
    this.tmpA.y -= 0.18;
    if (!this.cardSettled) {
      this.card.position.copy(this.tmpA);
      this.cardSettled = true;
    } else {
      this.card.position.lerp(this.tmpA, 1 - Math.exp(-dt * 3));
    }
    this.card.lookAt(this.head);
  }

  private meshCopy(presenting: boolean): { title: string; body: string } {
    if (!presenting || this.roomStats.meshes === 0) return presenting ? CARD.scan : CARD.point;
    const triangles = this.roomStats.triangles;
    const count = triangles > 1000 ? `${Math.round(triangles / 1000)}k` : String(triangles);
    const tint = this.roomStats.hasPhoto ? 'cooler than the camera' : 'blue until the camera starts';
    return {
      title: 'Room mesh',
      body: `${count} triangles, ${tint}.`,
    };
  }

  private readLook(): void {
    for (const entity of this.queries.settings.entities) {
      for (let i = 0; i < LOOK_KEYS.length; i++) {
        const key = LOOK_KEYS[i];
        const value = entity.getValue(StretchLook, key);
        if (typeof value === 'number') this.look[key] = value;
      }
      return;
    }
  }

  private attachCamera(devices: CameraDeviceInfo[]): boolean {
    if (getMode() !== 'stretch' || this.cameraEntity) return !!this.cameraEntity;
    const back = CameraUtils.findByFacing(devices, CameraFacing.Back);
    const chosen = back ?? devices[0];
    if (!chosen) return false;
    this.mount = cameraMount(chosen.label, back ? 'back' : 'unknown');
    const anchor = new Group();
    anchor.name = 'passthrough-camera';
    anchor.visible = false;
    const entity = this.world.createTransformEntity(anchor);
    entity.addComponent(CameraSource);
    entity.setValue(CameraSource, 'deviceId', chosen.deviceId);
    entity.setValue(CameraSource, 'facing', back ? CameraFacing.Back : CameraFacing.Unknown);
    entity.setValue(CameraSource, 'width', 1280);
    entity.setValue(CameraSource, 'height', 720);
    entity.setValue(CameraSource, 'frameRate', 30);
    this.cameraEntity = entity;
    return true;
  }

  private cameraVideo(): HTMLVideoElement | null {
    const entity = this.cameraEntity;
    if (!entity || entity.getValue(CameraSource, 'state') !== CameraState.Active) return null;
    return entity.getValue(CameraSource, 'videoElement') as HTMLVideoElement | null;
  }

  private cameraTrack(video: HTMLVideoElement | null): MediaStreamTrack | null {
    const stream = video?.srcObject;
    if (!(stream instanceof MediaStream)) return null;
    return stream.getVideoTracks()[0] ?? null;
  }

  private stopCamera(): void {
    const entity = this.cameraEntity;
    if (!entity) return;
    const stream = entity.getValue(CameraSource, 'stream') as MediaStream | null;
    stream?.getTracks().forEach((track) => track.stop());
    const video = entity.getValue(CameraSource, 'videoElement') as HTMLVideoElement | null;
    if (video) {
      video.pause();
      video.srcObject = null;
    }
    const texture = entity.getValue(CameraSource, 'texture') as { dispose(): void } | null;
    texture?.dispose();
    // An in-flight start aborts when the state is no longer Starting.
    entity.setValue(CameraSource, 'state', CameraState.Active);
    entity.dispose({ disposeResources: false });
    this.cameraEntity = null;
  }

  private dispose(): void {
    this.session?.removeEventListener('selectstart', this.onSelectStart);
    this.session?.removeEventListener('selectend', this.onSelectEnd);
    this.stopCamera();
    this.roomMesh.dispose();
    this.photo.dispose();
    this.slab.geometry.dispose();
    (this.slab.material as { dispose(): void }).dispose();
    (this.shell.material as { dispose(): void }).dispose();
    this.outline.geometry.dispose();
    (this.outline.material as { dispose(): void }).dispose();
    this.cardTex.dispose();
    this.cardMat.dispose();
    this.tagTex.dispose();
    this.hudEntity.dispose();
  }
}
