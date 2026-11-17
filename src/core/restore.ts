/**
 * 还原引擎（VESPEER.md 4.7）：把脱敏产物中的占位符按映射表换回真实值。
 * 纯 TS，零浏览器依赖。映射仅来自 numbered/fixed 且可逆的规则（见 engine.ts）。
 *
 * 还原后输出区需要高亮"被还原的片段"（原占位符位置、现原值），
 * 故提供 restoreWithMarks 返回分段标记；restore 仍返回纯字符串以兼容旧调用与单测。
 */

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

interface PrefixNode {
  prefix: string;
  children?: Map<string, PrefixNode>;
  placeholder?: string;
}

/** 同一批映射构建一次前缀树，供工作台连续编辑还原文本时复用。 */
export function createRestorer(mapping: Record<string, string>): (text: string) => RestoreResult {
  const root: PrefixNode = { prefix: '' };
  for (const placeholder of Object.keys(mapping)) {
    if (!placeholder) continue;
    let node = root;
    let offset = 0;
    while (offset < placeholder.length) {
      const character = placeholder[offset]!;
      const children = (node.children ??= new Map());
      let next = children.get(character);
      if (!next) {
        next = { prefix: placeholder.slice(offset) };
        children.set(character, next);
        node = next;
        break;
      }
      const { prefix } = next;
      let shared = 1;
      while (shared < prefix.length && prefix[shared] === placeholder[offset + shared]) shared += 1;
      if (shared < prefix.length) {
        // Split a shared edge only where keys branch, keeping long fixed replacements compact.
        next.prefix = prefix.slice(shared);
        next = {
          prefix: prefix.slice(0, shared),
          children: new Map([[next.prefix[0]!, next]]),
        };
        children.set(character, next);
      }
      offset += shared;
      node = next;
    }
    node.placeholder = placeholder;
  }

  return (text) => {
    if (!text || !root.children) return { output: text ?? '', marks: [] };
    const marks: RestoreMark[] = [];
    let output = '';
    let last = 0;
    for (let start = 0; start < text.length; start += 1) {
      let node = root.children.get(text[start]!);
      let offset = start;
      let placeholder: string | undefined;
      // Follow shared prefixes to retain the longest match at this position.
      while (node && text.startsWith(node.prefix, offset)) {
        if (node.placeholder) placeholder = node.placeholder;
        offset += node.prefix.length;
        node = node.children?.get(text[offset]!);
      }
      if (!placeholder) continue;
      output += text.slice(last, start);
      const original = mapping[placeholder] ?? placeholder;
      marks.push({ index: output.length, length: original.length, placeholder, original });
      output += original;
      last = start + placeholder.length;
      start = last - 1;
    }
    return { output: output + text.slice(last), marks };
  };
}

/** 还原并标记每个被还原片段在输出中的位置，供 UI 高亮。 */
export function restoreWithMarks(text: string, mapping: Record<string, string>): RestoreResult {
  if (!text) return { output: text ?? '', marks: [] };
  return createRestorer(mapping)(text);
}

/** 还原为纯字符串（兼容旧调用 / 单测） */
export function restore(text: string, mapping: Record<string, string>): string {
  return restoreWithMarks(text, mapping).output;
}
