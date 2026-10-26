/** 适配器契约（文档 4.6 适配器层） */
export interface Adapter {
  name: string;
  /** 当前 URL 是否适用本适配器 */
  match(url: string): boolean;
  /** 判定事件目标是否为该站点的可编辑输入区 */
  isEditableTarget(el: HTMLElement, siteSelector?: string): boolean;
  /** 回填；返回 false 由上层走剪贴板兜底 */
  insertText(el: HTMLElement, text: string): boolean;
}
