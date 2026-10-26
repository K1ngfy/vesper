/**
 * 还原引擎（VESPEER.md 4.7）：把脱敏产物中的占位符按映射表换回真实值。
 * 纯 TS，零浏览器依赖。映射仅来自 numbered/fixed 且可逆的规则（见 engine.ts）。
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 按"占位符长度降序"构造单一交替正则一趟替换，
 * 避免 [EMAIL_1] 先于 [EMAIL_10] 命中造成的前缀冲突。
 */
export function restore(text: string, mapping: Record<string, string>): string {
  if (!text) return text ?? '';
  const keys = Object.keys(mapping).filter(Boolean);
  if (keys.length === 0) return text;
  keys.sort((a, b) => b.length - a.length);
  const re = new RegExp(keys.map(escapeRegExp).join('|'), 'g');
  return text.replace(re, (m) => mapping[m] ?? m);
}
