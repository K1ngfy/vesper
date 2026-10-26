/**
 * 站点拦截 Tab（文档 4.4）：站点列表 + 按需申请可选主机权限（D5）。
 * 启用站点时触发 chrome.permissions.request（必须由用户手势发起——
 * 点击开关即手势，本页可直接调用）；被拒则提示并保持未启用。
 */
import { useEffect, useState } from 'react';
import { genId, SITE_DISPLAY_NAMES } from '../../core/presets';
import type { Scheme, SiteMode, SiteRule } from '../../core/types';
import { sendMessage } from '../../messages';
import { getSchemes, getSites, saveSites } from '../../storage';
import { t } from '../../i18n';

export default function SitesTab() {
  const [sites, setSites] = useState<SiteRule[]>([]);
  const [schemes, setSchemes] = useState<Scheme[]>([]);
  const [newPattern, setNewPattern] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    void Promise.all([getSites(), getSchemes()]).then(([s, sch]) => {
      setSites(s);
      setSchemes(sch);
    });
  }, []);

  async function persist(next: SiteRule[]) {
    setSites(next);
    await saveSites(next);
    await sendMessage({ type: 'REFRESH_SITE_REGISTRATIONS' });
  }

  async function toggleSite(site: SiteRule) {
    if (!site.enabled) {
      // 启用前申请该域名的可选权限（文档 4.4）
      const granted = await chrome.permissions.request({ origins: [site.matchPattern] });
      if (!granted) {
        setNotice(t.options.permissionDenied);
        return;
      }
      setNotice(t.options.refreshHint);
    } else {
      // 停用时一并交还权限（最小权限原则）
      await chrome.permissions.remove({ origins: [site.matchPattern] }).catch(() => {});
      setNotice('');
    }
    await persist(sites.map((s) => (s.id === site.id ? { ...s, enabled: !s.enabled } : s)));
  }

  function updateSite(id: string, patch: Partial<SiteRule>) {
    void persist(sites.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function addSite() {
    const pattern = newPattern.trim();
    if (!pattern) {
      setNotice(t.options.addSiteEmpty);
      return;
    }
    if (!isValidMatchPattern(pattern)) {
      setNotice(t.options.invalidPattern);
      return;
    }
    const site: SiteRule = {
      id: genId(),
      matchPattern: pattern,
      // 默认跟随当前方案（schemeId 为空），避免与 Popup 方案切换脱节
      schemeId: '',
      enabled: false,
      mode: 'preview',
    };
    setNewPattern('');
    setNotice(t.options.addSiteSuccess);
    void persist([...sites, site]);
  }

  /** match pattern 基本形态校验：*://host/* 或 https?://host/* */
  function isValidMatchPattern(pattern: string): boolean {
    return /^(\*|\w+):\/\/(\*|\*\.[^/\s]+|[^/\s*]+)\/\*?$/.test(pattern);
  }

  function siteName(pattern: string): string {
    return SITE_DISPLAY_NAMES[pattern] ?? pattern;
  }

  return (
    <div>
      <div className="mb-4 flex gap-2">
        <input
          className="min-w-0 flex-1 rounded-md border border-[var(--vesper-border)] bg-white px-3 py-2 text-sm"
          placeholder={t.options.matchPatternHint}
          value={newPattern}
          onChange={(e) => setNewPattern(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addSite();
          }}
        />
        <button
          className={`rounded-md px-4 py-2 text-sm font-medium text-white ${
            newPattern.trim()
              ? 'bg-black hover:brightness-150'
              : 'cursor-not-allowed bg-neutral-300'
          }`}
          onClick={addSite}
        >
          {t.options.addSite}
        </button>
      </div>
      {notice && <div className="mb-3 text-sm text-neutral-600">{notice}</div>}

      <div className="space-y-2">
        {sites.map((site) => (
          <div
            key={site.id}
            className="rounded-lg border border-[var(--vesper-border)] bg-[#ffffff] p-3"
          >
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                className="accent-black"
                checked={site.enabled}
                onChange={() => void toggleSite(site)}
              />
              <input
                className="min-w-0 flex-1 cursor-text rounded border border-[var(--vesper-border)] bg-white px-2 py-1 text-sm font-medium outline-none focus:border-black"
                value={site.name ?? ''}
                onChange={(e) => updateSite(site.id, { name: e.target.value })}
                placeholder={SITE_DISPLAY_NAMES[site.matchPattern] ?? t.options.siteNamePlaceholder}
              />
              <span className="shrink-0 font-mono text-xs text-[var(--vesper-text-dim)]">
                {site.matchPattern}
              </span>
              <button
                className="text-xs text-neutral-500 hover:text-black"
                onClick={() => void persist(sites.filter((s) => s.id !== site.id))}
              >
                {t.common.delete}
              </button>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3 pl-7 text-xs">
              <label className="flex items-center gap-1 text-[var(--vesper-text-dim)]">
                {t.options.bindScheme}
                <select
                  className="rounded border border-[var(--vesper-border)] bg-[#ffffff] px-2 py-1"
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
              </label>
              <label className="flex items-center gap-1 text-[var(--vesper-text-dim)]">
                模式
                <select
                  className="rounded border border-[var(--vesper-border)] bg-[#ffffff] px-2 py-1"
                  value={site.mode}
                  onChange={(e) => updateSite(site.id, { mode: e.target.value as SiteMode })}
                >
                  <option value="preview">{t.options.modePreview}</option>
                  <option value="auto">{t.options.modeAuto}</option>
                  <option value="warn-only">{t.options.modeWarnOnly}</option>
                </select>
              </label>
              <input
                className="min-w-40 flex-1 rounded border border-[var(--vesper-border)] bg-[#ffffff] px-2 py-1 font-mono"
                placeholder={t.options.selectorOverride}
                value={site.selector ?? ''}
                onChange={(e) => updateSite(site.id, { selector: e.target.value || undefined })}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
