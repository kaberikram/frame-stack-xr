import { Matrix4, Vector3, XRPlane, type Entity } from '@iwsdk/core';
import { polygonDepth } from './mesh-subdivide.js';

/** Planes beyond this are ignored; a furnished room has a dozen or two. */
const MAX_PLANES = 32;
/** Polygon points kept per plane. */
const MAX_POINTS = 64;
/** A ray this far outside a plane's outline still counts as on it. */
const EDGE_TOLERANCE = 0.01;

/** The raw WebXR plane IWSDK stores on each XRPlane entity. Local +Y is the plane's normal. */
interface RawPlane {
  polygon: readonly DOMPointReadOnly[];
  orientation?: string;
  semanticLabel?: string;
  lastChangedTime?: number;
}

export interface PlaneHit {
  point: Vector3;
  /** Plane normal, world space, facing the ray's origin. */
  normal: Vector3;
  distance: number;
  label: string;
  horizontal: boolean;
}

/** One detected plane, in world space. Polygon points are plane-space x and z pairs. */
export interface RoomPlane {
  readonly world: Matrix4;
  readonly inverse: Matrix4;
  readonly polygon: Float32Array;
  points: number;
  horizontal: boolean;
  label: string;
  raw: RawPlane | null;
  changed: number;
}

function makePlane(): RoomPlane {
  return {
    world: new Matrix4(), inverse: new Matrix4(), polygon: new Float32Array(MAX_POINTS * 2), points: 0,
    horizontal: true, label: '', raw: null, changed: -1,
  };
}

/**
 * Quest's detected planes (tables, floor, walls), refreshed once a frame from the XRPlane entities.
 * The scanned mesh is lumpy by a centimetre or two; these are flat, so a grab on a table lands on
 * the table and the dense room can be snapped flat where it lies on one.
 */
export class RoomPlanes {
  readonly planes: RoomPlane[] = [];
  count = 0;
  /** Changes whenever a plane appears, goes, moves or changes its outline. */
  signature = 0;

  private readonly o = new Vector3();
  private readonly d = new Vector3();

  constructor() {
    for (let i = 0; i < MAX_PLANES; i++) this.planes.push(makePlane());
  }

  sync(entities: Iterable<Entity>): void {
    let n = 0;
    let sig = 0;
    for (const entity of entities) {
      if (n >= MAX_PLANES) break;
      const raw = entity.getValue(XRPlane, '_plane') as RawPlane | null | undefined;
      const object = entity.object3D;
      if (!raw || !object || !raw.polygon || raw.polygon.length < 3) continue;
      const plane = this.planes[n++];
      object.updateWorldMatrix(true, false);
      plane.world.copy(object.matrixWorld);
      plane.inverse.copy(plane.world).invert();
      const changed = raw.lastChangedTime ?? 0;
      if (plane.raw !== raw || plane.changed !== changed) {
        plane.raw = raw;
        plane.changed = changed;
        plane.horizontal = raw.orientation !== 'vertical';
        plane.label = raw.semanticLabel || (plane.horizontal ? 'horizontal' : 'vertical');
        const count = Math.min(MAX_POINTS, raw.polygon.length);
        for (let i = 0; i < count; i++) {
          plane.polygon[i * 2] = raw.polygon[i].x;
          plane.polygon[i * 2 + 1] = raw.polygon[i].z;
        }
        plane.points = count;
      }
      const e = plane.world.elements;
      sig = (sig * 31 + plane.points + Math.round(changed)) | 0;
      sig = (sig * 31 + Math.round(e[12] * 100) + Math.round(e[13] * 100) * 7 + Math.round(e[14] * 100) * 13) | 0;
    }
    for (let i = n; i < this.count; i++) this.planes[i].raw = null;
    this.count = n;
    this.signature = (sig * 31 + n) | 0;
  }

  /** The nearest plane the ray from `origin` along unit `dir` crosses inside its outline. */
  raycast(origin: Vector3, dir: Vector3, maxDistance: number, out: PlaneHit): boolean {
    let best = maxDistance;
    let found = -1;
    for (let i = 0; i < this.count; i++) {
      const plane = this.planes[i];
      this.o.copy(origin).applyMatrix4(plane.inverse);
      this.d.copy(dir).transformDirection(plane.inverse);
      if (Math.abs(this.d.y) < 1e-4) continue;
      const t = -this.o.y / this.d.y;
      if (t <= 0 || t >= best) continue;
      const x = this.o.x + this.d.x * t;
      const z = this.o.z + this.d.z * t;
      if (polygonDepth(plane.polygon, plane.points, x, z) < -EDGE_TOLERANCE) continue;
      best = t;
      found = i;
    }
    if (found < 0) return false;
    const plane = this.planes[found];
    out.distance = best;
    out.point.copy(origin).addScaledVector(dir, best);
    const e = plane.world.elements;
    out.normal.set(e[4], e[5], e[6]).normalize();
    if (out.normal.dot(dir) > 0) out.normal.negate();
    out.label = plane.label;
    out.horizontal = plane.horizontal;
    return true;
  }
}
