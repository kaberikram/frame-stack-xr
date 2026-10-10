/**
 * In-headset console. In an immersive session the page and its console are invisible, so console
 * output is mirrored onto a small panel at the upper left of view, and onto a corner of the 2D page
 * outside a session.
 *
 * `installDebugConsole()` runs once from index.ts, before World.create. It wraps console.log, info,
 * warn and error (the real console still gets every call, unchanged) and listens for window `error`
 * and `unhandledrejection`. Three reports shader compile errors through console.error; they are
 * condensed to the failing GLSL line. `DebugConsoleSystem` draws the panel in both modes.
 *
 * `?debug=1` always shows it; `?debug=0` turns all of it off. With neither it shows on the dev server
 * (how the headset loads the app), and in a production build only once an error arrives.
 * `[jonze] ` lines drop the prefix and draw cyan; warnings are yellow, errors red.
 */
import {
  CanvasTexture,
  Euler,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  createSystem,
  type Entity,
} from '@iwsdk/core';
import { PREVIEW_FORCED, getMode } from './experience.js';
import { INK, MONO, makeCanvas, type Canvas2D } from './labels.js';

/**
 * Shown on the first line with the page-load time, and in the panel header: the commit this build
 * came from, so a headset recording proves which deploy was live and a cached page can't pass for a new one.
 */
const BUILD_TAG = `jonze-${__BUILD_SHA__}`;

const ROWS = 16;
/** Longer lines end in an ellipsis. Up to this many still fit a row, slightly condensed. */
const MAX_CHARS = 72;
const TAG = '[jonze] ';
/** Seconds between repaints: at most 4 canvas uploads a second, and none unless a line arrived. */
const PAINT_GAP = 0.25;
/** A line that keeps repeating repaints its counter at most this often. */
const REPEAT_GAP = 1;
/** Past this many lines in one second, non-errors are only counted, so a log flood can't eat frames. */
const FLOOD_LIMIT = 60;
/** The panel dims after this many seconds without a new line. */
const IDLE_DIM = 20;
const DIM_OPACITY = 0.4;
/** How fast the panel turns after the head, 1/s. Position follows the head exactly. */
const FOLLOW = 8;
/** Panel centre: this far from the eyes, this far left of and above where you look, clear of the hands. */
const DISTANCE = 0.7;
const YAW = (20 * Math.PI) / 180;
const PITCH = (18 * Math.PI) / 180;
const PANEL_W = 0.42;
const CANVAS_W = 1024;
const CANVAS_H = 600;
const PAD = 14;
const HEADER_H = 44;
const ROW_H = (CANVAS_H - HEADER_H - PAD) / ROWS;
const TIME_W = 80;
const REPEAT_W = 70;
const FONT_HEADER = `600 22px ${MONO}`;
const FONT_TIME = `400 18px ${MONO}`;
const FONT_TEXT = `500 24px ${MONO}`;
const PANEL_FILL = 'rgba(8, 10, 14, 0.74)';

const enum Level {
  Log,
  Info,
  Warn,
  Error,
}
const COLORS: readonly string[] = ['#AEB4C2', '#E5E8EE', '#FFD34D', '#FF6B5B'];
const TAGGED = '#8FD8FF';

type Method = 'log' | 'info' | 'warn' | 'error';
type ConsoleFn = (...data: unknown[]) => void;
const METHODS: readonly Method[] = ['log', 'info', 'warn', 'error'];
const LEVELS: Readonly<Record<Method, Level>> = { log: Level.Log, info: Level.Info, warn: Level.Warn, error: Level.Error };

const FORMAT = /%[sdifoOc%]/g;
const STACK_AT = /at .*?([\w.-]+\.(?:ts|js|mjs))(?:\?[^:)\s]*)?:(\d+)/;
const SHADER_NAME = /Material Name: *(.*)/;
const SHADER_STAGE = /^(VERTEX|FRAGMENT)$/m;
const SHADER_ERROR = /ERROR: *\d+:(\d+): *(.*)/;
const SHADER_SOURCE = /^> *\d+: *(.*)$/m;

