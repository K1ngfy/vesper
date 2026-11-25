/**
 * 站点拦截入口（VESPEER.md 4.6，T8/T9）。
 *
 * 注册方式：registration: 'runtime' —— 不进 manifest 静态 content_scripts，
 * 由 background 按"已启用且已授权"的站点动态注册（D5 最小权限）。
 * 注意：这里【不声明 matches】。WXT 会把 matches 追加进 manifest 的
 * host_permissions（默认主机权限），违反 D5；实际生效范围由
 * background.ts 中 chrome.scripting.registerContentScripts 的 matches 决定。
 *
 * 护栏（硬性）：
 * - 密码框、不可编辑区域、VESPER 自身 UI 内永不拦截；
 * - 只处理 text/plain；图片/文件粘贴不受影响；
 * - 回填由扩展完成。编辑器收到的合成粘贴事件不会再次触发拦截；
 * - 同步检查无命中时保留站点默认粘贴。
 */
import { desensitize } from '@/src/core/engine';
import type { DesensitizeResult, Scheme, SiteRule } from '@/src/core/types';
import { ENGINE_PORT, sendMessage } from '@/src/messages';
import { pickAdapter } from '@/src/content/adapters';
import { installClipboardGuard } from '@/src/content/clipboard-guard';
import { captureInsertion } from '@/src/content/insert';
import { closePreview, isOwnUI, showPreview, showProcessing, showToast } from '@/src/content/ui';
import { t } from '@/src/i18n';

interface Ctx {
  site: SiteRule;
  scheme: Scheme;
}

/** 当前生效的拦截上下文；配置变化时实时刷新，不在闭包里固化旧方案 */
let ctx: Ctx | null = null;
let refreshId = 0;
const REFRESH_RETRY_DELAYS = [250, 1_000, 3_000] as const;
let refreshRetry: ReturnType<typeof setTimeout> | undefined;
let refreshOnPaste = false;
let pasteId = 0;
let processing: AbortController | undefined;
let warnController: AbortController | undefined;
let approvedPaste: { target: HTMLElement; text: string; expires: number } | undefined;
let approvalTimer: ReturnType<typeof setTimeout> | undefined;

function clearApproval(): void {
  clearTimeout(approvalTimer);
  approvedPaste = undefined;
}
let releasePreview: (() => void) | undefined;

function cancelPaste(): void {
  pasteId += 1;
  processing?.abort();
  warnController?.abort();
  warnController = undefined;
  closePreview();
  releasePreview?.();
  releasePreview = undefined;
}

export default defineContentScript({
  registration: 'runtime',
  runAt: 'document_start',
  main() {
    // 同一 URL 可能被多条站点规则命中（如 *.openai.com 与 chatgpt.com 同时启用），
    // chrome.scripting 会按注册 id 各注入一份 → 同一页面出现两套监听，
    // 双重 preventDefault + 双重回填。用 window 标记（同源 isolated world 共享）
    // 保证只挂载一次。
    const flag = '__vesperContentMounted__';
    const w = window as unknown as Record<string, boolean>;
    if (w[flag]) return;
    w[flag] = true;

    installClipboardGuard();
    const adapter = pickAdapter(location.href);
    void refreshCtx();

    // Arc 浏览器会在网页根节点异步注入 --arc-palette-* 主题变量；记录标记以便侧边栏直接走独立窗口模式
    window.addEventListener(
      'load',
      () => {
        setTimeout(() => {
          try {
            const s = getComputedStyle(document.documentElement);
            if (
              s.getPropertyValue('--arc-palette-title').trim() ||
              s.getPropertyValue('--arc-palette-background').trim() ||
              s.getPropertyValue('--arc-background-simple-color').trim()
            ) {
              void chrome.storage?.local?.set({ 'vesper:isArc': true }).catch(() => {});
            }
          } catch {
            // 忽略受限页面样式读取异常
          }
        }, 600);
      },
      { once: true },
    );

    // 配置（方案/站点/设置）变化时刷新上下文：
    // Popup 切换"当前方案"后，已打开的页面无需刷新即按新方案拦截
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (
        area === 'local' &&
        (changes['vesper:settings'] ||
          changes['vesper:schemes'] ||
          changes['vesper:sites'] ||
          changes['vesper:permissionsRevision'])
      ) {
        void refreshCtx();
      }
    });

    // 捕获阶段监听，抢在站点脚本之前（文档 4.6）
    window.addEventListener('paste', (e) => onPaste(e, adapter), true);
    window.addEventListener('drop', (e) => onDrop(e, adapter), true);
  },
});

