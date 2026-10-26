/**
 * 适配器层入口（文档 4.6）：按 URL 选适配器，识别不到一律降级 generic。
 * 站点改版只动本目录文件；新增站点适配 = 加一个文件并注册到下表。
 */
import { chatgptAdapter } from './chatgpt';
import { claudeAdapter } from './claude';
import { genericAdapter } from './generic';
import type { Adapter } from './types';

const ADAPTERS: Adapter[] = [chatgptAdapter, claudeAdapter, genericAdapter];

export function pickAdapter(url: string): Adapter {
  return ADAPTERS.find((a) => a.match(url)) ?? genericAdapter;
}
