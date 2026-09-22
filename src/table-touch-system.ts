import {
  CanvasTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  VisibilityState,
  createSystem,
  type Entity,
  type ShaderMaterial,
} from '@iwsdk/core';
import { FrameStack } from './frame-stack-component.js';
import { FrameStackSystem } from './frame-stack-system.js';
import { INK, drawHint, makeCanvas, type Canvas2D } from './labels.js';
import { BUTTON_SLOP, HOVER_MAX, STACK_DRAG, STACK_TOUCH, STRIP_LENGTH, SURFACE_Y } from './layout.js';
import { discMaterial } from './stack-materials.js';
import { TickSound } from './tick-sound.js';
import { Contact, OneEuro, Stillness, hitTest, inZone, stripU, type Target } from './touch-logic.js';

type Side = 'left' | 'right';
const SIDES: readonly Side[] = ['left', 'right'];
const UP = new Vector3(0, 1, 0);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

interface Copy {
  title: string;
  body: string;
}
const PLACE: Copy = { title: 'Rest a fingertip on the table', body: 'Hold still where you want the slider.' };
const HANDS: Copy = { title: 'Put the controllers down', body: 'The slider works with your hands.' };

interface Finger {
  tracked: boolean;
  world: Vector3;
  local: Vector3;
  radius: number;
  /** Fingertip height above where it rested on the table at placement. */
  height: number;
  /** Smoothed rig-local x, for the film strip. */
  sx: number;
  /** Meters outside the frame volume. Infinity when the finger isn't tracked. */
  outside: number;
  /** Stack-local position along the time axis, in meters. */
  axisZ: number;
  contact: Contact;
  still: Stillness;
  filter: OneEuro;
  axis: OneEuro;
  shadow: Mesh;
  shadowMat: ShaderMaterial;
  ring: Mesh;
  ringMat: ShaderMaterial;
  ripple: Mesh;
  rippleMat: ShaderMaterial;
  rippleT: number;
}

/**
 * Turns the real table into the slider. To place it, rest an index fingertip on the
 * table and hold still: that spot becomes the strip's center, and the fingertip's
 * resting height becomes the "touching" reference, which is tighter than a room scan.
 * Then hover over the strip or the frames to preview, touch and slide to scrub, and tap the controls.
 */
export class TableTouchSystem extends createSystem({ stacks: { required: [FrameStack] } }) {
  private mode: 'idle' | 'placing' | 'ready' = 'idle';
  private stack!: FrameStackSystem;
  private rig: Entity | null = null;
  private restY = 0.008;
  private capture: { side: Side; target: Target | 'stack' } | null = null;
  private fingers!: Record<Side, Finger>;
  private readonly sound = new TickSound();
  private lastIdx = -1;
  private readonly homePos = new Vector3();
  private readonly homeQuat = new Quaternion();
  private readonly head = new Vector3();
  private readonly headQuat = new Quaternion();
  private readonly fwd = new Vector3();
  private readonly aim = new Vector3();
  private hudEntity!: Entity;
  private hint!: Mesh;
  private hintMat!: MeshBasicMaterial;
  private hintPaint!: Canvas2D;
  private hintTex!: CanvasTexture;
  private hintCopy: Copy | null = null;
  private hintOpacity = 0;
  private hintSettled = false;
  private ring!: Mesh;
  private ringMat!: ShaderMaterial;

