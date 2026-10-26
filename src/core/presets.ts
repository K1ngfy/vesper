/**
 * 种子数据：默认方案与预置站点（VESPEER.md 4.1 / 4.4）。
 * 纯 TS，可在单测与 storage 层共用。
 *
 * 默认方案规则顺序遵循"具体规则在前、宽泛规则在后"（文档 5.4）：
 * 具体密钥类检测器先于 generic_secret，避免宽泛规则抢走具体命中。
 */
import { DETECTORS } from './detectors';
import type { BuiltinDetectorId, Rule, Scheme, SiteRule } from './types';

export function genId(): string {
  // 本地随机 ID 即可，无需密码学强度
  return `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function builtinRule(id: BuiltinDetectorId, enabled: boolean): Rule {
  const det = DETECTORS[id];
  return {
    id: genId(),
    type: 'builtin',
    enabled,
    name: det.name,
    pattern: det.id,
    replacement: det.defaultReplacement,
    mode: 'numbered',
  };
}

/** MVP 默认开启前 8 个检测器（文档 4.2），其余内置但默认关闭 */
const DEFAULT_ENABLED: BuiltinDetectorId[] = [
  'openai_key',
  'aws_ak',
  'github_token',
  'jwt',
  'private_key',
  'email',
  'phone_cn',
  'ipv4',
];

const ALL_ORDERED: BuiltinDetectorId[] = [
  // 具体在前
  'openai_key',
  'aws_ak',
  'github_token',
  'jwt',
  'private_key',
  'id_card_cn',
  'email',
  'phone_cn',
  'ipv4',
  // 宽泛/部分替换在后
  'db_conn',
  'bearer',
  'generic_secret',
];

export function createDefaultScheme(): Scheme {
  const now = Date.now();
  return {
    id: genId(),
    name: '默认方案',
    isDefault: true,
    enabled: true,
    rules: ALL_ORDERED.map((id) => builtinRule(id, DEFAULT_ENABLED.includes(id))),
    createdAt: now,
    updatedAt: now,
  };
}

/** 预置站点（文档 4.4）：默认未启用，引导用户一键开启 */
export const PRESET_SITES: Omit<SiteRule, 'id'>[] = [
  { matchPattern: '*://chatgpt.com/*', schemeId: '', enabled: false, mode: 'preview' },
  { matchPattern: '*://claude.ai/*', schemeId: '', enabled: false, mode: 'preview' },
  { matchPattern: '*://gemini.google.com/*', schemeId: '', enabled: false, mode: 'preview' },
  { matchPattern: '*://chat.deepseek.com/*', schemeId: '', enabled: false, mode: 'preview' },
  { matchPattern: '*://www.kimi.com/*', schemeId: '', enabled: false, mode: 'preview' },
];

export const SITE_DISPLAY_NAMES: Record<string, string> = {
  '*://chatgpt.com/*': 'ChatGPT',
  '*://claude.ai/*': 'Claude',
  '*://gemini.google.com/*': 'Gemini',
  '*://chat.deepseek.com/*': 'DeepSeek',
  '*://www.kimi.com/*': 'Kimi',
};
