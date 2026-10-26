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

function handleIntercept(text: string | undefined, e: Event, adapter: Adapter): void {
  const target = e.target as HTMLElement | null;
  // 护栏链：缺一即放行（含上下文未就绪：未启用站点不干预）
  if (!text || !target || !ctx) return;
  if (isOwnUI(target)) return;
  if (isPasswordField(target)) return;
  if (!adapter.isEditableTarget(target, ctx.site.selector)) return;

  const res = desensitize(text, ctx.scheme);
  if (res.hits.length === 0) return; // 无命中：完全放行，不干预原行为

  e.preventDefault();
  e.stopPropagation();

  const mode = ctx.site.mode;
  if (mode === 'warn-only') {
    // 仅提醒：放行原文（手动补一次默认粘贴，因为我们已 preventDefault）
    insertOriginal(target, text, adapter);
    showToast(t.content.toastWarn(res.hits.length));
    return;
  }
  if (mode === 'auto') {
    applyDesensitized(target, res, text, adapter);
    return;
  }
  // 默认：预览确认
  showPreview(res, {
    onConfirm: () => applyDesensitized(target, res, text, adapter),
    onPasteOriginal: () => insertOriginal(target, text, adapter),
    onCancel: () => {},
  });
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
