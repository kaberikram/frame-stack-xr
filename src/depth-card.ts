import {
  CanvasTexture,
  DataTexture,
  LinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  type Texture,
} from '@iwsdk/core';
import type { DepthField } from './depth-model.js';
import { reliefMaterial } from './stack-materials.js';

type Mode = 'idle' | 'opening' | 'open' | 'closing';

const AXIS_X = new Vector3(1, 0, 0);
/** Landscape width. The film strip is 0.4 m, so the screen sits inside it. */
const LONG_SIDE = 0.32;
const SEGMENTS = 144;
/** Near-to-far push, as a fraction of the screen's long side. Same punch as the large card, on the smaller one. */
const RELIEF = 1;
/** Lean back so the screen faces someone looking down at the table. */
const TV_PITCH = 0.24;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

/**
 * The selected frame, stood up above the film strip like a tabletop screen.
 * It flies out of the stack, then eases into relief when a depth map arrives.
 * A second pinch flies it back into the stack.
 */
export class DepthCard {
  readonly mesh: Mesh;
  private readonly mat: ShaderMaterial;
  private readonly fallbackDepth: Texture;
  private readonly fromPos = new Vector3();
  private readonly toPos = new Vector3();
  private readonly fromQuat = new Quaternion();
  private readonly toQuat = new Quaternion();
  private readonly tilt = new Quaternion();
  private readonly fromScale = new Vector3();
  private readonly toScale = new Vector3();
  private readonly dir = new Vector3();
  private photo: CanvasTexture | null = null;
  private depthTex: DataTexture | null = null;
  private geo: PlaneGeometry;
  private nx = 1;
  private ny = 1;
  private mode: Mode = 'idle';
  private anim = 1;
  private reliefTarget = 0;
  generation = 0;

