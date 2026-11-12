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
 * - 无命中完全放行，不干预站点默认粘贴（含富文本）。
 */
import { desensitize } from '@/src/core/engine';
import EngineWorker from '@/src/core/engine.worker?worker';
import type { DesensitizeResult, Scheme, SiteRule } from '@/src/core/types';
import { sendMessage } from '@/src/messages';
import { pickAdapter } from '@/src/content/adapters';
import { insertText, isPasswordField } from '@/src/content/insert';
import { isOwnUI, showPreview, showToast } from '@/src/content/ui';
import { t } from '@/src/i18n';

interface Ctx {
  site: SiteRule;
  scheme: Scheme;
}

/** 当前生效的拦截上下文；配置变化时实时刷新，不在闭包里固化旧方案 */
let ctx: Ctx | null = null;

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
        (changes['vesper:settings'] || changes['vesper:schemes'] || changes['vesper:sites'])
      ) {
        void refreshCtx();
      }
    });

    // 捕获阶段监听，抢在站点脚本之前（文档 4.6）
    document.addEventListener('paste', (e) => onPaste(e, adapter), true);
    document.addEventListener('drop', (e) => onDrop(e, adapter), true);
  },
});

async function refreshCtx(): Promise<void> {
  const state = await sendMessage({ type: 'GET_SITE_STATE', url: location.href });
  // 诊断日志：只记状态与原因，不记任何文本内容（隐私红线）
  if (!state || state.status !== 'enabled' || !state.site || !state.scheme) {
    const status = state?.status ?? 'no-response';
    const reason = status !== 'enabled' ? status : !state.site ? 'site-missing' : 'scheme-missing';
    console.debug(`[VESPER] 本页未启用拦截（原因：${reason}）`);
    ctx = null;
    return;
  }
  console.debug(
    `[VESPER] 拦截已挂载：模式=${state.site.mode}，方案=${state.scheme.name}，规则数=${state.scheme.rules.length}`,
  );
  ctx = { site: state.site, scheme: state.scheme };
}

type Adapter = ReturnType<typeof pickAdapter>;

function onPaste(e: ClipboardEvent, adapter: Adapter): void {
  const text = e.clipboardData?.getData('text/plain');
  handleIntercept(text, e, adapter);
}

function onDrop(e: DragEvent, adapter: Adapter): void {
  const text = e.dataTransfer?.getData('text/plain');
  handleIntercept(text, e, adapter);
}

/**
 * 大文本阈值：超过则走 Worker 异步脱敏，避免主线程长时间阻塞（性能优化）。
 *
 * 历史阈值 100KB 过高 —— 50KB 文本同步跑 12 个内置检测器 + 用户规则
 * 已能阻塞主线程数秒，浏览器随后判定页面无响应并提示"崩溃"。
 * 12KB 同步耗时通常 < 30ms（毫秒级，用户无感），超过即异步化。
 */
const WORKER_THRESHOLD = 12 * 1024;

/** Worker 超时保护：用户正则若触发灾难性回溯，Worker 线程也会卡死。
 *  超时即放弃本次脱敏、回填原文，不让粘贴永久挂起。 */
const WORKER_TIMEOUT_MS = 10_000;

let engineWorker: Worker | null = null;

/** 大文本脱敏：在 Worker 线程执行，结果经 postMessage 返回（协议同 engine.worker.ts）。
 *  错误恢复：onError / 超时时把 engineWorker 置 null，下次重新创建，
 *  避免复用已 dead 的 worker 导致后续大文本永远走兜底。 */
function desensitizeInWorker(text: string, scheme: Scheme): Promise<DesensitizeResult> {
  return new Promise((resolve, reject) => {
    // new Worker 可能同步抛错（如测试环境 chrome.runtime.getURL 未桩、
    // 或生产环境 worker 脚本未在 web_accessible_resources）。
    // 放进 Promise 体内，统一成 reject，避免同步抛错穿透到调用方。
    let w: Worker;
    try {
      w = engineWorker ?? (engineWorker = new EngineWorker());
    } catch {
      reject(new Error('worker-create-failed'));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
    };
    const onMessage = (e: MessageEvent) => {
      cleanup();
      resolve(e.data as DesensitizeResult);
    };
    const onError = (_e: ErrorEvent) => {
      cleanup();
      // Worker 已死，置 null 让下次重新创建（否则后续大文本必走兜底）
      if (engineWorker === w) engineWorker = null;
      try {
        w.terminate();
      } catch {
        /* 已死，忽略 */
      }
      reject(new Error('worker-error'));
    };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    timer = setTimeout(() => {
      cleanup();
      if (engineWorker === w) engineWorker = null;
      try {
        w.terminate();
      } catch {
        /* 忽略 */
      }
      reject(new Error('worker-timeout'));
    }, WORKER_TIMEOUT_MS);
    w.postMessage({ text, scheme });
  });
}

