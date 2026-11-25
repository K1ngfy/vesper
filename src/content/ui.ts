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
import { createVesperLogoSvg } from '../brand';
import { t } from '../i18n';

const HOST_ID = 'vesper-shadow-host';
let root: ShadowRoot | undefined;
let activePreview: HTMLDialogElement | undefined;
let dismissToast: (() => void) | undefined;

function ensureHost(): ShadowRoot {
  if (root?.host.isConnected) return root;
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.dataset.vesperUi = '1';
  host.style.cssText = 'position:fixed;inset:0 auto auto 0;width:0;height:0;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(BASE_STYLE);
  shadow.adoptedStyleSheets = [sheet];
  document.documentElement.appendChild(host);
  root = shadow;
  return shadow;
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

  .dialog { width: min(560px, 90vw); max-height: 80vh; overflow: auto; padding: 20px; margin: auto; }
  .dialog::backdrop { background: rgba(0,0,0,.45); }
  .preview[open] { display: flex; flex-direction: column; overflow: hidden; }
  .processing { width: min(260px, 90vw); padding: 24px; text-align: center; font-size: 14px; }
  .spinner {
    width: 26px; height: 26px; margin: 0 auto 12px; border: 2px solid #e5e5e5;
    border-top-color: #111111; border-radius: 50%; animation: spin .8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  .title { flex: none; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 16px; font-weight: 600; margin-bottom: 4px; }
  .title .hint { font-size: 12px; color: #6b7280; font-weight: 400; margin-left: 2px; }
  .rows { min-height: 0; overflow-y: auto; overscroll-behavior: contain; margin: 12px 0; }
  .footer { flex: none; display: grid; gap: 12px; border-top: 1px solid #e5e5e5; padding-top: 12px; }
  .more { color: #6b7280; font-size: 12px; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; }

  @keyframes toast-enter {
    from { opacity: 0.08; transform: translate3d(14px, -6px, 0) scale(0.975); }
    to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
  }
  @keyframes toast-progress {
    from { transform: scaleX(1); }
    to { transform: scaleX(0); }
  }
  .toast {
    position: fixed; top: 20px; right: 20px; z-index: 2147483647;
    min-width: 300px; max-width: min(420px, calc(100vw - 32px));
    padding: 13px 14px 15px;
    display: flex; gap: 12px; align-items: flex-start;
    background: rgba(255, 255, 255, 0.96);
    backdrop-filter: blur(18px) saturate(180%);
    -webkit-backdrop-filter: blur(18px) saturate(180%);
    color: #0f172a;
    border: 1px solid rgba(15, 23, 42, 0.1);
    border-radius: 14px;
    box-shadow:
      0 20px 45px -12px rgba(15, 23, 42, 0.2),
      0 4px 14px -2px rgba(15, 23, 42, 0.08),
      inset 0 1px 0 rgba(255, 255, 255, 0.9);
    overflow: hidden;
    animation: toast-enter .22s cubic-bezier(0.16, 1, 0.3, 1);
    --toast-accent: #10b981;
    --toast-badge-bg: #ecfdf5;
    --toast-badge-border: #d1fae5;
    --toast-kicker: #047857;
  }
  .toast[data-variant="warning"] {
    --toast-accent: #f59e0b;
    --toast-badge-bg: #fffbeb;
    --toast-badge-border: #fde68a;
    --toast-kicker: #b45309;
  }
  .toast[data-variant="error"] {
    --toast-accent: #ef4444;
    --toast-badge-bg: #fef2f2;
    --toast-badge-border: #fecaca;
    --toast-kicker: #b91c1c;
  }
  .toast[data-variant="info"] {
    --toast-accent: #3b82f6;
    --toast-badge-bg: #eff6ff;
    --toast-badge-border: #dbeafe;
    --toast-kicker: #1d4ed8;
  }
  .toast-badge {
    position: relative; flex: none;
    width: 36px; height: 36px; border-radius: 10px;
    background: var(--toast-badge-bg);
    border: 1px solid var(--toast-badge-border);
    color: #111827;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .toast-dot {
    position: absolute; right: -2px; bottom: -2px;
    width: 10px; height: 10px; border-radius: 999px;
    background: var(--toast-accent);
    border: 2px solid #ffffff;
  }
  .toast-dot.pulse {
    background: #ffffff;
    border: 2px solid #cbd5e1;
    border-top-color: var(--toast-accent);
    animation: spin .85s linear infinite;
  }
  .toast-body {
    flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px;
    padding-top: 1px;
  }
  .toast-kicker {
    font-size: 11px; font-weight: 600; line-height: 1.2;
    letter-spacing: 0.02em; color: var(--toast-kicker);
  }
  .toast-msg {
    font-size: 13px; font-weight: 500; line-height: 1.45;
    color: #0f172a; overflow-wrap: anywhere;
  }
  .toast-controls {
    flex: none; display: inline-flex; align-items: center; gap: 6px;
    margin-left: 2px; align-self: center;
  }
  .toast-undo {
    border: 1px solid #111827; border-radius: 8px;
    padding: 5px 11px; font-size: 12px; font-weight: 500; line-height: 1.2;
    cursor: pointer; background: #111827; color: #ffffff;
    transition: background-color .15s ease, border-color .15s ease;
  }
  .toast-undo:hover { background: #334155; border-color: #334155; }
  .toast-close {
    width: 26px; height: 26px; padding: 0; border: none; border-radius: 7px;
    background: transparent; color: #94a3b8; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    transition: background-color .15s ease, color .15s ease;
  }
  .toast-close:hover { background: rgba(15, 23, 42, 0.06); color: #0f172a; }
  .toast-bar {
    position: absolute; left: 0; right: 0; bottom: 0; height: 2.5px;
    background: var(--toast-accent); opacity: 0.85;
    transform-origin: left center;
    animation: toast-progress var(--toast-duration, 10000ms) linear forwards;
  }
  .toast[data-paused="1"] .toast-bar { animation-play-state: paused; }
  @media (prefers-reduced-motion: reduce) {
    .toast { animation: none; }
    .toast-bar { animation: none; }
    .toast-dot.pulse { animation: none; }
  }
`;

function makeButton(label: string, act: string, cls: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = cls;
  btn.dataset.act = act;
  btn.textContent = label;
  return btn;
}

export function showProcessing(): () => void {
  const shadow = ensureHost();
  dismissToast?.();
  const dialog = document.createElement('dialog');
  dialog.className = 'panel dialog processing';
  dialog.setAttribute('aria-label', t.content.processing);
  for (const type of ['cancel', 'paste', 'drop', 'wheel']) {
    dialog.addEventListener(type, (event) => event.preventDefault(), { passive: false });
  }

  const spinner = document.createElement('div');
  spinner.className = 'spinner';
  spinner.setAttribute('aria-hidden', 'true');
  const status = document.createElement('div');
  status.setAttribute('role', 'status');
  status.textContent = t.content.processing;
  dialog.append(spinner, status);
  shadow.appendChild(dialog);
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  try {
    dialog.showModal();
  } catch (error) {
    close();
    throw error;
  }
  return close;
}

export interface PreviewActions {
  onConfirm: () => void;
  onPasteOriginal: () => void;
  onCancel: () => void;
}

/** 预览弹窗：命中 diff（原文删除线 / 结果高亮）+ 三个操作按钮 */
export function showPreview(res: DesensitizeResult, actions: PreviewActions): void {
  const shadow = ensureHost();
  closePreview();
  dismissToast?.();

  const dialog = document.createElement('dialog');
  dialog.className = 'panel dialog preview';
  dialog.setAttribute('aria-label', t.content.previewTitle);

  const totalHits = res.hitCount ?? res.hits.length;
  const title = document.createElement('div');
  title.className = 'title';
  title.appendChild(createVesperLogoSvg(18));
  title.appendChild(document.createTextNode(t.content.previewTitle));
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = t.content.previewHint(totalHits);
  title.appendChild(hint);
  dialog.appendChild(title);

  const rows = document.createElement('div');
  rows.className = 'rows';
  rows.tabIndex = 0;
  rows.setAttribute('role', 'region');
  rows.setAttribute('aria-label', t.content.previewList);
  // Keep the sensitive strings out of the page-accessible shadow tree.
  const details = rows.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    div { padding: 6px 0; border-bottom: 1px dashed #e5e5e5; font-size: 13px; overflow-wrap: anywhere; }
    span, del { color: #6b7280; }
    mark { background: #f3f4f6; color: #111; }
  `);
  details.adoptedStyleSheets = [sheet];
  const excerpt = (text: string) => (text.length > 300 ? text.slice(0, 300) + '…' : text);
  for (const h of res.hits.slice(0, 50)) {
    const row = document.createElement('div');
    const rule = document.createElement('span');
    rule.textContent = excerpt(h.ruleName);
    const del = document.createElement('del');
    del.textContent = excerpt(h.original);
    const mark = document.createElement('mark');
    mark.textContent = excerpt(h.replaced);
    row.append(rule, document.createElement('br'), del, ' → ', mark);
    details.appendChild(row);
  }
  dialog.appendChild(rows);

  const footer = document.createElement('div');
  footer.className = 'footer';
  if (totalHits > 50) {
    const more = document.createElement('div');
    more.className = 'more';
    more.textContent = `… 共 ${totalHits} 处，仅展示前 50 条`;
    footer.appendChild(more);
  }

  const actionBar = document.createElement('div');
  actionBar.className = 'actions';
  const cancelBtn = makeButton(t.content.btnCancel, 'cancel', 'btn ghost');
  const originalBtn = makeButton(t.content.btnPasteOriginal, 'original', 'btn danger');
  const confirmBtn = makeButton(t.content.btnDesensitizedPaste, 'confirm', 'btn');
  actionBar.append(cancelBtn, originalBtn, confirmBtn);
  footer.appendChild(actionBar);
  dialog.appendChild(footer);

  cancelBtn.autofocus = true;
  confirmBtn.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    closePreview();
    actions.onConfirm();
  });
  originalBtn.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    if (window.confirm(t.content.pasteOriginalConfirm)) {
      closePreview();
      actions.onPasteOriginal();
    }
  });
  const cancel = () => {
    closePreview();
    actions.onCancel();
  };
  cancelBtn.addEventListener('click', cancel);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    cancel();
  });
  shadow.appendChild(dialog);
  activePreview = dialog;
  try {
    dialog.showModal();
  } catch (error) {
    closePreview();
    throw error;
  }
}

