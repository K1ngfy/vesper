/**
 * 规则卡片（紧凑版）：拖拽排序 + 启停 + 删除 + 内嵌 RuleForm。
 * 卡头一行（拖拽柄 + 类型徽标 + 启停 + 删除），卡体由 RuleForm 提供紧凑两行。
 */
import type { Rule } from '../../core/types';
import { t } from '../../i18n';
import RuleForm from './RuleForm';

interface Props {
  rule: Rule;
  onChange: (rule: Rule) => void;
  onDelete: () => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
}

const TYPE_LABEL: Record<Rule['type'], string> = {
  keyword: t.options.ruleTypeKeyword,
  regex: t.options.ruleTypeRegex,
  builtin: t.options.ruleTypeBuiltin,
};

export default function RuleCard({
  rule,
  onChange,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
}: Props) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`rounded-md border bg-white p-2 ${
        rule.enabled ? 'border-[var(--vesper-border)]' : 'border-[var(--vesper-border)] opacity-60'
      }`}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <span className="cursor-grab text-[var(--vesper-text-dim)]" title={t.options.dragToSort}>
          ⠿
        </span>
        <span className="rounded bg-[#e5e5e5] px-1 py-0.5 text-[10px] text-black">
          {TYPE_LABEL[rule.type]}
        </span>
        <label className="ml-auto flex items-center gap-1 text-[10px] text-[var(--vesper-text-dim)]">
          <input
            type="checkbox"
            className="accent-black"
            checked={rule.enabled}
            onChange={(e) => onChange({ ...rule, enabled: e.target.checked })}
          />
          {t.common.enable}
        </label>
        <button className="text-[10px] text-neutral-500 hover:text-black" onClick={onDelete}>
          {t.common.delete}
        </button>
      </div>
      <RuleForm rule={rule} onChange={onChange} />
    </div>
  );
}