  init(): void {
    this.stack = this.world.getSystem(FrameStackSystem)!;
    const flat = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const finger = (): Finger => {
      const shadowMat = discMaterial(INK.stage, 0, 1);
      const ringMat = discMaterial(INK.text, 0.62, 0.12);
      const rippleMat = discMaterial(INK.text, 0.82, 0.1);
      const shadow = new Mesh(flat, shadowMat);
      const ring = new Mesh(flat, ringMat);
      const ripple = new Mesh(flat, rippleMat);
      shadow.renderOrder = 3;
      ring.renderOrder = 4;
      ripple.renderOrder = 4;
      shadow.visible = ring.visible = ripple.visible = false;
      return {
        tracked: false,
        world: new Vector3(),
        local: new Vector3(),
        radius: 0.008,
        height: 1,
        sx: 0,
        outside: Infinity,
        axisZ: 0,
        contact: new Contact(),
        still: new Stillness(),
        filter: new OneEuro(),
        axis: new OneEuro(),
        shadow,
        shadowMat,
        ring,
        ringMat,
        ripple,
        rippleMat,
        rippleT: 1,
      };
    };
    this.fingers = { left: finger(), right: finger() };

    // World-space helpers for placement: the instruction card and the hold-still ring.
    const hud = new Group();
    this.hintPaint = makeCanvas(1024, 256);
    this.hintTex = new CanvasTexture(this.hintPaint.canvas);
    this.hintTex.colorSpace = SRGBColorSpace;
    this.hintMat = new MeshBasicMaterial({ map: this.hintTex, transparent: true, depthWrite: false, depthTest: false, opacity: 0 });
    this.hint = new Mesh(new PlaneGeometry(0.28, 0.07), this.hintMat);
    this.hint.renderOrder = 10;
    this.hint.visible = false;
    this.ringMat = discMaterial(INK.text, 0.7, 0.08);
    this.ring = new Mesh(flat, this.ringMat);
    this.ring.renderOrder = 10;
    this.ring.visible = false;
    hud.add(this.hint, this.ring);
    this.hudEntity = this.world.createTransformEntity(hud);

    const unlock = () => this.sound.unlock();
    window.addEventListener('pointerdown', unlock);
    this.cleanupFuncs.push(
      this.queries.stacks.subscribe('qualify', (entity) => this.attach(entity), true),
      this.queries.stacks.subscribe('disqualify', (entity) => {
        if (entity === this.rig) this.rig = null;
      }),
      this.visibilityState.subscribe((state) => {
        if (state === VisibilityState.NonImmersive) this.exitXR();
        else if (this.mode === 'idle') this.startPlacing();
      }),
      () => window.removeEventListener('pointerdown', unlock),
      () => this.dispose(flat),
    );
    void document.fonts.ready.then(() => {
      this.hintCopy = null; // repaint the card with the loaded face
    });
  }

  /** Call from a user gesture (the Enter button) so scrub ticks can play in the headset. */
  unlockAudio(): void {
    this.sound.unlock();
  }

  update(delta: number): void {
    if (this.mode === 'idle' || !this.rig?.object3D) return;
    const dt = Math.min(0.1, delta);
    this.player.head.getWorldPosition(this.head);
    this.player.head.getWorldQuaternion(this.headQuat);
    this.readFingers(dt);
    if (this.mode === 'placing') this.updatePlacing(dt);
    else this.updateTouch(dt);
    this.updateHint(dt);
    this.updateFeedback(dt);
  }

  // ---------------------------------------------------------------- tracking

  private readFingers(dt: number): void {
    const frame = this.world.xrFrame;
    const ref = this.world.xrReferenceSpace;
    const rig = this.rig!.object3D!;
    rig.updateWorldMatrix(true, false);
    this.player.updateWorldMatrix(true, false);
    for (let i = 0; i < SIDES.length; i++) {
      const side = SIDES[i];
      const f = this.fingers[side];
      f.tracked = false;
      if (frame && ref && this.input.xr.isPrimary('hand', side)) {
        const tip = this.input.xr.visualAdapters.hand[side].getIndexTipSpace() as XRJointSpace | undefined;
        const pose = tip ? frame.getJointPose?.(tip, ref) : undefined;
        if (pose) {
          const p = pose.transform.position;
          f.world.set(p.x, p.y, p.z).applyMatrix4(this.player.matrixWorld);
          f.radius = pose.radius ?? 0.008;
          f.tracked = true;
        }
      }
      if (f.tracked) {
        f.local.copy(f.world);
        rig.worldToLocal(f.local);
        f.height = f.local.y - this.restY;
        f.sx = f.filter.filter(f.local.x, dt);
      } else {
        f.filter.reset();
      }
    }
  }

  // ---------------------------------------------------------------- placement

