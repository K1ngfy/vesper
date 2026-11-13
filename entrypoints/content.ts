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
 * - 回填用 insertText（不触发 paste/drop 事件），天然无递归拦截风险，
 *   不打任何时间窗标记——避免误伤用户的快速连续粘贴；
 * - 同步检查无命中时保留站点默认粘贴。
 */
import { desensitize } from '@/src/core/engine';
import type { DesensitizeResult, Scheme, SiteRule } from '@/src/core/types';
import { ENGINE_PORT, sendMessage } from '@/src/messages';
import { pickAdapter } from '@/src/content/adapters';
import { captureInsertion } from '@/src/content/insert';
import { closePreview, isOwnUI, showPreview, showToast } from '@/src/content/ui';
import { t } from '@/src/i18n';

interface Ctx {
  site: SiteRule;
  scheme: Scheme;
}

/** 当前生效的拦截上下文；配置变化时实时刷新，不在闭包里固化旧方案 */
let ctx: Ctx | null = null;
let refreshId = 0;
let previewId = 0;
let approvedPaste: { target: HTMLElement; text: string; expires: number } | undefined;
let approvalTimer: ReturnType<typeof setTimeout> | undefined;

function clearApproval(): void {
  clearTimeout(approvalTimer);
  approvedPaste = undefined;
}
let releasePreview: (() => void) | undefined;

function cancelPreview(): void {
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

    const adapter = pickAdapter(location.href);
    void refreshCtx();

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

async function refreshCtx(): Promise<void> {
  const id = ++refreshId;
  const state = await sendMessage({ type: 'GET_SITE_STATE', url: location.href }).catch(() => null);
  if (id !== refreshId) return;
  cancelPreview();
  clearApproval();
  ctx =
    state?.status === 'enabled' && state.site && state.scheme
      ? { site: state.site, scheme: state.scheme }
      : null;
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

async function desensitizeInExtension(text: string, scheme: Scheme): Promise<DesensitizeResult> {
  if (!(await sendMessage({ type: 'ENSURE_ENGINE' }))) throw new Error('engine-unavailable');
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: ENGINE_PORT });
    const timer = setTimeout(() => {
      port.disconnect();
      reject(new Error('engine-timeout'));
    }, 12_000);
    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      reject(new Error('engine-disconnected'));
    });
    port.onMessage.addListener((result: DesensitizeResult) => {
      clearTimeout(timer);
      port.disconnect();
      resolve(result);
    });
    try {
      port.postMessage({ text, scheme });
    } catch (error) {
      clearTimeout(timer);
      port.disconnect();
      reject(error);
    }
  });
}

function handleIntercept(text: string | undefined, event: Event, adapter: Adapter): void {
  const current = ctx;
  if (!text || !current?.scheme.enabled || !current.scheme.rules.some((r) => r.enabled)) return;
  if (event.defaultPrevented || !event.cancelable || !event.isTrusted) return;
  const source = event.composedPath()[0];
  if (!(source instanceof HTMLElement) || isOwnUI(event.target)) return;
  const target = adapter.getTarget(source, current.site.selector);
  if (!target) return;
  const approved = approvedPaste;
  clearApproval();
  if (
    approved &&
    event.type === 'paste' &&
    approved.expires > Date.now() &&
    approved.target === target &&
    approved.text === text
  )
    return;

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

  event.preventDefault();
  event.stopImmediatePropagation();
  const insertion = captureInsertion(target, event);
  const id = ++previewId;
  cancelPreview();
  void processPaste(insertion, text, current, id, result);
}

async function processPaste(
  insertion: ReturnType<typeof captureInsertion>,
  original: string,
  current: Ctx,
  id: number,
  result?: DesensitizeResult,
): Promise<void> {
  const mode = current.site.mode;
  let awaitingConfirmation = false;
  try {
    const res = result ?? (await desensitizeInExtension(original, current.scheme));
    if (result) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (ctx !== current || (mode === 'preview' && id !== previewId)) return;
    if (res.hits.length === 0 || mode === 'warn-only') {
      if ((await insertOrCopy(insertion, original, false)) && res.hits.length > 0) {
        showToast(t.content.toastWarn(res.hits.length));
      }
    } else if (mode === 'auto') {
      await applyDesensitized(insertion, res, current.scheme.id);
    } else {
      const release = () => {
        insertion.release();
        if (releasePreview === release) releasePreview = undefined;
      };
      showPreview(res, {
        onConfirm: () => {
          void applyDesensitized(insertion, res, current.scheme.id).finally(release);
        },
        onPasteOriginal: () => {
          void insertOrCopy(insertion, original, false).finally(release);
        },
        onCancel: release,
      });
      releasePreview = release;
      awaitingConfirmation = true;
    }
  } catch {
    if (ctx !== current || (mode === 'preview' && id !== previewId)) return;
    if (mode === 'warn-only') await insertOrCopy(insertion, original, false);
    else showToast(t.content.previewFailed);
  } finally {
    if (!awaitingConfirmation) insertion.release();
  }
}

async function insertOrCopy(
  insertion: ReturnType<typeof captureInsertion>,
  text: string,
  redacted: boolean,
): Promise<boolean> {
  try {
    if (insertion.insert(text)) return true;
  } catch {
    // The destination may have changed while the preview was open.
  }
  const current = ctx;
  try {
    await navigator.clipboard.writeText(text);
    if (ctx === current) {
      clearApproval();
      approvedPaste = { target: insertion.target, text, expires: Date.now() + 60_000 };
      approvalTimer = setTimeout(clearApproval, 60_000);
    }
    showToast(redacted ? t.content.fallbackCopied : t.content.originalCopied);
  } catch {
    showToast(t.content.fallbackFailed);
  }
  return false;
}

async function applyDesensitized(
  insertion: ReturnType<typeof captureInsertion>,
  res: DesensitizeResult,
  schemeId: string,
): Promise<void> {
  if (await insertOrCopy(insertion, res.output, true)) {
    const undo = insertion.getUndo();
    showToast(
      t.content.toastDesensitized(res.hits.length),
      undo ? { onUndo: undo.undo, onDismiss: undo.dispose } : {},
    );
    void sendMessage({ type: 'INCREMENT_COUNT' }).catch(() => {});
  }
  if (Object.keys(res.mapping).length > 0) {
    void sendMessage({ type: 'RECORD_MAPPING', schemeId, mapping: res.mapping }).catch(() => {});
  }
}
