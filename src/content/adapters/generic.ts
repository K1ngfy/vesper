/**
 * generic 适配器：默认实现，适用于任意站点。
 * 职责只有两件事（文档 4.6）：如何判定可编辑目标、如何回填。
 * 脱敏逻辑一律走 core 引擎；站点改版时应降级到本适配器而不是报错。
 */
import { insertText, isEditableTarget, isPasswordField } from '../insert';
import type { Adapter } from './types';

export const genericAdapter: Adapter = {
  name: 'generic',
  match: () => true,
  isEditableTarget(el, siteSelector) {
    // 站点配置的选择器覆盖优先（文档 4.4 selector 字段）
    if (siteSelector) {
      const scoped = el.closest(siteSelector);
      if (scoped && isEditableTarget(scoped) && !isPasswordField(scoped)) return true;
    }
    return isEditableTarget(el) && !isPasswordField(el);
  },
  insertText(el, text) {
    return insertText(el, text);
  },
};
