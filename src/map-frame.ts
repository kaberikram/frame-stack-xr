import { BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial, type Object3D, type Vector3 } from '@iwsdk/core';

/** The frame's strips are this wide, and float this far off the wall so it never sinks into it. */
const STRIP = 0.015;
const LIFT = 0.01;

/**
 * The area mapped for a palm push: a thin white frame on the wall, drawn while you drag it out and
 * while it waits to be pushed. Depth-tested, so your hands stay in front of it.
 */
export class MapFrame {
  private readonly mesh: Mesh;
  private readonly position: BufferAttribute;
  private readonly material: MeshBasicMaterial;
  /** The 16 corners' u, v on the wall, refilled on each place(). */
  private readonly uv = new Float32Array(32);

  constructor(parent: Object3D) {
    const geometry = new BufferGeometry();
    // Four strips, four corners each: left, right, bottom, top.
    this.position = new BufferAttribute(new Float32Array(16 * 3), 3);
    geometry.setAttribute('position', this.position);
    const index: number[] = [];
    for (let s = 0; s < 4; s++) {
      const b = s * 4;
      index.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    geometry.setIndex(index);
    this.material = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: true, depthWrite: false });
    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.matrix.identity();
    this.mesh.visible = false;
    parent.add(this.mesh);
    this.mesh.updateMatrixWorld(true);
  }

  /** The frame round a rectangle on a wall: its centre, axes, half sizes, and the wall's normal toward you. */
  place(C: Vector3, U: Vector3, hw: number, V: Vector3, hh: number, N: Vector3): void {
    const w = hw + STRIP;
    const h = hh + STRIP;
    // Left and right run the full height, bottom and top fit between them.
    const c = this.uv;
    c[0] = -w; c[1] = -h; c[2] = -hw; c[3] = -h; c[4] = -hw; c[5] = h; c[6] = -w; c[7] = h;
    c[8] = hw; c[9] = -h; c[10] = w; c[11] = -h; c[12] = w; c[13] = h; c[14] = hw; c[15] = h;
    c[16] = -hw; c[17] = -h; c[18] = hw; c[19] = -h; c[20] = hw; c[21] = -hh; c[22] = -hw; c[23] = -hh;
    c[24] = -hw; c[25] = hh; c[26] = hw; c[27] = hh; c[28] = hw; c[29] = h; c[30] = -hw; c[31] = h;
    const a = this.position.array as Float32Array;
    for (let i = 0; i < 16; i++) {
      const u = c[i * 2];
      const v = c[i * 2 + 1];
      a[i * 3] = C.x + U.x * u + V.x * v + N.x * LIFT;
      a[i * 3 + 1] = C.y + U.y * u + V.y * v + N.y * LIFT;
      a[i * 3 + 2] = C.z + U.z * u + V.z * v + N.z * LIFT;
    }
    this.position.needsUpdate = true;
  }

  setVisible(on: boolean): void {
    if (this.mesh.visible !== on) this.mesh.visible = on;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
