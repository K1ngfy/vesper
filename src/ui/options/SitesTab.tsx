/**
 * 站点拦截 Tab（文档 4.4）：情景模式切换 + 域名通配 + 行式表格 + 添加弹框。
 * - list（黑名单）模式：内置站点默认启用（预览确认）；顶部快速筛选 + 批量勾选，
 *   勾选后出现批量操作栏（启用/关闭/拦截模式/绑定方案）。
 * - global 模式：申请全局通配权限，例外主机用多行文本框维护（每行一条，支持通配/网段）。
 * 添加经弹框填写各字段；selector 覆盖为行内「编辑」展开项。
 */
import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_EXCLUDE_HOSTS,
  genId,
  normalizeHost,
  SITE_CATEGORY_ORDER,
  SITE_DISPLAY_NAMES,
} from '../../core/presets';
import type { Scheme, SiteCategory, SiteMode, SiteRule, SiteScope } from '../../core/types';
import { sendMessage } from '../../messages';
import {
  getSchemes,
  getSites,
  saveSites,
  getSettings,
  saveSettings,
  hostToOrigins,
} from '../../storage';
import { t } from '../../i18n';
import Toggle from '../Toggle';

/** 域名/通配模式校验：接受 example.com、*.example.com、*；拒绝含协议/路径的输入 */
function isValidHostPattern(input: string): boolean {
  const v = input.trim().toLowerCase();
  if (v === '*') return true;
  const base = v.startsWith('*.') ? v.slice(2) : v;
  if (!base || base.length > 253) return false;
  const labels = base.split('.');
  if (labels.length < 2) return false;
  return labels.every(
    (l) => /^[a-z0-9-]{1,63}$/.test(l) && !l.startsWith('-') && !l.endsWith('-'),
  );
}

/** 表格列宽：选择 / 名称 / 域名 / 状态 / 方案 / 拦截模式 / 操作 */
const COLS = 'grid-cols-[24px_minmax(90px,1fr)_minmax(130px,1.2fr)_80px_150px_130px_64px]';

type Filter = 'all' | SiteCategory;

const EditIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);
const TrashIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18" />
    <path d="M8 6V4h8v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
  </svg>
);

