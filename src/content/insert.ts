/**
 * 回填算法（VESPEER.md 4.6）：把脱敏后文本写入站点输入框。
 *
 * 关键约束：
 * - textarea/input 必须走原型链 native value setter + 冒泡 input 事件；
 *   直接 el.value= 对 React 受控组件无效（发送按钮不激活）——严禁。
 * - contenteditable 优先 execCommand('insertText')（对 ProseMirror 等编辑器
 *   最友好）；失败再用 Selection/Range 手动插入并派发 beforeinput/input。
 * - 任何一步失败都返回 false，由调用方走"复制到剪贴板"兜底，
 *   任何情况下不许让用户卡死或丢失文本。
 */

export function isEditableTarget(el: Element | null): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase();
    const textLike = ['text', 'search', 'url', 'tel', 'email', 'number', ''].includes(type);
    return textLike && !el.disabled && !el.readOnly;
  }
  return el.isContentEditable;
}

export function isPasswordField(el: Element | null): boolean {
  return el instanceof HTMLInputElement && el.type.toLowerCase() === 'password';
}

/** textarea / input：native value setter 路径 */
function insertIntoField(el: HTMLTextAreaElement | HTMLInputElement, text: string): boolean {
  try {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (!desc?.set) return false;
    el.focus();
    desc.set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  } catch {
    return false;
  }
}

/** contenteditable 回填上限：超过则返回 false 走剪贴板兜底，避免大文本回填卡顿/崩溃。
 *
 *  历史阈值 200KB 过高 —— ProseMirror/Slate/Lexical 等富文本编辑器对
 *  insertText/Range 插入会同步解析文本、构建文档模型、diff，30KB+ 即可
 *  让主线程长时间阻塞，200KB 必崩。16KB 是 ProseMirror 实测的相对安全上限，
 *  超过即走剪贴板兜底（textarea 不受此限，仍可大文本回填）。 */
const CE_INSERT_LIMIT = 16 * 1024;

/** contenteditable：execCommand 优先，Selection/Range 兜底 */
function insertIntoContentEditable(el: HTMLElement, text: string): boolean {
  // 大文本不回填到富文本编辑器（ProseMirror/Slate 处理大文档会卡死），改由上层复制到剪贴板
  if (text.length > CE_INSERT_LIMIT) return false;
  try {
    el.focus();
    const sel = window.getSelection();
    if (sel) {
      // 无选区时把光标移到末尾
      if (!sel.rangeCount || !el.contains(sel.anchorNode)) {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    // 优先 execCommand：ProseMirror/Slate 等编辑器能正确同步内部状态
    const ok = document.execCommand('insertText', false, text);
    if (ok) return true;
  } catch {
    /* 继续走兜底 */
  }
  try {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(
      new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: text }),
    );
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
    );
    return true;
  } catch {
    return false;
  }
}

/** 统一入口：按序尝试，成功即止（文档 4.6 回填算法） */
export function insertText(target: HTMLElement, text: string): boolean {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    return insertIntoField(target, text);
  }
  if (target.isContentEditable) {
    return insertIntoContentEditable(target, text);
  }
  return false;
}
