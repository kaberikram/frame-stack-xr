import { CameraUtils, Quaternion, Vector3, VisibilityState, createSystem } from '@iwsdk/core';
import { prepareDepthModel } from './depth-model.js';
import { PREVIEW_FORCED, getMode, isMode, launchSession, setMode, type ExperienceMode } from './experience.js';
import {
  DEFAULT_CLIP_DEPTH,
  DEFAULT_CLIP_NAME,
  DEFAULT_CLIP_URL,
  autoRate,
  demoSource,
  disposeVideo,
  loadVideoFile,
  loadVideoUrl,
  videoSource,
  type LoadedVideo,
} from './frame-sources.js';
import { FrameStackSystem } from './frame-stack-system.js';
import { RoomStretchSystem } from './room-stretch-system.js';
import { SorangSystem } from './sorang-system.js';
import { TableTouchSystem } from './table-touch-system.js';

const NO_PASSTHROUGH = 'Open this page in the Meta Quest browser to use passthrough.';
const DEPTH_WAIT = 'Downloading the depth model. Passthrough unlocks when it’s ready.';
const DEPTH_FAIL = 'The depth model didn’t load. Reload the page to try again.';
const STRETCH_HINT = 'Round 7. Hold an open palm up to a wall, then push.';
const STRETCH_CAMERA = 'Camera on. Push a palm into a wall, or pinch and pull.';
const STRETCH_ASKING = 'Allow the camera so the pull can show your room.';
const STRETCH_BLOCKED = 'Camera blocked. Allow it for this site so the pull can show your room.';
const SORANG_HINT = 'Click the view to look around. WASD walks. Shift is faster.';
const SORANG_TIP_MS = 4000;

const TITLES: Record<ExperienceMode, string> = { stack: 'Frame stack', stretch: 'Jonze stretch', sorang: 'Sorang' };

/** Wires the 2D launch card in index.html: pick a clip and a sample rate, then enter passthrough. */
export class LauncherSystem extends createSystem({}) {
  private video: LoadedVideo | null = null;
  private toastTimer = 0;
  /** Bumped on every open so a slower load can't replace a newer clip. */
  private loadGen = 0;
  private stretchHint = STRETCH_HINT;
  /** The headset camera prompt is open on the page. Enter waits so the prompt can't end the session. */
  private cameraAsking = false;
  private cameraAsked = false;
  private readonly previewPos = new Vector3();
  private readonly previewQuat = new Quaternion();
  private previewSaved = false;
  /** Sorang plays behind a collapsed card; the chip or Esc opens it. */
  private cardOpen = true;
  private immersive = false;
  private readonly uiOff = typeof location !== 'undefined' && new URLSearchParams(location.search).get('ui') === '0';
  private tipShown = false;
  private tipTimer = 0;