function handleIntercept(text: string | undefined, e: Event, adapter: Adapter): void {
  const target = e.target as HTMLElement | null;
  // 护栏链：缺一即放行（含上下文未就绪：未启用站点不干预）
  if (!text || !target || !ctx) return;
  // 已被其它实例处理过（极端情况下的重复监听）：不再二次拦截
  if (e.defaultPrevented) return;
  if (isOwnUI(target)) return;
  if (isPasswordField(target)) return;
  if (!adapter.isEditableTarget(target, ctx.site.selector)) return;

  const current = ctx;
  const mode = current.site.mode;

  // 大文本：先拦截，再走 Worker 异步脱敏，避免主线程卡顿/崩溃
  if (text.length >= WORKER_THRESHOLD) {
    e.preventDefault();
    e.stopPropagation();
    void runLargeText(text, target, adapter, current, mode).catch(() => {
      // 任何异常都不许让用户丢掉这次粘贴（已被 preventDefault）
      insertOriginal(target, text, adapter);
    });
    return;
  }

  let res: DesensitizeResult;
  try {
    res = desensitize(text, current.scheme);
  } catch {
    // 引擎异常（如用户正则写坏）：放行站点默认粘贴，不干预
    console.warn('[VESPER] 脱敏引擎异常，本次粘贴放行');
    return;
  }
  if (res.hits.length === 0) return; // 无命中：完全放行，不干预原行为

  e.preventDefault();
  e.stopPropagation();
  dispatchByMode(target, res, text, adapter, mode);
}

/** 大文本：Worker 脱敏后按模式分发；无命中补回原文（已 preventDefault） */
async function runLargeText(
  text: string,
  target: HTMLElement,
  adapter: Adapter,
  current: Ctx,
  mode: SiteRule['mode'],
): Promise<void> {
  if (!ctx) return;
  let res: DesensitizeResult;
  try {
    res = await desensitizeInWorker(text, current.scheme);
  } catch {
    // Worker 失败：补回原文，任何情况下不丢用户文本（文档 4.6 护栏）
    insertOriginal(target, text, adapter);
    return;
  }
  if (res.hits.length === 0) {
    insertOriginal(target, text, adapter);
    return;
  }
  dispatchByMode(target, res, text, adapter, mode);
}

/** 按站点拦截模式分发处理（warn-only / auto / preview） */
function dispatchByMode(
  target: HTMLElement,
  res: DesensitizeResult,
  original: string,
  adapter: Adapter,
  mode: SiteRule['mode'],
): void {
  try {
    if (mode === 'warn-only') {
      // 仅提醒：放行原文（手动补一次默认粘贴，因为我们已 preventDefault）
      insertOriginal(target, original, adapter);
      showToast(t.content.toastWarn(res.hits.length));
      return;
    }
    if (mode === 'auto') {
      applyDesensitized(target, res, original, adapter);
      return;
    }
    // 默认：预览确认
    showPreview(res, {
      onConfirm: () => applyDesensitized(target, res, original, adapter),
      onPasteOriginal: () => insertOriginal(target, original, adapter),
      onCancel: () => {},
    });
  } catch {
    // 预览/回填失败（典型：站点 CSP 阻断注入 UI）时，
    // 退回"补回原文"，绝不出现"粘不进去"的死局
    console.warn('[VESPER] 拦截处理异常，已回填原文');
    insertOriginal(target, original, adapter);
    showToast(t.content.previewFailed);
  }
}

/** 回填原文（warn-only / 用户选择粘贴原文） */
function insertOriginal(target: HTMLElement, text: string, adapter: Adapter): void {
  if (!adapter.insertText(target, text)) {
    fallbackCopy(text);
  }
}

/** 回填脱敏结果 + Toast（撤销/查看）+ 计数 + 映射上报（仅当用户开启本地保留时落盘） */
function applyDesensitized(
  target: HTMLElement,
  res: DesensitizeResult,
  original: string,
  adapter: Adapter,
): void {
  const ok = adapter.insertText(target, res.output);
  if (!ok) {
    fallbackCopy(res.output);
  }
  showToast(t.content.toastDesensitized(res.hits.length), {
    onUndo: () => {
      // 撤销：恢复原文重填
      adapter.insertText(target, original);
    },
  });
  void sendMessage({ type: 'INCREMENT_COUNT', by: 1 });
  if (Object.keys(res.mapping).length > 0) {
    void sendMessage({ type: 'RECORD_MAPPING', schemeId: '', mapping: res.mapping });
  }
}

/** 兜底：写入剪贴板，任何情况下不让用户丢文本（文档 4.6） */
function fallbackCopy(text: string): void {
  void navigator.clipboard
    .writeText(text)
    .then(() => showToast(t.content.fallbackCopied))
    .catch(() => showToast(t.content.fallbackCopied));
}