async function refreshCtx(attempt = 0): Promise<void> {
  clearTimeout(refreshRetry);
  refreshOnPaste = false;
  const id = ++refreshId;
  try {
    const state = await sendMessage({ type: 'GET_SITE_STATE', url: location.href });
    if (id !== refreshId) return;
    if (!state || (state.status === 'enabled' && (!state.site || !state.scheme))) {
      throw new Error('site-state-unavailable');
    }
    const next =
      state.status === 'enabled' && state.site && state.scheme
        ? { site: state.site, scheme: state.scheme }
        : null;
    if (JSON.stringify(ctx) === JSON.stringify(next)) return;
    ctx = next;
    const interrupted = processing || releasePreview;
    cancelPaste();
    clearApproval();
    if (interrupted) showToast(t.content.configChanged, { variant: 'warning' });
  } catch {
    if (id !== refreshId) return;
    // A failed read is not a decision to disable interception. Retry the read
    // while keeping the last confirmed policy for this document.
    const delay = REFRESH_RETRY_DELAYS[attempt];
    if (delay === undefined) refreshOnPaste = true;
    else refreshRetry = setTimeout(() => void refreshCtx(attempt + 1), delay);
  }
}

type Adapter = ReturnType<typeof pickAdapter>;

function onPaste(e: ClipboardEvent, adapter: Adapter): void {
  if (e.clipboardData?.files.length) return;
  const text = e.clipboardData?.getData('text/plain');
  handleIntercept(text, e, adapter);
}

function onDrop(e: DragEvent, adapter: Adapter): void {
  if (e.dataTransfer?.files.length) return;
  const text = e.dataTransfer?.getData('text/plain');
  handleIntercept(text, e, adapter);
}

const WORKER_THRESHOLD = 12 * 1024;
// 预留安全余量，避免超大文本在 Chrome 64MiB 扩展消息上限内序列化失败或拖卡宿主主线程。
const MAX_PASTE_CHARS = 15 * 1024 * 1024;
const MIN_PROCESSING_DISPLAY_MS = 300;

function totalHits(res: DesensitizeResult): number {
  return res.hitCount ?? res.hits.length;
}

function sameClipboardText(a: string, b: string): boolean {
  return a === b || a.replace(/\r\n?/g, '\n') === b.replace(/\r\n?/g, '\n');
}

function desensitizeInExtension(
  text: string,
  scheme: Scheme,
  signal: AbortSignal,
): Promise<DesensitizeResult> {
  return new Promise((resolve, reject) => {
    let port: chrome.runtime.Port | undefined;
    let settled = false;
    const finish = () => {
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      port?.disconnect();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      reject(error);
      finish();
    };
    const abort = () => fail(new Error('engine-cancelled'));
    // Include extension page startup in the deadline so the modal always unlocks.
    const timer = setTimeout(() => fail(new Error('engine-timeout')), 12_000);
    signal.addEventListener('abort', abort, { once: true });
    void sendMessage({ type: 'ENSURE_ENGINE' })
      .then((ready) => {
        if (settled) return;
        if (!ready) throw new Error('engine-unavailable');
        port = chrome.runtime.connect({ name: ENGINE_PORT });
        port.onDisconnect.addListener(() => fail(new Error('engine-disconnected')));
        port.onMessage.addListener((result: DesensitizeResult) => {
          if (settled) return;
          resolve(result);
          finish();
        });
        port.postMessage({ text, scheme });
      })
      .catch(fail);
  });
}

