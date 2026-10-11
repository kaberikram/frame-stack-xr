import { BufferAttribute, BufferGeometry, Mesh, type Object3D, type ShaderMaterial, type Vector3 } from '@iwsdk/core';
import type { PhotoSlot } from './passthrough-photo.js';
import { createRubberUniforms, rubberMaterial, type RubberUniformSet } from './stretch-material.js';

/**
 * Light per face of a box pushed into a wall, so a flat photo still reads as depth: the back as the
 * wall was, its floor lit from the room above, its ceiling in shade.
 */
const BACK = 1;
const FLOOR = 0.88;
const SIDES = 0.74;
const CEILING = 0.6;

/** Faces as x, y corners in -1..1 (z 0 at the wall, 1 at the back), and each face's light. */
const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const;

function boxGeometry(): BufferGeometry {
  const position: number[] = [];
  const shade: number[] = [];
  const index: number[] = [];
  const quad = (a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[], light: number) => {
    const base = position.length / 3;
    position.push(...a, ...b, ...c, ...d);
    shade.push(light, light, light, light);
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  quad([-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1], BACK);
  // Each side runs from its rim on the wall (z 0) back to the box's back edge (z 1).
  const light = [FLOOR, SIDES, CEILING, SIDES];
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = CORNERS[i];
    const [bx, by] = CORNERS[(i + 1) % 4];
    quad([ax, ay, 0], [bx, by, 0], [bx, by, 1], [ax, ay, 1], light[i]);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(position), 3));
  geometry.setAttribute('aShade', new BufferAttribute(new Float32Array(shade), 1));
  geometry.setIndex(index);
  return geometry;
}

/**
 * A wall section pushed in by a palm: a box behind the wall, drawn where the room leaves its opening
 * undrawn (stretch-material.ts, uBoxOn). It reads its own photo slot through photo set 0 of its own
 * uniforms, so the hands keep pinching through theirs. Everything that is not a photo or a grab
 * (depth, hand cut, look, the box's shape) is the room's own uniform, shared by reference.
 */
export class PushBox {
  readonly uniforms: RubberUniformSet;
  private readonly mesh: Mesh;
  private readonly headset: ShaderMaterial;
  private readonly preview: ShaderMaterial;

  constructor(parent: Object3D, room: RubberUniformSet) {
    const own = createRubberUniforms();
    this.uniforms = {
      ...own,
      uFeather: room.uFeather,
      uLinear: room.uLinear,
      uAnyPhoto: room.uAnyPhoto,
      uLive: room.uLive,
      uLiveToClip: room.uLiveToClip,
      uHasLive: room.uHasLive,
      uEnvDepth: room.uEnvDepth,
      uDepthOn: room.uDepthOn,
      uDepthRaw: room.uDepthRaw,
      uDepthNear: room.uDepthNear,
      uEyeSize: room.uEyeSize,
      uNormDepth0: room.uNormDepth0,
      uNormDepth1: room.uNormDepth1,
      uSegA: room.uSegA,
      uSegB: room.uSegB,
      uOccDebug: room.uOccDebug,
      uBoxOn: room.uBoxOn,
      uBoxC: room.uBoxC,
      uBoxU: room.uBoxU,
      uBoxV: room.uBoxV,
      uBoxN: room.uBoxN,
      uBoxDepth: room.uBoxDepth,
    };
    this.headset = rubberMaterial(this.uniforms, false, false, 'box');
    this.preview = rubberMaterial(this.uniforms, true, false, 'box');
    this.mesh = new Mesh(boxGeometry(), this.headset);
    // After the room (2), whose depth makes the opening's rim and anything in front hide the box,
    // and after the hands (0).
    this.mesh.renderOrder = 3;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.matrix.identity();
    this.mesh.visible = false;
    parent.add(this.mesh);
    this.mesh.updateMatrixWorld(true);
  }

  /**
   * Shown through all of stretch mode, collapsed while there is no box (uBoxOn 0), so its program
   * compiles when the mode starts rather than on the first push.
   */
  setVisible(on: boolean, preview: boolean): void {
    this.mesh.visible = on;
    const material = preview ? this.preview : this.headset;
    if (this.mesh.material !== material) this.mesh.material = material;
  }

  /** The box's shape, shared with the room (which cuts its opening): centre, axes with half sizes, normal toward you. */
  place(C: Vector3, U: Vector3, hw: number, V: Vector3, hh: number, N: Vector3, depth: number): void {
    const u = this.uniforms;
    u.uBoxOn.value = 1;
    u.uBoxC.value.copy(C);
    u.uBoxU.value.set(U.x, U.y, U.z, hw);
    u.uBoxV.value.set(V.x, V.y, V.z, hh);
    u.uBoxN.value.copy(N);
    u.uBoxDepth.value = depth;
  }

  hide(): void {
    this.uniforms.uBoxOn.value = 0;
    this.uniforms.uBoxDepth.value = 0;
  }

  /** The box's photo, from its own slot, faded in by `fade`. */
  writePhoto(slot: PhotoSlot, fade: number): void {
    const u = this.uniforms;
    const has = slot.has && slot.texture ? 1 : 0;
    u.uPhoto0.value = slot.texture;
    u.uWorldToClip0.value.copy(slot.toClip);
    u.uCamPos0.value.copy(slot.cam);
    u.uGain0.value.copy(slot.gain);
    u.uHasPhoto0.value = has;
    const fill = slot.fill;
    u.uFill0.value = fill.texture;
    u.uFillToClip0.value.copy(fill.toClip);
    u.uFillCam0.value.copy(fill.cam);
    u.uHasFill0.value = has && fill.has && fill.ready && fill.texture ? 1 : 0;
    u.uFade0.value = fade;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.headset.dispose();
    this.preview.dispose();
  }
}
