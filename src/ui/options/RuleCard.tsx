/**
 * 规则列表行组件（单列逐条展示）：
 * 展示执行顺序编号、类型徽标、规则名称、匹配与替换摘要、替换方式、启停开关、编辑与删除操作。
 */
import { getDetector } from '../../core/detectors';
import type { Rule } from '../../core/types';
import { t } from '../../i18n';
import Toggle from '../Toggle';

/** 规则列表网格列宽：顺序 / 类型 / 名称 / 匹配与替换 / 替换方式 / 状态 / 操作 */
export const RULE_ROW_COLS =
  'grid-cols-[54px_56px_minmax(110px,0.85fr)_minmax(200px,2.1fr)_104px_54px_68px]';

interface Props {
  rule: Rule;
  order: number;
  isDragOver?: boolean;
  onToggle: (enabled: boolean) => void;
  onModeChange: (mode: Rule['mode']) => void;
  onEdit: () => void;
  onDelete: () => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}

const TYPE_LABEL: Record<Rule['type'], string> = {
  keyword: t.options.ruleTypeKeyword,
  regex: t.options.ruleTypeRegex,
  builtin: t.options.ruleTypeBuiltin,
};

const TYPE_BADGE_CLS: Record<Rule['type'], string> = {
  keyword: 'border-neutral-300 bg-neutral-100 text-neutral-900',
  regex: 'border-neutral-400 bg-white font-mono text-neutral-900',
  builtin: 'border-neutral-200 bg-neutral-50 text-neutral-600',
};

const MODE_LABEL: Record<Rule['mode'], string> = {
  fixed: t.options.modeFixed,
  numbered: t.options.modeNumbered,
  mask: t.options.modeMask,
};

const EditIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

const TrashIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 6h18" />
    <path d="M8 6V4h8v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
  </svg>
);

function getPatternSummary(rule: Rule): string {
  if (rule.type === 'builtin') {
    return getDetector(rule.pattern)?.name ?? rule.pattern;
  }
  if (rule.type === 'regex') {
    return `/${rule.pattern}/${rule.regexFlags ?? 'g'}`;
  }
  return rule.pattern;
}

function getReplacementSummary(rule: Rule): string {
  if (rule.mode === 'mask') {
    const head = rule.maskKeep?.head ?? 1;
    const tail = rule.maskKeep?.tail ?? 1;
    return `${t.options.modeMask}(${t.options.maskHead}${head}·${t.options.maskTail}${tail}${rule.maskKeepDomain ? '·留域名' : ''})`;
  }
  if (rule.replacement) return rule.replacement;
  if (rule.mode === 'fixed') return '（空）';
  if (rule.type === 'builtin') {
    return getDetector(rule.pattern)?.defaultReplacement ?? '[MASKED_n]';
  }
  return '[MASKED_n]';
}

function getOptionTags(rule: Rule): string[] {
  const tags: string[] = [];
  if (rule.type === 'keyword') {
    if (rule.caseSensitive) tags.push(t.options.caseSensitive);
    if (rule.wholeWord) tags.push(t.options.wholeWord);
  }
  return tags;
}

export default function RuleCard({
  rule,
  order,
  isDragOver = false,
  onToggle,
  onModeChange,
  onEdit,
  onDelete,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: Props) {
  const detector = rule.type === 'builtin' ? getDetector(rule.pattern) : undefined;
  const displayName = rule.name.trim() || detector?.name || rule.pattern || t.options.ruleUnnamed;
  const patternSummary = getPatternSummary(rule);
  const replacementSummary = getReplacementSummary(rule);
  const optionTags = getOptionTags(rule);

  return (
    <div
      draggable
      data-rule-id={rule.id}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`grid ${RULE_ROW_COLS} items-center gap-3 border-t border-[var(--vesper-border)] px-3 py-2.5 text-sm transition-colors hover:bg-neutral-50 ${
        isDragOver ? 'border-t-2 border-t-black bg-neutral-100/80' : ''
      }`}
    >
      {/* 顺序与拖拽柄 */}
      <div
        className="flex cursor-grab items-center gap-1.5 text-xs text-[var(--vesper-text-dim)] select-none"
        title={t.options.dragToSort}
      >
        <span aria-hidden="true">⠿</span>
        <span className="font-mono text-[11px]">#{order}</span>
      </div>

      {/* 类型徽标 */}
      <div>
        <span
          className={`inline-block rounded border px-1.5 py-0.5 text-[11px] leading-tight ${TYPE_BADGE_CLS[rule.type]}`}
        >
          {TYPE_LABEL[rule.type]}
        </span>
      </div>

      {/* 规则名称 */}
      <div
        className={`min-w-0 truncate text-xs font-medium ${
          rule.enabled ? 'text-black' : 'text-neutral-400'
        }`}
        title={displayName}
      >
        {displayName}
      </div>

      {/* 匹配与替换摘要 */}
      <div className={`min-w-0 ${rule.enabled ? '' : 'opacity-55'}`}>
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          <span
            className="max-w-[52%] truncate rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-black"
            title={patternSummary}
          >
            {patternSummary}
          </span>
          <span className="shrink-0 text-neutral-400">→</span>
          <span
            className="min-w-0 truncate rounded border border-neutral-200 bg-white px-1.5 py-0.5 font-mono text-[11px] text-neutral-800"
            title={replacementSummary}
          >
            {replacementSummary}
          </span>
        </div>
        {(optionTags.length > 0 || detector?.description) && (
          <div className="mt-1 flex items-center gap-1.5 truncate text-[11px] text-[var(--vesper-text-dim)]">
            {optionTags.map((tag) => (
              <span
                key={tag}
                className="rounded bg-neutral-100 px-1 py-0.2 text-[10px] text-neutral-600"
              >
                {tag}
              </span>
            ))}
            {detector?.description && <span className="truncate">{detector.description}</span>}
          </div>
        )}
      </div>

      {/* 替换方式（可直接下拉切换，无需打开编辑弹窗） */}
      <div>
        <select
          aria-label={t.options.ruleColMode}
          value={rule.mode}
          draggable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onDragStart={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onChange={(e) => onModeChange(e.target.value as Rule['mode'])}
          className="w-full cursor-pointer rounded border border-[var(--vesper-border)] bg-white px-1.5 py-1 text-xs text-neutral-800 outline-none hover:border-neutral-400 focus:border-black"
        >
          {(Object.keys(MODE_LABEL) as Rule['mode'][]).map((m) => (
            <option key={m} value={m}>
              {MODE_LABEL[m]}
            </option>
          ))}
        </select>
      </div>

      {/* 启停开关 */}
      <div className="flex items-center">
        <Toggle
          checked={rule.enabled}
          onChange={onToggle}
          title={rule.enabled ? t.common.disable : t.common.enable}
        />
      </div>

      {/* 编辑与删除操作 */}
      <div className="flex items-center justify-end gap-1">
        <button
          type="button"
          className="rounded p-1.5 text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-black"
          title={t.common.edit}
          aria-label={t.common.edit}
          onClick={onEdit}
        >
          {EditIcon}
        </button>
        <button
          type="button"
          className="rounded p-1.5 text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-black"
          title={t.common.delete}
          aria-label={t.common.delete}
          onClick={onDelete}
        >
          {TrashIcon}
        </button>
      </div>
    </div>
  );
}