async function runPasteEngine(text: string, scheme: Scheme): Promise<DesensitizeResult> {
  const close = showProcessing();
  const controller = new AbortController();
  processing = controller;
  const { signal } = controller;
  signal.addEventListener('abort', close, { once: true });
  // A warm worker can finish before the browser paints the modal.
  const visibleUntil = performance.now() + MIN_PROCESSING_DISPLAY_MS;
  try {
    return await desensitizeInExtension(text, scheme, signal);
  } finally {
    const remaining = visibleUntil - performance.now();
    if (!signal.aborted && remaining > 0 && document.visibilityState === 'visible') {
      await new Promise<void>((resolve) => setTimeout(resolve, remaining));
    }
    if (processing === controller) processing = undefined;
    close();
  }
}

function handleIntercept(text: string | undefined, event: Event, adapter: Adapter): void {
  if (!text) return;
  if (event.defaultPrevented || !event.cancelable || !event.isTrusted) return;
  const rawSource = event.composedPath()[0];
  const source =
    rawSource instanceof HTMLElement
      ? rawSource
      : rawSource instanceof Node
        ? rawSource.parentElement
        : null;
  if (!source || isOwnUI(event.target)) return;
  const current = ctx;
  if (refreshOnPaste) void refreshCtx();
  if (!current?.scheme.enabled || !current.scheme.rules.some((r) => r.enabled)) return;
  const target = adapter.getTarget(source, current.site.selector);
  if (!target) return;
  const approved = approvedPaste;
  clearApproval();
  if (
    approved &&
    event.type === 'paste' &&
    approved.expires > Date.now() &&
    approved.target === target &&
    sameClipboardText(approved.text, text)
  )
    return;

  if (text.length > MAX_PASTE_CHARS) {
    if (current.site.mode === 'warn-only') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    showToast(t.content.pasteTooLarge, { variant: 'error' });
    return;
  }

  // Custom regexps can block even on short input. Built-in and literal rules retain
  // native paste for short text with no matches.
  const asyncEngine =
    text.length >= WORKER_THRESHOLD ||
    current.scheme.rules.some((r) => r.enabled && r.type === 'regex');
  let result: DesensitizeResult | undefined;
  try {
    result = asyncEngine ? undefined : desensitize(text, current.scheme, true);
  } catch {
    // Retry in the extension worker and surface a failure if it cannot complete.
  }
  if (result?.hits.length === 0) return;

  // 仅提醒模式：绝不阻止原生粘贴（完整保留富文本格式、附件转换与撤销历史），仅异步/同步检测并弹提醒
  if (current.site.mode === 'warn-only') {
    warnController?.abort();
    warnController = undefined;
    if (result) {
      const count = totalHits(result);
      if (count > 0) showToast(t.content.toastWarn(count), { variant: 'warning' });
      return;
    }
    const controller = new AbortController();
    warnController = controller;
    void desensitizeInExtension(text, current.scheme, controller.signal)
      .then((res) => {
        if (warnController !== controller) return;
        warnController = undefined;
        const count = totalHits(res);
        if (count > 0) showToast(t.content.toastWarn(count), { variant: 'warning' });
      })
      .catch(() => {
        if (warnController === controller) warnController = undefined;
      });
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();
  const insertion = captureInsertion(target, event);
  cancelPaste();
  const id = pasteId;
  void processPaste(insertion, text, current, () => pasteId === id, result);
}

async function processPaste(
  insertion: ReturnType<typeof captureInsertion>,
  original: string,
  current: Ctx,
  isCurrent: () => boolean,
  result?: DesensitizeResult,
): Promise<void> {
  const mode = current.site.mode;
  let awaitingConfirmation = false;
  try {
    const res = result ?? (await runPasteEngine(original, current.scheme));
    if (result) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (!isCurrent()) return;
    const hitCount = totalHits(res);
    if (hitCount === 0 || mode === 'warn-only') {
      const outcome = await insertOrCopy(insertion, original, false, isCurrent);
      if (outcome === 'inserted' && isCurrent() && hitCount > 0) {
        showToast(t.content.toastWarn(hitCount), { variant: 'warning' });
      }
    } else if (mode === 'auto') {
      await applyDesensitized(insertion, res, current.scheme.id, isCurrent);
    } else {
      const release = () => {
        insertion.release();
        if (releasePreview === release) releasePreview = undefined;
      };
      showPreview(res, {
        onConfirm: () => {
          void applyDesensitized(insertion, res, current.scheme.id, isCurrent).finally(release);
        },
        onPasteOriginal: () => {
          void insertOrCopy(insertion, original, false, isCurrent).finally(release);
        },
        onCancel: release,
      });
      releasePreview = release;
      awaitingConfirmation = true;
    }
  } catch (error) {
    if (!isCurrent()) return;
    if (mode === 'warn-only') {
      await insertOrCopy(insertion, original, false, isCurrent);
    } else {
      const msg = error instanceof Error ? error.message : String(error);
      showToast(
        /context invalidated/i.test(msg) ? t.content.contextInvalidated : t.content.previewFailed,
        { variant: 'error' },
      );
    }
  } finally {
    if (!awaitingConfirmation) insertion.release();
  }
}

async function insertOrCopy(
  insertion: ReturnType<typeof captureInsertion>,
  text: string,
  redacted: boolean,
  isCurrent: () => boolean,
): Promise<'inserted' | 'copied' | 'partial' | 'failed'> {
  if (!isCurrent()) return 'failed';
  let dismissProgress: (() => void) | undefined;
  const progress = setTimeout(() => {
    if (isCurrent()) {
      dismissProgress = showToast(t.content.inserting, { persistent: true, variant: 'info' });
    }
  }, 200);
  let offset = 0;
  let tooLarge = false;
  try {
    const outcome = await insertion.insert(text, isCurrent);
    if (outcome.status === 'inserted') return 'inserted';
    if (outcome.status === 'too-large') tooLarge = true;
    else offset = outcome.offset;
  } catch {
    // The destination may have changed while the preview was open.
  } finally {
    clearTimeout(progress);
    dismissProgress?.();
  }
  // A newer paste owns the clipboard. A partial write must never copy the prefix again.
  if (!isCurrent()) return 'failed';
  const remaining = text.slice(offset);
  try {
    await navigator.clipboard.writeText(remaining);
    if (!isCurrent()) return 'failed';
    clearApproval();
    approvedPaste = { target: insertion.target, text: remaining, expires: Date.now() + 60_000 };
    approvalTimer = setTimeout(clearApproval, 60_000);
    showToast(
      offset > 0
        ? t.content.partialCopied
        : tooLarge
          ? redacted
            ? t.content.largeCopied
            : t.content.largeOriginalCopied
          : redacted
            ? t.content.fallbackCopied
            : t.content.originalCopied,
      { variant: offset > 0 ? 'warning' : 'info' },
    );
    return 'copied';
  } catch {
    if (isCurrent()) {
      showToast(offset > 0 ? t.content.partialFailed : t.content.fallbackFailed, {
        variant: 'error',
      });
    }
    return offset > 0 ? 'partial' : 'failed';
  }
}

async function applyDesensitized(
  insertion: ReturnType<typeof captureInsertion>,
  res: DesensitizeResult,
  schemeId: string,
  isCurrent: () => boolean,
): Promise<void> {
  const outcome = await insertOrCopy(insertion, res.output, true, isCurrent);
  if (!isCurrent() || outcome === 'failed') return;
  void sendMessage({ type: 'RECORD_MAPPING', schemeId, mapping: res.mapping }).catch(() => {});
  if (outcome === 'inserted') {
    const undo = insertion.getUndo();
    showToast(
      t.content.toastDesensitized(totalHits(res)),
      undo
        ? { variant: 'success', onUndo: undo.undo, onDismiss: undo.dispose }
        : { variant: 'success' },
    );
    void sendMessage({ type: 'INCREMENT_COUNT' }).catch(() => {});
  } else if (outcome === 'copied') {
    void sendMessage({ type: 'INCREMENT_COUNT' }).catch(() => {});
  }
}
