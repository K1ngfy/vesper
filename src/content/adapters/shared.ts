/** 适配器共用回填：对 contenteditable 主输入框走统一 insertText */
import { insertText } from '../insert';

export function insertIntoPromptTextarea(box: HTMLElement | null, text: string): boolean {
  if (!box) return false;
  return insertText(box, text);
}