  constructor(scene: Scene) {
    this.mat = reliefMaterial();
    this.fallbackDepth = this.mat.uniforms.uDepth.value as Texture;
    this.geo = new PlaneGeometry(1, 1, 1, 1);
    this.mesh = new Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  get occupied(): boolean {
    return this.mode !== 'idle';
  }

  /**
   * Fly the slice up to a screen standing on `anchorPos`. `anchorQuat` is the
   * table's facing: the screen shares that yaw and leans back a little.
   * `tableScale` matches the rig, so the screen stays proportional to the strip.
   * `photo` is the low-res slice, shown until the sharp frame lands.
   */
  begin(
    frame: Mesh,
    anchorPos: Vector3,
    anchorQuat: Quaternion,
    photo: HTMLCanvasElement,
    aspect: number,
    tableScale = 1,
  ): number {
    this.generation += 1;
    this.resetLook();
    frame.getWorldPosition(this.fromPos);
    frame.getWorldQuaternion(this.fromQuat);
    frame.getWorldScale(this.fromScale);
    const fit = Math.max(0.05, tableScale);
    const width = (aspect >= 1 ? LONG_SIDE : LONG_SIDE * aspect) * fit;
    const height = (aspect >= 1 ? LONG_SIDE / aspect : LONG_SIDE) * fit;
    this.toScale.set(width, height, 1);
    this.mat.uniforms.uDepthAmt.value = Math.max(width, height) * RELIEF;
    this.dir.set(0, height / 2 + 0.03 * fit, 0).applyQuaternion(anchorQuat);
    this.toPos.copy(anchorPos).add(this.dir);
    this.tilt.setFromAxisAngle(AXIS_X, -TV_PITCH);
    this.toQuat.copy(anchorQuat).multiply(this.tilt);
    this.rebuild(aspect);
    this.setPhoto(photo);
    this.mode = 'opening';
    this.anim = reduceMotion.matches ? 1 : 0;
    this.mesh.visible = true;
    this.apply(this.anim);
    if (this.anim >= 1) this.mode = 'open';
    return this.generation;
  }

  close(pos: Vector3, quat: Quaternion, scale: Vector3): void {
    if (this.mode === 'idle' || this.mode === 'closing') return;
    this.generation += 1;
    this.fromPos.copy(this.mesh.position);
    this.fromQuat.copy(this.mesh.quaternion);
    this.fromScale.copy(this.mesh.scale);
    this.toPos.copy(pos);
    this.toQuat.copy(quat);
    this.toScale.copy(scale);
    this.reliefTarget = 0;
    this.mode = 'closing';
    this.anim = reduceMotion.matches ? 1 : 0;
    this.apply(this.anim);
  }

  dismiss(): void {
    this.generation += 1;
    this.mode = 'idle';
    this.mesh.visible = false;
    this.resetLook();
  }

  setPhoto(canvas: HTMLCanvasElement): void {
    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    tex.minFilter = LinearFilter;
    tex.magFilter = LinearFilter;
    tex.generateMipmaps = false;
    this.photo?.dispose();
    this.photo = tex;
    this.mat.uniforms.uPhoto.value = tex;
  }

  setDepth(field: DepthField): void {
    if (this.mode === 'idle' || this.mode === 'closing') return;
    const rgba = new Uint8Array(field.width * field.height * 4);
    for (let i = 0; i < field.data.length; i++) {
      const v = field.data[i];
      const j = i * 4;
      rgba[j] = v;
      rgba[j + 1] = v;
      rgba[j + 2] = v;
      rgba[j + 3] = 255;
    }
    const tex = new DataTexture(rgba, field.width, field.height);
    tex.colorSpace = LinearSRGBColorSpace;
    tex.minFilter = LinearFilter;
    tex.magFilter = LinearFilter;
    tex.generateMipmaps = false;
    tex.flipY = true;
    tex.needsUpdate = true;
    this.depthTex?.dispose();
    this.depthTex = tex;
    this.mat.uniforms.uDepth.value = tex;
    (this.mat.uniforms.uTexel.value as Vector2).set(1 / field.width, 1 / field.height);
    this.mat.uniforms.uHasDepth.value = 1;
    this.reliefTarget = 1;
  }

  update(dt: number): void {
    if (this.mode === 'idle') return;
    if (this.anim < 1) {
      this.anim = Math.min(1, this.anim + dt / 0.5);
      const t = 1 - (1 - this.anim) ** 3;
      this.apply(t);
      if (this.anim >= 1) {
        if (this.mode === 'opening') this.mode = 'open';
        else if (this.mode === 'closing') this.finishClose();
      }
    }
    const relief = this.mat.uniforms.uRelief.value as number;
    const next = relief + (this.reliefTarget - relief) * (1 - Math.exp(-dt * 3.5));
    this.mat.uniforms.uRelief.value = Math.abs(this.reliefTarget - next) < 0.001 ? this.reliefTarget : next;
  }

  dispose(): void {
    this.dismiss();
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
    this.fallbackDepth.dispose();
  }

  private finishClose(): void {
    this.mode = 'idle';
    this.mesh.visible = false;
    this.resetLook();
  }

  private apply(t: number): void {
    this.mesh.position.lerpVectors(this.fromPos, this.toPos, t);
    this.mesh.quaternion.copy(this.fromQuat).slerp(this.toQuat, t);
    this.mesh.scale.lerpVectors(this.fromScale, this.toScale, t);
  }

  private rebuild(aspect: number): void {
    const nx = aspect >= 1 ? SEGMENTS : Math.max(8, Math.round(SEGMENTS * aspect));
    const ny = aspect >= 1 ? Math.max(8, Math.round(SEGMENTS / aspect)) : SEGMENTS;
    if (nx === this.nx && ny === this.ny) return;
    this.geo.dispose();
    this.geo = new PlaneGeometry(1, 1, nx, ny);
    this.mesh.geometry = this.geo;
    this.nx = nx;
    this.ny = ny;
  }

  private resetLook(): void {
    this.reliefTarget = 0;
    this.mat.uniforms.uRelief.value = 0;
    this.mat.uniforms.uHasDepth.value = 0;
    this.mat.uniforms.uDepth.value = this.fallbackDepth;
    this.photo?.dispose();
    this.photo = null;
    this.mat.uniforms.uPhoto.value = null;
    this.depthTex?.dispose();
    this.depthTex = null;
  }
}
