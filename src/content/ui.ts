/**
 * 注入 UI（文档 4.6）：Shadow DOM 渲染，与宿主页面样式完全隔离。
 * 不用 React，保持 content script 轻量；品牌色：深空蓝底 + 星芒橙强调。
 *
 * 护栏：所有根节点带 data-vesper-ui 标记，粘贴监听器据此跳过自身 UI。
 */
import type { DesensitizeResult } from '../core/types';
import { t } from '../i18n';

const HOST_ID = 'vesper-shadow-host';

function ensureHost(): ShadowRoot {
  let host = document.getElementById(HOST_ID) as HTMLElement | null;
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-vesper-ui', '1');
    document.documentElement.appendChild(host);
    host.attachShadow({ mode: 'open' });
  }
  return host.shadowRoot!;
}

const BASE_STYLE = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  /* 极简黑白：白底黑字、黑边、黑按钮白字 */
  .panel {
    background: #ffffff; color: #111111;
    border: 1px solid #111111;
    border-radius: 8px; box-shadow: 0 12px 40px rgba(0,0,0,.18);
  }
  .btn {
    border: 1px solid #111111; border-radius: 6px; padding: 8px 14px; font-size: 13px;
    cursor: pointer; color: #ffffff; background: #111111;
  }
  .btn:hover { background: #333333; }
  .btn.ghost { background: #ffffff; border: 1px solid #9ca3af; color: #111111; }
  .btn.danger { background: #ffffff; border: 1px solid #111111; color: #111111; }
  del { color: #6b7280; text-decoration: line-through; }
  mark { background: #f3f4f6; color: #111111; border-radius: 2px; padding: 0 2px; }
`;

function makeStyleRoot(shadow: ShadowRoot): void {
  const style = document.createElement('style');
  style.textContent = BASE_STYLE;
  shadow.appendChild(style);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface PreviewActions {
  onConfirm: () => void;
  onPasteOriginal: () => void;
  onCancel: () => void;
}

/** 预览弹窗：命中 diff（原文删除线 / 结果高亮）+ 三个操作按钮 */
export function showPreview(res: DesensitizeResult, actions: PreviewActions): void {
  const shadow = ensureHost();
  shadow.innerHTML = '';
  makeStyleRoot(shadow);

  const wrap = document.createElement('div');
  wrap.setAttribute('data-vesper-ui', '1');
  wrap.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;';

  const rows = res.hits
    .slice(0, 50)
    .map(
      (h) =>
        `<div style="padding:6px 0;border-bottom:1px dashed #e5e5e5;font-size:13px;">
           <span style="color:#6b7280;">${escapeHtml(h.ruleName)}</span><br/>
           <del>${escapeHtml(h.original)}</del> → <mark>${escapeHtml(h.replaced)}</mark>
         </div>`,
    )
    .join('');

  wrap.innerHTML = `
    <div class="panel" style="width:min(560px,90vw);max-height:80vh;overflow:auto;padding:20px;">
      <div style="font-size:16px;font-weight:600;margin-bottom:4px;">
        ✳ ${t.content.previewTitle}
        <span style="font-size:12px;color:#6b7280;font-weight:400;">${t.content.previewHint(res.hits.length)}</span>
      </div>
      <div style="margin:12px 0;">${rows}</div>
      ${res.hits.length > 50 ? `<div style="color:#6b7280;font-size:12px;">… 共 ${res.hits.length} 处，仅展示前 50 条</div>` : ''}
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
        <button class="btn ghost" data-act="cancel">${t.content.btnCancel}</button>
        <button class="btn danger" data-act="original">${t.content.btnPasteOriginal}</button>
        <button class="btn" data-act="confirm">${t.content.btnDesensitizedPaste}</button>
      </div>
    </div>`;

  const close = () => {
    shadow.innerHTML = '';
  };
  wrap.querySelector('[data-act="confirm"]')!.addEventListener('click', () => {
    close();
    actions.onConfirm();
  });
  wrap.querySelector('[data-act="original"]')!.addEventListener('click', () => {
    // 粘贴原文需二次确认（文档 4.6）
    if (window.confirm(t.content.pasteOriginalConfirm)) {
      close();
      actions.onPasteOriginal();
    }
  });
  wrap.querySelector('[data-act="cancel"]')!.addEventListener('click', () => {
    close();
    actions.onCancel();
  });
  shadow.appendChild(wrap);
}

export interface ToastActions {
  onUndo?: () => void;
  onView?: () => void;
}

/** Toast：右下角浮层，6 秒自动消失，可带撤销/查看 */
export function showToast(message: string, actions: ToastActions = {}): void {
  const shadow = ensureHost();
  const style = document.createElement('style');
  style.textContent = BASE_STYLE;
  shadow.appendChild(style);

  const toast = document.createElement('div');
  toast.setAttribute('data-vesper-ui', '1');
  toast.className = 'panel';
  toast.style.cssText =
    'position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:12px 16px;display:flex;gap:12px;align-items:center;font-size:13px;';
  toast.innerHTML = `<span>✳ ${escapeHtml(message)}</span>`;

  if (actions.onUndo) {
    const undo = document.createElement('button');
    undo.className = 'btn ghost';
    undo.textContent = t.content.undo;
    undo.addEventListener('click', () => {
      actions.onUndo!();
      dismiss();
    });
    toast.appendChild(undo);
  }
  if (actions.onView) {
    const view = document.createElement('button');
    view.className = 'btn ghost';
    view.textContent = t.content.view;
    view.addEventListener('click', () => actions.onView!());
    toast.appendChild(view);
  }

  shadow.appendChild(toast);
  const timer = setTimeout(dismiss, 6000);
  function dismiss() {
    clearTimeout(timer);
    toast.remove();
  }
}

/** 判断事件目标是否在 VESPER 自身 UI 内（护栏） */
export function isOwnUI(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && el.closest('[data-vesper-ui]') != null;
}