const PARAM = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('debug');
/** Browser hints about choices made on purpose: shown, but as plain lines, not warnings. */
const BENIGN = /willReadFrequently/;
/** One-shot session lines that must stay on the panel however much else is logged after them. */
const PINNED = /^(build|session|depth|camera pick|camera frames|lens f=|xr multiview)\b/;

/** The last ROWS lines, oldest first, in arrays allocated once. */
class ConsoleLines {
  readonly text: string[] = new Array<string>(ROWS).fill('');
  readonly level = new Uint8Array(ROWS);
  readonly tagged = new Uint8Array(ROWS);
  /**
   * Which line a full buffer drops first: log 0, info 1, [jonze] 3, any warn 4, the newest session line
   * of each kind 5, error 6. An older copy of a session line drops back to 3.
   */
  readonly rank = new Uint8Array(ROWS);
  readonly repeat = new Uint32Array(ROWS);
  readonly time = new Float64Array(ROWS);
  count = 0;
  errors = 0;
  warns = 0;
  dropped = 0;
  lastAt = -Infinity;
  repeatAt = -Infinity;
  floodAt = -Infinity;
  floodCount = 0;
  panelDirty = false;
  pageDirty = false;
  presenting = false;

  push(level: Level, raw: string, now: number): void {
    if (level === Level.Warn && BENIGN.test(raw)) level = Level.Log;
    let line = raw;
    let tagged = 0;
    if (line.startsWith(TAG)) {
      line = line.slice(TAG.length);
      tagged = 1;
    }
    if (line.length > MAX_CHARS) line = `${line.slice(0, MAX_CHARS - 1)}…`;
    if (level === Level.Error) this.errors++;
    else if (level === Level.Warn) this.warns++;
    this.lastAt = now;
    const last = this.count - 1;
    if (last >= 0 && this.level[last] === level && this.text[last] === line) {
      this.repeat[last]++;
      this.time[last] = now;
      if (now - this.repeatAt >= REPEAT_GAP) {
        this.repeatAt = now;
        this.panelDirty = true;
        this.pageDirty = true;
      }
      return;
    }
    const pinned = tagged && level < Level.Warn ? PINNED.exec(line) : null;
    if (pinned) {
      for (let i = 0; i < this.count; i++) {
        if (this.rank[i] === 5 && this.text[i].startsWith(pinned[1])) this.rank[i] = 3;
      }
    }
    const rank = level === Level.Error ? 6 : level === Level.Warn ? 4 : pinned ? 5 : tagged ? 3 : level;
    let at = this.count;
    if (at < ROWS) {
      this.count++;
    } else {
      // Full: the oldest line of the least important kind goes, so errors outlast chatter.
      let drop = 0;
      for (let i = 1; i < ROWS; i++) if (this.rank[i] < this.rank[drop]) drop = i;
      if (rank < this.rank[drop]) {
        this.dropped++;
        this.panelDirty = true;
        return;
      }
      for (let i = drop; i < ROWS - 1; i++) this.move(i + 1, i);
      at = ROWS - 1;
    }
    this.panelDirty = true;
    this.pageDirty = true;
    this.text[at] = line;
    this.level[at] = level;
    this.tagged[at] = tagged;
    this.rank[at] = rank;
    this.repeat[at] = 1;
    this.time[at] = now;
  }

  colorOf(i: number): string {
    const level = this.level[i];
    return this.tagged[i] && level < Level.Warn ? TAGGED : COLORS[level];
  }

  private move(from: number, to: number): void {
    this.text[to] = this.text[from];
    this.level[to] = this.level[from];
    this.tagged[to] = this.tagged[from];
    this.rank[to] = this.rank[from];
    this.repeat[to] = this.repeat[from];
    this.time[to] = this.time[from];
  }
}

const lines = new ConsoleLines();
let installed = false;
let alwaysOn = false;
let pageOn = false;
let busy = false;
let page: HTMLDivElement | null = null;
const pageRows: HTMLDivElement[] = [];
let pageTimer = 0;

