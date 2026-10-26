/**
 * ChatGPT 适配器。
 * 选择器实测自 2026-10 快照：主输入框为 #prompt-textarea（ProseMirror，
 * contenteditable）。站点改版需重验。
 * 只使用语义 ID，禁止构建期随机类名（抗版本漂移）。
 *
 * 降级策略（文档 4.6：站点改版应降级到 generic 而不是失效）：
 * 识别不到 #prompt-textarea 时，回退 generic 判定（任意可编辑元素），
 * 保证改版后拦截仍然生效，而不是静默放行。
 */
import { insertIntoPromptTextarea } from './shared';
import { isEditableTarget, isPasswordField } from '../insert';
import type { Adapter } from './types';

export const chatgptAdapter: Adapter = {
  name: 'chatgpt',
  match: (url) => /^https?:\/\/(www\.)?chatgpt\.com\//.test(url),
  isEditableTarget(el) {
    const box = el.closest('#prompt-textarea');
    if (box) return true;
    // 站点改版降级：任意可编辑目标（排除密码框）
    return isEditableTarget(el) && !isPasswordField(el);
  },
  insertText(el, text) {
    const box = el.closest('#prompt-textarea') as HTMLElement | null;
    return insertIntoPromptTextarea(box ?? el, text);
  },
};
