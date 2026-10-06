import {
  BoxGeometry,
  CameraFacing,
  CameraSource,
  CameraState,
  CameraUtils,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  XRMesh,
  CanvasTexture,
  createSystem,
  type CameraDeviceInfo,
  type Entity,
} from '@iwsdk/core';
import { getMode } from './experience.js';
import { HandOccluder } from './hand-occluder.js';
import { drawHint, makeCanvas, type Canvas2D } from './labels.js';
import { cameraMount, PassthroughPhoto, type CameraMount, type PhotoCapture } from './passthrough-photo.js';
import { RoomMeshOverlay } from './room-mesh-overlay.js';
import { StretchLook } from './stretch-component.js';
import { Spring, buildTriGrid, rayTriGrid, triangleNormal, type RayHit, type TriGrid } from './stretch-math.js';
import type { RubberUniformSet } from './stretch-material.js';

type Side = 'left' | 'right';
/** Hand motion below this does not pull. The axis locks once the hand has moved this far. */
const DEAD = 0.03;
const LOCK = 0.06;

interface Look {
  gain: number;
  reach: number;
  ramp: number;
  stripes: number;
  feather: number;
  wobble: number;
  waveLength: number;
  waveSpeed: number;
  stiffness: number;
  damping: number;
  meshTint: number;
}
const LOOK_KEYS = [
  'gain', 'reach', 'ramp', 'stripes', 'feather', 'wobble', 'waveLength', 'waveSpeed',
  'stiffness', 'damping', 'meshTint',
] as const;

interface Grab {
  holding: boolean;
  on: boolean;
  locked: boolean;
  worldG: Vector3;
  localG: Vector3;
  axis: Vector3;
  normal: Vector3;
  localNormal: Vector3;
  hand0: Vector3;
  target: Vector3;
  D: Vector3;
  springs: [Spring, Spring, Spring];
  A: number;
}

interface Scan {
  mesh: Mesh;
  positions: ArrayLike<number>;
  index: ArrayLike<number>;
  grid: TriGrid;
  posCount: number;
  indexCount: number;
}

interface Copy {
  title: string;
  body: string;
}
const CARD = {
  point: { title: 'Pinch the room', body: 'Pull with one hand or both.' },
  scan: { title: 'No room mesh yet', body: 'Finish Space Setup and enter again.' },
  meshing: { title: 'Room mesh', body: 'Building a denser copy.' },
};

const WARDROBE = { x: -0.75, y: 1, z: -1.7, sx: 0.9, sy: 2, sz: 0.55 };
const FRONT_Z = WARDROBE.z + WARDROBE.sz / 2;

function makeGrab(): Grab {
  return {
    holding: false,
    on: false,
    locked: false,
    worldG: new Vector3(),
    localG: new Vector3(),
    axis: new Vector3(0, 1, 0),
    normal: new Vector3(0, 0, 1),
    localNormal: new Vector3(0, 0, 1),
    hand0: new Vector3(),
    target: new Vector3(),
    D: new Vector3(),
    springs: [new Spring(), new Spring(), new Spring()],
    A: 0.1,
  };
}

