/**
 * 方案管理 Tab（T5 + 2026-10-25 UX 修订）：方案列表（建/删/复制/设默认/启停）
 * + 规则编辑器。修订点：
 * 1. 添加规则改为弹窗配置（AddRuleModal），确认且校验通过后才入列；
 * 2. 规则列表支持按类型/启停快速筛选（含计数）。
 * 验收路径：建方案 → 弹窗加 3 类规则 → 设默认。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { genId } from '../../core/presets';
import type { Rule, RuleType, Scheme } from '../../core/types';
import { getSchemes, saveSchemes } from '../../storage';
import { t } from '../../i18n';
import RuleCard from './RuleCard';
import AddRuleModal from './AddRuleModal';

type RuleFilter = 'all' | RuleType | 'enabled' | 'disabled';

export default function SchemesTab() {
  const [schemes, setSchemes] = useState<Scheme[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [addType, setAddType] = useState<RuleType | null>(null); // 非 null 时显示添加弹窗
  const [filter, setFilter] = useState<RuleFilter>('all');
  const dragIndex = useRef<number>(-1);

  useEffect(() => {
    void getSchemes().then((list) => {
      setSchemes(list);
      setSelectedId(list.find((s) => s.isDefault)?.id ?? list[0]?.id ?? '');
    });
  }, []);

  const selected = schemes.find((s) => s.id === selectedId);

  const filteredRules = useMemo(() => {
    if (!selected) return [] as { rule: Rule; index: number }[];
    return selected.rules
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => {
        switch (filter) {
          case 'all':
            return true;
          case 'enabled':
            return rule.enabled;
          case 'disabled':
            return !rule.enabled;
          default:
            return rule.type === filter;
        }
      });
  }, [selected, filter]);

  const counts = useMemo(() => {
    const rules = selected?.rules ?? [];
    return {
      all: rules.length,
      keyword: rules.filter((r) => r.type === 'keyword').length,
      regex: rules.filter((r) => r.type === 'regex').length,
      builtin: rules.filter((r) => r.type === 'builtin').length,
      enabled: rules.filter((r) => r.enabled).length,
      disabled: rules.filter((r) => !r.enabled).length,
    };
  }, [selected]);

  async function persist(next: Scheme[]) {
    setSchemes(next);
    await saveSchemes(next);
  }

  function updateScheme(patch: Partial<Scheme>) {
    if (!selected) return;
    void persist(
      schemes.map((s) => (s.id === selected.id ? { ...s, ...patch, updatedAt: Date.now() } : s)),
    );
  }

  function addScheme() {
    const now = Date.now();
    const s: Scheme = {
      id: genId(),
      name: `新方案 ${schemes.length + 1}`,
      isDefault: false,
      enabled: true,
      rules: [],
      createdAt: now,
      updatedAt: now,
    };
    void persist([...schemes, s]);
    setSelectedId(s.id);
  }

  function duplicateScheme() {
    if (!selected) return;
    const copy: Scheme = {
      ...selected,
      id: genId(),
      name: `${selected.name} 副本`,
      isDefault: false,
      rules: selected.rules.map((r) => ({ ...r, id: genId() })),
      updatedAt: Date.now(),
    };
    void persist([...schemes, copy]);
    setSelectedId(copy.id);
  }

  function deleteScheme() {
    if (!selected) return;
    const next = schemes.filter((s) => s.id !== selected.id);
    if (selected.isDefault && next.length > 0) next[0]!.isDefault = true;
    void persist(next);
    setSelectedId(next[0]?.id ?? '');
  }

  function setDefault() {
    if (!selected) return;
    void persist(schemes.map((s) => ({ ...s, isDefault: s.id === selected.id })));
  }

  function moveRule(from: number, to: number) {
    if (!selected || from === to || from < 0 || to < 0) return;
    const rules = [...selected.rules];
    const [r] = rules.splice(from, 1);
    if (!r) return;
    rules.splice(to, 0, r);
    updateScheme({ rules });
  }

  const filterChips: { id: RuleFilter; label: string; count: number }[] = [
    { id: 'all', label: t.options.filterAll, count: counts.all },
    { id: 'keyword', label: t.options.ruleTypeKeyword, count: counts.keyword },
    { id: 'regex', label: t.options.ruleTypeRegex, count: counts.regex },
    { id: 'builtin', label: t.options.ruleTypeBuiltin, count: counts.builtin },
    { id: 'enabled', label: t.options.filterEnabled, count: counts.enabled },
    { id: 'disabled', label: t.options.filterDisabled, count: counts.disabled },
  ];

  return (
    <div className="flex gap-4">
      {/* 方案列表 */}
      <aside className="w-48 shrink-0">
        <button
          className="mb-2 w-full rounded-md bg-black py-1.5 text-sm font-medium text-white hover:brightness-150"
          onClick={addScheme}
        >
          {t.options.newScheme}
        </button>
        <div className="space-y-1">
          {schemes.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelectedId(s.id)}
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm ${
                s.id === selectedId
                  ? 'border border-black bg-[#f3f4f6]'
                  : 'border border-transparent hover:bg-white'
              }`}
            >
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              {s.isDefault && (
                <span className="rounded bg-[var(--vesper-accent)]/20 px-1 text-[10px] text-[var(--vesper-accent)]">
                  {t.common.defaultTag}
                </span>
              )}
              {!s.enabled && (
                <span className="text-[10px] text-neutral-400">{t.common.disabled}</span>
              )}
            </button>
          ))}
        </div>
      </aside>

      {/* 规则编辑器 */}
      <section className="min-w-0 flex-1">
        {selected ? (
          <>
            {/* 方案头：名称 + 启停 + 操作（一行） */}
            <div className="mb-2 flex items-center gap-2">
              <input
                className="min-w-0 flex-1 rounded border border-[var(--vesper-border)] bg-white px-2 py-1.5 text-sm font-medium"
                value={selected.name}
                onChange={(e) => updateScheme({ name: e.target.value })}
              />
              <label className="flex items-center gap-1 text-xs text-[var(--vesper-text-dim)]">
                <input
                  type="checkbox"
                  className="accent-black"
                  checked={selected.enabled}
                  onChange={(e) => updateScheme({ enabled: e.target.checked })}
                />
                {t.common.enable}
              </label>
              {!selected.isDefault && (
                <button
                  className="rounded border border-[var(--vesper-border)] px-2 py-1 text-xs hover:border-black"
                  onClick={setDefault}
                >
                  {t.common.setDefault}
                </button>
              )}
              <button
                className="rounded border border-[var(--vesper-border)] px-2 py-1 text-xs hover:border-black"
                onClick={duplicateScheme}
              >
                {t.common.duplicate}
              </button>
              <button
                className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-500 hover:border-black"
                onClick={deleteScheme}
              >
                {t.common.delete}
              </button>
            </div>

            {/* 工具栏：添加规则按钮 + 拖拽提示（一行） */}
            <div className="mb-2 flex items-center gap-1.5 text-xs">
              <button
                className="rounded border border-dashed border-[var(--vesper-border)] px-2.5 py-1 hover:border-black"
                onClick={() => setAddType('keyword')}
              >
                {t.options.addKeyword}
              </button>
              <button
                className="rounded border border-dashed border-[var(--vesper-border)] px-2.5 py-1 hover:border-black"
                onClick={() => setAddType('regex')}
              >
                {t.options.addRegex}
              </button>
              <button
                className="rounded border border-dashed border-[var(--vesper-border)] px-2.5 py-1 hover:border-black"
                onClick={() => setAddType('builtin')}
              >
                {t.options.addBuiltin}
              </button>
              <span className="ml-auto text-[var(--vesper-text-dim)]">{t.options.dragToSort}</span>
            </div>

            {/* 快速筛选：按类型 / 启停 */}
            <div className="mb-2 flex flex-wrap gap-1.5 text-xs">
              {filterChips.map(({ id, label, count }) => (
                <button
                  key={id}
                  className={`rounded-full px-2.5 py-0.5 ${
                    filter === id
                      ? 'bg-black font-medium text-white'
                      : 'border border-[var(--vesper-border)] text-[var(--vesper-text-dim)] hover:border-black hover:text-black'
                  }`}
                  onClick={() => setFilter(id)}
                >
                  {label} · {count}
                </button>
              ))}
            </div>

            {/* 规则卡片：≥768px 双列、≥1280px 三列，窄屏单列；紧凑卡片 */}
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
              {filteredRules.map(({ rule, index }) => (
                <RuleCard
                  key={rule.id}
                  rule={rule}
                  onChange={(r) =>
                    updateScheme({ rules: selected.rules.map((x) => (x.id === r.id ? r : x)) })
                  }
                  onDelete={() =>
                    updateScheme({ rules: selected.rules.filter((x) => x.id !== rule.id) })
                  }
                  onDragStart={() => {
                    dragIndex.current = index;
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => moveRule(dragIndex.current, index)}
                />
              ))}
            </div>
            {selected.rules.length === 0 && (
              <div className="py-8 text-center text-sm text-[var(--vesper-text-dim)]">
                {t.options.noRulesYet}
              </div>
            )}
            {selected.rules.length > 0 && filteredRules.length === 0 && (
              <div className="py-8 text-center text-sm text-[var(--vesper-text-dim)]">
                {t.options.noRulesMatchFilter}
              </div>
            )}
          </>
        ) : (
          <div className="py-16 text-center text-sm text-[var(--vesper-text-dim)]">
            {t.options.createSchemeFirst}
          </div>
        )}
      </section>

      {addType != null && selected && (
        <AddRuleModal
          initialType={addType}
          onCancel={() => setAddType(null)}
          onConfirm={(rule) => {
            updateScheme({ rules: [...selected.rules, rule] });
            setAddType(null);
            setFilter('all'); // 添加后切回全部，确保新规则立即可见
          }}
        />
      )}
    </div>
  );
}
