import { CameraUtils, Quaternion, SessionMode, Vector3, VisibilityState, createSystem } from '@iwsdk/core';
import { prepareDepthModel } from './depth-model.js';
import { PREVIEW_FORCED, getMode, isMode, isStageMode, launchSession, setMode, type ExperienceMode } from './experience.js';
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
import { RoomsSystem } from './rooms-system.js';
import { SorangSystem } from './sorang-system.js';
import { TableTouchSystem } from './table-touch-system.js';

const NO_PASSTHROUGH = 'Open this page in the Meta Quest browser to use passthrough.';
const DEPTH_WAIT = 'Downloading the depth model. Passthrough unlocks when it’s ready.';
const DEPTH_FAIL = 'The depth model didn’t load. Reload the page to try again.';
const STRETCH_HINT = 'Round 8. Aim your fist like a vacuum. Hold longer and it takes everything.';
const STRETCH_CAMERA = 'Camera on. Aim a fist like a vacuum, push a palm into a wall, or pinch and pull.';
const STRETCH_ASKING = 'Allow the camera so the pull can show your room.';
const STRETCH_BLOCKED = 'Camera blocked. Allow it for this site so the pull can show your room.';
const SORANG_HINT = 'Click the view to start the music and look around. WASD walks. Or enter VR and stand in front of it.';
const SORANG_NO_VR = 'Click the view to start the music and look around. WASD walks. Open this page in the Meta Quest browser for VR.';
const SORANG_TIP = 'Click to look around. WASD walks. R starts the song again.';
const SORANG_CLICK = 'Click to start the music.';
const SORANG_TIP_MS = 4000;
const ROOMS_HINT = 'Desktop only. Click the view to start the music.';
const ROOMS_TIP = 'Space pauses. R starts the song again. ←/→ jump a bar. Esc shows the card.';
const ENTER_PASSTHROUGH = 'Enter passthrough';
const ENTER_VR = 'Enter VR';