export function closePreview(): void {
  activePreview?.close();
  activePreview?.remove();
  activePreview = undefined;
}

export type ToastVariant = 'success' | 'warning' | 'error' | 'info';

export const DEFAULT_TOAST_DURATION_MS = 10_000;

export interface ToastActions {
  onUndo?: () => void;
  onDismiss?: () => void;
  persistent?: boolean;
  variant?: ToastVariant;
  durationMs?: number;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function createCloseIconSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);
  return svg;
}

function getToastKickerText(variant: ToastVariant, persistent?: boolean): string {
  if (persistent) return t.content.toastKickerLoading;
  switch (variant) {
    case 'warning':
      return t.content.toastKickerWarn;
    case 'error':
      return t.content.toastKickerError;
    case 'info':
      return t.content.toastKickerInfo;
    case 'success':
    default:
      return t.content.toastKickerSuccess;
  }
}

/** Toast：右上角精致通知卡片，默认 10 秒自动消失（悬停暂停倒计时），可带撤销与手动关闭 */
export function showToast(message: string, actions: ToastActions = {}): () => void {
  const shadow = ensureHost();
  dismissToast?.();

  const variant: ToastVariant = actions.variant ?? 'success';
  const duration = actions.durationMs ?? DEFAULT_TOAST_DURATION_MS;

  const toast = document.createElement('div');
  toast.setAttribute('data-vesper-ui', '1');
  toast.dataset.variant = variant;
  toast.className = 'toast';
  toast.style.setProperty('--toast-duration', `${duration}ms`);

  const badge = document.createElement('div');
  badge.className = 'toast-badge';
  badge.setAttribute('aria-hidden', 'true');
  const dot = document.createElement('span');
  dot.className = actions.persistent ? 'toast-dot pulse' : 'toast-dot';
  badge.append(createVesperLogoSvg(18), dot);

  const body = document.createElement('div');
  body.className = 'toast-body';

  const kicker = document.createElement('span');
  kicker.className = 'toast-kicker';
  kicker.setAttribute('aria-hidden', 'true');
  kicker.textContent = getToastKickerText(variant, actions.persistent);

  const text = document.createElement('span');
  text.className = 'toast-msg';
  text.setAttribute('role', 'status');
  text.textContent = message;

  body.append(kicker, text);
  toast.append(badge, body);

  if (actions.onUndo || !actions.persistent) {
    const controls = document.createElement('div');
    controls.className = 'toast-controls';

    if (actions.onUndo) {
      const undo = makeButton(t.content.undo, 'undo', 'toast-undo');
      undo.addEventListener('click', (event) => {
        if (!event.isTrusted) return;
        try {
          actions.onUndo!();
        } finally {
          dismiss();
        }
      });
      controls.appendChild(undo);
    }

    if (!actions.persistent) {
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'toast-close';
      closeBtn.dataset.act = 'dismiss';
      closeBtn.setAttribute('aria-label', t.content.toastClose);
      closeBtn.appendChild(createCloseIconSvg());
      closeBtn.addEventListener('click', () => dismiss());
      controls.appendChild(closeBtn);
    }

    toast.appendChild(controls);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let remaining = duration;
  let startedAt = performance.now();

  if (!actions.persistent) {
    const bar = document.createElement('div');
    bar.className = 'toast-bar';
    bar.setAttribute('aria-hidden', 'true');
    toast.appendChild(bar);

    timer = setTimeout(dismiss, remaining);

    const pauseTimer = () => {
      if (toast.dataset.paused === '1') return;
      toast.dataset.paused = '1';
      clearTimeout(timer);
      remaining = Math.max(400, remaining - (performance.now() - startedAt));
    };
    const resumeTimer = () => {
      if (toast.dataset.paused !== '1') return;
      delete toast.dataset.paused;
      startedAt = performance.now();
      timer = setTimeout(dismiss, remaining);
    };
    toast.addEventListener('mouseenter', pauseTimer);
    toast.addEventListener('mouseleave', resumeTimer);
    toast.addEventListener('focusin', pauseTimer);
    toast.addEventListener('focusout', (e) => {
      if (!toast.contains(e.relatedTarget as Node | null)) resumeTimer();
    });
  }

  shadow.appendChild(toast);
  dismissToast = dismiss;
  return dismiss;

  function dismiss() {
    if (dismissToast !== dismiss) return;
    clearTimeout(timer);
    toast.remove();
    actions.onDismiss?.();
    dismissToast = undefined;
  }
}

/** 判断事件目标是否在 VESPER 自身 UI 内（护栏） */
export function isOwnUI(el: EventTarget | null): boolean {
  return el === root?.host || (el instanceof Node && Boolean(root?.contains(el)));
}
