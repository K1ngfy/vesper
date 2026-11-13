import { startEngineJob } from '@/src/core/worker-job';
import type { Scheme } from '@/src/core/types';
import { ENGINE_PORT } from '@/src/messages';

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== ENGINE_PORT || port.sender?.id !== chrome.runtime.id) return;
  let job: ReturnType<typeof startEngineJob> | undefined;
  let connected = true;
  port.onDisconnect.addListener(() => {
    connected = false;
    job?.cancel();
  });
  port.onMessage.addListener(async ({ text, scheme }: { text: string; scheme: Scheme }) => {
    if (job) return;
    try {
      job = startEngineJob(text, scheme);
      const result = await job.result;
      if (connected) port.postMessage(result);
    } catch {
      if (connected) port.disconnect();
    }
  });
});