  init(): void {
    const stack = this.world.getSystem(FrameStackSystem)!;
    const launch = document.getElementById('launch');
    const source = document.getElementById('source');
    const progress = document.getElementById('progress');
    const bar = document.getElementById('progressBar');
    const rate = document.getElementById('rate') as HTMLSelectElement | null;
    const rateNote = document.getElementById('rateNote');
    const load = document.getElementById('loadBtn');
    const enter = document.getElementById('enterBtn') as HTMLButtonElement | null;
    const file = document.getElementById('file') as HTMLInputElement | null;
    const hint = document.getElementById('hint');
    const modeStack = document.getElementById('modeStack');
    const modeStretch = document.getElementById('modeStretch');
    const stackPanel = document.getElementById('stackPanel');
    const stretchPanel = document.getElementById('stretchPanel');
    if (!launch || !source || !progress || !bar || !rate || !rateNote || !load || !enter || !file || !hint || !modeStack || !modeStretch || !stackPanel || !stretchPanel) {
      void stack.build(demoSource());
      return;
    }
    const touch = this.world.getSystem(TableTouchSystem)!;
    const stretch = this.world.getSystem(RoomStretchSystem)!;
    const sorang = this.world.getSystem(SorangSystem)!;
    // Optional, so a page from before Sorang still runs the other two modes.
    const modeSorang = document.getElementById('modeSorang');
    const sorangPanel = document.getElementById('sorangPanel');
    const sorangSource = document.getElementById('sorangSource');
    const imageBtn = document.getElementById('imageBtn');
    const playBtn = document.getElementById('playBtn');
    const imageFile = document.getElementById('imageFile') as HTMLInputElement | null;
    const cardBtn = document.getElementById('cardBtn');
    const tip = document.getElementById('sorangTip');
    const version = document.getElementById('stretchVersion');
    if (version) {
      version.textContent =
        `Round 7 · jonze-${__BUILD_SHA__}. Hold a palm up to a wall and push: it sinks in like a box and stays. ` +
        'Pinch it to pop it back. Touching or tapping the mesh does nothing.';
    }

    enter.disabled = true;
    const placeHint = hint.textContent ?? '';
    let xrKnown = false;
    let xrOk = false;
    let depthRequested = false;
    let depthReady = false;
    let depthNote = DEPTH_WAIT;
    const syncEnter = () => {
      if (getMode() === 'sorang') {
        enter.disabled = true;
        hint.textContent = SORANG_HINT;
        return;
      }
      const stackMode = getMode() === 'stack';
      const depthOk = !stackMode || depthReady || !stack.needsDepthModel;
      const cameraOk = stackMode || !this.cameraAsking;
      enter.disabled = !(xrOk && depthOk && cameraOk);
      if (!xrKnown) return;
      if (!xrOk) hint.textContent = NO_PASSTHROUGH;
      else if (stackMode && !depthOk) hint.textContent = depthNote;
      else hint.textContent = stackMode ? placeHint : this.stretchHint;
    };
    let defaultOpened = false;
    const openDefaultOnce = () => {
      if (defaultOpened) return;
      defaultOpened = true;
      void this.openDefault(stack, rate, source);
    };
    const syncCard = () => {
      const sorangMode = getMode() === 'sorang';
      launch.hidden = this.immersive || (sorangMode && (!this.cardOpen || this.uiOff));
      if (cardBtn) cardBtn.hidden = this.immersive || !sorangMode || this.cardOpen || this.uiOff;
      if (tip && (!sorangMode || this.uiOff || this.immersive)) tip.hidden = true;
    };
    const renderSorang = () => {
      if (sorangSource) sorangSource.textContent = sorang.status().text;
      const drifting = sorang.stage === 'drift' || sorang.stage === 'orbit';
      if (!tip || this.tipShown || this.uiOff || getMode() !== 'sorang' || !drifting) return;
      this.tipShown = true;
      tip.hidden = false;
      clearTimeout(this.tipTimer);
      this.tipTimer = window.setTimeout(() => {
        tip.hidden = true;
      }, SORANG_TIP_MS);
    };
    const tabs: ReadonlyArray<readonly [ExperienceMode, HTMLElement | null]> = [
      ['stack', modeStack],
      ['stretch', modeStretch],
      ['sorang', modeSorang],
    ];
    const applyMode = (mode: ExperienceMode) => {
      const was = getMode();
      setMode(mode);
      document.title = TITLES[mode];
      const title = document.getElementById('title');
      if (title) title.textContent = TITLES[mode];
      stackPanel.hidden = mode !== 'stack';
      stretchPanel.hidden = mode !== 'stretch';
      if (sorangPanel) sorangPanel.hidden = mode !== 'sorang';
      load.hidden = mode !== 'stack';
      if (imageBtn) imageBtn.hidden = mode !== 'sorang';
      if (playBtn) playBtn.hidden = mode !== 'sorang';
      enter.hidden = mode === 'sorang';
      for (const [m, tab] of tabs) tab?.setAttribute('aria-selected', m === mode ? 'true' : 'false');
      this.applyPreview(mode);
      if (mode === 'stretch') this.armStretchCamera(stretch, syncEnter);
      if (mode === 'stack') {
        openDefaultOnce();
        requestDepthModel();
      }
      if (mode === 'sorang') {
        // The painting plays behind a collapsed card; a second click on the tab doesn't restart it.
        if (was !== 'sorang') this.tipShown = false;
        this.cardOpen = false;
      } else {
        this.cardOpen = true;
        if (tip) tip.hidden = true;
      }
      syncCard();
      renderSorang();
      syncEnter();
    };
    const requestDepthModel = () => {
      if (depthRequested || !stack.needsDepthModel) return;
      depthRequested = true;
      void prepareDepthModel().then(
        () => {
          depthReady = true;
          syncEnter();
        },
        () => {
          depthRequested = false;
          depthNote = DEPTH_FAIL;
          syncEnter();
        },
      );
    };

    const render = () => {
      source.textContent = stack.describe();
      progress.hidden = stack.ready;
      bar.style.transform = `scaleX(${stack.N ? stack.loaded / stack.N : 0})`;
      rateNote.textContent = stack.rateNote();
      requestDepthModel();
      syncEnter();
    };
    stack.name = DEFAULT_CLIP_NAME;
    rate.value = String(stack.rate);
    render();

    const onRate = () => {
      stack.rate = Number(rate.value);
      if (this.video) void stack.build(videoSource(this.video));
    };
    const onLoad = () => file.click();
    const onFile = () => {
      const f = file.files?.[0];
      file.value = '';
      if (f) void this.open(f, stack, rate, source);
    };
    const onEnter = () => {
      if (getMode() === 'sorang') return; // desktop only for now
      touch.unlockAudio(); // this click is the gesture that lets scrub ticks play in the headset
      const stretchMode = getMode() === 'stretch';
      if (stretchMode) {
        stretch.unlockAudio(); // the same click lets the pull's melody play in the headset
        void stretch.armCamera();
      }
      launchSession(() => this.world.launchXR(), stretchMode);
    };
    const onStack = () => applyMode('stack');
    const onStretch = () => applyMode('stretch');
    const onSorang = () => applyMode('sorang');
    const onImage = () => {
      // Start the model download while the picker is open; a loaded picture needs it.
      prepareDepthModel().catch(() => {});
      imageFile?.click();
    };
    const onImageFile = () => {
      const f = imageFile?.files?.[0];
      if (imageFile) imageFile.value = '';
      if (!f) return;
      if (f.type && !f.type.startsWith('image/')) {
        this.toast(`${f.name} isn’t an image file.`);
        return;
      }
      void sorang.useImage(f);
    };
    const onPlay = () => {
      sorang.restart();
      this.cardOpen = false;
      syncCard();
    };
    const onCard = () => {
      this.cardOpen = true;
      syncCard();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Escape' || e.repeat || getMode() !== 'sorang') return;
      // The first Esc releases the mouse. The card toggles once the view is free.
      if (document.pointerLockElement) return;
      this.cardOpen = !this.cardOpen;
      syncCard();
    };
    rate.addEventListener('change', onRate);
    load.addEventListener('click', onLoad);
    file.addEventListener('change', onFile);
    enter.addEventListener('click', onEnter);
    modeStack.addEventListener('click', onStack);
    modeStretch.addEventListener('click', onStretch);
    modeSorang?.addEventListener('click', onSorang);
    imageBtn?.addEventListener('click', onImage);
    imageFile?.addEventListener('change', onImageFile);
    playBtn?.addEventListener('click', onPlay);
    cardBtn?.addEventListener('click', onCard);
    window.addEventListener('keydown', onKey);
    const params = new URLSearchParams(location.search);
    const lensOn = params.get('lens') === 'overlay';
    const handsOn = params.get('occ') === 'debug';
    const consoleOn = params.get('debug') === '1';
    const pushDemo = params.get('demo') === 'push';
    const checkId = lensOn ? 'checkLens' : handsOn ? 'checkHands' : consoleOn ? 'checkConsole' : '';
    if (checkId) document.getElementById(checkId)?.setAttribute('aria-current', 'page');
    const modeParam = params.get('mode');
    if (isMode(modeParam)) applyMode(modeParam);
    else if (lensOn || handsOn || consoleOn || pushDemo) applyMode('stretch');

    if (this.world.xrEnabled && navigator.xr) {
      navigator.xr.isSessionSupported('immersive-ar').then(
        (ok) => {
          xrKnown = true;
          xrOk = ok;
          syncEnter();
        },
        () => {
          xrKnown = true;
          syncEnter();
        },
      );
    } else {
      xrKnown = true;
      syncEnter();
    }

    // Sorang doesn't need the clip; slicing it in the background would only cost frames.
    if (getMode() !== 'sorang') openDefaultOnce();

    this.cleanupFuncs.push(
      stack.onChange(render),
      sorang.onChange(renderSorang),
      sorang.onMessage((message) => {
        this.toast(message);
        if (getMode() !== 'sorang') return;
        this.cardOpen = true;
        syncCard();
      }),
      this.visibilityState.subscribe((state) => {
        this.immersive = state !== VisibilityState.NonImmersive;
        syncCard();
      }),
      () => {
        rate.removeEventListener('change', onRate);
        load.removeEventListener('click', onLoad);
        file.removeEventListener('change', onFile);
        enter.removeEventListener('click', onEnter);
        modeStack.removeEventListener('click', onStack);
        modeStretch.removeEventListener('click', onStretch);
        modeSorang?.removeEventListener('click', onSorang);
        imageBtn?.removeEventListener('click', onImage);
        imageFile?.removeEventListener('change', onImageFile);
        playBtn?.removeEventListener('click', onPlay);
        cardBtn?.removeEventListener('click', onCard);
        window.removeEventListener('keydown', onKey);
        clearTimeout(this.tipTimer);
        if (this.video) disposeVideo(this.video);
      },
    );
  }

