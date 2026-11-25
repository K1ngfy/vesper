// Side Panel 形态（文档 4.3）：复用同一工作台组件（上下分栏）
import React from 'react';
import ReactDOM from 'react-dom/client';
import WorkbenchApp from '@/src/ui/WorkbenchApp';
import '@/src/ui/global.css';

const isFallbackWindow = new URLSearchParams(location.search).get('mode') === 'window';

function hasArcCssVariables(): boolean {
  try {
    const s = getComputedStyle(document.documentElement);
    return Boolean(
      s.getPropertyValue('--arc-palette-title').trim() ||
      s.getPropertyValue('--arc-palette-background').trim() ||
      s.getPropertyValue('--arc-background-simple-color').trim(),
    );
  } catch {
    return false;
  }
}

/**
 * 核验原生 sidePanel 是否真实可见地渲染在屏幕上：
 * 新版 Arc 浏览器的 Chromium 内核虽暴露了 chrome.sidePanel.open 且会在内存中创建
 * SIDE_PANEL WebContents（使 getContexts 返回非空），但 Arc 窗口并未挂载该视图，
 * 导致其处于未合成/不可见或零尺寸状态。仅在非独立窗口模式下响应后台探活。
 */
if (!isFallbackWindow) {
  let rafConfirmed = false;
  const markRaf = () => {
    rafConfirmed = true;
  };
  requestAnimationFrame(markRaf);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestAnimationFrame(markRaf);
  });

  chrome.runtime?.onMessage?.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'PING_NATIVE_SIDE_PANEL') return false;
    const isArc = hasArcCssVariables();
    if (isArc) {
      void chrome.storage?.local?.set({ 'vesper:isArc': true }).catch(() => {});
    }
    const visible =
      !isArc &&
      rafConfirmed &&
      document.visibilityState === 'visible' &&
      !document.hidden &&
      window.innerWidth >= 100 &&
      window.innerHeight >= 100 &&
      window.outerWidth > 0;
    sendResponse({ visible, isArc });
    return false;
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WorkbenchApp layout="vertical" />
  </React.StrictMode>,
);
