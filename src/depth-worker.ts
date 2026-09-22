/**
 * Depth Anything V2 small, off the render thread.
 * WASM, one thread: Quest's immersive session already owns the GPU, and the
 * page is not cross-origin isolated, so WebGPU and threaded WASM are out.
 * The dynamic import stays inside the worker so the model never joins the XR bundle.
 */

interface DepthImage {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  channels?: number;
}

type DepthPipe = (image: unknown) => Promise<{ depth?: DepthImage }>;
type RawImageCtor = new (data: Uint8ClampedArray, width: number, height: number, channels: number) => unknown;

let RawImage: RawImageCtor | null = null;

interface PrepareMsg {
  type: 'prepare';
}
interface EstimateMsg {
  type: 'estimate';
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
type InMsg = PrepareMsg | EstimateMsg;

interface DepthScope {
  postMessage(message: object, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<InMsg>) => void) | null;
}

const MODEL = 'onnx-community/depth-anything-v2-small';
const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5/+esm';

const scope = self as unknown as DepthScope;
let pipe: DepthPipe | null = null;

function post(message: object, transfer?: Transferable[]): void {
  if (transfer) scope.postMessage(message, transfer);
  else scope.postMessage(message);
}

/** Stretch onto the 2nd–98th percentile so a flat scene still has relief. */
function stretch(src: Uint8Array | Uint8ClampedArray, channels: number, count: number): Uint8Array {
  const hist = new Uint32Array(256);
  for (let i = 0; i < count; i++) hist[src[i * channels]]++;
  const cutoff = Math.max(1, Math.round(count * 0.02));
  let lo = 0;
  let hi = 255;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= cutoff) {
      lo = v;
      break;
    }
  }
  acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= cutoff) {
      hi = v;
      break;
    }
  }
  const out = new Uint8Array(count);
  const spread = hi - lo;
  if (spread < 8) {
    for (let i = 0; i < count; i++) out[i] = src[i * channels];
    return out;
  }
  const scale = 255 / spread;
  for (let i = 0; i < count; i++) {
    let v = (src[i * channels] - lo) * scale;
    if (v < 0) v = 0;
    else if (v > 255) v = 255;
    out[i] = v;
  }
  return out;
}

async function loadPipe(): Promise<DepthPipe> {
  // CDN module: Vite must not bundle it, and the worker must not import it at startup.
  const transformers = (await import(/* @vite-ignore */ TRANSFORMERS)) as {
    env: {
      allowLocalModels: boolean;
      allowRemoteModels: boolean;
      useBrowserCache: boolean;
      backends: { onnx: { wasm: { numThreads: number } } };
    };
    pipeline: (task: string, model: string, options: { device: string; dtype: string }) => Promise<DepthPipe>;
    RawImage: RawImageCtor;
  };
  transformers.env.allowLocalModels = false;
  transformers.env.allowRemoteModels = true;
  transformers.env.useBrowserCache = true;
  const wasm = transformers.env.backends?.onnx?.wasm;
  if (wasm) wasm.numThreads = 1;
  RawImage = transformers.RawImage;
  const attempts = [
    { device: 'wasm', dtype: 'q8' },
    { device: 'wasm', dtype: 'fp32' },
  ];
  let last: unknown = null;
  for (const attempt of attempts) {
    try {
      return await transformers.pipeline('depth-estimation', MODEL, attempt);
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error ? last : new Error('depth model failed');
}

async function prepare(): Promise<void> {
  if (pipe) {
    post({ type: 'ready' });
    return;
  }
  post({ type: 'progress', message: 'Loading depth model' });
  pipe = await loadPipe();
  if (!RawImage) throw new Error('depth model failed');
  const blank = new Uint8ClampedArray(64 * 64 * 4);
  blank.fill(128);
  try {
    await pipe(new RawImage(blank, 64, 64, 4));
  } catch {
    // Warm-up compiles the kernels. A failure here still leaves the pipe usable.
  }
  post({ type: 'ready' });
}

async function estimate(width: number, height: number, data: Uint8ClampedArray): Promise<void> {
  try {
    if (!pipe || !RawImage) await prepare();
    if (!pipe || !RawImage) throw new Error('depth model failed');
    post({ type: 'progress', message: 'Reading depth' });
    const out = await pipe(new RawImage(data, width, height, 4));
    const depth = out.depth;
    if (!depth) throw new Error('model returned no depth map');
    const channels = depth.channels || 1;
    const gray = stretch(depth.data, channels, depth.width * depth.height);
    post({ type: 'depth', width: depth.width, height: depth.height, data: gray }, [gray.buffer]);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : 'depth failed' });
  }
}

let chain: Promise<void> = Promise.resolve();

scope.onmessage = (event: MessageEvent<InMsg>) => {
  const msg = event.data;
  chain = chain
    .then(async () => {
      switch (msg.type) {
        case 'prepare':
          await prepare();
          return;
        case 'estimate':
          await estimate(msg.width, msg.height, msg.data);
          return;
        default: {
          const never: never = msg;
          throw new Error(`unknown depth message ${String(never)}`);
        }
      }
    })
    .catch((err: unknown) => {
      post({ type: 'error', message: err instanceof Error ? err.message : 'depth failed' });
    });
};