/** 例外主机文本框：按行拆分、去空、去重（保留顺序，不做严格校验以支持网段/IPv6） */
function parseExcludeText(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const v = raw.trim().toLowerCase();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** 生效标记：模式卡片右侧的小图标（实心圆 + 白勾），标识「当前正在启用」 */
function ActiveBadge({ title }: { title: string }) {
  return (
    <span className="inline-flex shrink-0 items-center" title={title} aria-label={title}>
      <svg width="17" height="17" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" fill="currentColor" />
        <path
          d="M8 12.4l2.6 2.6L16 9.5"
          fill="none"
          stroke="#ffffff"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export default function SitesTab() {
  const [sites, setSites] = useState<SiteRule[]>([]);
  const [schemes, setSchemes] = useState<Scheme[]>([]);
  const [scope, setScope] = useState<SiteScope>('list');
  const [excludeHosts, setExcludeHosts] = useState<string[]>([]);
  /** 例外文本框的编辑态（不回写用户输入，避免打字时被规范化打断） */
  const [excludeText, setExcludeText] = useState('');
  const excludeTimer = useRef<number | null>(null);
  const [globalGranted, setGlobalGranted] = useState(false);
  const [globalMode, setGlobalMode] = useState<SiteMode>('preview');
  const [notice, setNotice] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState({
    name: '',
    host: '',
    category: 'custom' as SiteCategory,
    schemeId: '',
    mode: 'preview' as SiteMode,
  });

  useEffect(() => {
    void Promise.all([getSites(), getSchemes(), getSettings()]).then(([s, sch, st]) => {
      setSites(s);
      setSchemes(sch);
      setScope(st?.siteScope ?? 'list');
      setGlobalMode(st?.globalMode ?? 'preview');
      const exclude = st?.excludeHosts ?? DEFAULT_EXCLUDE_HOSTS;
      setExcludeHosts(exclude);
      setExcludeText(exclude.join('\n'));
    });
    void chrome.permissions.contains({ origins: ['*://*/*'] }).then(setGlobalGranted);
  }, []);

  async function persistSites(next: SiteRule[]) {
    setSites(next);
    await saveSites(next);
    await sendMessage({ type: 'REFRESH_SITE_REGISTRATIONS' });
  }

  async function persistScope(next: SiteScope) {
    const settings = await getSettings();
    if (!settings) return;
    settings.siteScope = next;
    await saveSettings(settings);
    setScope(next);
    await sendMessage({ type: 'REFRESH_SITE_REGISTRATIONS' });
  }

  async function enableGlobal() {
    const granted = await chrome.permissions.request({ origins: ['*://*/*'] });
    if (!granted) {
      setNotice(t.options.permissionDenied);
      return;
    }
    setGlobalGranted(true);
    setNotice(t.options.refreshHint);
    await persistScope('global');
  }

  async function persistExcludeHosts(next: string[]) {
    setExcludeHosts(next);
    const settings = await getSettings();
    if (!settings) return;
    settings.excludeHosts = next;
    await saveSettings(settings);
    // 保存后 content script 会因 storage 变更自动刷新判定，无需再注册
  }

  /** 全局模式拦截模式变更：写入 settings，content script 监听 storage 变化自动刷新 */
  async function persistGlobalMode(next: SiteMode) {
    setGlobalMode(next);
    const settings = await getSettings();
    if (!settings) return;
    settings.globalMode = next;
    await saveSettings(settings);
  }

  /** 停止输入 500ms 后落盘；失焦时立即落盘 */
  function scheduleExcludeCommit(text: string) {
    if (excludeTimer.current) window.clearTimeout(excludeTimer.current);
    excludeTimer.current = window.setTimeout(() => {
      void persistExcludeHosts(parseExcludeText(text));
    }, 500);
  }

  function commitExcludeText(text: string) {
    if (excludeTimer.current) {
      window.clearTimeout(excludeTimer.current);
      excludeTimer.current = null;
    }
    const next = parseExcludeText(text);
    if (next.join('\n') === excludeHosts.join('\n')) return;
    void persistExcludeHosts(next);
  }

  /** 单个站点启停（状态列点击）：启用申请权限，停用交还权限 */
  async function toggleSite(site: SiteRule) {
    if (!site.enabled) {
      const origins = hostToOrigins(site.host);
      const granted = await chrome.permissions.request({ origins });
      if (!granted) {
        setNotice(t.options.permissionDenied);
        return;
      }
      setNotice(t.options.refreshHint);
    } else {
      const origins = hostToOrigins(site.host);
      await chrome.permissions.remove({ origins }).catch(() => {});
      setNotice('');
    }
    await persistSites(
      sites.map((s) => (s.id === site.id ? { ...s, enabled: !s.enabled } : s)),
    );
  }

  function updateSite(id: string, patch: Partial<SiteRule>) {
    void persistSites(sites.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function openAdd() {
    setDraft({ name: '', host: '', category: 'custom', schemeId: '', mode: 'preview' });
    setNotice('');
    setShowAdd(true);
  }

  function submitAdd() {
    const host = draft.host.trim().toLowerCase();
    if (!host) {
      setNotice(t.options.addSiteEmpty);
      return;
    }
    if (!isValidHostPattern(host)) {
      setNotice(t.options.invalidDomain);
      return;
    }
    if (sites.some((s) => normalizeHost(s.host) === normalizeHost(host))) {
      setNotice(t.options.invalidDomain);
      return;
    }
    const site: SiteRule = {
      id: genId(),
      host,
      name: draft.name.trim() || undefined,
      schemeId: draft.schemeId,
      enabled: false,
      mode: draft.mode,
      category: draft.category,
    };
    void persistSites([...sites, site]);
    setShowAdd(false);
    setNotice(t.options.addSiteSuccess);
  }

  function copyAiPrompt(host: string) {
    const prompt = t.options.selectorAiPrompt.replace('{host}', host || '（目标站点域名）');
    void navigator.clipboard.writeText(prompt).then(() => setNotice(t.options.aiPromptCopied));
  }

  // ---------- 批量选择与操作 ----------

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  /** 批量启用：一次性申请所有选中站点权限后启用 */
  async function batchEnable() {
    const targets = sites.filter((s) => selected.has(s.id) && !s.enabled);
    if (targets.length === 0) {
      clearSelection();
      return;
    }
    const origins = Array.from(new Set(targets.flatMap((s) => hostToOrigins(s.host))));
    const granted = await chrome.permissions.request({ origins });
    if (!granted) {
      setNotice(t.options.permissionDenied);
      return;
    }
    await persistSites(sites.map((s) => (selected.has(s.id) ? { ...s, enabled: true } : s)));
    setNotice(t.options.refreshHint);
    clearSelection();
  }

  /** 批量关闭：停用并交还权限 */
  async function batchDisable() {
    const targets = sites.filter((s) => selected.has(s.id) && s.enabled);
    const origins = Array.from(new Set(targets.flatMap((s) => hostToOrigins(s.host))));
    if (origins.length) await chrome.permissions.remove({ origins }).catch(() => {});
    await persistSites(sites.map((s) => (selected.has(s.id) ? { ...s, enabled: false } : s)));
    clearSelection();
  }

  function batchSetMode(mode: SiteMode) {
    void persistSites(sites.map((s) => (selected.has(s.id) ? { ...s, mode } : s)));
    clearSelection();
  }

  function batchSetScheme(schemeId: string) {
    void persistSites(sites.map((s) => (selected.has(s.id) ? { ...s, schemeId } : s)));
    clearSelection();
  }

  const filteredSites =
    filter === 'all' ? sites : sites.filter((s) => (s.category ?? 'custom') === filter);
  const allSelected =
    filteredSites.length > 0 && filteredSites.every((s) => selected.has(s.id));

  function toggleSelectAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(filteredSites.map((s) => s.id)));
  }

  /** 单个站点行 + 行内高级展开区 */
  function renderSite(site: SiteRule) {
    const isOpen = expanded[site.id] ?? false;
    return (
      <div key={site.id} className="border-t border-[var(--vesper-border)]">
        <div className={`grid ${COLS} items-center gap-3 px-3 py-2 transition-colors hover:bg-neutral-50`}>
          <input
            type="checkbox"
            className="accent-black"
            checked={selected.has(site.id)}
            onChange={() => toggleSelect(site.id)}
          />
          <input
            className="min-w-0 w-full rounded border border-transparent bg-transparent px-1.5 py-0.5 text-sm outline-none hover:border-[var(--vesper-border)] focus:border-black"
            value={site.name ?? ''}
            onChange={(e) => updateSite(site.id, { name: e.target.value })}
            placeholder={SITE_DISPLAY_NAMES[normalizeHost(site.host)] ?? t.options.siteNamePlaceholder}
          />
          <span
            className="min-w-0 truncate font-mono text-xs text-[var(--vesper-text-dim)]"
            title={site.host}
          >
            {site.host}
          </span>
          <Toggle
            checked={site.enabled}
            onChange={() => void toggleSite(site)}
            title={site.enabled ? t.common.disable : t.common.enable}
          />
          <select
            className="w-full rounded border border-[var(--vesper-border)] bg-white px-1.5 py-1 text-xs"
            value={site.schemeId}
            onChange={(e) => updateSite(site.id, { schemeId: e.target.value })}
          >
            <option value="">{t.options.followActive}</option>
            {schemes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            className="w-full rounded border border-[var(--vesper-border)] bg-white px-1.5 py-1 text-xs"
            value={site.mode}
            onChange={(e) => updateSite(site.id, { mode: e.target.value as SiteMode })}
          >
            <option value="preview">{t.options.modePreview}</option>
            <option value="auto">{t.options.modeAuto}</option>
            <option value="warn-only">{t.options.modeWarnOnly}</option>
          </select>
          <div className="flex items-center justify-end gap-1">
            <button
              className={`rounded p-1 hover:bg-neutral-200 ${isOpen ? 'text-black' : 'text-neutral-500'}`}
              title={t.common.edit}
              onClick={() => setExpanded({ ...expanded, [site.id]: !isOpen })}
            >
              {EditIcon}
            </button>
            <button
              className="rounded p-1 text-neutral-500 hover:bg-neutral-200 hover:text-black"
              title={t.common.delete}
              onClick={() => void persistSites(sites.filter((s) => s.id !== site.id))}
            >
              {TrashIcon}
            </button>
          </div>
        </div>
        {isOpen && (
          <div className={`grid ${COLS} items-center gap-3 border-t border-dashed border-[var(--vesper-border)] bg-neutral-50 px-3 py-2 text-xs`}>
            <div />
            <div className="col-span-2 space-y-1">
              <p className="text-[var(--vesper-text-dim)]">{t.options.selectorHelp}</p>
              <input
                className="w-full rounded border border-[var(--vesper-border)] bg-white px-1.5 py-1 font-mono"
                placeholder="CSS 选择器，如 div#chat-input textarea"
                value={site.selector ?? ''}
                onChange={(e) =>
                  updateSite(site.id, { selector: e.target.value || undefined })
                }
              />
            </div>
            <div />
            <button
              className="w-full rounded border border-[var(--vesper-border)] bg-white px-1.5 py-1 text-[var(--vesper-text-dim)] hover:border-black"
              onClick={() => copyAiPrompt(site.host)}
            >
              {t.options.copyAiPrompt}
            </button>
            <div />
            <div />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* 情景模式切换：选中项标题高亮 + 生效图标 */}
      <section>
        <h3 className="mb-2 text-sm font-semibold">{t.options.scopeTitle}</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          <button
            className={`rounded-lg border p-3 text-left text-sm ${
              scope === 'global'
                ? 'border-black bg-neutral-50'
                : 'border-[var(--vesper-border)] bg-white hover:border-neutral-400'
            }`}
            onClick={() => {
              if (scope !== 'global' || !globalGranted) void enableGlobal();
            }}
          >
            <div className="flex items-center">
              <span
                className={
                  scope === 'global'
                    ? 'font-semibold text-black'
                    : 'font-medium text-[var(--vesper-text-dim)]'
                }
              >
                {t.options.scopeGlobal}
              </span>
              {scope === 'global' && globalGranted && (
                <span className="ml-auto">
                  <ActiveBadge title={t.options.scopeActive} />
                </span>
              )}
            </div>
            <div className="mt-1 text-xs text-[var(--vesper-text-dim)]">
              {t.options.scopeGlobalDesc}
            </div>
            {scope === 'global' && !globalGranted && (
              <span className="mt-1 block text-[11px] text-neutral-600">
                {t.options.scopeGlobalNeedGrant}
              </span>
            )}
          </button>
          <button
            className={`rounded-lg border p-3 text-left text-sm ${
              scope === 'list'
                ? 'border-black bg-neutral-50'
                : 'border-[var(--vesper-border)] bg-white hover:border-neutral-400'
            }`}
            onClick={() => scope !== 'list' && void persistScope('list')}
          >
            <div className="flex items-center">
              <span
                className={
                  scope === 'list'
                    ? 'font-semibold text-black'
                    : 'font-medium text-[var(--vesper-text-dim)]'
                }
              >
                {t.options.scopeList}
              </span>
              {scope === 'list' && (
                <span className="ml-auto">
                  <ActiveBadge title={t.options.scopeActive} />
                </span>
              )}
            </div>
            <div className="mt-1 text-xs text-[var(--vesper-text-dim)]">
              {t.options.scopeListDesc}
            </div>
          </button>
        </div>
      </section>

      {notice && <div className="text-sm text-neutral-600">{notice}</div>}

      {scope === 'global' ? (
        /* 全局模式：拦截模式 + 例外主机（多行文本框，每行一条） */
        <section className="space-y-4">
          {/* 拦截模式 */}
          <div>
            <h4 className="mb-1 text-sm font-medium">{t.options.globalModeTitle}</h4>
            <p className="mb-2 text-xs text-[var(--vesper-text-dim)]">{t.options.globalModeHint}</p>
            <select
              className="w-full max-w-xs rounded-md border border-[var(--vesper-border)] bg-white px-3 py-2 text-sm"
              value={globalMode}
              onChange={(e) => void persistGlobalMode(e.target.value as SiteMode)}
            >
              <option value="preview">{t.options.modePreview}</option>
              <option value="auto">{t.options.modeAuto}</option>
              <option value="warn-only">{t.options.modeWarnOnly}</option>
            </select>
          </div>
          {/* 例外主机 */}
          <div>
            <h4 className="mb-1 text-sm font-medium">{t.options.excludeListTitle}</h4>
            <p className="mb-1 text-xs text-[var(--vesper-text-dim)]">{t.options.excludeListHint}</p>
            <p className="mb-2 text-[11px] text-[var(--vesper-text-dim)]">
              {t.options.excludeListTip}
            </p>
            <textarea
              className="h-44 w-full resize-y rounded-md border border-[var(--vesper-border)] bg-white px-3 py-2 font-mono text-xs leading-5 outline-none focus:border-black"
              value={excludeText}
              onChange={(e) => {
                setExcludeText(e.target.value);
                scheduleExcludeCommit(e.target.value);
              }}
              onBlur={() => commitExcludeText(excludeText)}
              spellCheck={false}
              placeholder={t.options.excludeEmpty}
            />
          </div>
        </section>
      ) : (
        /* list（黑名单）模式：顶部筛选 + 添加按钮 + 批量操作 + 行式表格 */
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1">
              {(['all', ...SITE_CATEGORY_ORDER] as Filter[]).map((f) => (
                <button
                  key={f}
                  className={`rounded-full px-3 py-1 text-xs ${
                    filter === f
                      ? 'bg-black text-white'
                      : 'border border-[var(--vesper-border)] text-[var(--vesper-text-dim)] hover:border-black'
                  }`}
                  onClick={() => setFilter(f)}
                >
                  {f === 'all' ? t.options.filterAll : t.options.categoryNames[f]}
                </button>
              ))}
            </div>
            <button
              className="shrink-0 rounded-md bg-black px-4 py-1.5 text-sm font-medium text-white hover:brightness-150"
              onClick={openAdd}
            >
              {t.options.addSite}
            </button>
          </div>

          {/* 批量操作栏：有勾选时出现 */}
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--vesper-border)] bg-neutral-50 px-3 py-2 text-xs">
              <span className="font-medium">{t.options.selectedCount(selected.size)}</span>
              <button
                className="rounded border border-[var(--vesper-border)] bg-white px-2 py-1 hover:border-black"
                onClick={() => void batchEnable()}
              >
                {t.common.enable}
              </button>
              <button
                className="rounded border border-[var(--vesper-border)] bg-white px-2 py-1 hover:border-black"
                onClick={() => void batchDisable()}
              >
                {t.options.batchDisable}
              </button>
              <select
                className="rounded border border-[var(--vesper-border)] bg-white px-2 py-1"
                value=""
                onChange={(e) => {
                  if (e.target.value) batchSetMode(e.target.value as SiteMode);
                }}
              >
                <option value="">拦截模式</option>
                <option value="preview">{t.options.modePreview}</option>
                <option value="auto">{t.options.modeAuto}</option>
                <option value="warn-only">{t.options.modeWarnOnly}</option>
              </select>
              <select
                className="rounded border border-[var(--vesper-border)] bg-white px-2 py-1"
                value=""
                onChange={(e) => {
                  if (e.target.value !== '') batchSetScheme(e.target.value);
                }}
              >
                <option value="">绑定方案</option>
                <option value="">{t.options.followActive}</option>
                {schemes.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <button
                className="ml-auto text-[var(--vesper-text-dim)] hover:text-black"
                onClick={clearSelection}
              >
                {t.options.clearSelection}
              </button>
            </div>
          )}

          <div className="overflow-hidden rounded-lg border border-[var(--vesper-border)] bg-white">
            <div
              className={`grid ${COLS} items-center gap-3 border-b border-[var(--vesper-border)] bg-neutral-50 px-3 py-2 text-[11px] font-medium text-[var(--vesper-text-dim)]`}
            >
              <input
                type="checkbox"
                className="accent-black"
                checked={allSelected}
                onChange={toggleSelectAll}
              />
              <span>名称</span>
              <span>域名</span>
              <span>状态</span>
              <span>{t.options.bindScheme}</span>
              <span>拦截模式</span>
              <span className="text-right">操作</span>
            </div>
            {filteredSites.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-[var(--vesper-text-dim)]">
                {t.options.noRulesMatchFilter}
              </div>
            ) : (
              filteredSites.map((site) => renderSite(site))
            )}
          </div>
        </section>
      )}

      {/* 添加站点弹框 */}
      {showAdd && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
          onClick={() => setShowAdd(false)}
        >
          <div
            className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-4 text-sm font-semibold">{t.options.addSiteTitle}</h3>
            <div className="space-y-3 text-sm">
              <label className="block">
                <span className="mb-1 block text-xs text-[var(--vesper-text-dim)]">{t.options.fieldName}</span>
                <input
                  className="w-full rounded-md border border-[var(--vesper-border)] px-3 py-2"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder={t.options.siteNamePlaceholder}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-[var(--vesper-text-dim)]">{t.options.fieldHost}</span>
                <input
                  className="w-full rounded-md border border-[var(--vesper-border)] px-3 py-2 font-mono"
                  value={draft.host}
                  onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                  placeholder="*.example.com"
                  autoFocus
                />
                <span className="mt-1 block text-[11px] text-[var(--vesper-text-dim)]">
                  {t.options.hostWildcardHint}
                </span>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-xs text-[var(--vesper-text-dim)]">{t.options.fieldCategory}</span>
                  <select
                    className="w-full rounded-md border border-[var(--vesper-border)] bg-white px-2 py-2"
                    value={draft.category}
                    onChange={(e) => setDraft({ ...draft, category: e.target.value as SiteCategory })}
                  >
                    {SITE_CATEGORY_ORDER.map((c) => (
                      <option key={c} value={c}>
                        {t.options.categoryNames[c]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-[var(--vesper-text-dim)]">拦截模式</span>
                  <select
                    className="w-full rounded-md border border-[var(--vesper-border)] bg-white px-2 py-2"
                    value={draft.mode}
                    onChange={(e) => setDraft({ ...draft, mode: e.target.value as SiteMode })}
                  >
                    <option value="preview">{t.options.modePreview}</option>
                    <option value="auto">{t.options.modeAuto}</option>
                    <option value="warn-only">{t.options.modeWarnOnly}</option>
                  </select>
                </label>
              </div>
              <label className="block">
                <span className="mb-1 block text-xs text-[var(--vesper-text-dim)]">{t.options.bindScheme}</span>
                <select
                  className="w-full rounded-md border border-[var(--vesper-border)] bg-white px-2 py-2"
                  value={draft.schemeId}
                  onChange={(e) => setDraft({ ...draft, schemeId: e.target.value })}
                >
                  <option value="">{t.options.followActive}</option>
                  {schemes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="rounded-md border border-[var(--vesper-border)] px-4 py-2 text-sm hover:border-black"
                onClick={() => setShowAdd(false)}
              >
                {t.common.cancel}
              </button>
              <button
                className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white hover:brightness-150"
                onClick={submitAdd}
              >
                {t.common.add}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
