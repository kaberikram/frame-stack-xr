import {
  DoubleSide,
  LinearFilter,
  Matrix4,
  Mesh,
  ShaderMaterial,
  SRGBColorSpace,
  VideoTexture,
  type Material,
  type Object3D,
} from '@iwsdk/core';
import { PassthroughPhoto, type PhotoCapture } from './passthrough-photo.js';

export interface RoomMeshStats {
  meshes: number;
  triangles: number;
  hasPhoto: boolean;
}

/**
 * Draws the scanned room triangles with the live camera, shifted cooler than the
 * passthrough behind them. The mesh is what Space Setup built. Flat plane boxes stay hidden.
 */
export class RoomMeshOverlay {
  private readonly worldToClip = new Matrix4();
  private readonly mat: ShaderMaterial;
  private readonly saved = new Map<Mesh, Material | Material[]>();
  private video: HTMLVideoElement | null = null;
  private videoTex: VideoTexture | null = null;

  constructor(private readonly photo: PassthroughPhoto) {
    this.mat = new ShaderMaterial({
      uniforms: {
        uPhoto: { value: null },
        uWorldToClip: { value: this.worldToClip },
        uHasPhoto: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uPhoto;
        uniform mat4 uWorldToClip;
        uniform float uHasPhoto;
        varying vec3 vWorld;
        void main() {
          vec4 clip = uWorldToClip * vec4(vWorld, 1.0);
          vec2 uv = clip.xy / max(clip.w, 1e-4) * 0.5 + 0.5;
          float inFrame = step(1e-4, clip.w);
          if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) inFrame = 0.0;
          vec3 src = texture(uPhoto, uv).rgb;
          vec3 tinted = vec3(src.r * 0.72, src.g * 0.94, min(1.0, src.b * 1.16 + 0.05));
          vec3 bare = vec3(0.35, 0.62, 0.82);
          float covered = uHasPhoto * inFrame;
          gl_FragColor = vec4(mix(bare, tinted, covered), mix(0.38, 0.9, covered));
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: DoubleSide,
      toneMapped: false,
    });
  }

  show(
    entities: Iterable<{ object3D?: Object3D | null }>,
    req: Omit<PhotoCapture, 'objectWorld' | 'center'>,
  ): RoomMeshStats {
    const hasPhoto = this.photo.projectLive(req);
    this.attachVideo(req.video);
    this.worldToClip.copy(this.photo.worldToClip);
    this.mat.uniforms.uHasPhoto.value = hasPhoto ? 1 : 0;

    for (const [mesh] of this.saved) {
      if (!mesh.parent) this.saved.delete(mesh);
    }

    let meshes = 0;
    let triangles = 0;
    for (const entity of entities) {
      const mesh = entity.object3D as Mesh | null;
      if (!mesh?.isMesh || !mesh.geometry?.getAttribute('position')) continue;
      if (!this.saved.has(mesh)) this.saved.set(mesh, mesh.material);
      mesh.material = this.mat;
      mesh.visible = true;
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      meshes += 1;
      const index = mesh.geometry.getIndex();
      const positions = mesh.geometry.getAttribute('position').count;
      triangles += index ? Math.floor(index.count / 3) : Math.floor(positions / 3);
    }
    return { meshes, triangles, hasPhoto };
  }

  hide(): void {
    for (const [mesh, material] of this.saved) {
      if (mesh.material === this.mat) mesh.material = material;
      mesh.visible = false;
    }
    this.saved.clear();
    this.mat.uniforms.uHasPhoto.value = 0;
  }

  dispose(): void {
    this.hide();
    this.videoTex?.dispose();
    this.videoTex = null;
    this.video = null;
    this.mat.dispose();
  }

  private attachVideo(video: HTMLVideoElement | null): void {
    if (!video || video === this.video) return;
    this.videoTex?.dispose();
    const tex = new VideoTexture(video);
    tex.colorSpace = SRGBColorSpace;
    tex.minFilter = LinearFilter;
    tex.magFilter = LinearFilter;
    tex.generateMipmaps = false;
    this.video = video;
    this.videoTex = tex;
    this.mat.uniforms.uPhoto.value = tex;
  }
}