  private updatePlacing(dt: number): void {
    let best: Finger | null = null;
    let bestP = 0;
    let anyHand = false;
    for (let i = 0; i < SIDES.length; i++) {
      const f = this.fingers[SIDES[i]];
      if (!f.tracked) {
        f.still.reset();
        continue;
      }
      anyHand = true;
      // A table touch is below and ahead of the eyes; skip hands raised near the face.
      const below = this.head.y - f.world.y;
      const ahead = Math.hypot(f.world.x - this.head.x, f.world.z - this.head.z);
      if (below < 0.2 || ahead < 0.12) {
        f.still.reset();
        continue;
      }
      const p = f.still.update(f.world.x, f.world.y, f.world.z, dt);
      if (p > bestP) {
        bestP = p;
        best = f;
      }
    }
    this.showHint(anyHand ? PLACE : HANDS);
    this.ring.visible = best !== null && bestP > 0.08;
    if (best && this.ring.visible) {
      this.ring.position.set(best.world.x, best.world.y - best.radius + 0.002, best.world.z);
      this.ring.scale.setScalar(0.05);
      this.ringMat.uniforms.uProgress.value = bestP;
    }
    if (best && bestP >= 1) this.place(best);
  }

  private place(f: Finger): void {
    const rig = this.rig!.object3D!;
    const surfaceY = f.world.y - Math.min(0.012, Math.max(0.004, f.radius));
    this.restY = f.world.y - surfaceY;
    this.fwd.set(f.world.x - this.head.x, 0, f.world.z - this.head.z);
    if (this.fwd.lengthSq() < 1e-6) this.fwd.set(0, 0, -1);
    this.fwd.normalize();
    rig.position.set(f.world.x, surfaceY, f.world.z);
    rig.quaternion.setFromAxisAngle(UP, Math.atan2(-this.fwd.x, -this.fwd.z)); // strip runs across the view
    rig.visible = true;
    this.mode = 'ready';
    this.ring.visible = false;
    // Fingers already on the table count as down until lifted, so the placing touch doesn't scrub.
    for (let i = 0; i < SIDES.length; i++) {
      const g = this.fingers[SIDES[i]];
      g.still.reset();
      g.contact.touching = true;
    }
    this.stack.reveal();
    this.sound.tap();
  }

  private startPlacing(): void {
    this.mode = 'placing';
    this.release();
    this.hintSettled = false;
    const rig = this.rig?.object3D;
    if (rig) rig.visible = false;
  }

  private exitXR(): void {
    this.mode = 'idle';
    this.release();
    this.hint.visible = false;
    this.ring.visible = false;
    this.hintOpacity = 0;
    const rig = this.rig?.object3D;
    if (rig) {
      rig.position.copy(this.homePos);
      rig.quaternion.copy(this.homeQuat);
      rig.visible = true;
    }
  }

  // ---------------------------------------------------------------- touch

  private updateTouch(dt: number): void {
    this.sampleStack();
    for (let i = 0; i < SIDES.length; i++) {
      const side = SIDES[i];
      const f = this.fingers[side];
      const edge = f.contact.update(f.height, f.tracked);
      if (edge === 'down') this.onDown(side, f);
      else if (edge === 'up') this.onUp(side, f);
    }

    const cap = this.capture;
    if (cap?.target === 'stack') {
      const f = this.fingers[cap.side];
      if (!this.stack.ready || !f.tracked || f.outside > STACK_DRAG) this.capture = null;
      else this.stack.seek(this.stack.uOnAxis(f.axis.filter(f.axisZ, dt)));
    } else if (cap?.target === 'strip') {
      this.stack.seek(stripU(this.fingers[cap.side].sx));
    } else if (cap) {
      const f = this.fingers[cap.side];
      this.stack.setPressed(inZone(cap.target, f.local.x, f.local.z, BUTTON_SLOP) ? cap.target : null);
    }

    if (!this.capture) this.grabOrSkim(dt);

    const idx = this.stack.displayIndex();
    if (idx !== this.lastIdx) {
      const scrubbing = this.capture?.target === 'strip' || this.capture?.target === 'stack';
      if (scrubbing || this.stack.skim !== null) this.sound.tick(this.stack.isMajor(idx));
      this.lastIdx = idx;
    }
  }

