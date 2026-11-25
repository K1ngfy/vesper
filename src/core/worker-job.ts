import EngineWorker from './engine.worker?worker';
import type { DesensitizeResult, Scheme } from './types';

let idleWorker: Worker | null = null;

function acquireWorker(): Worker {
  if (idleWorker) {
    const worker = idleWorker;
    idleWorker = null;
    return worker;
  }
  return new EngineWorker();
}

function releaseWorker(worker: Worker): void {
  worker.onmessage = null;
  worker.onerror = null;
  worker.onmessageerror = null;
  if (!idleWorker) idleWorker = worker;
  else worker.terminate();
}

/** Run in an extension page, where the worker URL and CSP belong to VESPER. */
export function startEngineJob(text: string, scheme: Scheme, validate = false) {
  const worker = acquireWorker();
  let timer: ReturnType<typeof setTimeout>;
  let settled = false;
  let cancel: () => void;
  const result = new Promise<DesensitizeResult>((resolve, reject) => {
    const finish = (reusable: boolean, fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (reusable) releaseWorker(worker);
      else worker.terminate();
      fn();
    };
    cancel = () => finish(false, () => reject(new Error('engine-cancelled')));
    timer = setTimeout(() => finish(false, () => reject(new Error('engine-timeout'))), 10_000);
    worker.onmessage = ({ data }) => {
      if (data.error) finish(true, () => reject(new Error(data.error)));
      else finish(true, () => resolve(data.result));
    };
    worker.onerror = () => finish(false, () => reject(new Error('engine-worker-error')));
    worker.onmessageerror = () => finish(false, () => reject(new Error('engine-message-error')));
    try {
      worker.postMessage({ text, scheme, validate });
    } catch (error) {
      finish(false, () => reject(error));
    }
  });
  return { result, cancel: () => cancel() };
}
