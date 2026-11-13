import EngineWorker from './engine.worker?worker';
import type { DesensitizeResult, Scheme } from './types';

/** Run in an extension page, where the worker URL and CSP belong to VESPER. */
export function startEngineJob(text: string, scheme: Scheme, validate = false) {
  const worker = new EngineWorker();
  let timer: ReturnType<typeof setTimeout>;
  let cancel: () => void;
  const result = new Promise<DesensitizeResult>((resolve, reject) => {
    cancel = () => reject(new Error('engine-cancelled'));
    timer = setTimeout(() => reject(new Error('engine-timeout')), 10_000);
    worker.onmessage = ({ data }) => {
      if (data.error) reject(new Error(data.error));
      else resolve(data.result);
    };
    worker.onerror = () => reject(new Error('engine-worker-error'));
    worker.onmessageerror = () => reject(new Error('engine-message-error'));
    worker.postMessage({ text, scheme, validate });
  }).finally(() => {
    clearTimeout(timer);
    worker.terminate();
  });
  return { result, cancel: () => cancel() };
}