  private async openDefault(stack: FrameStackSystem, rate: HTMLSelectElement, source: HTMLElement): Promise<void> {
    const gen = ++this.loadGen;
    source.textContent = `Opening ${DEFAULT_CLIP_NAME}`;
    const video = await loadVideoUrl(DEFAULT_CLIP_URL, DEFAULT_CLIP_NAME, DEFAULT_CLIP_DEPTH);
    if (gen !== this.loadGen) {
      if (video) disposeVideo(video);
      return;
    }
    if (!video) {
      this.toast('Couldn’t open the default clip. Showing the demo instead.');
      void stack.build(demoSource());
      return;
    }
    this.useVideo(video, stack, rate);
  }

  private async open(file: File, stack: FrameStackSystem, rate: HTMLSelectElement, source: HTMLElement): Promise<void> {
    if (file.type && !file.type.startsWith('video/')) {
      this.toast(`${file.name} isn’t a video file.`);
      return;
    }
    const gen = ++this.loadGen;
    source.textContent = `Opening ${file.name}`;
    const video = await loadVideoFile(file);
    if (gen !== this.loadGen) {
      if (video) disposeVideo(video);
      return;
    }
    if (!video) {
      this.toast(`Couldn’t decode ${file.name}. MP4 (H.264) and WebM files work in most browsers.`);
      stack.notify();
      return;
    }
    this.useVideo(video, stack, rate);
  }

