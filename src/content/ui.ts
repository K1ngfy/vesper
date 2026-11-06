/**
 * 注入 UI（文档 4.6）：Shadow DOM 渲染，与宿主页面样式完全隔离。
 * 不用 React，保持 content script 轻量；品牌色：极简黑白。
 *
 * 护栏：
 * - 所有根节点带 data-vesper-ui 标记，粘贴监听器据此跳过自身 UI；
 * - **禁止 innerHTML 拼接**：主流 AI 站点启用 Trusted Types CSP
 *   （require-trusted-types-for 'script'），字符串赋给 innerHTML 会直接抛
 *   TrustedHTML 错误。一旦在 preview 里抛出，用户文本已被 preventDefault
 *   拦下却无处回填 —— 表现为"网页里粘不进去"。故全部改用 createElement +
 *   textContent 构建。
 */
import type { DesensitizeResult } from '../core/types';
import { t } from '../i18n';

const HOST_ID = 'vesper-shadow-host';
const STYLE_ATTR = 'data-vesper-style';

function ensureHost(): ShadowRoot {
  let host = document.getElementById(HOST_ID) as HTMLElement | null;
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-vesper-ui', '1');
    document.documentElement.appendChild(host);
  }
  if (!host.shadowRoot) host.attachShadow({ mode: 'open' });
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

  .overlay {
    position: fixed; inset: 0; z-index: 2147483647;
    background: rgba(0,0,0,.45);
    display: flex; align-items: center; justify-content: center;
  }
  .dialog { width: min(560px, 90vw); max-height: 80vh; overflow: auto; padding: 20px; }
  .title { font-size: 16px; font-weight: 600; margin-bottom: 4px; }
  .title .hint { font-size: 12px; color: #6b7280; font-weight: 400; margin-left: 6px; }
  .rows { margin: 12px 0; }
  .row { padding: 6px 0; border-bottom: 1px dashed #e5e5e5; font-size: 13px; }
  .row .rule { color: #6b7280; }
  .more { color: #6b7280; font-size: 12px; }
  .actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
  .toast {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
    padding: 12px 16px; display: flex; gap: 12px; align-items: center; font-size: 13px;
  }
`;

/** 样式节点只挂一次（重复挂会让 Shadow DOM 越来越重） */
function ensureStyle(shadow: ShadowRoot): void {
  if (shadow.querySelector(`style[${STYLE_ATTR}]`)) return;
  const style = document.createElement('style');
  style.setAttribute(STYLE_ATTR, '1');
  style.textContent = BASE_STYLE;
  shadow.appendChild(style);
}

/** 清空内容但保留样式节点 */
function clearContent(shadow: ShadowRoot): void {
  for (const node of Array.from(shadow.children)) {
    if (node.tagName !== 'STYLE') node.remove();
  }
}

function makeButton(label: string, act: string, cls: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = cls;
  btn.dataset.act = act;
  btn.textContent = label;
  return btn;
}

export interface PreviewActions {
  onConfirm: () => void;
  onPasteOriginal: () => void;
  onCancel: () => void;
}

/** 预览弹窗：命中 diff（原文删除线 / 结果高亮）+ 三个操作按钮 */
export function showPreview(res: DesensitizeResult, actions: PreviewActions): void {
  const shadow = ensureHost();
  clearContent(shadow);
  ensureStyle(shadow);

  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  wrap.setAttribute('data-vesper-ui', '1');

  const dialog = document.createElement('div');
  dialog.className = 'panel dialog';

  const title = document.createElement('div');
  title.className = 'title';
  title.appendChild(document.createTextNode(`✳ ${t.content.previewTitle}`));
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = t.content.previewHint(res.hits.length);
  title.appendChild(hint);
  dialog.appendChild(title);

  const rows = document.createElement('div');
  rows.className = 'rows';
  for (const h of res.hits.slice(0, 50)) {
    const row = document.createElement('div');
    row.className = 'row';
    const rule = document.createElement('span');
    rule.className = 'rule';
    rule.textContent = h.ruleName;
    row.appendChild(rule);
    row.appendChild(document.createElement('br'));
    const del = document.createElement('del');
    del.textContent = h.original;
    row.appendChild(del);
    row.appendChild(document.createTextNode(' → '));
    const mark = document.createElement('mark');
    mark.textContent = h.replaced;
    row.appendChild(mark);
    rows.appendChild(row);
  }
  dialog.appendChild(rows);

  if (res.hits.length > 50) {
    const more = document.createElement('div');
    more.className = 'more';
    more.textContent = `… 共 ${res.hits.length} 处，仅展示前 50 条`;
    dialog.appendChild(more);
  }

  const actionBar = document.createElement('div');
  actionBar.className = 'actions';
  const cancelBtn = makeButton(t.content.btnCancel, 'cancel', 'btn ghost');
  const originalBtn = makeButton(t.content.btnPasteOriginal, 'original', 'btn danger');
  const confirmBtn = makeButton(t.content.btnDesensitizedPaste, 'confirm', 'btn');
  actionBar.append(cancelBtn, originalBtn, confirmBtn);
  dialog.appendChild(actionBar);

  wrap.appendChild(dialog);

  const close = () => clearContent(shadow);

  confirmBtn.addEventListener('click', () => {
    close();
    actions.onConfirm();
  });
  originalBtn.addEventListener('click', () => {
    // 粘贴原文需二次确认（文档 4.6）
    if (window.confirm(t.content.pasteOriginalConfirm)) {
      close();
      actions.onPasteOriginal();
    }
  });
  cancelBtn.addEventListener('click', () => {
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
  ensureStyle(shadow);

  const toast = document.createElement('div');
  toast.setAttribute('data-vesper-ui', '1');
  toast.className = 'panel toast';

  const text = document.createElement('span');
  text.textContent = `✳ ${message}`;
  toast.appendChild(text);

  if (actions.onUndo) {
    const undo = makeButton(t.content.undo, 'undo', 'btn ghost');
    undo.addEventListener('click', () => {
      actions.onUndo!();
      dismiss();
    });
    toast.appendChild(undo);
  }
  if (actions.onView) {
    const view = makeButton(t.content.view, 'view', 'btn ghost');
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
