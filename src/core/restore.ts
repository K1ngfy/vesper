/**
 * 还原引擎（VESPEER.md 4.7）：把脱敏产物中的占位符按映射表换回真实值。
 * 纯 TS，零浏览器依赖。映射仅来自 numbered/fixed 且可逆的规则（见 engine.ts）。
 *
 * 还原后输出区需要高亮"被还原的片段"（原占位符位置、现原值），
 * 故提供 restoreWithMarks 返回分段标记；restore 仍返回纯字符串以兼容旧调用与单测。
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface RestoreMark {
  /** 被还原片段（原值）在输出中的起始下标 */
  index: number;
  /** 被还原片段（原值）长度 */
  length: number;
  /** 原占位符，如 [EMAIL_1] */
  placeholder: string;
  /** 还原后的原值 */
  original: string;
}

export interface RestoreResult {
  output: string;
  marks: RestoreMark[];
}

/**
 * 还原并标记每个被还原片段在输出中的位置，供 UI 高亮。
 * 按"占位符长度降序"构造单一交替正则一趟替换，
 * 避免 [EMAIL_1] 先于 [EMAIL_10] 命中造成的前缀冲突。
 */
export function restoreWithMarks(
  text: string,
  mapping: Record<string, string>,
): RestoreResult {
  if (!text) return { output: text ?? '', marks: [] };
  const keys = Object.keys(mapping).filter(Boolean);
  if (keys.length === 0) return { output: text, marks: [] };
  keys.sort((a, b) => b.length - a.length);
  const re = new RegExp(keys.map(escapeRegExp).join('|'), 'g');
  const marks: RestoreMark[] = [];
  let output = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    output += text.slice(last, m.index);
    const original = mapping[m[0]] ?? m[0];
    marks.push({ index: output.length, length: original.length, placeholder: m[0], original });
    output += original;
    last = m.index + m[0].length;
    // 理论上 keys 非空不会零宽匹配，兜底防死循环
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  output += text.slice(last);
  return { output, marks };
}

/** 还原为纯字符串（兼容旧调用 / 单测） */
export function restore(text: string, mapping: Record<string, string>): string {
  return restoreWithMarks(text, mapping).output;
}
