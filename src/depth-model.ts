/** Talks to the depth worker. Safe to call before the first pinch; later calls join the same load. */

export interface DepthField {
  width: number;
  height: number;
  data: Uint8Array;
}

interface WorkerMsg {
  type: string;
  message?: string;
  width?: number;
  height?: number;
  data?: Uint8Array;
}

let worker: Worker | null = null;
let loading: Promise<void> | null = null;
let serial = 0;

function depthWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./depth-worker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('error', () => {
    loading = null;
  });
  return worker;
}

export function prepareDepthModel(): Promise<void> {
  if (loading) return loading;
  const thread = depthWorker();
  loading = new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<WorkerMsg>) => {
      if (event.data.type === 'ready') {
        thread.removeEventListener('message', onMessage);
        resolve();
      } else if (event.data.type === 'error') {
        thread.removeEventListener('message', onMessage);
        loading = null;
        reject(new Error(event.data.message ?? 'depth model failed'));
      }
    };
    thread.addEventListener('message', onMessage);
    thread.postMessage({ type: 'prepare' });
  });
  return loading;
}

/** Drops a result that lands after the card was closed. */
export function cancelDepth(): void {
  serial += 1;
}

export function estimateDepth(canvas: HTMLCanvasElement): Promise<DepthField> {
  const ticket = ++serial;
  return prepareDepthModel().then(async () => {
    if (ticket !== serial) throw new Error('cancelled');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('depth failed');
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = new Uint8ClampedArray(pixels.data);
    const thread = depthWorker();
    return new Promise((resolve, reject) => {
      const onMessage = (event: MessageEvent<WorkerMsg>) => {
        const msg = event.data;
        if (msg.type === 'progress' || msg.type === 'ready') return;
        thread.removeEventListener('message', onMessage);
        if (ticket !== serial) {
          reject(new Error('cancelled'));
          return;
        }
        if (msg.type === 'depth' && msg.data && msg.width && msg.height) {
          resolve({ width: msg.width, height: msg.height, data: msg.data });
          return;
        }
        reject(new Error(msg.message ?? 'depth failed'));
      };
      thread.addEventListener('message', onMessage);
      thread.postMessage({ type: 'estimate', width: canvas.width, height: canvas.height, data }, [data.buffer]);
    });
  });
}
