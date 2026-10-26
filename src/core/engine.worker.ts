/**
 * 大文本脱敏 Worker（文档 4.3：>500KB 走 Web Worker 避免冻 UI）。
 * 经 vite `?worker` 引入，消息协议：{ text, scheme } → DesensitizeResult。
 */
import { desensitize } from './engine';

self.onmessage = (e: MessageEvent) => {
  const { text, scheme } = e.data;
  const res = desensitize(text, scheme);
  self.postMessage(res);
};
