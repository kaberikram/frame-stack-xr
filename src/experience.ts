export type ExperienceMode = 'stack' | 'stretch';

/**
 * `?preview=1` forces the desk stand-in room and webcam even where the dev server's
 * emulator makes the page look like a headset.
 */
export const PREVIEW_FORCED = typeof location !== 'undefined' && new URLSearchParams(location.search).has('preview');

let mode: ExperienceMode = 'stack';

export function getMode(): ExperienceMode {
  return mode;
}

export function setMode(next: ExperienceMode): void {
  mode = next;
}

/**
 * `camera-access` is optional: Quest Browser still rejects it when required, and
 * ignores it when the feature is missing. If a build rejects the whole session
 * over that token, start again without it.
 */
export function launchSession(launch: () => void, requestCamera: boolean): void {
  const xr = navigator.xr;
  if (!requestCamera || !xr) {
    launch();
    return;
  }
  const original = xr.requestSession.bind(xr);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    xr.requestSession = original;
  };
  xr.requestSession = ((sessionMode, init) => {
    restore();
    const optional = [...(init?.optionalFeatures ?? [])];
    if (!optional.includes('camera-access')) optional.push('camera-access');
    return original(sessionMode, { ...init, optionalFeatures: optional }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!/camera-access/i.test(message)) throw error;
      console.warn(`[jonze] session refused camera-access, retrying without it: ${message}`);
      return original(sessionMode, init);
    });
  }) as typeof xr.requestSession;
  try {
    launch();
  } finally {
    restore();
  }
}
