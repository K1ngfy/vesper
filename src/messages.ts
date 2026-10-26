/**
 * 类型化消息契约（VESPEER.md 第 6 节）。
 * content script 不直接读 storage 中的敏感数据，一律经 background 路由。
 */
import type { Scheme, SiteRule } from './core/types';

export type Message =
  | { type: 'GET_ACTIVE_SCHEME' }
  | { type: 'GET_SCHEMES' }
  | { type: 'SET_ACTIVE_SCHEME'; schemeId: string }
  | { type: 'GET_SITE_STATE'; url: string }
  | { type: 'INCREMENT_COUNT'; by?: number }
  | { type: 'GET_DAILY_COUNT' }
  | { type: 'RECORD_MAPPING'; schemeId: string; mapping: Record<string, string> }
  | { type: 'REFRESH_SITE_REGISTRATIONS' }
  | { type: 'OPEN_WORKBENCH' };

export type SiteStatus = 'enabled' | 'unconfigured' | 'no-permission' | 'disabled';

export interface SiteStateResponse {
  status: SiteStatus;
  site?: SiteRule;
  scheme?: Scheme;
}

export type MessageResponse<M extends Message> = M extends { type: 'GET_ACTIVE_SCHEME' }
  ? Scheme | null
  : M extends { type: 'GET_SCHEMES' }
    ? Scheme[]
    : M extends { type: 'GET_SITE_STATE' }
      ? SiteStateResponse
      : M extends { type: 'INCREMENT_COUNT' } | { type: 'GET_DAILY_COUNT' }
        ? number
        : void;

export async function sendMessage<M extends Message>(msg: M): Promise<MessageResponse<M>> {
  return (await chrome.runtime.sendMessage(msg)) as MessageResponse<M>;
}
