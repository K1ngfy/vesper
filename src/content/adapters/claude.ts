/**
 * Claude 适配器。
 * 选择器实测自 2026-10 快照：输入区为 .ProseMirror 的 contenteditable
 * （ProseMirror 为库语义类名，相对稳定）。站点改版需重验。
 *
 * 降级策略（文档 4.6：站点改版应降级到 generic 而不是失效）：
 * 识别不到 .ProseMirror 时，回退 generic 判定，保证改版后拦截仍生效。
 */
import { insertIntoPromptTextarea } from './shared';
import { isEditableTarget, isPasswordField } from '../insert';
import type { Adapter } from './types';

export const claudeAdapter: Adapter = {
  name: 'claude',
  match: (url) => /^https?:\/\/(www\.)?claude\.ai\//.test(url),
  isEditableTarget(el) {
    const box = el.closest('.ProseMirror');
    if (box) return isEditableTarget(box);
    // 站点改版降级：任意可编辑目标（排除密码框）
    return isEditableTarget(el) && !isPasswordField(el);
  },
  insertText(el, text) {
    const box = el.closest('.ProseMirror') as HTMLElement | null;
    return insertIntoPromptTextarea(box ?? el, text);
  },
};