function smooth(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/**
 * Pinch the scanned room and pull. Each hand grabs the surface behind the pinch,
 * that spot follows the hand, and the mesh around it bends. A long pull turns the
 * stretched part into stripes of the column that was grabbed.
 */
export class RoomStretchSystem extends createSystem({
  settings: { required: [StretchLook] },
  meshes: { required: [XRMesh] },
}) {
  private readonly left = makeGrab();
  private readonly right = makeGrab();
  private readonly demoL = makeGrab();
  private readonly demoR = makeGrab();
  private scan: Scan | null = null;
  private readonly hit: RayHit = { t: Infinity, tri: -1 };
  private reveal = 0;
  private demoT = 0;
  private session: XRSession | null = null;
  private readonly look: Look = {
    gain: 1, reach: 0.45, ramp: 0.35, stripes: 0.5, feather: 0.06, wobble: 0.04,
    waveLength: 0.45, waveSpeed: 7, stiffness: 90, damping: 9, meshTint: 0.85,
  };

  private readonly photo = new PassthroughPhoto();
  private overlay!: RoomMeshOverlay;
  private hands!: HandOccluder;
  private readonly handMap: { left: XRHand | null; right: XRHand | null } = { left: null, right: null };
  private room!: Group;
  private cameraEntity: Entity | null = null;
  private mount: CameraMount = 'view';
  private arming: Promise<boolean> | null = null;

  private hud!: Group;
  private hudEntity!: Entity;
  private card!: Mesh;
  private cardMat!: MeshBasicMaterial;
  private cardPaint!: Canvas2D;
  private cardTex!: CanvasTexture;
  private cardKey = '';
  private cardShown: Copy = CARD.point;
  private cardOpacity = 0;
  private cardSettled = false;

  private readonly head = new Vector3();
  private readonly headQuat = new Quaternion();
  private readonly pinch = new Vector3();
  private readonly raw = new Vector3();
  private readonly unit = new Vector3();
  private readonly localO = new Vector3();
  private readonly localD = new Vector3();
  private readonly localHit = new Vector3();
  private readonly localN = new Vector3();
  private readonly inv = new Matrix4();

  init(): void {
    this.overlay = new RoomMeshOverlay(this.photo, this.scene);
    this.hands = new HandOccluder(this.scene);
    this.buildRoom();

    this.hud = new Group();
    this.hud.visible = false;
    this.cardPaint = makeCanvas(1024, 256);
    this.cardTex = new CanvasTexture(this.cardPaint.canvas);
    this.cardTex.colorSpace = SRGBColorSpace;
    this.cardMat = new MeshBasicMaterial({ map: this.cardTex, transparent: true, depthWrite: false, depthTest: false, opacity: 0 });
    this.card = new Mesh(new PlaneGeometry(0.46, 0.115), this.cardMat);
    this.card.renderOrder = 10;
    this.card.visible = false;
    this.hud.add(this.card);
    this.hudEntity = this.world.createTransformEntity(this.hud);

    this.demoL.worldG.set(WARDROBE.x - 0.18, 1.2, FRONT_Z);
    this.demoL.axis.set(-1, 0, 0);
    this.demoL.A = 3;
    this.demoR.worldG.set(WARDROBE.x + 0.18, 1.2, FRONT_Z);
    this.demoR.axis.set(1, 0, 0);
    this.demoR.A = 3;

    this.cleanupFuncs.push(() => this.dispose());
    void document.fonts.ready.then(() => {
      this.cardKey = '';
      drawHint(this.cardPaint, this.cardShown.title, this.cardShown.body);
      this.cardTex.needsUpdate = true;
    });
    drawHint(this.cardPaint, CARD.point.title, CARD.point.body);
    this.cardTex.needsUpdate = true;
  }

  /**
   * Open the passthrough camera. Call from the Enter click so the permission
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
      this.room.visible = false;
      this.overlay.hide(true);
      this.hands.setActive(false);
      this.stopCamera();
      this.clearGrabs();
      return;
    }
    const dt = Math.min(0.1, delta);
    if (this.cameraEntity && this.cameraEntity.getValue(CameraSource, 'state') === CameraState.Error) this.stopCamera();
    this.readLook();
    this.syncSession();
    const presenting = this.renderer.xr.isPresenting;
    const video = this.cameraVideo();
    const req = this.captureReq(video);
    const live = this.photo.projectLive(req);
    this.overlay.setLive(video, live, this.photo.worldToClip);
    if (presenting) {
      this.room.visible = false;
      this.player.head.getWorldPosition(this.head);
      this.player.head.getWorldQuaternion(this.headQuat);
      this.refreshHands();
      const source = this.findGlobal();
      this.overlay.sync(source);
      this.syncGrid(source);
      const handsInFrame = this.hands.jointCount > 0 && this.photo.jointsInFrame(this.hands.points, this.hands.jointCount);
      this.photo.keepClean(video, !handsInFrame);
      this.poseGrab(this.left);
      this.poseGrab(this.right);
      this.stepHand(this.left, dt, 'left');
      this.stepHand(this.right, dt, 'right');
      this.publish(this.left, this.right, dt, time);
    } else {
      this.overlay.hide(false);
      this.hands.setActive(false);
      this.room.visible = true;
      this.photo.keepClean(video, true);
      this.updateDemo(dt, video);
      this.publish(this.demoL, this.demoR, dt, time);
    }
    this.hud.visible = true;
    this.updateHud(dt, presenting);
  }

  // ---------------------------------------------------------------- room

  private buildRoom(): void {
    const mat = this.overlay.material;
    this.room = new Group();
    this.room.name = 'stretch-stand-in';
    const add = (mesh: Mesh) => {
      mesh.material = mat;
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      this.room.add(mesh);
    };
    const floor = new Mesh(new PlaneGeometry(4, 4, 80, 80));
    floor.rotation.x = -Math.PI / 2;
    add(floor);
    const wall = new Mesh(new PlaneGeometry(4, 2.4, 80, 48));
    wall.position.set(0, 1.2, -2);
    add(wall);
    const wardrobe = new Mesh(new BoxGeometry(WARDROBE.sx, WARDROBE.sy, WARDROBE.sz, 18, 40, 11));
    wardrobe.position.set(WARDROBE.x, WARDROBE.y, WARDROBE.z);
    add(wardrobe);
    const table = new Mesh(new BoxGeometry(1.2, 0.72, 0.7, 24, 14, 14));
    table.position.set(0.85, 0.36, -1.15);
    add(table);
    this.room.visible = false;
    this.scene.add(this.room);
  }

  private findGlobal(): Mesh | null {
    let found: Mesh | null = null;
    for (const entity of this.queries.meshes.entities) {
      const object = entity.object3D;
      if (!object) continue;
      if (entity.getValue(XRMesh, 'isBounded3D')) {
        object.visible = false;
        continue;
      }
      const mesh = object as Mesh;
      if (mesh.isMesh && mesh.geometry) found = mesh;
    }
    return found;
  }

  private syncGrid(mesh: Mesh | null): void {
    const position = mesh?.geometry?.getAttribute('position');
    const index = mesh?.geometry?.getIndex();
    if (!mesh || !position || !index) {
      this.scan = null;
      return;
    }
    if (this.scan && this.scan.mesh === mesh && this.scan.posCount === position.count && this.scan.indexCount === index.count) return;
    const positions = this.packed(position);
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
    if (!Number.isFinite(minX)) {
      this.scan = null;
      return;
    }
    this.scan = {
      mesh,
      positions,
      index: indices,
      grid: buildTriGrid(positions, indices, minX, minY, minZ, maxX, maxY, maxZ),
      posCount: position.count,
      indexCount: index.count,
    };
  }

  private packed(position: { count: number; array: ArrayLike<number>; getX(i: number): number; getY(i: number): number; getZ(i: number): number }): ArrayLike<number> {
    if (position.array.length === position.count * 3) return position.array;
    const out = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      out[i * 3] = position.getX(i);
      out[i * 3 + 1] = position.getY(i);
      out[i * 3 + 2] = position.getZ(i);
    }
    return out;
  }

  // ---------------------------------------------------------------- hands and grabs

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
    if (getMode() !== 'stretch' || !this.renderer.xr.isPresenting) return;
    const side = (event as XRInputSourceEvent).inputSource?.handedness;
    if (side !== 'left' && side !== 'right') return;
    const grab = side === 'left' ? this.left : this.right;
    if (grab.holding) return;
    this.refreshHands();
    this.player.head.getWorldPosition(this.head);
    if (!this.pinchPoint(side, this.pinch)) return;
    if (!this.raycast(this.head, this.pinch)) return;
    grab.holding = true;
    grab.locked = false;
    grab.localG.copy(this.localHit);
    grab.localNormal.copy(this.localN);
    grab.hand0.copy(this.pinch);
    grab.target.set(0, 0, 0);
    grab.D.set(0, 0, 0);
    grab.A = 0.1;
    for (let i = 0; i < grab.springs.length; i++) grab.springs[i].reset(0);
    this.poseGrab(grab);
    const other = side === 'left' ? this.right : this.left;
    const video = this.cameraVideo();
    this.photo.projectLive(this.captureReq(video));
    this.photo.freezeWorld(video, grab.worldG, this.photo.ready && (other.holding || other.on));
  };

  private readonly onSelectEnd = (event: Event): void => {
    const side = (event as XRInputSourceEvent).inputSource?.handedness;
    if (side !== 'left' && side !== 'right') return;
    const grab = side === 'left' ? this.left : this.right;
    grab.holding = false;
  };

  private refreshHands(): void {
    this.hands.setActive(true);
    this.player.updateWorldMatrix(true, false);
    this.handMap.left = this.input.xr.isPrimary('hand', 'left') ? this.input.xr.getPrimaryInputSource('left')?.hand ?? null : null;
    this.handMap.right = this.input.xr.isPrimary('hand', 'right') ? this.input.xr.getPrimaryInputSource('right')?.hand ?? null : null;
    this.hands.update(this.world.xrFrame, this.world.xrReferenceSpace, this.player.matrixWorld, this.handMap);
  }

  private pinchPoint(side: Side, out: Vector3): boolean {
    if (this.hands.hasPinch[side]) {
      out.copy(this.hands.thumbTip[side]).add(this.hands.indexTip[side]).multiplyScalar(0.5);
      return true;
    }
    const ray = this.player.raySpaces[side];
    if (!ray) return false;
    ray.getWorldPosition(out);
    return true;
  }

  private raycast(origin: Vector3, through: Vector3): boolean {
    const scan = this.scan;
    if (!scan) return false;
    const mesh = scan.mesh;
    mesh.updateWorldMatrix(true, false);
    this.inv.copy(mesh.matrixWorld).invert();
    this.localO.copy(origin).applyMatrix4(this.inv);
    this.localD.copy(through).applyMatrix4(this.inv).sub(this.localO);
    const len = this.localD.length();
    if (len < 1e-5) return false;
    this.localD.multiplyScalar(1 / len);
    if (!rayTriGrid(
      scan.positions, scan.index, scan.grid,
      this.localO.x, this.localO.y, this.localO.z,
      this.localD.x, this.localD.y, this.localD.z,
      this.hit,
    )) return false;
    if (this.hit.t > 12) return false;
    this.localHit.copy(this.localO).addScaledVector(this.localD, this.hit.t);
    triangleNormal(scan.positions, scan.index, this.hit.tri, this.localN);
    if (this.localN.dot(this.localD) > 0) this.localN.negate();
    return true;
  }

  private poseGrab(grab: Grab): void {
    const mesh = this.scan?.mesh;
    if (!mesh || (!grab.holding && !grab.on)) return;
    mesh.updateWorldMatrix(true, false);
    grab.worldG.copy(grab.localG).applyMatrix4(mesh.matrixWorld);
    grab.normal.copy(grab.localNormal).transformDirection(mesh.matrixWorld);
  }

  private stepHand(grab: Grab, dt: number, side: Side): void {
    if (grab.holding && this.pinchPoint(side, this.pinch)) this.aim(grab, this.pinch);
    else if (!grab.holding) grab.target.set(0, 0, 0);
    const { stiffness, damping } = this.look;
    grab.springs[0].step(grab.target.x, dt, stiffness, damping);
    grab.springs[1].step(grab.target.y, dt, stiffness, damping);
    grab.springs[2].step(grab.target.z, dt, stiffness, damping);
    grab.D.set(grab.springs[0].value, grab.springs[1].value, grab.springs[2].value);
    const resting = grab.springs[0].atRest(0) && grab.springs[1].atRest(0) && grab.springs[2].atRest(0);
    grab.on = grab.holding || !resting;
  }

  /** `D` follows the hand, scaled so the grab point stays under the fingers. */
  private aim(grab: Grab, hand: Vector3): void {
    this.raw.copy(hand).sub(grab.hand0);
    const dist = this.raw.length();
    if (dist < DEAD) {
      grab.target.set(0, 0, 0);
      return;
    }
    this.unit.copy(this.raw).multiplyScalar(1 / dist);
    if (!grab.locked) grab.axis.copy(this.unit);
    if (!grab.locked && dist >= LOCK) grab.locked = true;
    const headG = Math.max(0.05, this.head.distanceTo(grab.worldG));
    const headH = Math.max(0.05, this.head.distanceTo(hand));
    const k = Math.min(8, Math.max(1, this.look.gain * headG / headH));
    grab.target.copy(this.raw).multiplyScalar(k);
    const along = grab.target.dot(grab.axis);
    if (along < 0) grab.target.addScaledVector(grab.axis, -along);
    const facing = Math.abs(grab.normal.dot(grab.axis));
    grab.A = 0.1 + (1 - facing) * 2.9;
  }

  private clearGrabs(): void {
    this.resetGrab(this.left);
    this.resetGrab(this.right);
    this.reveal = 0;
    this.photo.invalidate();
  }

  private resetGrab(grab: Grab): void {
    grab.holding = false;
    grab.on = false;
    grab.locked = false;
    grab.target.set(0, 0, 0);
    grab.D.set(0, 0, 0);
    for (let i = 0; i < grab.springs.length; i++) grab.springs[i].reset(0);
  }

  /** Desktop preview: two points on the wardrobe pull apart, hold, then return. */
  private updateDemo(dt: number, video: HTMLVideoElement | null): void {
    this.demoT += dt;
    const t = this.demoT % 8;
    let pull = 0;
    if (t < 1.2) pull = smooth(t / 1.2) * 0.72;
    else if (t < 5.2) pull = 0.72;
    else if (t < 6.8) pull = (1 - smooth((t - 5.2) / 1.6)) * 0.72;
    const moving = pull > 0.02;
    this.demoL.on = moving;
    this.demoR.on = moving;
    this.demoL.D.set(-pull, 0, pull * 0.22);
    this.demoR.D.set(pull, 0, pull * 0.22);
    if (moving && video && !this.photo.ready) this.photo.freezeWorld(video, this.demoL.worldG, false);
  }

  private publish(a: Grab, b: Grab, dt: number, time: number): void {
    const U = this.overlay.uniforms;
    this.writeGrab(U, 0, a);
    this.writeGrab(U, 1, b);
    U.uReach.value = this.look.reach;
    U.uRamp.value = this.look.ramp;
    U.uStripes.value = this.look.stripes;
    U.uFeather.value = this.look.feather;
    U.uWobble.value = this.look.wobble;
    U.uWaveK.value = 1 / Math.max(this.look.waveLength, 0.05);
    U.uWaveSpeed.value = this.look.waveSpeed;
    U.uTime.value = time;
    U.uMeshTint.value = this.look.meshTint;
    const moving = a.on || b.on;
    const revealTarget = moving ? 1 : 0;
    this.reveal += (revealTarget - this.reveal) * (1 - Math.exp(-dt * 8));
    if (!moving && this.reveal < 0.02) {
      this.reveal = 0;
      if (this.photo.ready) this.photo.invalidate();
    }
    U.uReveal.value = this.reveal;
    U.uHasPhoto.value = this.photo.ready ? 1 : 0;
    U.uPhoto.value = this.photo.frozenTexture;
    (U.uWorldToClip.value as Matrix4).copy(this.photo.frozenToClip);
    (U.uCamPos.value as Vector3).copy(this.photo.ready ? this.photo.frozenCam : this.photo.liveCam);
  }

  private writeGrab(U: RubberUniformSet, slot: 0 | 1, grab: Grab): void {
    const G = (slot === 0 ? U.uG0 : U.uG1).value as Vector3;
    const D = (slot === 0 ? U.uD0 : U.uD1).value as Vector3;
    const axis = (slot === 0 ? U.uAxis0 : U.uAxis1).value as Vector3;
    G.copy(grab.worldG);
    D.copy(grab.D);
    axis.copy(grab.axis);
    if (slot === 0) {
      U.uA0.value = grab.A;
      U.uOn0.value = grab.on ? 1 : 0;
    } else {
      U.uA1.value = grab.A;
      U.uOn1.value = grab.on ? 1 : 0;
    }
  }

  // ---------------------------------------------------------------- hint card

  private updateHud(dt: number, presenting: boolean): void {
    const holding = this.left.holding || this.right.holding;
    const wantCard = presenting && !holding;
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
    this.unit.set(0, 0, -1).applyQuaternion(this.headQuat);
    this.unit.y = 0;
    if (this.unit.lengthSq() < 1e-6) this.unit.set(0, 0, -1);
    this.pinch.copy(this.unit).normalize().multiplyScalar(0.7).add(this.head);
    this.pinch.y -= 0.22;
    if (!this.cardSettled) {
      this.card.position.copy(this.pinch);
      this.cardSettled = true;
    } else {
      this.card.position.lerp(this.pinch, 1 - Math.exp(-dt * 3));
    }
    this.card.lookAt(this.head);
  }

  private meshCopy(presenting: boolean): Copy {
    if (!presenting) return CARD.point;
    if (!this.scan) return CARD.scan;
    if (!this.overlay.ready) return CARD.meshing;
    const triangles = this.overlay.triangles;
    const count = triangles > 1000 ? `${Math.round(triangles / 1000)}k` : String(triangles);
    return { title: 'Room mesh', body: `${count} tris. Pinch and pull.` };
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

  // ---------------------------------------------------------------- camera

  private captureReq(video: HTMLVideoElement | null): Omit<PhotoCapture, 'objectWorld' | 'center'> {
    return {
      renderer: this.renderer,
      presenting: this.renderer.xr.isPresenting,
      frame: this.world.xrFrame,
      refSpace: this.world.xrReferenceSpace,
      video,
      track: this.cameraTrack(video),
      mount: this.mount,
      viewCamera: this.camera,
    };
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
    entity.setValue(CameraSource, 'state', CameraState.Active);
    entity.dispose({ disposeResources: false });
    this.cameraEntity = null;
  }

  private dispose(): void {
    this.session?.removeEventListener('selectstart', this.onSelectStart);
    this.session?.removeEventListener('selectend', this.onSelectEnd);
    this.stopCamera();
    this.overlay.dispose();
    this.hands.dispose();
    this.photo.dispose();
    this.room.traverse((object) => {
      const mesh = object as Mesh;
      mesh.geometry?.dispose();
    });
    this.room.removeFromParent();
    this.cardTex.dispose();
    this.cardMat.dispose();
    this.hudEntity.dispose();
  }
}
