import { startEngineJob } from '@/src/core/worker-job';
import type { DesensitizeResult, Scheme } from '@/src/core/types';
import { ENGINE_PORT } from '@/src/messages';

const PREVIEW_HIT_LIMIT = 50;
const PREVIEW_EXCERPT_LEN = 301;

/**
 * 压缩回传给 content script 的结果：预览弹窗最多只展示前 50 条（每条截断 300 字），
 * 仅回传精简预览列表 + 总命中数 hitCount，避免数十万条 hits 膨胀触碰 Chrome 64MiB IPC 上限
 * 或在宿主网页主线程 JSON 反序列化时造成卡顿。
 */
function compactForContent(result: DesensitizeResult): DesensitizeResult {
  const needsSlice = result.hits.length > PREVIEW_HIT_LIMIT;
  const previewHits = needsSlice ? result.hits.slice(0, PREVIEW_HIT_LIMIT) : result.hits;
  const needsClip = previewHits.some(
    (h) => h.original.length > PREVIEW_EXCERPT_LEN || h.replaced.length > PREVIEW_EXCERPT_LEN,
  );
  if (!needsSlice && !needsClip) return result;
  const clip = (s: string) =>
    s.length > PREVIEW_EXCERPT_LEN ? s.slice(0, PREVIEW_EXCERPT_LEN) : s;
  return {
    output: result.output,
    hitCount: result.hits.length,
    hits: previewHits.map((h) => ({
      ...h,
      original: clip(h.original),
      replaced: clip(h.replaced),
    })),
    mapping: result.mapping,
    durationMs: result.durationMs,
  };
}

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
      if (connected) port.postMessage(compactForContent(result));
    } catch {
      if (connected) port.disconnect();
    }
  });
});
