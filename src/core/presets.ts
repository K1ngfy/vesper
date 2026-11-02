/**
 * 种子数据：默认方案与预置站点（VESPEER.md 4.1 / 4.4）。
 * 纯 TS，可在单测与 storage 层共用。
 *
 * 默认方案规则顺序遵循"具体规则在前、宽泛规则在后"（文档 5.4）：
 * 具体密钥类检测器先于 generic_secret，避免宽泛规则抢走具体命中。
 *
 * 预置站点按分类组织（ai / search / translate），默认未启用。
 * 预置 host 统一用 *.example.com 通配形式（匹配根域及所有子域）。
 */
import { DETECTORS } from './detectors';
import type { BuiltinDetectorId, Rule, Scheme, SiteCategory, SiteRule } from './types';

/**
 * 规范化域名匹配模式：去掉开头的 "*." 前缀；'*' 保持原样（匹配所有站点）。
 * 用于跨"是否带通配前缀"的统一比较与查找（*.chatgpt.com ≡ chatgpt.com）。
 */
export function normalizeHost(host: string): string {
  const v = host.trim().toLowerCase();
  return v.startsWith('*.') ? v.slice(2) : v;
}

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

/** 站点分类展示顺序（文档 4.4）；'custom' 为用户新建站点默认分类，排末位 */
export const SITE_CATEGORY_ORDER: SiteCategory[] = ['ai', 'search', 'translate', 'custom'];

/**
 * 预置站点（文档 4.4）：默认未启用，按分类组织，引导用户一键开启。
 * host 统一用 *.example.com 通配形式，匹配根域及所有子域。
 * - ai：AI 助手（对话/写作，输入框是主要粘贴入口）
 * - search：搜索引擎（查询框易粘贴含敏感信息的搜索词）
 * - translate：翻译站点（整段文档粘贴风险高）
 */
export const PRESET_SITES: Omit<SiteRule, 'id'>[] = [
  // AI 助手
  { host: '*.chatgpt.com', schemeId: '', enabled: true, mode: 'preview', category: 'ai' },
  { host: '*.claude.ai', schemeId: '', enabled: true, mode: 'preview', category: 'ai' },
  { host: '*.gemini.google.com', schemeId: '', enabled: true, mode: 'preview', category: 'ai' },
  { host: '*.deepseek.com', schemeId: '', enabled: true, mode: 'preview', category: 'ai' },
  { host: '*.kimi.com', schemeId: '', enabled: true, mode: 'preview', category: 'ai' },
  { host: '*.hailuoai.com', schemeId: '', enabled: true, mode: 'preview', category: 'ai' },
  { host: '*.doubao.com', schemeId: '', enabled: true, mode: 'preview', category: 'ai' },
  { host: '*.tongyi.com', schemeId: '', enabled: true, mode: 'preview', category: 'ai' },
  { host: '*.yiyan.baidu.com', schemeId: '', enabled: true, mode: 'preview', category: 'ai' },
  { host: '*.chatglm.cn', schemeId: '', enabled: true, mode: 'preview', category: 'ai' },
  { host: '*.xinghuo.xfyun.cn', schemeId: '', enabled: true, mode: 'preview', category: 'ai' },
  { host: '*.yuanbao.tencent.com', schemeId: '', enabled: true, mode: 'preview', category: 'ai' },
  { host: '*.copilot.microsoft.com', schemeId: '', enabled: true, mode: 'preview', category: 'ai' },
  { host: '*.perplexity.ai', schemeId: '', enabled: true, mode: 'preview', category: 'ai' },
  { host: '*.poe.com', schemeId: '', enabled: true, mode: 'preview', category: 'ai' },
  { host: '*.you.com', schemeId: '', enabled: true, mode: 'preview', category: 'ai' },
  // 搜索（查询框易粘贴敏感信息）
  { host: '*.google.com', schemeId: '', enabled: true, mode: 'preview', category: 'search' },
  { host: '*.bing.com', schemeId: '', enabled: true, mode: 'preview', category: 'search' },
  { host: '*.baidu.com', schemeId: '', enabled: true, mode: 'preview', category: 'search' },
  { host: '*.sogou.com', schemeId: '', enabled: true, mode: 'preview', category: 'search' },
  { host: '*.so.com', schemeId: '', enabled: true, mode: 'preview', category: 'search' },
  { host: '*.duckduckgo.com', schemeId: '', enabled: true, mode: 'preview', category: 'search' },
  // 翻译（整段粘贴风险高）
  { host: '*.translate.google.com', schemeId: '', enabled: true, mode: 'preview', category: 'translate' },
  { host: '*.deepl.com', schemeId: '', enabled: true, mode: 'preview', category: 'translate' },
  { host: '*.fanyi.baidu.com', schemeId: '', enabled: true, mode: 'preview', category: 'translate' },
  { host: '*.fanyi.youdao.com', schemeId: '', enabled: true, mode: 'preview', category: 'translate' },
  { host: '*.fanyi.qq.com', schemeId: '', enabled: true, mode: 'preview', category: 'translate' },
  { host: '*.fanyi.volcengine.com', schemeId: '', enabled: true, mode: 'preview', category: 'translate' },
];

/** 规范化 host → 分类映射（迁移补 category 用；键不带通配前缀） */
export const PRESET_HOST_CATEGORY: Record<string, SiteCategory> = Object.fromEntries(
  PRESET_SITES.map((s) => [normalizeHost(s.host), s.category ?? 'custom']),
);

/** 规范化 host → 显示名映射（键不带通配前缀，查找用 normalizeHost(host)） */
export const SITE_DISPLAY_NAMES: Record<string, string> = {
  // AI 助手
  'chatgpt.com': 'ChatGPT',
  'claude.ai': 'Claude',
  'gemini.google.com': 'Gemini',
  'deepseek.com': 'DeepSeek',
  'kimi.com': 'Kimi',
  'hailuoai.com': '海螺AI',
  'doubao.com': '豆包',
  'tongyi.com': '通义千问',
  'yiyan.baidu.com': '文心一言',
  'chatglm.cn': '智谱清言',
  'xinghuo.xfyun.cn': '讯飞星火',
  'yuanbao.tencent.com': '腾讯元宝',
  'copilot.microsoft.com': 'Copilot',
  'perplexity.ai': 'Perplexity',
  'poe.com': 'Poe',
  'you.com': 'You.com',
  // 搜索
  'google.com': 'Google',
  'bing.com': 'Bing',
  'baidu.com': '百度',
  'sogou.com': '搜狗',
  'so.com': '360搜索',
  'duckduckgo.com': 'DuckDuckGo',
  // 翻译
  'translate.google.com': 'Google 翻译',
  'deepl.com': 'DeepL',
  'fanyi.baidu.com': '百度翻译',
  'fanyi.youdao.com': '有道翻译',
  'fanyi.qq.com': '腾讯翻译',
  'fanyi.volcengine.com': '火山翻译',
};
