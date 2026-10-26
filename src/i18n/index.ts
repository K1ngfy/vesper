/**
 * i18n 入口（D7：中文优先，预留英文）。
 * 当前仅中文；接入英文时在此处按浏览器语言切换。
 */
import { zhCN, type Messages } from './zh-CN';

export const t: Messages = zhCN;
export type { Messages };
