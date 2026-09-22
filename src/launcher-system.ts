import { createSystem, VisibilityState } from '@iwsdk/core';
import { prepareDepthModel } from './depth-model.js';
import {
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
import { TableTouchSystem } from './table-touch-system.js';

const NO_PASSTHROUGH = 'Open this page in the Meta Quest browser to use passthrough.';
const DEPTH_WAIT = 'Downloading the depth model. Passthrough unlocks when it’s ready.';
const DEPTH_FAIL = 'The depth model didn’t load. Reload the page to try again.';

/** Wires the 2D launch card in index.html: pick a clip and a sample rate, then enter passthrough. */
export class LauncherSystem extends createSystem({}) {
  private video: LoadedVideo | null = null;
  private toastTimer = 0;
  /** Bumped on every open so a slower load can't replace a newer clip. */
  private loadGen = 0;

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
    if (!launch || !source || !progress || !bar || !rate || !rateNote || !load || !enter || !file || !hint) {
      void stack.build(demoSource());
      return;
    }
    const touch = this.world.getSystem(TableTouchSystem)!;

    const render = () => {
      source.textContent = stack.describe();
      progress.hidden = stack.ready;
      bar.style.transform = `scaleX(${stack.N ? stack.loaded / stack.N : 0})`;
      rateNote.textContent = stack.rateNote();
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
      touch.unlockAudio(); // this click is the gesture that lets scrub ticks play in the headset
      this.world.launchXR();
    };
    rate.addEventListener('change', onRate);
    load.addEventListener('click', onLoad);
    file.addEventListener('change', onFile);
    enter.addEventListener('click', onEnter);

    enter.disabled = true;
    const placeHint = hint.textContent ?? '';
    let xrKnown = false;
    let xrOk = false;
    let depthReady = false;
    let depthNote = DEPTH_WAIT;
    const syncEnter = () => {
      enter.disabled = !(xrOk && depthReady);
      if (!xrKnown) return;
      if (!xrOk) hint.textContent = NO_PASSTHROUGH;
      else if (!depthReady) hint.textContent = depthNote;
      else hint.textContent = placeHint;
    };
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

    void prepareDepthModel().then(
      () => {
        depthReady = true;
        syncEnter();
      },
      () => {
        depthNote = DEPTH_FAIL;
        syncEnter();
      },
    );

    void this.openDefault(stack, rate, source);

    this.cleanupFuncs.push(
      stack.onChange(render),
      this.visibilityState.subscribe((state) => {
        launch.hidden = state !== VisibilityState.NonImmersive;
      }),
      () => {
        rate.removeEventListener('change', onRate);
        load.removeEventListener('click', onLoad);
        file.removeEventListener('change', onFile);
        enter.removeEventListener('click', onEnter);
        if (this.video) disposeVideo(this.video);
      },
    );
  }

  private async openDefault(stack: FrameStackSystem, rate: HTMLSelectElement, source: HTMLElement): Promise<void> {
    const gen = ++this.loadGen;
    source.textContent = `Opening ${DEFAULT_CLIP_NAME}`;
    const video = await loadVideoUrl(DEFAULT_CLIP_URL, DEFAULT_CLIP_NAME);
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
