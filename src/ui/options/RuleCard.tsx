/**
 * 规则卡片（紧凑版）：拖拽排序 + 启停 + 删除 + 内嵌 RuleForm。
 * 卡头一行（拖拽柄 + 类型徽标 + 启停滑块 + 删除图标），卡体由 RuleForm 提供紧凑两行。
 * 卡内不展示"样本即时预览"（配置页从简），该测试台只在"添加规则"弹窗保留。
 */
import type { Rule } from '../../core/types';
import { t } from '../../i18n';
import RuleForm from './RuleForm';
import Toggle from '../Toggle';

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

const TrashIcon = (
  <svg
    width="13"
    height="13"
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
        <div
          className="ml-auto flex items-center"
          title={rule.enabled ? t.common.disable : t.common.enable}
        >
          <Toggle checked={rule.enabled} onChange={(v) => onChange({ ...rule, enabled: v })} />
        </div>
        <button
          className="rounded p-1 text-neutral-500 hover:bg-neutral-200 hover:text-black"
          title={t.common.delete}
          aria-label={t.common.delete}
          onClick={onDelete}
        >
          {TrashIcon}
        </button>
      </div>
      <RuleForm rule={rule} onChange={onChange} showTest={false} />
    </div>
  );
}
