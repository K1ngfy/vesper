/**
 * VESPER 脱敏引擎（VESPEER.md 第 5 节）——纯 TS，零浏览器 API 依赖。
 *
 * 硬性要求实现说明：
 * 1. 防二次替换：每次命中先置入内部令牌 \uE000{hitIndex}\uE001，
 *    全部规则执行完毕后统一换成最终占位符；且所有替换回调检查
 *    "命中片段含令牌即跳过"，检测器正则亦排除令牌字符，双保险。
 * 2. 同值一致：numbered 模式每规则一个 Map(原值→占位符)+计数器；
 *    mask 为原值的纯函数，天然一致。
 * 3. 正则安全：构造失败抛错由上层（规则编辑器）捕获并提示；
 *    引擎不做全局超时，灾难性回溯风险由编辑器文案提示（文档 5.3）。
 * 4. 顺序即优先级：严格按 rules 数组顺序执行。
 * 5. numbered 占位符约定：模板中"独立的 n"（前后非字母数字）替换为编号，
 *    如 `[EMAIL_n]` → `[EMAIL_1]`。
 *
 * 隐私红线（文档第 8 节）：本文件禁止 console.log 打印原文/映射。
 */
import { getDetector } from './detectors';
import type { DesensitizeResult, Hit, Rule, Scheme } from './types';

const TOKEN_START = '\uE000'; // 私用区字符，正常文本不会包含
const TOKEN_END = '\uE001';
const TOKEN_RE = /\uE000(\d+)\uE001/g;

/** numbered 模板中的编号占位：独立的字母 n（如 [EMAIL_n] 中的 n） */
const NUMBER_SLOT_RE = /(?<![A-Za-z0-9])n(?![A-Za-z0-9])/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** mask 模式：保留首尾，中间用 * 填充（星数=隐藏长度，最少 3 个，防短值信息泄露） */
export function maskValue(
  value: string,
  keep: { head: number; tail: number } = { head: 1, tail: 1 },
  keepDomain = false,
): string {
  if (keepDomain && value.includes('@')) {
    const at = value.indexOf('@');
    const local = value.slice(0, at);
    const domain = value.slice(at);
    return maskValue(local, keep, false) + domain;
  }
  const { head, tail } = keep;
  if (value.length <= head + tail) {
    return '*'.repeat(Math.max(3, value.length));
  }
  const hidden = value.length - head - tail;
  return value.slice(0, head) + '*'.repeat(Math.max(3, hidden)) + value.slice(value.length - tail);
}

/** 编译单条规则为可执行正则；非法正则在此抛错（编辑器保存前试跑捕获） */
function compileRule(rule: Rule): { regex: RegExp; group?: number }[] {
  switch (rule.type) {
    case 'keyword': {
      let src = escapeRegExp(rule.pattern);
      if (rule.wholeWord) {
        // 自绘词边界：\b 对中文无效，改用字母数字下划线断言
        src = `(?<![A-Za-z0-9_])${src}(?![A-Za-z0-9_])`;
      }
      const flags = rule.caseSensitive ? 'g' : 'gi';
      return [{ regex: new RegExp(src, flags) }];
    }
    case 'regex': {
      let flags = rule.regexFlags ?? 'g';
      if (!flags.includes('g')) flags += 'g';
      return [{ regex: new RegExp(rule.pattern, flags) }];
    }
    case 'builtin': {
      const det = getDetector(rule.pattern);
      if (!det) throw new Error(`未知内置检测器: ${rule.pattern}`);
      return det.patterns.map((p) => ({
        regex: new RegExp(p.source, p.flags),
        group: p.group,
      }));
    }
  }
}

/** 展开 regex 规则的 fixed 模板中的 $1 等捕获组引用 */
function expandTemplate(template: string, args: unknown[]): string {
  return template.replace(/\$(\d+)/g, (_, d) => {
    const v = args[Number(d)];
    return typeof v === 'string' ? v : '';
  });
}

