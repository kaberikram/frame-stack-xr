import { ExternalTexture, Matrix4, Vector2, type WebGLRenderer } from '@iwsdk/core';

/** Quest adds validity and the depth range the texture was rendered with. */
interface GpuDepth extends XRWebGLDepthInformation {
  readonly isValid?: boolean;
  readonly depthNear?: number;
  readonly depthFar?: number;
}

interface DepthBinding {
  getDepthInformation?(view: XRView): GpuDepth | null | undefined;
}

/**
 * The headset's depth of the real room, for cutting the real hands and arms out of a stretch.
 * Quest gives it as a GPU texture array, one layer per eye, aligned with the views. three.js would
 * also draw it as a full-screen occluder that z-fights the scanned room against raw depth, so that
 * mesh is hidden every frame and the texture is read in the stretch shader instead.
 */
export class EnvDepth {
  /** True while this frame has a depth texture bound. */
  on = false;
  readonly texture = new ExternalTexture();
  rawToMeters = 1;
  near = 0;
  /** Pixels per eye in the XR framebuffer, for turning gl_FragCoord into a view uv. */
  readonly eyeSize = new Vector2(1, 1);
  /** Each eye's normDepthBufferFromNormView: view uv into depth uv. */
  readonly normDepth = [new Matrix4(), new Matrix4()];
  /**
   * Each eye's pose in the XR reference space and its projection, from this frame's viewer pose: the
   * views the depth layers were taken from. The posed XR cameras still hold last frame's until render.
   */
  readonly viewPose = [new Matrix4(), new Matrix4()];
  readonly viewProjection = [new Matrix4(), new Matrix4()];
  private logged = false;

  /** Call once per frame, before the stretch draws. */
  sync(renderer: WebGLRenderer, frame: XRFrame | null, session: XRSession | null): void {
    this.on = false;
    const xr = renderer.xr;
    const mesh = xr.isPresenting ? xr.getDepthSensingMesh() : null;
    if (mesh && mesh.visible) mesh.visible = false;
    if (!frame || !session || session.depthUsage !== 'gpu-optimized') return;
    const ref = xr.getReferenceSpace();
    const pose = ref ? frame.getViewerPose(ref) : null;
    if (!pose || pose.views.length === 0) return;
    const binding = xr.getBinding() as unknown as DepthBinding | null;
    const views = pose.views;
    for (let i = 0; i < Math.min(2, views.length); i++) {
      const depth = binding?.getDepthInformation?.(views[i]);
      if (!depth || depth.isValid === false || !depth.texture) return;
      if (i === 0) {
        this.texture.sourceTexture = depth.texture;
        this.rawToMeters = depth.rawValueToMeters || 1;
        this.near = depth.depthNear ?? 0;
      }
      const ndb = depth.normDepthBufferFromNormView?.matrix;
      if (ndb) this.normDepth[i].fromArray(ndb);
      else this.normDepth[i].identity();
      this.viewPose[i].fromArray(views[i].transform.matrix);
      this.viewProjection[i].fromArray(views[i].projectionMatrix);
      if (!this.logged && i === Math.min(2, views.length) - 1) this.log(xr.getCamera(), session, depth, views.length);
    }
    if (views.length === 1) this.normDepth[1].copy(this.normDepth[0]);
    const viewport = xr.getCamera().cameras[0]?.viewport;
    if (viewport && viewport.z > 0 && viewport.w > 0) this.eyeSize.set(viewport.z, viewport.w);
    this.on = this.near > 0;
  }

  /** A new session logs its depth line again. */
  reset(): void {
    this.on = false;
    this.logged = false;
  }

  private log(camera: { near: number; far: number }, session: XRSession, depth: GpuDepth, views: number): void {
    this.logged = true;
    const identity = this.normDepth[0].equals(IDENTITY) && (views < 2 || this.normDepth[1].equals(IDENTITY));
    const own = depth.transform && depth.projectionMatrix ? ' own-pose' : '';
    console.info(
      `[jonze] depth ${session.depthUsage} ${session.depthDataFormat ?? '?'} ${depth.width}x${depth.height} ` +
        `near=${(depth.depthNear ?? 0).toFixed(3)} raw=${depth.rawValueToMeters} ndb=${identity ? 'identity' : 'NOT'}${own} ` +
        `xr near/far ${camera.near.toFixed(3)}/${camera.far.toFixed(1)}`,
    );
  }
}

const IDENTITY = new Matrix4();
