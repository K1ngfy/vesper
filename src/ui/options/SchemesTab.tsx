/**
 * 方案管理 Tab：左侧方案列表（次级导航）+ 右侧单列逐条规则管理。
 * - 突出「+ 关键词 / + 正则 / + 内置检测器」主操作区，弱化「+ 新建方案」防误点；
 * - 规则逐条表格式展示，含优先级序号、拖拽排序、快捷启停、弹窗编辑与删除。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { applyRuleModeChange } from '../../core/engine';
import { genId } from '../../core/presets';
import type { Rule, RuleType, Scheme } from '../../core/types';
import { ensureSeeded, getSchemes, getSettings, saveSchemes, updateSettings } from '../../storage';
import { t } from '../../i18n';
import Toggle from '../Toggle';
import RuleCard, { RULE_ROW_COLS } from './RuleCard';
import AddRuleModal from './AddRuleModal';

type RuleFilter = 'all' | RuleType | 'enabled' | 'disabled';
type RuleModalState = { mode: 'add'; initialType: RuleType } | { mode: 'edit'; rule: Rule } | null;

export default function SchemesTab() {
  const [schemes, setSchemes] = useState<Scheme[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [schemeName, setSchemeName] = useState('');
  const [modal, setModal] = useState<RuleModalState>(null);
  const [filter, setFilter] = useState<RuleFilter>('all');
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragIndex = useRef<number>(-1);
  const nameTimer = useRef<number | null>(null);
  const schemesRef = useRef<Scheme[]>([]);
  const selectedIdRef = useRef('');
  const schemeNameRef = useRef('');
  const pendingScrollId = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  schemesRef.current = schemes;
  selectedIdRef.current = selectedId;
  schemeNameRef.current = schemeName;

  useEffect(() => {
    void ensureSeeded()
      .then(() => getSchemes())
      .then((list) => {
        setSchemes(list);
        const initial = list.find((s) => s.isDefault) ?? list[0];
        setSelectedId(initial?.id ?? '');
        setSchemeName(initial?.name ?? '');
      });
  }, []);

  const selected = schemes.find((s) => s.id === selectedId);

  useEffect(() => {
    setSchemeName(selected?.name ?? '');
  }, [selected?.id]);

  // 卸载时落盘未提交的方案名防抖修改，防止切换 Tab 时丢失
  useEffect(() => {
    return () => {
      if (nameTimer.current != null) {
        window.clearTimeout(nameTimer.current);
        nameTimer.current = null;
        const id = selectedIdRef.current;
        const name = schemeNameRef.current;
        const target = schemesRef.current.find((s) => s.id === id);
        if (target && target.name !== name) {
          const next = schemesRef.current.map((s) =>
            s.id === id ? { ...s, name, updatedAt: Date.now() } : s,
          );
          schemesRef.current = next;
          void saveSchemes(next);
        }
      }
    };
  }, []);

  // 新增规则后平滑滚动到新条目
  useEffect(() => {
    const id = pendingScrollId.current;
    if (!id) return;
    pendingScrollId.current = null;
    const row = listRef.current?.querySelector(`[data-rule-id="${CSS.escape(id)}"]`);
    row?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [selected?.rules.length]);

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
    schemesRef.current = next;
    setSchemes(next);
    await saveSchemes(next);
  }

  function updateSchemeById(id: string, patch: Partial<Scheme>) {
    const next = schemesRef.current.map((s) =>
      s.id === id ? { ...s, ...patch, updatedAt: Date.now() } : s,
    );
    void persist(next);
  }

  function updateScheme(patch: Partial<Scheme>) {
    if (!selected) return;
    updateSchemeById(selected.id, patch);
  }

  function mutateSelectedRules(updater: (rules: Rule[]) => Rule[]) {
    if (!selected) return;
    const current = schemesRef.current.find((s) => s.id === selected.id);
    if (!current) return;
    updateSchemeById(current.id, { rules: updater(current.rules) });
  }

  function commitSchemeName(id: string, name: string) {
    if (nameTimer.current != null) {
      window.clearTimeout(nameTimer.current);
      nameTimer.current = null;
    }
    const target = schemesRef.current.find((s) => s.id === id);
    if (!target || target.name === name) return;
    updateSchemeById(id, { name });
  }

  function onSchemeNameChange(value: string) {
    setSchemeName(value);
    if (!selected) return;
    const id = selected.id;
    if (nameTimer.current != null) window.clearTimeout(nameTimer.current);
    nameTimer.current = window.setTimeout(() => {
      nameTimer.current = null;
      commitSchemeName(id, value);
    }, 300);
  }

  function addScheme() {
    if (selected) commitSchemeName(selected.id, schemeName);
    const now = Date.now();
    const s: Scheme = {
      id: genId(),
      name: `新方案 ${schemes.length + 1}`,
      isDefault: schemes.length === 0,
      enabled: true,
      rules: [],
      createdAt: now,
      updatedAt: now,
    };
    void persist([...schemesRef.current, s]);
    setSelectedId(s.id);
    setSchemeName(s.name);
  }

  function duplicateScheme() {
    if (!selected) return;
    commitSchemeName(selected.id, schemeName);
    const current = schemesRef.current.find((s) => s.id === selected.id) ?? selected;
    const copy: Scheme = {
      ...current,
      id: genId(),
      name: `${current.name} 副本`,
      isDefault: false,
      rules: current.rules.map((r) => ({ ...r, id: genId() })),
      updatedAt: Date.now(),
    };
    void persist([...schemesRef.current, copy]);
    setSelectedId(copy.id);
    setSchemeName(copy.name);
  }

  async function deleteScheme() {
    if (!selected || schemes.length <= 1) return;
    if (
      selected.rules.length > 0 &&
      !window.confirm(t.options.deleteSchemeConfirm(schemeName || selected.name))
    ) {
      return;
    }
    if (nameTimer.current != null) {
      window.clearTimeout(nameTimer.current);
      nameTimer.current = null;
    }
    const filtered = schemesRef.current.filter((s) => s.id !== selected.id);
    const next =
      selected.isDefault && filtered.length > 0
        ? filtered.map((s, idx) => (idx === 0 ? { ...s, isDefault: true } : s))
        : filtered;
    await persist(next);
    const fallback = next.find((s) => s.isDefault) ?? next[0];
    setSelectedId(fallback?.id ?? '');
    setSchemeName(fallback?.name ?? '');

    // 同步修复 activeSchemeId，避免删除当前激活方案后 Popup 下拉失步
    const settings = await getSettings();
    if (settings && settings.activeSchemeId === selected.id) {
      await updateSettings({ activeSchemeId: fallback?.id ?? '' });
    }
  }

  function setDefault() {
    if (!selected) return;
    commitSchemeName(selected.id, schemeName);
    void persist(schemesRef.current.map((s) => ({ ...s, isDefault: s.id === selected.id })));
    // 设默认方案后，当前方案自动跟随（Popup 与站点拦截均按新默认方案）
    void updateSettings({ activeSchemeId: selected.id });
  }

  function moveRule(from: number, to: number) {
    mutateSelectedRules((currentRules) => {
      if (
        from === to ||
        from < 0 ||
        to < 0 ||
        from >= currentRules.length ||
        to >= currentRules.length
      ) {
        return currentRules;
      }
      const rules = [...currentRules];
      const [r] = rules.splice(from, 1);
      if (!r) return currentRules;
      rules.splice(to, 0, r);
      return rules;
    });
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
    <div className="flex items-start gap-5">
      {/* 左侧方案列表（次级导航，避免与右侧「添加规则」抢夺焦点） */}
      <aside className="w-56 shrink-0 rounded-lg border border-[var(--vesper-border)] bg-neutral-50/70 p-3">
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-[var(--vesper-text-dim)]">
            {t.options.schemeListTitle}
          </span>
          <button
            type="button"
            className="rounded-md border border-[var(--vesper-border)] bg-white px-2 py-1 text-xs font-medium text-black transition-colors hover:border-black hover:bg-neutral-100"
            onClick={addScheme}
          >
            {t.options.newScheme}
          </button>
        </div>
        <div className="space-y-1">
          {schemes.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                if (selected) commitSchemeName(selected.id, schemeName);
                setSelectedId(s.id);
              }}
              className={`flex w-full items-center gap-1.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
                s.id === selectedId
                  ? 'border border-black bg-white font-medium text-black shadow-xs'
                  : 'border border-transparent text-neutral-700 hover:bg-white/80'
              }`}
            >
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="shrink-0 font-mono text-[10px] text-[var(--vesper-text-dim)]">
                {s.rules.length}
              </span>
              {s.isDefault && (
                <span className="shrink-0 rounded bg-[var(--vesper-accent)]/15 px-1 text-[10px] text-[var(--vesper-accent)]">
                  {t.common.defaultTag}
                </span>
              )}
              {!s.enabled && (
                <span className="shrink-0 text-[10px] text-neutral-400">{t.common.disabled}</span>
              )}
            </button>
          ))}
        </div>
      </aside>

      {/* 右侧规则工作区 */}
      <section className="min-w-0 flex-1 space-y-3">
        {selected ? (
          <>
            {/* 方案头：名称 + 启停 + 方案级操作 */}
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="min-w-[180px] flex-1 rounded-md border border-[var(--vesper-border)] bg-white px-3 py-1.5 text-sm font-medium outline-none focus:border-black"
                value={schemeName}
                onChange={(e) => onSchemeNameChange(e.target.value)}
                onBlur={() => commitSchemeName(selected.id, schemeName)}
              />
              <label className="flex items-center gap-1.5 px-1 text-xs text-[var(--vesper-text-dim)]">
                <Toggle checked={selected.enabled} onChange={(v) => updateScheme({ enabled: v })} />
                {t.common.enable}
              </label>
              {!selected.isDefault && (
                <button
                  type="button"
                  className="rounded-md border border-[var(--vesper-border)] bg-white px-2.5 py-1.5 text-xs hover:border-black"
                  onClick={setDefault}
                >
                  {t.common.setDefault}
                </button>
              )}
              <button
                type="button"
                className="rounded-md border border-[var(--vesper-border)] bg-white px-2.5 py-1.5 text-xs hover:border-black"
                onClick={duplicateScheme}
              >
                {t.common.duplicate}
              </button>
              <button
                type="button"
                disabled={schemes.length <= 1}
                title={schemes.length <= 1 ? t.options.cannotDeleteLastScheme : t.common.delete}
                className="rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-xs text-neutral-500 hover:border-black hover:text-black disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => void deleteScheme()}
              >
                {t.common.delete}
              </button>
            </div>

            {/* 主操作栏：高对比度「添加规则」入口 */}
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--vesper-border)] bg-neutral-50/80 px-3 py-2.5">
              <span className="text-xs font-semibold text-black">{t.options.addRuleLabel}</span>
              <button
                type="button"
                className="rounded-md bg-black px-3.5 py-1.5 text-xs font-medium text-white shadow-xs transition-colors hover:bg-neutral-800"
                onClick={() => setModal({ mode: 'add', initialType: 'keyword' })}
              >
                {t.options.addKeyword}
              </button>
              <button
                type="button"
                className="rounded-md bg-black px-3.5 py-1.5 text-xs font-medium text-white shadow-xs transition-colors hover:bg-neutral-800"
                onClick={() => setModal({ mode: 'add', initialType: 'regex' })}
              >
                {t.options.addRegex}
              </button>
              <button
                type="button"
                className="rounded-md bg-black px-3.5 py-1.5 text-xs font-medium text-white shadow-xs transition-colors hover:bg-neutral-800"
                onClick={() => setModal({ mode: 'add', initialType: 'builtin' })}
              >
                {t.options.addBuiltin}
              </button>
              <span className="ml-auto text-[11px] text-[var(--vesper-text-dim)]">
                {t.options.dragToSort}
              </span>
            </div>

            {/* 快速筛选：轻量样式，不与主操作按钮产生视觉冲突 */}
            <div className="flex flex-wrap gap-1.5 text-xs">
              {filterChips.map(({ id, label, count }) => (
                <button
                  key={id}
                  type="button"
                  className={`rounded-full px-2.5 py-0.5 transition-colors ${
                    filter === id
                      ? 'border border-black bg-neutral-900/10 font-medium text-black'
                      : 'border border-[var(--vesper-border)] bg-white text-[var(--vesper-text-dim)] hover:border-neutral-400 hover:text-black'
                  }`}
                  onClick={() => setFilter(id)}
                >
                  {label} · {count}
                </button>
              ))}
            </div>

            {/* 单列逐条规则列表 */}
            <div
              ref={listRef}
              className="overflow-hidden rounded-lg border border-[var(--vesper-border)] bg-white"
            >
              <div
                className={`grid ${RULE_ROW_COLS} items-center gap-3 bg-neutral-50 px-3 py-2 text-[11px] font-medium text-[var(--vesper-text-dim)]`}
              >
                <span>{t.options.ruleColOrder}</span>
                <span>{t.options.ruleColType}</span>
                <span>{t.options.ruleColName}</span>
                <span>{t.options.ruleColSummary}</span>
                <span>{t.options.ruleColMode}</span>
                <span>{t.options.ruleColStatus}</span>
                <span className="text-right">{t.options.ruleColActions}</span>
              </div>

              {selected.rules.length === 0 ? (
                <div className="border-t border-[var(--vesper-border)] py-10 text-center text-sm text-[var(--vesper-text-dim)]">
                  {t.options.noRulesYet}
                </div>
              ) : filteredRules.length === 0 ? (
                <div className="border-t border-[var(--vesper-border)] py-10 text-center text-sm text-[var(--vesper-text-dim)]">
                  {t.options.noRulesMatchFilter}
                </div>
              ) : (
                filteredRules.map(({ rule, index }) => (
                  <RuleCard
                    key={rule.id}
                    rule={rule}
                    order={index + 1}
                    isDragOver={dragOverId === rule.id}
                    onToggle={(enabled) =>
                      mutateSelectedRules((rules) =>
                        rules.map((x) => (x.id === rule.id ? { ...x, enabled } : x)),
                      )
                    }
                    onModeChange={(mode) =>
                      mutateSelectedRules((rules) =>
                        rules.map((x) => (x.id === rule.id ? applyRuleModeChange(x, mode) : x)),
                      )
                    }
                    onEdit={() => setModal({ mode: 'edit', rule })}
                    onDelete={() =>
                      mutateSelectedRules((rules) => rules.filter((x) => x.id !== rule.id))
                    }
                    onDragStart={() => {
                      dragIndex.current = index;
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (dragIndex.current >= 0 && dragIndex.current !== index) {
                        setDragOverId(rule.id);
                      }
                    }}
                    onDragLeave={() => {
                      if (dragOverId === rule.id) setDragOverId(null);
                    }}
                    onDrop={() => {
                      const from = dragIndex.current;
                      dragIndex.current = -1;
                      setDragOverId(null);
                      moveRule(from, index);
                    }}
                    onDragEnd={() => {
                      dragIndex.current = -1;
                      setDragOverId(null);
                    }}
                  />
                ))
              )}
            </div>
          </>
        ) : (
          <div className="py-16 text-center text-sm text-[var(--vesper-text-dim)]">
            {t.options.createSchemeFirst}
          </div>
        )}
      </section>

      {modal != null && selected && (
        <AddRuleModal
          initialType={modal.mode === 'add' ? modal.initialType : undefined}
          initialRule={modal.mode === 'edit' ? modal.rule : undefined}
          onCancel={() => setModal(null)}
          onConfirm={(rule) => {
            if (modal.mode === 'add') {
              pendingScrollId.current = rule.id;
              mutateSelectedRules((rules) => [...rules, rule]);
              setFilter('all'); // 添加后切回全部，确保新规则立即可见
            } else {
              mutateSelectedRules((rules) => rules.map((x) => (x.id === rule.id ? rule : x)));
            }
            setModal(null);
          }}
        />
      )}
    </div>
  );
}
