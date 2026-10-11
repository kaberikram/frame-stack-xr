import { BufferAttribute, BufferGeometry, Mesh, Vector3, type Object3D, type ShaderMaterial } from '@iwsdk/core';
import { vortexMaterial, type RubberUniformSet } from './stretch-material.js';

/** Local +Z is the nozzle. The mesh is turned so +Z follows the fist's aim. */
const AIM = new Vector3(0, 0, 1);
/** After the flying shards (3) and before the far black (3.5), so the ring sits over the mouth. */
const ORDER = 3.4;
const RING_SEG = 48;

/**
 * The vacuum's nozzle: a ring about 9 cm across at the fist. Depth-tested, no depth write, so
 * shards and hands stay visible through it.
 */
export class VoidVortex {
  private readonly mesh: Mesh;
  private readonly warmer: Mesh;
  private readonly headset: ShaderMaterial;
  private readonly previewMat: ShaderMaterial;
  private previewMode = false;

  constructor(parent: Object3D, room: RubberUniformSet) {
    this.headset = vortexMaterial(room, false);
    this.previewMat = vortexMaterial(room, true);
    this.mesh = this.mount(new Mesh(buildVortex(), this.headset));
    this.mesh.visible = false;
    parent.add(this.mesh);
    this.mesh.updateMatrixWorld(true);
    // One degenerate triangle through stretch mode, so the program compiles before the first fist.
    const speck = new BufferGeometry();
    speck.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
    const band = new Float32Array(9);
    band[1] = -1;
    band[4] = -1;
    band[7] = -1;
    speck.setAttribute('aVortex', new BufferAttribute(band, 3));
    this.warmer = this.mount(new Mesh(speck, this.headset));
    this.warmer.visible = false;
    parent.add(this.warmer);
    this.warmer.updateMatrixWorld(true);
  }

  /** Draw the compile speck. The real nozzle is placed separately. */
  warm(on: boolean): void {
    this.warmer.visible = on;
  }

  /**
   * `show` with `suck` above a whisper draws the nozzle at `hole`, aimed along `aim` (unit length).
   * `preview` picks the desk program.
   */
  place(show: boolean, suck: number, hole: Vector3, aim: Vector3, time: number, preview: boolean): void {
    if (preview !== this.previewMode) {
      this.previewMode = preview;
      const material = preview ? this.previewMat : this.headset;
      this.mesh.material = material;
      this.warmer.material = material;
    }
    const material = this.mesh.material as ShaderMaterial;
    material.uniforms.uSuck.value = suck;
    material.uniforms.uTime.value = time;
    const draw = show && suck > 0.01 && aim.lengthSq() > 1e-8;
    this.mesh.visible = draw;
    if (!draw) return;
    this.mesh.position.copy(hole);
    this.mesh.quaternion.setFromUnitVectors(AIM, aim);
    this.mesh.updateMatrix();
  }

  hide(): void {
    this.mesh.visible = false;
    this.warmer.visible = false;
  }

  dispose(): void {
    this.hide();
    this.mesh.removeFromParent();
    this.warmer.removeFromParent();
    this.mesh.geometry.dispose();
    this.warmer.geometry.dispose();
    this.headset.dispose();
    this.previewMat.dispose();
  }

  private mount(mesh: Mesh): Mesh {
    mesh.frustumCulled = false;
    mesh.renderOrder = ORDER;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }
}

/** A ring in the local XY plane. The mesh is aimed so the ring faces along the fist. */
function buildVortex(): BufferGeometry {
  const positions: number[] = [];
  const vortex: number[] = [];
  const indices: number[] = [];
  const ring = (radius: number, angle: number): void => {
    positions.push(Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
    vortex.push(0, -1, radius > 0.04 ? 1 : 0);
  };
  for (let i = 0; i <= RING_SEG; i++) {
    const angle = ((i % RING_SEG) / RING_SEG) * Math.PI * 2;
    ring(0.038, angle);
    ring(0.044, angle);
  }
  for (let i = 0; i < RING_SEG; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('aVortex', new BufferAttribute(new Float32Array(vortex), 3));
  geometry.setIndex(indices);
  return geometry;
}
