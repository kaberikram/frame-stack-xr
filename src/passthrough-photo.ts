import {
  ArrayCamera,
  CanvasTexture,
  ClampToEdgeWrapping,
  ExternalTexture,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from '@iwsdk/core';

export type CameraMount = 'left' | 'right' | 'center' | 'view';

/** Where the passthrough camera sits, in the parent camera's local space. Pitch is radians, negative looks down. */
interface Mount {
  x: number;
  y: number;
  z: number;
  pitch: number;
}

// Quest 3's getUserMedia passthrough image behaves like ~77° horizontal FOV at 1280×720
// (fx ≈ fy ≈ 800). camera-access is still rejected by Quest Browser, so the pose is the
// published offset of that camera from the right eye: a few centimetres toward center,
// up, and forward, pitched down toward the hands. Other mounts mirror that.
const RIGHT: Mount = { x: -0.032, y: 0.02, z: -0.025, pitch: -0.26 };
const LEFT: Mount = { x: 0.032, y: 0.02, z: -0.025, pitch: -0.26 };
const CENTER: Mount = { x: 0, y: 0.02, z: -0.025, pitch: -0.26 };
const REF_W = 1280;
const REF_H = 720;
const REF_F = 800;

interface XRCameraImage {
  width: number;
  height: number;
}

interface CameraView extends XRView {
  camera?: XRCameraImage;
}

interface CameraBinding extends XRWebGLBinding {
  getCameraImage?: (camera: XRCameraImage) => WebGLTexture | null;
}

export interface PhotoCapture {
  renderer: WebGLRenderer;
  presenting: boolean;
  frame: XRFrame | null;
  refSpace: XRReferenceSpace | null;
  objectWorld: Matrix4;
  center: Vector3;
  video: HTMLVideoElement | null;
  track: MediaStreamTrack | null;
  mount: CameraMount;
  viewCamera: PerspectiveCamera;
}

/** Which visor camera a device label is talking about. A webcam stays `view`. */
export function cameraMount(label: string, facing: 'back' | 'front' | 'unknown'): CameraMount {
  const text = label.toLowerCase();
  const back = facing === 'back' || /back|environment|rear/.test(text);
  if (!back) return 'view';
  if (/left/.test(text) || /camera\D*1\b/.test(text)) return 'left';
  if (/right/.test(text) || /camera\D*2\b/.test(text)) return 'right';
  return 'center';
}

/**
 * Freezes one camera frame and the projection that mapped it onto the object.
 * On a headset the frame is the passthrough camera. On a desk it is the webcam,
 * projected through the preview camera so the smear is still made of real pixels.
 */
export class PassthroughPhoto {
  readonly meshToClip = new Matrix4();
  /** World-space points into the live camera's clip space. Updated by `projectLive`, not by a frozen capture. */
  readonly worldToClip = new Matrix4();
  readonly liveCam = new Vector3();
  /** Frozen snapshot, world space. A second grab reuses whatever the first one stored. */
  readonly frozenToClip = new Matrix4();
  readonly frozenCam = new Vector3();
  readonly camMesh = new Vector3();
  ready = false;

  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly canvasTex: CanvasTexture;
  private readonly cleanCanvas = document.createElement('canvas');
  private readonly cleanCtx: CanvasRenderingContext2D;
  private readonly cleanTex: CanvasTexture;
  private readonly cleanToClip = new Matrix4();
  private readonly cleanCam = new Vector3();
  private cleanAt = -Infinity;
  private cleanReady = false;
  private frozenIsClean = false;
  private readonly rt: WebGLRenderTarget;
  private readonly blitScene = new Scene();
  private readonly blitCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly blitMat: MeshBasicMaterial;
  private readonly external: ExternalTexture;
  private showingRT = false;
  private xrImages: boolean | null = null;

  private readonly offset = new Matrix4();
  private readonly camWorld = new Matrix4();
  private readonly projection = new Matrix4();
  private readonly view = new Matrix4();
  private readonly vp = new Matrix4();
  private readonly centerT = new Matrix4();
  private readonly meshFromWorld = new Matrix4();
  private readonly camPos = new Vector3();
  private readonly lensOffset = new Vector3();

  private lensW = 0;
  private lensH = 0;
  private lensTrack: MediaStreamTrack | null = null;
  private lensFx = REF_F;
  private lensFy = REF_F;
  private lensCx = REF_W / 2;
  private lensCy = REF_H / 2;
  private lensHasOffset = false;
  private lensPitch: number | null = null;

  constructor() {
    this.canvas.width = 2;
    this.canvas.height = 2;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is unavailable');
    this.ctx = ctx;
    this.canvasTex = new CanvasTexture(this.canvas);
    this.canvasTex.colorSpace = SRGBColorSpace;
    this.canvasTex.minFilter = LinearFilter;
    this.canvasTex.magFilter = LinearFilter;
    this.canvasTex.generateMipmaps = false;
    this.canvasTex.wrapS = ClampToEdgeWrapping;
    this.canvasTex.wrapT = ClampToEdgeWrapping;
    this.cleanCanvas.width = 2;
    this.cleanCanvas.height = 2;
    const cleanCtx = this.cleanCanvas.getContext('2d');
    if (!cleanCtx) throw new Error('2D canvas is unavailable');
    this.cleanCtx = cleanCtx;
    this.cleanTex = new CanvasTexture(this.cleanCanvas);
    this.cleanTex.colorSpace = SRGBColorSpace;
    this.cleanTex.minFilter = LinearFilter;
    this.cleanTex.magFilter = LinearFilter;
    this.cleanTex.generateMipmaps = false;
    this.cleanTex.wrapS = ClampToEdgeWrapping;
    this.cleanTex.wrapT = ClampToEdgeWrapping;
    this.rt = new WebGLRenderTarget(4, 4, { depthBuffer: false, stencilBuffer: false });
    this.rt.texture.colorSpace = SRGBColorSpace;
    this.rt.texture.minFilter = LinearFilter;
    this.rt.texture.magFilter = LinearFilter;
    this.rt.texture.generateMipmaps = false;
    this.blitMat = new MeshBasicMaterial({ map: this.canvasTex, toneMapped: false });
    this.blitScene.add(new Mesh(new PlaneGeometry(2, 2), this.blitMat));
    this.external = new ExternalTexture(null);
  }

  get texture(): Texture {
    return this.showingRT ? this.rt.texture : this.canvasTex;
  }

  /** The snapshot a grab is showing. The clean frame when hands were out of view, otherwise the pinch frame. */
  get frozenTexture(): Texture {
    return this.frozenIsClean ? this.cleanTex : this.texture;
  }

  invalidate(): void {
    this.ready = false;
  }

  /**
   * Updates `worldToClip` for the camera that is playing right now.
   * Leaves the frozen snapshot alone, so a pinch and this overlay can share one photo helper.
   */
  projectLive(req: Omit<PhotoCapture, 'objectWorld' | 'center'>): boolean {
    const video = req.video;
    if (!video || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return false;
    if (req.presenting) this.fitLens(req, video.videoWidth, video.videoHeight);
    else this.fitView(req.viewCamera);
    this.worldToClip.copy(this.vp);
    this.liveCam.copy(this.camPos);
    return true;
  }

  /** True when any joint lands inside the live camera, so that frame would smear a hand onto the room. */
  jointsInFrame(points: ArrayLike<number>, count: number): boolean {
    for (let i = 0; i < count; i++) {
      if (this.contains(points[i * 3], points[i * 3 + 1], points[i * 3 + 2], this.worldToClip)) return true;
    }
    return false;
  }

  /**
   * Keeps one spare frame from a moment when the hands were out of the camera.
   * Call after `projectLive`. `allow` is false while a joint is inside the frame.
   */
  keepClean(video: HTMLVideoElement | null, allow: boolean): void {
    if (!allow || !video) return;
    const now = performance.now() / 1000;
    if (this.cleanReady && now - this.cleanAt < 0.25) return;
    if (!this.drawInto(this.cleanCanvas, this.cleanCtx, this.cleanTex, video)) return;
    this.cleanToClip.copy(this.worldToClip);
    this.cleanCam.copy(this.camPos);
    this.cleanAt = now;
    this.cleanReady = true;
  }

  /**
   * Freezes a world-space snapshot for a grab at `point`.
   * Uses the spare frame when it is recent and contains the point, so raised hands
   * are not painted onto the table. `reuse` keeps the snapshot the other hand already took.
   */
  freezeWorld(video: HTMLVideoElement | null, point: Vector3 | null, reuse: boolean): boolean {
    if (reuse && this.ready) return true;
    const now = performance.now() / 1000;
    if (
      this.cleanReady &&
      now - this.cleanAt < 2 &&
      point &&
      this.contains(point.x, point.y, point.z, this.cleanToClip)
    ) {
      this.frozenIsClean = true;
      this.frozenToClip.copy(this.cleanToClip);
      this.frozenCam.copy(this.cleanCam);
      this.showingRT = false;
      this.ready = true;
      return true;
    }
    if (!video || !this.drawInto(this.canvas, this.ctx, this.canvasTex, video)) return false;
    this.frozenIsClean = false;
    this.frozenToClip.copy(this.worldToClip);
    this.frozenCam.copy(this.camPos);
    this.showingRT = false;
    this.ready = true;
    return true;
  }

  /** Copies the current frame and bakes object-local points into that frame's clip space. */
  capture(req: PhotoCapture): boolean {
    if (req.video && this.drawVideo(req.video)) {
      if (req.presenting) this.fitQuest(req);
      else this.fitView(req.viewCamera);
      this.finish(req.objectWorld, req.center);
      this.showingRT = false;
      this.ready = true;
      return true;
    }
    return this.tryXR(req);
  }

  dispose(): void {
    this.canvasTex.dispose();
    this.cleanTex.dispose();
    this.rt.dispose();
    this.blitMat.dispose();
    this.blitScene.traverse((object) => {
      const mesh = object as Mesh;
      mesh.geometry?.dispose();
    });
  }

  private drawVideo(video: HTMLVideoElement): boolean {
    return this.drawInto(this.canvas, this.ctx, this.canvasTex, video);
  }

  private drawInto(
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    tex: CanvasTexture,
    video: HTMLVideoElement,
  ): boolean {
    if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return false;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.drawImage(video, 0, 0, w, h);
    tex.needsUpdate = true;
    return true;
  }

  private contains(x: number, y: number, z: number, clip: Matrix4): boolean {
    const e = clip.elements;
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (w <= 1e-4) return false;
    const u = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w) * 0.5 + 0.5;
    const v = ((e[1] * x + e[5] * y + e[9] * z + e[13]) / w) * 0.5 + 0.5;
    return u > 0.02 && u < 0.98 && v > 0.02 && v < 0.98;
  }

  private fitView(cam: PerspectiveCamera): void {
    cam.updateMatrixWorld();
    this.vp.copy(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
    this.camPos.setFromMatrixPosition(cam.matrixWorld);
  }

  private fitQuest(req: PhotoCapture): void {
    this.fitLens(req, this.canvas.width, this.canvas.height);
  }

  private fitLens(req: Omit<PhotoCapture, 'objectWorld' | 'center'>, w: number, h: number): void {
    this.readLens(req.track, w, h);
    const xrCam = req.renderer.xr.getCamera() as ArrayCamera;
    xrCam.updateMatrixWorld(true);
    const eyes = xrCam.cameras;
    const mount = req.mount === 'view' ? 'center' : req.mount;
    if (this.lensHasOffset) {
      this.place(xrCam, this.lensOffset.x, this.lensOffset.y, this.lensOffset.z, this.lensPitch ?? CENTER.pitch);
    } else if (mount === 'left' && eyes[0]) {
      this.place(eyes[0], LEFT.x, LEFT.y, LEFT.z, LEFT.pitch);
    } else if (mount === 'right' && eyes.length) {
      this.place(eyes[eyes.length - 1], RIGHT.x, RIGHT.y, RIGHT.z, RIGHT.pitch);
    } else {
      this.place(xrCam, CENTER.x, CENTER.y, CENTER.z, CENTER.pitch);
    }
    writeProjection(this.projection, this.lensFx, this.lensFy, this.lensCx, this.lensCy, w, h);
    this.view.copy(this.camWorld).invert();
    this.vp.copy(this.projection).multiply(this.view);
    this.camPos.setFromMatrixPosition(this.camWorld);
  }

  private place(parent: Object3D, x: number, y: number, z: number, pitch: number): void {
    this.offset.makeRotationX(pitch);
    this.offset.setPosition(x, y, z);
    parent.updateWorldMatrix(true, false);
    this.camWorld.copy(parent.matrixWorld).multiply(this.offset);
  }

  private finish(objectWorld: Matrix4, center: Vector3): void {
    this.centerT.makeTranslation(center.x, center.y, center.z);
    this.meshToClip.copy(this.vp).multiply(objectWorld).multiply(this.centerT);
    this.meshFromWorld.copy(objectWorld).multiply(this.centerT).invert();
    this.camMesh.copy(this.camPos).applyMatrix4(this.meshFromWorld);
  }

  /** Raw camera access, when the browser actually has it. The image belongs to that eye. */
  private tryXR(req: PhotoCapture): boolean {
    if (this.xrImages === false || !req.presenting || !req.frame || !req.refSpace) return false;
    const binding = req.renderer.xr.getBinding() as CameraBinding | null;
    if (!binding?.getCameraImage) {
      this.xrImages = false;
      return false;
    }
    const pose = req.frame.getViewerPose(req.refSpace);
    if (!pose) return false;
    for (const view of pose.views) {
      const camera = (view as CameraView).camera;
      if (!camera) continue;
      const tex = binding.getCameraImage(camera);
      if (!tex) continue;
      this.blit(req.renderer, tex, camera.width, camera.height);
      this.fitEye(req.renderer, view.eye);
      this.finish(req.objectWorld, req.center);
      this.showingRT = true;
      this.ready = true;
      this.xrImages = true;
      return true;
    }
    return false;
  }

  private fitEye(renderer: WebGLRenderer, eye: XREye): void {
    const xrCam = renderer.xr.getCamera() as ArrayCamera;
    xrCam.updateMatrixWorld(true);
    const eyes = xrCam.cameras;
    const cam = eye === 'left' ? eyes[0] : eyes[eyes.length - 1] ?? eyes[0];
    if (!cam) {
      this.fitView(xrCam as unknown as PerspectiveCamera);
      return;
    }
    this.vp.copy(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
    this.camPos.setFromMatrixPosition(cam.matrixWorld);
  }

  private blit(renderer: WebGLRenderer, tex: WebGLTexture, w: number, h: number): void {
    this.external.sourceTexture = tex;
    if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h);
    this.blitMat.map = this.external;
    const prev = renderer.getRenderTarget();
    const xrOn = renderer.xr.enabled;
    renderer.xr.enabled = false;
    try {
      renderer.setRenderTarget(this.rt);
      renderer.clear();
      renderer.render(this.blitScene, this.blitCam);
    } finally {
      renderer.setRenderTarget(prev);
      renderer.xr.enabled = xrOn;
    }
  }

  /** Intrinsics from the track when the browser reports them, otherwise the Quest 3 estimate scaled to this frame. */
  private readLens(track: MediaStreamTrack | null, w: number, h: number): void {
    if (this.lensTrack === track && this.lensW === w && this.lensH === h) return;
    this.lensTrack = track;
    this.lensW = w;
    this.lensH = h;
    this.lensFx = REF_F * (w / REF_W);
    this.lensFy = REF_F * (h / REF_H);
    this.lensCx = w * 0.5;
    this.lensCy = h * 0.5;
    this.lensHasOffset = false;
    this.lensPitch = null;
    if (!track) return;
    let settings: Record<string, unknown>;
    try {
      settings = track.getSettings() as Record<string, unknown>;
    } catch {
      return;
    }
    const sw = typeof settings.width === 'number' && settings.width > 0 ? settings.width : w;
    const sh = typeof settings.height === 'number' && settings.height > 0 ? settings.height : h;
    let fx: number | null = null;
    let fy: number | null = null;
    let cx: number | null = null;
    let cy: number | null = null;
    for (const [raw, value] of Object.entries(settings)) {
      const key = raw.toLowerCase();
      if (key.includes('intrinsic') && Array.isArray(value) && value.length >= 9) {
        const mfx = num(value[0]);
        const mfy = num(value[4]);
        const mcx = num(value[2]);
        const mcy = num(value[5]);
        if (mfx !== null && mfy !== null && mfx > 50 && mfy > 50) {
          fx = mfx;
          fy = mfy;
          cx = mcx;
          cy = mcy;
        }
      }
      if (key.includes('focal')) {
        const pair = xy(value);
        if (pair && pair.x > 50 && pair.y > 50) {
          fx = pair.x;
          fy = pair.y;
        } else {
          const n = num(value);
          if (n !== null && n > 50 && n < 8000) fx = fy = n;
        }
      }
      if (key.includes('principal')) {
        const pair = xy(value);
        if (!pair) continue;
        cx = pair.x <= 2 ? pair.x * sw : pair.x;
        cy = pair.y <= 2 ? pair.y * sh : pair.y;
      }
      if (key.includes('position') || key.includes('translation') || key.includes('lenspose') || key.includes('extrinsic')) {
        const p = xyz(value);
        if (!p || Math.hypot(p.x, p.y, p.z) > 0.5) continue;
        this.lensOffset.set(p.x, p.y, p.z);
        this.lensHasOffset = true;
      }
    }
    if (fx === null || fy === null) return;
    this.lensFx = fx * (w / sw);
    this.lensFy = fy * (h / sh);
    if (cx !== null) this.lensCx = cx * (w / sw);
    if (cy !== null) this.lensCy = cy * (h / sh);
  }
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function xy(value: unknown): { x: number; y: number } | null {
  if (Array.isArray(value) && value.length >= 2) {
    const x = num(value[0]);
    const y = num(value[1]);
    if (x !== null && y !== null) return { x, y };
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const x = num(o.x);
    const y = num(o.y);
    if (x !== null && y !== null) return { x, y };
  }
  return null;
}

function xyz(value: unknown): { x: number; y: number; z: number } | null {
  if (Array.isArray(value) && value.length >= 3) {
    const x = num(value[0]);
    const y = num(value[1]);
    const z = num(value[2]);
    if (x !== null && y !== null && z !== null) return { x, y, z };
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const x = num(o.x);
    const y = num(o.y);
    const z = num(o.z);
    if (x !== null && y !== null && z !== null) return { x, y, z };
  }
  return null;
}

/** OpenGL projection from pixel intrinsics. x right, y up, camera looking down -Z. */
function writeProjection(target: Matrix4, fx: number, fy: number, cx: number, cy: number, width: number, height: number): void {
  const near = 0.05;
  const far = 40;
  const x = (2 * fx) / width;
  const y = (2 * fy) / height;
  const a = 1 - (2 * cx) / width;
  const b = (2 * cy) / height - 1;
  const c = -(far + near) / (far - near);
  const d = -(2 * far * near) / (far - near);
  target.set(x, 0, a, 0, 0, y, b, 0, 0, 0, c, d, 0, 0, -1, 0);
}