const TITLES: Record<ExperienceMode, string> = { stack: 'Frame stack', stretch: 'Jonze stretch', sorang: 'Sorang', rooms: 'Rooms' };

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
  /** Sorang and Rooms play behind a collapsed card; the chip or Esc opens it. */
  private cardOpen = true;
  private immersive = false;
  private readonly uiOff = typeof location !== 'undefined' && new URLSearchParams(location.search).get('ui') === '0';
  private tipShown = false;
  private tipTimer = 0;
  /** The tip is asking for the click that lets the music play. */
  private clickTip = false;

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
    const rooms = this.world.getSystem(RoomsSystem)!;
    // Optional, like Sorang's.
    const modeRooms = document.getElementById('modeRooms');
    const roomsPanel = document.getElementById('roomsPanel');
    const roomsSource = document.getElementById('roomsSource');
    const version = document.getElementById('stretchVersion');
    if (version) {
      version.textContent =
        `Round 8 · jonze-${__BUILD_SHA__}. Aim your fist like a vacuum: shards in front of it swirl into ` +
        'the fist. Hold longer and it takes the whole room, leaving pitch black.';
    }

    enter.disabled = true;
    const placeHint = hint.textContent ?? '';
    let xrKnown = false;
    let xrOk = false;
    let vrOk = false;
    let depthRequested = false;
    let depthReady = false;
    let depthNote = DEPTH_WAIT;
    const syncEnter = () => {
      if (getMode() === 'rooms') {
        hint.textContent = ROOMS_HINT;
        return;
      }
      if (getMode() === 'sorang') {
        enter.disabled = !vrOk;
        hint.textContent = vrOk || !xrKnown ? SORANG_HINT : SORANG_NO_VR;
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
      const stageMode = isStageMode(getMode());
      launch.hidden = this.immersive || (stageMode && (!this.cardOpen || this.uiOff));
      if (cardBtn) cardBtn.hidden = this.immersive || !stageMode || this.cardOpen || this.uiOff;
      if (tip && (!stageMode || this.uiOff || this.immersive)) tip.hidden = true;
    };
    const renderRooms = () => {
      if (roomsSource) roomsSource.textContent = rooms.status().text;
      if (!tip || this.uiOff || getMode() !== 'rooms' || this.immersive) return;
      if (rooms.needsClick) {
        clearTimeout(this.tipTimer);
        this.clickTip = true;
        tip.textContent = SORANG_CLICK;
        tip.hidden = false;
        return;
      }
      if (this.clickTip) {
        this.clickTip = false;
        tip.hidden = true;
      }
      if (this.tipShown || rooms.currentPhase !== 'playing') return;
      this.tipShown = true;
      tip.textContent = ROOMS_TIP;
      tip.hidden = false;
      clearTimeout(this.tipTimer);
      this.tipTimer = window.setTimeout(() => {
        tip.hidden = true;
      }, SORANG_TIP_MS);
    };
    const renderSorang = () => {
      if (sorangSource) sorangSource.textContent = sorang.status().text;
      if (getMode() === 'rooms') {
        renderRooms();
        return;
      }
      if (!tip || this.uiOff || getMode() !== 'sorang' || this.immersive) return;
      if (sorang.needsClick) {
        // Browsers start sound only after a click or a key; ask for one while the painting waits.
        clearTimeout(this.tipTimer);
        this.clickTip = true;
        tip.textContent = SORANG_CLICK;
        tip.hidden = false;
        return;
      }
      if (this.clickTip) {
        this.clickTip = false;
        tip.hidden = true;
      }
      const drifting = sorang.stage === 'drift' || sorang.stage === 'orbit';
      if (this.tipShown || !drifting) return;
      this.tipShown = true;
      tip.textContent = SORANG_TIP;
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
      ['rooms', modeRooms],
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
      if (roomsPanel) roomsPanel.hidden = mode !== 'rooms';
      load.hidden = mode !== 'stack';
      if (imageBtn) imageBtn.hidden = mode !== 'sorang';
      if (playBtn) playBtn.hidden = !isStageMode(mode);
      // Rooms is desktop only: there is nothing to enter.
      enter.hidden = mode === 'rooms';
      enter.textContent = mode === 'sorang' ? ENTER_VR : ENTER_PASSTHROUGH;
      for (const [m, tab] of tabs) tab?.setAttribute('aria-selected', m === mode ? 'true' : 'false');
      this.applyPreview(mode);
      if (mode === 'stretch') this.armStretchCamera(stretch, syncEnter);
      if (mode === 'stack') {
        openDefaultOnce();
        requestDepthModel();
      }
      if (isStageMode(mode)) {
        // The piece plays behind a collapsed card; a second click on the tab doesn't restart it.
        if (was !== mode) {
          this.tipShown = false;
          this.clickTip = false;
          if (tip) tip.hidden = true;
        }
        this.cardOpen = false;
      } else {
        this.cardOpen = true;
        this.clickTip = false;
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
      if (getMode() === 'sorang') {
        // This click is the gesture that lets the song play in the headset. Start from the top there.
        sorang.unlockAudio();
        sorang.restart();
        this.world.launchXR({
          sessionMode: SessionMode.ImmersiveVR,
          features: { handTracking: true, anchors: false, planeDetection: false, meshDetection: false, depthSensing: false },
        });
        return;
      }
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
    const onSorang = () => {
      // The tab click is a gesture: the music may start as soon as the painting is ready.
      sorang.unlockAudio();
      applyMode('sorang');
    };
    const onRooms = () => {
      // The tab click is a gesture: the music may start as soon as the frame is up.
      rooms.unlockAudio();
      applyMode('rooms');
    };
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
      if (getMode() === 'rooms') {
        rooms.unlockAudio();
        rooms.restart();
      } else {
        sorang.unlockAudio();
        sorang.restart();
      }
      this.cardOpen = false;
      syncCard();
    };
    const onCard = () => {
      this.cardOpen = true;
      syncCard();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Escape' || e.repeat || !isStageMode(getMode())) return;
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
    modeRooms?.addEventListener('click', onRooms);
    imageBtn?.addEventListener('click', onImage);
    imageFile?.addEventListener('change', onImageFile);
    playBtn?.addEventListener('click', onPlay);
    cardBtn?.addEventListener('click', onCard);
    window.addEventListener('keydown', onKey);
    const params = new URLSearchParams(location.search);
    const lensOn = params.get('lens') === 'overlay';
    const handsOn = params.get('occ') === 'debug';
    const consoleOn = params.get('debug') === '1';
    const pushDemo = params.get('demo') === 'push' || params.get('demo') === 'void';
    const checkId = lensOn ? 'checkLens' : handsOn ? 'checkHands' : consoleOn ? 'checkConsole' : '';
    if (checkId) document.getElementById(checkId)?.setAttribute('aria-current', 'page');
    const modeParam = params.get('mode');
    if (isMode(modeParam)) applyMode(modeParam);
    else if (lensOn || handsOn || consoleOn || pushDemo) applyMode('stretch');

    if (this.world.xrEnabled && navigator.xr) {
      const xr = navigator.xr;
      const vr = xr.isSessionSupported('immersive-vr').then(
        (ok) => ok,
        () => false,
      );
      xr.isSessionSupported('immersive-ar').then(
        async (ok) => {
          vrOk = await vr;
          xrKnown = true;
          xrOk = ok;
          syncEnter();
        },
        async () => {
          vrOk = await vr;
          xrKnown = true;
          syncEnter();
        },
      );
    } else {
      xrKnown = true;
      syncEnter();
    }

    // Sorang and Rooms don't need the clip; slicing it in the background would only cost frames.
    if (!isStageMode(getMode())) openDefaultOnce();

    this.cleanupFuncs.push(
      stack.onChange(render),
      sorang.onChange(renderSorang),
      rooms.onChange(renderRooms),
      sorang.onMessage((message) => {
        this.toast(message);
        if (getMode() !== 'sorang') return;
        this.cardOpen = true;
        syncCard();
      }),
      this.visibilityState.subscribe((state) => {
        const was = this.immersive;
        this.immersive = state !== VisibilityState.NonImmersive;
        // However the session began (Enter VR, or the browser's own offer), Sorang starts from the top in it.
        if (this.immersive && !was && getMode() === 'sorang') sorang.restart();
        syncCard();
        renderSorang();
      }),
      () => {
        rate.removeEventListener('change', onRate);
        load.removeEventListener('click', onLoad);
        file.removeEventListener('change', onFile);
        enter.removeEventListener('click', onEnter);
        modeStack.removeEventListener('click', onStack);
        modeStretch.removeEventListener('click', onStretch);
        modeSorang?.removeEventListener('click', onSorang);
        modeRooms?.removeEventListener('click', onRooms);
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
    if (isStageMode(mode)) return; // SorangSystem and RoomsSystem place the camera themselves
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
