/**
 * 规则新建 / 编辑弹窗：
 * - 支持新建与编辑双模式（编辑保留原规则 ID 与启停状态）；
 * - 禁用点击外部遮罩关闭，杜绝框选拖出或误触丢失正在编辑的内容；
 * - 显式右上角关闭按钮 + 底部取消按钮；按 Esc 若有未保存改动则二次确认。
 */
import { useEffect, useState } from 'react';
import { DETECTORS } from '../../core/detectors';
import { genId } from '../../core/presets';
import type { Rule, RuleType } from '../../core/types';
import { t } from '../../i18n';
import RuleForm from './RuleForm';

interface Props {
  initialType?: RuleType;
  initialRule?: Rule;
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

function cloneRule(rule: Rule): Rule {
  return {
    ...rule,
    ...(rule.maskKeep ? { maskKeep: { ...rule.maskKeep } } : {}),
  };
}

/** 确认前校验：返回错误文案或 null */
function validate(rule: Rule): string | null {
  if (rule.type !== 'builtin' && !rule.pattern.trim()) return t.options.errPatternRequired;
  if (rule.type === 'regex') {
    try {
      let flags = rule.regexFlags ?? 'g';
      if (!flags.includes('g')) flags += 'g';
      new RegExp(rule.pattern, flags);
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

export default function AddRuleModal({ initialType, initialRule, onConfirm, onCancel }: Props) {
  const isEdit = initialRule != null;
  const [initialDraft] = useState<Rule>(() =>
    initialRule ? cloneRule(initialRule) : makeDraft(initialType ?? 'keyword'),
  );
  const [draft, setDraft] = useState<Rule>(() => cloneRule(initialDraft));
  const [touched, setTouched] = useState(false);
  const error = validate(draft);
  const isDirty = JSON.stringify(draft) !== JSON.stringify(initialDraft);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (!isDirty || window.confirm(t.options.closeUnsavedConfirm)) {
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isDirty, onCancel]);

  function switchType(type: RuleType) {
    if (draft.type === type) return;
    setDraft((prev) => {
      const next = makeDraft(type);
      // 保留原 ID、启停状态与用户自定义名称
      const prevDefaultName =
        prev.type === 'builtin'
          ? DETECTORS[prev.pattern as keyof typeof DETECTORS]?.name
          : undefined;
      const keepName = prev.name && prev.name !== prevDefaultName ? prev.name : next.name;
      return { ...next, id: prev.id, enabled: prev.enabled, name: keepName };
    });
  }

  const title = isEdit ? t.options.editRuleTitle : t.options.addRuleTitle;

  return (
    <div
      data-testid="add-rule-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[var(--vesper-border)] bg-white shadow-2xl"
      >
        {/* 弹窗头部 */}
        <div className="flex items-center gap-3 border-b border-[var(--vesper-border)] px-5 py-3.5">
          <span className="text-base font-semibold text-black">{title}</span>
          <div className="ml-auto flex gap-1 text-xs">
            {TYPE_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                className={`rounded-md px-3 py-1 transition-colors ${
                  draft.type === value
                    ? 'bg-[var(--vesper-accent)] font-medium text-white'
                    : 'border border-[var(--vesper-border)] text-[var(--vesper-text-dim)] hover:border-black hover:text-[var(--vesper-text)]'
                }`}
                onClick={() => switchType(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label={t.options.closeModal}
            title={t.options.closeModal}
            className="rounded-md p-1 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-black"
            onClick={onCancel}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        {/* 表单与多行测试预览主体 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <RuleForm rule={draft} onChange={setDraft} />
        </div>

        {/* 弹窗底部：校验错误 + 操作按钮 */}
        <div className="flex items-center justify-between gap-3 border-t border-[var(--vesper-border)] bg-neutral-50/70 px-5 py-3.5 text-sm">
          <div className="min-w-0 flex-1 text-xs text-red-600">{touched && error ? error : ''}</div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              className="rounded-md border border-[var(--vesper-border)] bg-white px-4 py-1.5 text-sm hover:border-black"
              onClick={onCancel}
            >
              {t.common.cancel}
            </button>
            <button
              type="button"
              data-testid="confirm-add-rule"
              className="rounded-md bg-[var(--vesper-accent)] px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-800"
              onClick={() => {
                setTouched(true);
                if (!error) onConfirm(draft);
              }}
            >
              {isEdit ? t.common.save : t.common.add}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
