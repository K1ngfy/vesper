/**
 * VESPER 核心类型定义（依据 VESPEER.md 第 5 节）。
 * 本文件为纯 TS，禁止引入任何浏览器 / WXT API，保证可单测。
 */

export interface Scheme {
  id: string;
  name: string;
  isDefault: boolean;
  enabled: boolean;
  rules: Rule[];
  createdAt: number;
  updatedAt: number;
}

export type RuleType = 'keyword' | 'regex' | 'builtin';
export type ReplaceMode = 'fixed' | 'numbered' | 'mask';

export interface Rule {
  id: string;
  type: RuleType;
  enabled: boolean;
  name: string;
  /** keyword=原文; regex=正则源; builtin=检测器 ID */
  pattern: string;
  /** fixed 模式的替换文本; 正则模板可含 $1; numbered 模式下 `n` 会被编号替换 */
  replacement: string;
  mode: ReplaceMode;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regexFlags?: string;
  /** mask 模式保留首尾位数，默认首 1 尾 1 */
  maskKeep?: { head: number; tail: number };
  /** 扩展（文档 4.1 邮箱场景）：mask 模式下对邮箱保留域名，默认关 */
  maskKeepDomain?: boolean;
}

export interface Hit {
  ruleId: string;
  ruleName: string;
  original: string;
  replaced: string;
  index: number;
}

export interface DesensitizeResult {
  output: string;
  hits: Hit[];
  /** 占位符 → 原值；仅 numbered/fixed 且可逆的规则产生；mask 不可逆（文档 4.7） */
  mapping: Record<string, string>;
  durationMs: number;
}

export type SiteMode = 'auto' | 'preview' | 'warn-only';

export interface SiteRule {
  id: string;
  matchPattern: string;
  /** 显示名称（可选）；为空时回退到 SITE_DISPLAY_NAMES 或 matchPattern */
  name?: string;
  schemeId: string;
  enabled: boolean;
  mode: SiteMode;
  selector?: string;
}

/** 内置检测器 ID（文档 4.2，共 12 个） */
export type BuiltinDetectorId =
  | 'email'
  | 'phone_cn'
  | 'ipv4'
  | 'openai_key'
  | 'aws_ak'
  | 'github_token'
  | 'jwt'
  | 'private_key'
  | 'id_card_cn'
  | 'db_conn'
  | 'bearer'
  | 'generic_secret';

export interface DetectorPattern {
  source: string;
  flags: string;
  /**
   * 部分替换：仅替换该捕获组内容（如 db_conn 只换密码段）。
   * 缺省表示替换整个匹配。
   */
  group?: number;
}

export interface Detector {
  id: BuiltinDetectorId;
  name: string;
  description: string;
  patterns: DetectorPattern[];
  /** numbered 模式默认占位符模板（`n` 会被编号替换） */
  defaultReplacement: string;
}