/** Call once, first thing in index.ts. Safe to call again. */
export function installDebugConsole(): void {
  if (installed || PARAM === '0' || typeof window === 'undefined') return;
  installed = true;
  alwaysOn = PARAM !== null || import.meta.env.DEV;
  // The desk preview is judged from screenshots: keep the page corner clear there unless asked.
  pageOn = alwaysOn && (!PREVIEW_FORCED || PARAM === '1');
  buildPage();
  for (let m = 0; m < METHODS.length; m++) {
    const method = METHODS[m];
    const original: ConsoleFn = console[method];
    const level = LEVELS[method];
    console[method] = (...args: unknown[]) => {
      original.apply(console, args);
      captureArgs(level, args);
    };
  }
  window.addEventListener('error', onWindowError);
  window.addEventListener('unhandledrejection', onRejection);
  void document.fonts.ready.then(() => {
    lines.panelDirty = true;
    lines.pageDirty = true;
    schedulePage();
  });
  const loaded = new Date(performance.timeOrigin).toTimeString().slice(0, 8);
  console.info(`${TAG}build ${BUILD_TAG} loaded ${loaded} ${import.meta.env.MODE}${location.search ? ` ${location.search}` : ''}`);
}

function wanted(): boolean {
  return alwaysOn || lines.errors > 0;
}

function pageWanted(): boolean {
  return pageOn || lines.errors > 0;
}

function captureArgs(level: Level, args: readonly unknown[]): void {
  if (busy || flooded(level)) return;
  busy = true;
  try {
    record(level, formatArgs(args));
  } catch {
    // The mirror must never break the call it mirrors.
  } finally {
    busy = false;
  }
}

function flooded(level: Level): boolean {
  if (level === Level.Error) return false;
  const now = performance.now() / 1000;
  if (now - lines.floodAt >= 1) {
    lines.floodAt = now;
    lines.floodCount = 0;
  }
  if (++lines.floodCount <= FLOOD_LIMIT) return false;
  lines.dropped++;
  lines.panelDirty = true;
  return true;
}

function record(level: Level, text: string): void {
  const now = performance.now() / 1000;
  if (level === Level.Error && text.includes('Shader Error')) {
    // three: "...Shader Error...\nMaterial Name: x\n...\nFRAGMENT\n\nERROR: 0:412: ...\n\n> 412: <source>"
    const name = SHADER_NAME.exec(text)?.[1].trim() || 'unnamed';
    const stage = SHADER_STAGE.exec(text)?.[1].toLowerCase() ?? 'link';
    const error = SHADER_ERROR.exec(text);
    lines.push(level, error ? `shader ${name} ${stage} line ${error[1]}: ${error[2]}` : `shader ${name}: ${firstLine(text)}`, now);
    const source = SHADER_SOURCE.exec(text);
    if (source) lines.push(level, `  > ${source[1].trim()}`, now);
  } else {
    lines.push(level, firstLine(text), now);
  }
  syncPage();
  schedulePage();
}

function formatArgs(args: readonly unknown[]): string {
  if (args.length === 0) return '';
  const first = args[0];
  let next = 1;
  let out: string;
  if (typeof first === 'string' && first.includes('%')) {
    // Console substitutions: %s %d %i %f %o %O take the next argument; %c takes its CSS and drops it.
    out = first.replace(FORMAT, (spec) => {
      if (spec === '%%') return '%';
      if (next >= args.length) return spec;
      const value = args[next++];
      return spec === '%c' ? '' : describe(value);
    });
  } else {
    out = describe(first);
  }
  for (; next < args.length; next++) out += ` ${describe(args[next])}`;
  return out;
}

