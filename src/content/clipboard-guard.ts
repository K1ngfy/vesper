/**
 * 合成粘贴期间的剪贴板读取守卫（同时支持宿主页面 MAIN world 与测试环境挂载）。
 *
 * 背景：
 * 当用户在 VESPER 预览弹窗点击「脱敏粘贴」后，VESPER 会向富文本编辑器派发携带脱敏文本的
 * 合成 `ClipboardEvent('paste')`。部分站点（如 AI 对话框的附件/富文本粘贴处理器）会在其
 * `paste` 监听器中调用 `navigator.clipboard.read()` 或 `navigator.clipboard.readText()`：
 * 1. 由于点击「脱敏粘贴」按钮产生了瞬态用户激活（click 手势而非原生 Cmd+V 快捷键），
 *    Chromium 会立即弹出浏览器原生的「想要查看剪贴板中的文本和图像 / 确认粘贴」权限弹窗；
 * 2. 若用户点击允许，网页更会直接读到系统剪贴板中尚未脱敏的原始敏感内容！
 *
 * 解决方案：
 * 在捕获阶段识别带有 `application/x-vesper-paste` 标记的合成粘贴事件，在极短回填窗口（300ms）内
 * 接管 `Clipboard.prototype.readText` / `read` 与 `execCommand('paste')`，直接返回本次脱敏后的文本，
 * 既彻底消除浏览器的二次确认弹窗，又杜绝宿主网页趁机读取系统剪贴板中的原始敏感文本。
 */

export const VESPER_SYNTHETIC_PASTE_MIME = 'application/x-vesper-paste';

const GUARD_INSTALLED_KEY = '__vesperClipboardGuardInstalled__';
const GUARD_HANDLED_MS = 40;

export function installClipboardGuard(): void {
  const w = window as unknown as Record<string, boolean>;
  if (w[GUARD_INSTALLED_KEY]) return;
  w[GUARD_INSTALLED_KEY] = true;

  let activeUntil = 0;
  let activeText = '';
  let activeHtml = '';
  let clearTimer: ReturnType<typeof setTimeout> | undefined;

  const disarm = () => {
    activeUntil = 0;
    activeText = '';
    activeHtml = '';
    if (clearTimer !== undefined) {
      clearTimeout(clearTimer);
      clearTimer = undefined;
    }
  };

  window.addEventListener(
    'paste',
    (event: ClipboardEvent) => {
      if (event.isTrusted) {
        disarm();
        return;
      }
      const dt = event.clipboardData;
      if (!dt || dt.getData(VESPER_SYNTHETIC_PASTE_MIME) !== '1') return;
      activeText = dt.getData('text/plain') ?? '';
      activeHtml = dt.getData('text/html') ?? '';
      activeUntil = performance.now() + GUARD_HANDLED_MS;
      if (clearTimer !== undefined) clearTimeout(clearTimer);
      clearTimer = setTimeout(disarm, GUARD_HANDLED_MS);
    },
    true,
  );

  // 冒泡末尾检查：若没有任何站点 paste 监听器调用 preventDefault 接管，微任务后立即撤防
  window.addEventListener(
    'paste',
    (event: ClipboardEvent) => {
      if (event.isTrusted) return;
      const dt = event.clipboardData;
      if (!dt || dt.getData(VESPER_SYNTHETIC_PASTE_MIME) !== '1') return;
      if (!event.defaultPrevented) {
        queueMicrotask(() => queueMicrotask(disarm));
      }
    },
    false,
  );

  for (const type of ['keydown', 'mousedown', 'pointerdown', 'copy', 'cut']) {
    window.addEventListener(
      type,
      (event) => {
        if (event.isTrusted) disarm();
      },
      true,
    );
  }

  if (typeof Clipboard !== 'undefined' && Clipboard.prototype) {
    const origReadText = Clipboard.prototype.readText;
    if (typeof origReadText === 'function') {
      Clipboard.prototype.readText = function vesperReadText(this: Clipboard): Promise<string> {
        if (performance.now() < activeUntil) {
          return Promise.resolve(activeText);
        }
        return origReadText.call(this);
      };
    }

    const origRead = Clipboard.prototype.read;
    if (typeof origRead === 'function') {
      Clipboard.prototype.read = function vesperRead(
        this: Clipboard,
        ...args: Parameters<Clipboard['read']>
      ): Promise<ClipboardItems> {
        if (performance.now() < activeUntil) {
          if (typeof ClipboardItem !== 'undefined') {
            const items: Record<string, Blob> = {
              'text/plain': new Blob([activeText], { type: 'text/plain' }),
            };
            if (activeHtml) {
              items['text/html'] = new Blob([activeHtml], { type: 'text/html' });
            }
            return Promise.resolve([new ClipboardItem(items)]);
          }
          return Promise.resolve([]);
        }
        return origRead.apply(this, args);
      };
    }
  }

  if (typeof Document !== 'undefined' && Document.prototype) {
    const origExecCommand = Document.prototype.execCommand;
    if (typeof origExecCommand === 'function') {
      Document.prototype.execCommand = function vesperExecCommand(
        this: Document,
        commandId: string,
        showUI?: boolean,
        value?: string,
      ): boolean {
        if (performance.now() < activeUntil && commandId?.toLowerCase() === 'paste') {
          return false;
        }
        return origExecCommand.call(this, commandId, showUI, value);
      };
    }
  }
}