  private useVideo(video: LoadedVideo, stack: FrameStackSystem, rate: HTMLSelectElement): void {
    if (this.video) disposeVideo(this.video);
    this.video = video;
    stack.rate = autoRate(video.el.duration);
    rate.value = String(stack.rate);
    void stack.build(videoSource(video));
  }

  /**
   * The desk preview needs a webcam. A headset already has passthrough, and opening the camera
   * here paints that feed across the browser page, so there it only asks for permission (a
   * stream that stops at once). Asking inside the session can end the session.
   */
  private armStretchCamera(stretch: RoomStretchSystem, syncEnter: () => void): void {
    const arm = () => {
      void stretch.armCamera().then((ok) => {
        this.stretchHint = ok ? STRETCH_CAMERA : STRETCH_BLOCKED;
        syncEnter();
      });
    };
    const xr = navigator.xr;
    if (!xr || PREVIEW_FORCED) {
      arm();
      return;
    }
    void xr.isSessionSupported('immersive-ar').then((ok) => {
      if (getMode() !== 'stretch') return;
      if (!ok) {
        arm();
        return;
      }
      if (this.cameraAsked) return;
      this.cameraAsked = true;
      this.cameraAsking = true;
      this.stretchHint = STRETCH_ASKING;
      syncEnter();
      CameraUtils.getDevices().then(
        () => {
          this.stretchHint = STRETCH_HINT;
        },
        () => {
          this.cameraAsked = false;
          this.stretchHint = STRETCH_BLOCKED;
        },
      ).finally(() => {
        this.cameraAsking = false;
        syncEnter();
      });
    });
  }

  private applyPreview(mode: ExperienceMode): void {
    if (this.renderer.xr.isPresenting) return;
    const cam = this.camera;
    if (!this.previewSaved) {
      this.previewPos.copy(cam.position);
      this.previewQuat.copy(cam.quaternion);
      this.previewSaved = true;
    }
    if (mode === 'sorang') return; // SorangSystem places the camera itself
    if (mode === 'stretch') {
      cam.position.set(0.25, 1.6, 2.5);
      cam.lookAt(0, 1, -1.7);
      return;
    }
    cam.position.copy(this.previewPos);
    cam.quaternion.copy(this.previewQuat);
  }

  private toast(message: string): void {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      el.hidden = true;
    }, 6500);
  }
}