function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}${where(value.stack)}`;
  if (typeof value === 'function') return `ƒ ${value.name || 'anonymous'}`;
  if (value === null || typeof value !== 'object') return String(value);
  if (ArrayBuffer.isView(value)) return `${value.constructor.name}(${value.byteLength} bytes)`;
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return String(value);
    return json.length > MAX_CHARS ? json.slice(0, MAX_CHARS) : json;
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** " @file.ts:123" from the first frame of a Chromium stack. */
function where(stack: string | undefined): string {
  const at = stack ? STACK_AT.exec(stack) : null;
  return at ? ` @${at[1]}:${at[2]}` : '';
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n');
  return nl < 0 ? text : text.slice(0, nl);
}

function basename(url: string): string {
  const q = url.indexOf('?');
  const clean = q < 0 ? url : url.slice(0, q);
  return clean.slice(clean.lastIndexOf('/') + 1);
}

function onWindowError(event: ErrorEvent): void {
  const error: unknown = event.error;
  const site = event.filename ? ` @${basename(event.filename)}:${event.lineno}` : '';
  captureArgs(Level.Error, ['uncaught', error instanceof Error ? error : `${event.message}${site}`]);
}

function onRejection(event: PromiseRejectionEvent): void {
  captureArgs(Level.Error, ['unhandled rejection', event.reason]);
}

// ------------------------------------------------------------ 2D page mirror (outside a session)

function buildPage(): void {
  const body = document.body;
  if (!body) return;
  page = document.createElement('div');
  page.id = 'debugConsole';
  page.hidden = true;
  page.style.cssText =
    `position:fixed;z-index:5;right:8px;bottom:8px;max-width:min(560px,46vw);padding:6px 8px;` +
    `border-radius:8px;background:rgba(8,10,14,0.8);font:11px/1.35 ${MONO};pointer-events:none`;
  for (let i = 0; i < ROWS; i++) {
    const row = document.createElement('div');
    row.style.cssText = 'white-space:pre;overflow:hidden;text-overflow:ellipsis';
    row.hidden = true;
    page.appendChild(row);
    pageRows.push(row);
  }
  body.appendChild(page);
  syncPage();
}

function syncPage(): void {
  if (!page) return;
  const hidden = lines.presenting || !pageWanted();
  if (page.hidden === hidden) return;
  page.hidden = hidden;
  if (!hidden) {
    lines.pageDirty = true;
    schedulePage();
  }
}

function schedulePage(): void {
  if (pageTimer !== 0 || !page || page.hidden || !lines.pageDirty) return;
  pageTimer = window.setTimeout(paintPage, PAINT_GAP * 1000);
}

function paintPage(): void {
  pageTimer = 0;
  if (!page || page.hidden) return;
  lines.pageDirty = false;
  for (let i = 0; i < pageRows.length; i++) {
    const row = pageRows[i];
    if (i >= lines.count) {
      row.hidden = true;
      continue;
    }
    row.hidden = false;
    row.textContent = lines.repeat[i] > 1 ? `${lines.text[i]}  ×${lines.repeat[i]}` : lines.text[i];
    row.style.color = lines.colorOf(i);
  }
}

// ------------------------------------------------------------ world-space panel (in a session)

/** Draws the captured lines on a head-locked panel while presenting, in every mode. */
export class DebugConsoleSystem extends createSystem({}) {
  private mesh: Mesh | null = null;
  private material!: MeshBasicMaterial;
  private texture!: CanvasTexture;
  private paint!: Canvas2D;
  private entity!: Entity;
  private readonly headPos = new Vector3();
  private readonly headQuat = new Quaternion();
  private readonly smoothQuat = new Quaternion();
  private readonly offset = new Vector3();
  private readonly facing = new Quaternion();
  private presenting = false;
  private shown = false;
  private settled = false;
  private paintedAt = -Infinity;
  private opacity = 1;

  init(): void {
    if (!installed) return;
    // three's default. Without it a broken shader fails silently instead of reaching the panel.
    this.renderer.debug.checkShaderErrors = true;
    const cosP = Math.cos(PITCH);
    this.offset.set(-Math.sin(YAW) * cosP, Math.sin(PITCH), -Math.cos(YAW) * cosP).multiplyScalar(DISTANCE);
    // Turned back toward the eye, so the text faces you squarely from the corner of view.
    this.facing.setFromEuler(new Euler(PITCH, YAW, 0, 'YXZ'));

    this.paint = makeCanvas(CANVAS_W, CANVAS_H);
    this.texture = new CanvasTexture(this.paint.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    // Over everything: the stretch mesh and the hand spheres both write depth.
    this.material = new MeshBasicMaterial({
      map: this.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false,
    });
    const mesh = new Mesh(new PlaneGeometry(PANEL_W, (PANEL_W * CANVAS_H) / CANVAS_W), this.material);
    mesh.name = 'debug-console';
    mesh.renderOrder = 1000;
    mesh.frustumCulled = false;
    mesh.visible = false;
    const hud = new Group();
    hud.add(mesh);
    this.entity = this.world.createTransformEntity(hud);
    this.mesh = mesh;
    this.cleanupFuncs.push(() => this.dispose());
  }

  update(delta: number): void {
    const mesh = this.mesh;
    if (!mesh) return;
    const presenting = this.renderer.xr.isPresenting;
    if (presenting !== this.presenting) {
      this.presenting = presenting;
      lines.presenting = presenting;
      syncPage();
    }
    const show = presenting && wanted();
    if (show !== this.shown) {
      this.shown = show;
      this.settled = false;
      lines.panelDirty = true;
      if (!show) mesh.visible = false;
    }
    if (!show) return;
    const now = performance.now() / 1000;
    if (lines.panelDirty && now - this.paintedAt >= PAINT_GAP) {
      lines.panelDirty = false;
      this.paintedAt = now;
      this.paintPanel();
    }
    this.place(mesh, Math.min(0.1, delta), now);
  }

  private place(mesh: Mesh, dt: number, now: number): void {
    const head = this.player.head;
    head.getWorldPosition(this.headPos);
    head.getWorldQuaternion(this.headQuat);
    if (!this.settled) {
      this.smoothQuat.copy(this.headQuat);
      this.settled = true;
      mesh.visible = true;
    } else {
      this.smoothQuat.slerp(this.headQuat, 1 - Math.exp(-dt * FOLLOW));
    }
    mesh.position.copy(this.offset).applyQuaternion(this.smoothQuat).add(this.headPos);
    mesh.quaternion.copy(this.smoothQuat).multiply(this.facing);
    const target = now - lines.lastAt < IDLE_DIM ? 1 : DIM_OPACITY;
    this.opacity += (target - this.opacity) * (1 - Math.exp(-dt * 4));
    this.material.opacity = this.opacity;
  }

  /** Only when a line arrived, at most every PAINT_GAP. Strings built here are per event, not per frame. */
  private paintPanel(): void {
    const { canvas, ctx } = this.paint;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.beginPath();
    ctx.roundRect(2, 2, w - 4, h - 4, 18);
    ctx.fillStyle = PANEL_FILL;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = lines.errors > 0 ? COLORS[Level.Error] : INK.line;
    ctx.stroke();

    ctx.textBaseline = 'middle';
    ctx.font = FONT_HEADER;
    ctx.textAlign = 'left';
    ctx.fillStyle = INK.muted;
    ctx.fillText(`console ${BUILD_TAG} · ${getMode()}`, PAD, HEADER_H / 2);
    ctx.textAlign = 'right';
    if (lines.errors > 0) ctx.fillStyle = COLORS[Level.Error];
    ctx.fillText(
      `${lines.errors} err  ${lines.warns} warn${lines.dropped ? `  ${lines.dropped} dropped` : ''}`,
      w - PAD,
      HEADER_H / 2,
    );

    ctx.font = FONT_TIME;
    for (let i = 0; i < lines.count; i++) {
      const y = HEADER_H + (i + 0.5) * ROW_H;
      ctx.fillStyle = INK.muted;
      ctx.fillText((lines.time[i] % 1000).toFixed(1), PAD + TIME_W - 12, y);
      if (lines.repeat[i] > 1) {
        ctx.fillStyle = COLORS[Level.Warn];
        ctx.fillText(`×${lines.repeat[i]}`, w - PAD, y);
      }
    }
    ctx.font = FONT_TEXT;
    ctx.textAlign = 'left';
    for (let i = 0; i < lines.count; i++) {
      const y = HEADER_H + (i + 0.5) * ROW_H;
      const right = lines.repeat[i] > 1 ? w - PAD - REPEAT_W : w - PAD;
      ctx.fillStyle = lines.colorOf(i);
      // maxWidth condenses a long line instead of clipping it.
      ctx.fillText(lines.text[i], PAD + TIME_W, y, right - PAD - TIME_W);
    }
    this.texture.needsUpdate = true;
  }

  private dispose(): void {
    this.texture.dispose();
    this.material.dispose();
    this.entity.dispose();
    this.mesh = null;
  }
}
