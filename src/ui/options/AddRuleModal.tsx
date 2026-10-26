/**
 * "添加规则"弹窗（2026-10-25 修订）：点击添加按钮后先弹窗配置，
 * 用户确认（且校验通过）后才加入规则列表，避免"静默追加无感知"。
 * 表单复用 RuleForm；顶部可切换规则类型；底部实时显示校验错误。
 */
import { useState } from 'react';
import { DETECTORS } from '../../core/detectors';
import { genId } from '../../core/presets';
import { testRule } from '../../core/engine';
import type { Rule, RuleType } from '../../core/types';
import { t } from '../../i18n';
import RuleForm from './RuleForm';

interface Props {
  initialType: RuleType;
  onConfirm: (rule: Rule) => void;
  onCancel: () => void;
}

function makeDraft(type: RuleType): Rule {
  const base: Rule = {
    id: genId(),
    type,
    enabled: true,
    name: '',
    pattern: '',
    replacement: '',
    mode: 'fixed',
  };
  if (type === 'builtin') {
    const det = DETECTORS.email;
    return {
      ...base,
      name: det.name,
      pattern: det.id,
      replacement: det.defaultReplacement,
      mode: 'numbered',
    };
  }
  if (type === 'regex') return { ...base, regexFlags: 'g' };
  return base;
}

/** 确认前校验：返回错误文案或 null */
function validate(rule: Rule): string | null {
  if (rule.type !== 'builtin' && !rule.pattern.trim()) return t.options.errPatternRequired;
  if (rule.type === 'regex') {
    try {
      testRule(' ', rule);
    } catch (err) {
      return `${t.options.errRegexInvalid}${(err as Error).message}`;
    }
  }
  if (rule.mode === 'fixed' && !rule.replacement.trim()) {
    return t.options.errReplacementRequired;
  }
  if (rule.mode === 'numbered' && !rule.replacement.trim()) {
    return t.options.errReplacementRequired;
  }
  return null;
}

const TYPE_OPTIONS: { value: RuleType; label: string }[] = [
  { value: 'keyword', label: t.options.ruleTypeKeyword },
  { value: 'regex', label: t.options.ruleTypeRegex },
  { value: 'builtin', label: t.options.ruleTypeBuiltin },
];

export default function AddRuleModal({ initialType, onConfirm, onCancel }: Props) {
  const [draft, setDraft] = useState<Rule>(() => makeDraft(initialType));
  const [touched, setTouched] = useState(false);
  const error = validate(draft);

  function switchType(type: RuleType) {
    setDraft((prev) => {
      const next = makeDraft(type);
      // 保留用户已填的名称
      return { ...next, name: prev.name };
    });
  }

  return (
    <div
      data-testid="add-rule-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-xl rounded-xl border border-[var(--vesper-border)] bg-[#ffffff] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-3">
          <span className="text-base font-medium">{t.options.addRuleTitle}</span>
          <div className="ml-auto flex gap-1 text-xs">
            {TYPE_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                className={`rounded-md px-3 py-1 ${
                  draft.type === value
                    ? 'bg-[var(--vesper-accent)] font-medium text-white'
                    : 'border border-[var(--vesper-border)] text-[var(--vesper-text-dim)] hover:text-[var(--vesper-text)]'
                }`}
                onClick={() => switchType(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <RuleForm rule={draft} onChange={setDraft} />

        {touched && error && <div className="mt-3 text-xs text-neutral-500">{error}</div>}

        <div className="mt-4 flex justify-end gap-2 text-sm">
          <button
            className="rounded-md border border-[var(--vesper-border)] px-4 py-2"
            onClick={onCancel}
          >
            {t.common.cancel}
          </button>
          <button
            data-testid="confirm-add-rule"
            className="rounded-md bg-[var(--vesper-accent)] px-4 py-2 font-medium text-white hover:brightness-110"
            onClick={() => {
              setTouched(true);
              if (!error) onConfirm(draft);
            }}
          >
            {t.common.add}
          </button>
        </div>
      </div>
    </div>
  );
}