  /** One stack probe per finger, so later checks don't transform the point again. */
  private sampleStack(): void {
    for (let i = 0; i < SIDES.length; i++) {
      const f = this.fingers[SIDES[i]];
      if (!f.tracked) {
        f.outside = Infinity;
        continue;
      }
      this.stack.probe(f.local.x, f.local.y, f.local.z);
      f.outside = this.stack.stackOutside;
      f.axisZ = this.stack.stackAxis;
    }
  }

  /** A finger inside the frames seeks. Otherwise the nearest nearby finger previews. */
  private grabOrSkim(dt: number): void {
    let grab: { side: Side; finger: Finger } | null = null;
    for (let i = 0; i < SIDES.length; i++) {
      const side = SIDES[i];
      const f = this.fingers[side];
      if (!this.stack.ready || !f.tracked || f.outside > STACK_TOUCH) continue;
      if (!grab || f.outside < grab.finger.outside) grab = { side, finger: f };
    }
    if (grab) {
      this.capture = { side: grab.side, target: 'stack' };
      grab.finger.axis.reset();
      this.sound.tap();
      this.stack.seek(this.stack.uOnAxis(grab.finger.axis.filter(grab.finger.axisZ, dt)));
      return;
    }

    // Hovering previews frames, like the mouse skim in the browser version.
    let strip: Finger | null = null;
    let stack: Finger | null = null;
    for (let i = 0; i < SIDES.length; i++) {
      const f = this.fingers[SIDES[i]];
      if (!f.tracked || f.contact.touching) continue;
      if (f.height <= HOVER_MAX && inZone('strip', f.local.x, f.local.z) && (!strip || f.height < strip.height)) strip = f;
      if (f.outside <= HOVER_MAX && (!stack || f.outside < stack.outside)) stack = f;
    }
    if (strip) this.stack.skimAt(stripU(strip.sx));
    else if (stack && this.stack.ready) this.stack.skimAt(this.stack.uOnAxis(stack.axis.filter(stack.axisZ, dt)));
    else this.stack.skimAt(null);
  }

  private onDown(side: Side, f: Finger): void {
    if (this.capture) return; // one finger drives at a time
    const target = hitTest(f.local.x, f.local.z);
    if (!target) return;
    this.capture = { side, target };
    f.ripple.position.set(f.local.x, SURFACE_Y + 0.0008, f.local.z);
    f.rippleT = 0;
    this.sound.tap();
    if (target === 'strip') {
      f.filter.reset(); // land exactly where the finger touched
      f.sx = f.local.x;
      this.stack.seek(stripU(f.sx));
    } else {
      this.stack.setPressed(target); // feedback on touch-down, commit on lift
    }
  }

  private onUp(side: Side, f: Finger): void {
    const cap = this.capture;
    if (!cap || cap.side !== side) return;
    this.capture = null;
    if (cap.target === 'strip' || cap.target === 'stack') return; // the frame under the finger stays put
    this.stack.setPressed(null);
    if (!f.tracked || !inZone(cap.target, f.local.x, f.local.z, BUTTON_SLOP)) return; // slid off: cancel
    if (cap.target === 'play') this.stack.togglePlay();
    else if (cap.target === 'speed') this.stack.cycleSpeed();
    else if (cap.target === 'move') this.startPlacing();
  }

  private release(): void {
    this.capture = null;
    this.stack.skimAt(null);
    this.stack.setPressed(null);
    for (let i = 0; i < SIDES.length; i++) {
      const f = this.fingers[SIDES[i]];
      f.contact.touching = false;
      f.still.reset();
      f.filter.reset();
      f.axis.reset();
      f.shadow.visible = f.ring.visible = f.ripple.visible = false;
      f.rippleT = 1;
    }
  }

  // ---------------------------------------------------------------- visuals