export function desensitize(text: string, scheme: Scheme): DesensitizeResult {
  const start = Date.now();
  if (!text || !scheme?.enabled) {
    return { output: text ?? '', hits: [], mapping: {}, durationMs: 0 };
  }

  let current = text;
  const hits: Hit[] = [];
  const finals: string[] = []; // hitIndex -> 最终替换文本
  const mapping: Record<string, string> = {};

  for (const rule of scheme.rules) {
    if (!rule.enabled) continue;

    // numbered 模式的同值一致缓存（每规则独立编号空间）
    const numberedCache = new Map<string, string>();
    let counter = 0;

    let compiled: { regex: RegExp; group?: number }[];
    try {
      compiled = compileRule(rule);
    } catch {
      // 非法正则理论上在保存期已被拦截；执行期兜底跳过该规则，不中断整体脱敏
      continue;
    }

    for (const { regex, group } of compiled) {
      regex.lastIndex = 0;
      current = current.replace(regex, (...args: unknown[]) => {
        const full = args[0] as string;
        // 双保险：命中片段含内部令牌（已被前序规则替换过）→ 原样返回
        if (full.includes(TOKEN_START)) return full;

        const original = group != null ? (args[group] as string) : full;
        if (original == null || original === '') return full;

        let finalText: string;
        switch (rule.mode) {
          case 'fixed': {
            finalText =
              rule.type === 'regex' ? expandTemplate(rule.replacement, args) : rule.replacement;
            break;
          }
          case 'numbered': {
            const cached = numberedCache.get(original);
            if (cached != null) {
              finalText = cached;
            } else {
              counter += 1;
              const template =
                rule.replacement ||
                (rule.type === 'builtin' ? getDetector(rule.pattern)?.defaultReplacement : '') ||
                '[MASKED_n]';
              finalText = template.replace(NUMBER_SLOT_RE, String(counter));
              numberedCache.set(original, finalText);
            }
            break;
          }
          case 'mask': {
            finalText = maskValue(original, rule.maskKeep, rule.maskKeepDomain);
            break;
          }
        }

        // 还原映射：仅 numbered / fixed 且可逆（文档 4.7）；mask 不可逆不入表
        if (rule.mode === 'numbered' || rule.mode === 'fixed') {
          const existing = mapping[finalText];
          if (existing == null) {
            mapping[finalText] = original;
          } else if (existing !== original) {
            // fixed 模式一个替换文本对应多个原值 → 不可逆，移除该映射
            delete mapping[finalText];
          }
        }

        const hitIndex = hits.length;
        hits.push({
          ruleId: rule.id,
          ruleName: rule.name,
          original,
          replaced: finalText,
          index: -1, // 最终 pass 统一回填
        });
        finals.push(finalText);
        const token = `${TOKEN_START}${hitIndex}${TOKEN_END}`;

        if (group != null) {
          // 部分替换：只换掉捕获组，保留前后文
          return full.replace(original, token);
        }
        return token;
      });
    }
  }

  // 统一回填：令牌 → 最终占位符，同时计算每个命中在输出中的下标
  let output = '';
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(current)) !== null) {
    const hitIndex = Number(m[1]);
    output += current.slice(last, m.index);
    hits[hitIndex]!.index = output.length;
    output += finals[hitIndex]!;
    last = m.index + m[0].length;
  }
  output += current.slice(last);

  return { output, hits, mapping, durationMs: Date.now() - start };
}

/** 规则测试台用：用单条规则对样本文本试跑（非法正则直接向上抛错给编辑器提示） */
export function testRule(sample: string, rule: Rule): DesensitizeResult {
  // 先编译一次以便尽早抛出语法错误
  compileRule(rule);
  const scheme: Scheme = {
    id: '__test__',
    name: '__test__',
    isDefault: false,
    enabled: true,
    rules: [rule],
    createdAt: 0,
    updatedAt: 0,
  };
  return desensitize(sample, scheme);
}
