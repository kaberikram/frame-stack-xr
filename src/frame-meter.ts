import type { Scene, WebGLRenderer } from '@iwsdk/core';

/** Frames kept for the rate and the 95th percentile. */
const FRAMES = 120;
/** Seconds between readouts. */
const REPORT_GAP = 1;
/** Timer queries in flight: results arrive a few frames late. */
const QUERIES = 4;

interface TimerQuery {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

const enum Slot {
  Free,
  Running,
  Waiting,
}

/**
 * Frame timing for the console header, about once a second: frame rate and 95th-percentile frame
 * time, the stretch system's own update (mean/max), three's render call on the CPU, GPU time per
 * frame where the browser exposes timer queries, the draw calls and triangles of the last frame, and
 * how many room chunks drew with the stretch program. Allocates nothing per frame.
 */
export class FrameMeter {
  private readonly dts = new Float32Array(FRAMES);
  private readonly sorted = new Float32Array(FRAMES);
  private filled = 0;
  private next = 0;
  private updSum = 0;
  private updMax = 0;
  private updN = 0;
  private renderStart = 0;
  private renderSum = 0;
  private renderN = 0;
  private gpuSum = 0;
  private gpuN = 0;
  private roomMax = -1;
  /** The main render's draw calls and triangles, taken as it ends: other passes reset renderer.info. */
  private calls = 0;
  private triangles = 0;
  private reportAt = 0;
  private readonly gl: WebGL2RenderingContext | null;
  private readonly timer: TimerQuery | null;
  private readonly queries: WebGLQuery[] = [];
  private readonly state = new Uint8Array(QUERIES);
  private running = -1;
  private readonly before: Scene['onBeforeRender'];
  private readonly after: Scene['onAfterRender'];

  constructor(private readonly renderer: WebGLRenderer, private readonly scene: Scene) {
    const gl = renderer.getContext();
    this.gl = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? gl : null;
    this.timer = (this.gl?.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQuery | null) ?? null;
    if (this.gl && this.timer) {
      for (let i = 0; i < QUERIES; i++) {
        const query = this.gl.createQuery();
        if (query) this.queries.push(query);
      }
    }
    this.before = scene.onBeforeRender;
    this.after = scene.onAfterRender;
    const meter = this;
    scene.onBeforeRender = function (...args) {
      meter.renderStart = performance.now();
      meter.before.apply(this, args);
    };
    scene.onAfterRender = function (...args) {
      meter.after.apply(this, args);
      meter.calls = renderer.info.render.calls;
      meter.triangles = renderer.info.render.triangles;
      if (meter.renderStart > 0) {
        meter.renderSum += performance.now() - meter.renderStart;
        meter.renderN++;
      }
    };
  }

  /**
   * Call once a frame while presenting. `room` is how many chunks drew with the stretch program this
   * frame, or -1 when the room is not drawn. Returns a new readout about once a second, else ''.
   */
  frame(dt: number, updateMs: number, room: number, chunks: number, now: number): string {
    this.dts[this.next] = dt * 1000;
    this.next = (this.next + 1) % FRAMES;
    if (this.filled < FRAMES) this.filled++;
    this.updSum += updateMs;
    this.updN++;
    if (updateMs > this.updMax) this.updMax = updateMs;
    if (room > this.roomMax) this.roomMax = room;
    this.pollGpu();
    if (now - this.reportAt < REPORT_GAP) return '';
    this.reportAt = now;
    return this.report(chunks);
  }

  /** Call on frames that are not measured, so no timer query is left running across a pause. */
  idle(): void {
    if (this.running >= 0 && this.gl && this.timer) {
      this.gl.endQuery(this.timer.TIME_ELAPSED_EXT);
      this.state[this.running] = Slot.Free;
      this.running = -1;
    }
  }

  dispose(): void {
    this.idle();
    this.scene.onBeforeRender = this.before;
    this.scene.onAfterRender = this.after;
    for (let i = 0; i < this.queries.length; i++) this.gl?.deleteQuery(this.queries[i]);
    this.queries.length = 0;
  }

  /** Ends the query begun last frame (it covered that frame's render), reads finished ones, begins another. */
  private pollGpu(): void {
    const gl = this.gl;
    const timer = this.timer;
    if (!gl || !timer || this.queries.length === 0) return;
    if (this.running >= 0) {
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      this.state[this.running] = Slot.Waiting;
      this.running = -1;
    }
    const disjoint = gl.getParameter(timer.GPU_DISJOINT_EXT) as boolean;
    let free = -1;
    for (let i = 0; i < this.queries.length; i++) {
      if (this.state[i] === Slot.Waiting && gl.getQueryParameter(this.queries[i], gl.QUERY_RESULT_AVAILABLE)) {
        if (!disjoint) {
          this.gpuSum += (gl.getQueryParameter(this.queries[i], gl.QUERY_RESULT) as number) / 1e6;
          this.gpuN++;
        }
        this.state[i] = Slot.Free;
      }
      if (this.state[i] === Slot.Free && free < 0) free = i;
    }
    if (free >= 0) {
      gl.beginQuery(timer.TIME_ELAPSED_EXT, this.queries[free]);
      this.state[free] = Slot.Running;
      this.running = free;
    }
  }

  private report(chunks: number): string {
    const n = this.filled;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      this.sorted[i] = this.dts[i];
      sum += this.dts[i];
    }
    const recent = this.sorted.subarray(0, n);
    recent.sort();
    const p95 = recent[Math.min(n - 1, Math.floor(n * 0.95))];
    const fps = sum > 0 ? (n * 1000) / sum : 0;
    const upd = this.updN > 0 ? this.updSum / this.updN : 0;
    const render = this.renderN > 0 ? this.renderSum / this.renderN : 0;
    const gpu = this.gpuN > 0 ? (this.gpuSum / this.gpuN).toFixed(1) : this.timer ? '…' : 'n/a';
    const room = this.roomMax >= 0 ? `${this.roomMax}/${chunks}` : `-/${chunks}`;
    const text =
      `${fps.toFixed(0)}fps p95 ${p95.toFixed(0)} js ${upd.toFixed(1)}/${this.updMax.toFixed(0)} ` +
      `cpu ${render.toFixed(1)} gpu ${gpu} ${this.calls}dc ${(this.triangles / 1000).toFixed(0)}k room ${room}`;
    this.updSum = 0;
    this.updMax = 0;
    this.updN = 0;
    this.renderSum = 0;
    this.renderN = 0;
    this.gpuSum = 0;
    this.gpuN = 0;
    this.roomMax = -1;
    return text;
  }
}