  private updateHint(dt: number): void {
    this.hintOpacity += ((this.mode === 'placing' ? 1 : 0) - this.hintOpacity) * (1 - Math.exp(-dt * 8));
    this.hint.visible = this.hintOpacity > 0.01;
    this.hintMat.opacity = this.hintOpacity;
    if (!this.hint.visible) return;
    // Float the card below eye level, a comfortable reach ahead, lazily following the head.
    this.fwd.set(0, 0, -1).applyQuaternion(this.headQuat);
    this.fwd.y = 0;
    if (this.fwd.lengthSq() < 1e-6) this.fwd.set(0, 0, -1);
    this.fwd.normalize();
    this.aim.copy(this.head).addScaledVector(this.fwd, 0.55);
    this.aim.y -= 0.16;
    if (!this.hintSettled) {
      this.hint.position.copy(this.aim);
      this.hintSettled = true;
    } else {
      this.hint.position.lerp(this.aim, 1 - Math.exp(-dt * 3));
    }
    this.hint.lookAt(this.head);
  }

  private showHint(copy: Copy): void {
    if (copy === this.hintCopy) return;
    this.hintCopy = copy;
    drawHint(this.hintPaint, copy.title, copy.body);
    this.hintTex.needsUpdate = true;
  }

  private updateFeedback(dt: number): void {
    const ready = this.mode === 'ready';
    for (let i = 0; i < SIDES.length; i++) {
      const f = this.fingers[SIDES[i]];
      const onStack = f.tracked && f.outside <= HOVER_MAX;
      const near =
        ready &&
        f.tracked &&
        !onStack &&
        f.height < 0.12 &&
        Math.abs(f.local.x) < STRIP_LENGTH / 2 + 0.16 &&
        Math.abs(f.local.z) < 0.14;
      f.shadow.visible = near && !f.contact.touching;
      f.ring.visible = (near && f.contact.touching) || (ready && onStack);
      if (onStack) {
        f.ring.position.set(f.local.x, f.local.y, f.local.z);
        f.ring.renderOrder = 9;
        f.ringMat.depthTest = false;
        f.ring.scale.setScalar(0.02);
      } else if (near) {
        // A fingertip "shadow" that tightens and darkens as the finger nears the table.
        const k = clamp01(f.height / 0.12);
        f.shadow.position.set(f.local.x, SURFACE_Y + 0.0006, f.local.z);
        f.shadow.scale.setScalar(2 * lerp(0.005, 0.016, k));
        f.shadowMat.uniforms.uOpacity.value = lerp(0.5, 0, k);
        f.ring.position.set(f.local.x, SURFACE_Y + 0.0008, f.local.z);
        f.ring.renderOrder = 4;
        f.ringMat.depthTest = true;
        f.ring.scale.setScalar(0.02);
      }
      if (f.rippleT < 1) {
        f.rippleT = Math.min(1, f.rippleT + dt / 0.35);
        const e = 1 - (1 - f.rippleT) ** 3;
        f.ripple.visible = ready;
        f.ripple.scale.setScalar(2 * lerp(0.008, 0.03, e));
        f.rippleMat.uniforms.uOpacity.value = 0.8 * (1 - f.rippleT);
      } else {
        f.ripple.visible = false;
      }
    }
  }

  private attach(entity: Entity): void {
    const rig = entity.object3D;
    if (this.rig || !rig) return;
    this.rig = entity;
    this.homePos.copy(rig.position);
    this.homeQuat.copy(rig.quaternion);
    for (let i = 0; i < SIDES.length; i++) {
      const f = this.fingers[SIDES[i]];
      rig.add(f.shadow, f.ring, f.ripple);
    }
    if (this.renderer.xr.isPresenting) this.startPlacing();
  }

  private dispose(flat: PlaneGeometry): void {
    flat.dispose();
    this.hint.geometry.dispose();
    this.hintMat.dispose();
    this.hintTex.dispose();
    this.ringMat.dispose();
    for (let i = 0; i < SIDES.length; i++) {
      const f = this.fingers[SIDES[i]];
      f.shadowMat.dispose();
      f.ringMat.dispose();
      f.rippleMat.dispose();
      f.shadow.removeFromParent();
      f.ring.removeFromParent();
      f.ripple.removeFromParent();
    }
    this.hudEntity.dispose();
  }
}
