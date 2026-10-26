/**
 * 规则编辑表单（共享组件，2026-10-25 紧凑版）：规则卡片与"添加规则"弹窗共用。
 * 紧凑布局：名称+匹配源+模式同一行；替换/掩码同一行；类型相关选项一行小字；
 * 测试台单行（样本输入 + 内联结果），整体高度约为旧版一半。
 */
import { useState } from 'react';
import { DETECTOR_LIST } from '../../core/detectors';
import { testRule } from '../../core/engine';
import type { Rule } from '../../core/types';
import { t } from '../../i18n';

interface Props {
  rule: Rule;
  onChange: (rule: Rule) => void;
}

export default function RuleForm({ rule, onChange }: Props) {
  const [sample, setSample] = useState('');
  const [testOut, setTestOut] = useState('');
  const [testErr, setTestErr] = useState('');

  const detector =
    rule.type === 'builtin' ? DETECTOR_LIST.find((d) => d.id === rule.pattern) : undefined;

  function update(patch: Partial<Rule>) {
    const next = { ...rule, ...patch };
    onChange(next);
    if (sample) runTest(sample, next);
  }

  function runTest(text: string, r: Rule) {
    setSample(text);
    if (!text) {
      setTestOut('');
      setTestErr('');
      return;
    }
    try {
      const res = testRule(text, r);
      setTestOut(res.output);
      setTestErr('');
    } catch (err) {
      setTestOut('');
      setTestErr((err as Error).message);
    }
  }

  return (
    <div className="space-y-1.5 text-sm">
      {/* 行1：名称 + 匹配源 + 模式 */}
      <div className="flex gap-1.5">
        <input
          className="w-32 shrink-0 rounded border border-[var(--vesper-border)] bg-white px-2 py-1 text-xs outline-none focus:border-black"
          value={rule.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder={t.options.ruleNamePlaceholder}
        />
        {rule.type === 'builtin' ? (
          <select
            className="min-w-0 flex-1 rounded border border-[var(--vesper-border)] bg-white px-2 py-1 text-xs"
            value={rule.pattern}
            onChange={(e) => {
              const det = DETECTOR_LIST.find((d) => d.id === e.target.value)!;
              update({ pattern: det.id, replacement: det.defaultReplacement, mode: 'numbered' });
            }}
          >
            {DETECTOR_LIST.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="min-w-0 flex-1 rounded border border-[var(--vesper-border)] bg-white px-2 py-1 font-mono text-xs outline-none focus:border-black"
            value={rule.pattern}
            onChange={(e) => update({ pattern: e.target.value })}
            placeholder={
              rule.type === 'keyword' ? t.options.keywordPlaceholder : t.options.regexPlaceholder
            }
          />
        )}
        <select
          className="w-28 shrink-0 rounded border border-[var(--vesper-border)] bg-white px-2 py-1 text-xs"
          value={rule.mode}
          onChange={(e) => update({ mode: e.target.value as Rule['mode'] })}
        >
          <option value="fixed">{t.options.modeFixed}</option>
          <option value="numbered">{t.options.modeNumbered}</option>
          <option value="mask">{t.options.modeMask}</option>
        </select>
      </div>

      {/* 行2：替换文本 或 推码选项 */}
      {rule.mode !== 'mask' ? (
        <input
          className="w-full rounded border border-[var(--vesper-border)] bg-white px-2 py-1 font-mono text-xs outline-none focus:border-black"
          value={rule.replacement}
          onChange={(e) => update({ replacement: e.target.value })}
          placeholder={t.options.replacementPlaceholder}
        />
      ) : (
        <div className="flex items-center gap-1.5 text-xs text-[var(--vesper-text-dim)]">
          {t.options.maskHead}
          <input
            type="number"
            min={0}
            className="w-10 rounded border border-[var(--vesper-border)] bg-white px-1 py-0.5"
            value={rule.maskKeep?.head ?? 1}
            onChange={(e) =>
              update({ maskKeep: { head: Number(e.target.value), tail: rule.maskKeep?.tail ?? 1 } })
            }
          />
          {t.options.maskTail}
          <input
            type="number"
            min={0}
            className="w-10 rounded border border-[var(--vesper-border)] bg-white px-1 py-0.5"
            value={rule.maskKeep?.tail ?? 1}
            onChange={(e) =>
              update({ maskKeep: { head: rule.maskKeep?.head ?? 1, tail: Number(e.target.value) } })
            }
          />
          <label className="ml-1 flex items-center gap-1">
            <input
              type="checkbox"
              className="accent-black"
              checked={rule.maskKeepDomain ?? false}
              onChange={(e) => update({ maskKeepDomain: e.target.checked })}
            />
            {t.options.maskKeepDomain}
          </label>
        </div>
      )}

      {/* 行3：类型相关选项/提示（单行小字，仅在相关时出现） */}
      {rule.type === 'builtin' && detector && (
        <div className="truncate text-[10px] text-[var(--vesper-text-dim)]">
          {detector.description}
        </div>
      )}
      {rule.type === 'regex' && (
        <div className="flex items-center gap-2 text-[10px] text-[var(--vesper-text-dim)]">
          <span className="shrink-0">
            flags
            <input
              className="ml-1 w-14 rounded border border-[var(--vesper-border)] bg-white px-1 py-0.5 font-mono"
              value={rule.regexFlags ?? 'g'}
              onChange={(e) => update({ regexFlags: e.target.value })}
            />
          </span>
          <span className="truncate">{t.options.regexCatastrophicHint}</span>
        </div>
      )}
      {rule.type === 'keyword' && (
        <div className="flex gap-3 text-[10px] text-[var(--vesper-text-dim)]">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              className="accent-black"
              checked={rule.caseSensitive ?? false}
              onChange={(e) => update({ caseSensitive: e.target.checked })}
            />
            {t.options.caseSensitive}
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              className="accent-black"
              checked={rule.wholeWord ?? false}
              onChange={(e) => update({ wholeWord: e.target.checked })}
            />
            {t.options.wholeWord}
          </label>
        </div>
      )}

      {/* 行4：测试台单行 */}
      <div className="flex items-center gap-2">
        <input
          className="min-w-0 flex-1 rounded border border-dashed border-[var(--vesper-border)] bg-transparent px-2 py-1 text-xs outline-none focus:border-black"
          placeholder={t.options.ruleTestPlaceholder}
          value={sample}
          onChange={(e) => runTest(e.target.value, rule)}
        />
        {testErr && <span className="shrink-0 text-xs text-neutral-500">⚠ {testErr}</span>}
        {testOut && (
          <span className="shrink-0 max-w-[45%] truncate rounded bg-[#f9fafb] px-2 py-0.5 font-mono text-xs text-black">
            → {testOut}
          </span>
        )}
      </div>
    </div>
  );
}
