/**
 * Popup（VESPEER.md 4.5，T7）：总开关、方案切换、当前站点状态、
 * 渐进授权（list 模式「在此站点启用」/ global 模式「开启全局拦截」）、
 * 三个入口（工作台/配置/侧边栏）、今日脱敏次数。
 *
 * 渐进授权：list 模式下未配置/无权限的当前标签页可一键申请该域两条 origin
 * 并加入名单启用，替代「全局权限」诉求，守住 D5 最小权限。
 */
import { useEffect, useState } from 'react';
import type { Scheme, SiteRule, SiteScope } from '@/src/core/types';
import { sendMessage, type SiteStateResponse } from '@/src/messages';
import {
  getSettings,
  saveSettings,
  getSites,
  saveSites,
  hostToOrigins,
  urlToHost,
} from '@/src/storage';
import { genId } from '@/src/core/presets';
import { t } from '@/src/i18n';
import Toggle from '@/src/ui/Toggle';

const STATUS_CLS: Record<string, string> = {
  enabled: 'text-black',
  disabled: 'text-neutral-500',
  unconfigured: 'text-neutral-400',
  'no-permission': 'text-neutral-600',
};

export default function App() {
  const [globalEnabled, setGlobalEnabled] = useState(true);
  const [schemes, setSchemes] = useState<Scheme[]>([]);
  const [schemeId, setSchemeId] = useState('');
  const [siteState, setSiteState] = useState<SiteStateResponse | null>(null);
  const [scope, setScope] = useState<SiteScope>('list');
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);

  async function refreshSiteState() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      setSiteState(await sendMessage({ type: 'GET_SITE_STATE', url: tab.url }));
    }
  }

  useEffect(() => {
    void (async () => {
      const [settings, list, c] = await Promise.all([
        getSettings(),
        sendMessage({ type: 'GET_SCHEMES' }),
        sendMessage({ type: 'GET_DAILY_COUNT' }),
      ]);
      if (settings) {
        setGlobalEnabled(settings.globalEnabled);
        setSchemeId(settings.activeSchemeId);
        setScope(settings.siteScope ?? 'list');
      }
      setSchemes(list);
      setCount(c);
      await refreshSiteState();
    })();
  }, []);

  async function toggleGlobal() {
    const settings = await getSettings();
    if (!settings) return;
    settings.globalEnabled = !settings.globalEnabled;
    await saveSettings(settings);
    setGlobalEnabled(settings.globalEnabled);
    // 状态行跟随刷新：关闭后当前站点应立即显示「已停用」
    await refreshSiteState();
  }

  async function switchScheme(id: string) {
    setSchemeId(id);
    await sendMessage({ type: 'SET_ACTIVE_SCHEME', schemeId: id });
  }

  /** list 模式渐进授权：申请当前域名两条 origin 并加入名单启用 */
  async function enableCurrentSite() {
    setBusy(true);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) return;
      const host = urlToHost(tab.url);
      if (!host) return;
      const origins = hostToOrigins(host);
      const granted = await chrome.permissions.request({ origins });
      if (!granted) return;
      const sites = await getSites();
      const existing = sites.find((s) => s.host === host);
      const next: SiteRule[] = existing
        ? sites.map((s) => (s.id === existing.id ? { ...s, enabled: true } : s))
        : [...sites, { id: genId(), host, schemeId: '', enabled: true, mode: 'preview' }];
      await saveSites(next);
      await sendMessage({ type: 'REFRESH_SITE_REGISTRATIONS' });
      await refreshSiteState();
    } finally {
      setBusy(false);
    }
  }

  /** global 模式：申请全局通配权限并切换作用范围 */
  async function enableGlobal() {
    setBusy(true);
    try {
      const granted = await chrome.permissions.request({ origins: ['*://*/*'] });
      if (!granted) return;
      const settings = await getSettings();
      if (settings) {
        settings.siteScope = 'global';
        await saveSettings(settings);
        setScope('global');
      }
      await sendMessage({ type: 'REFRESH_SITE_REGISTRATIONS' });
      await refreshSiteState();
    } finally {
      setBusy(false);
    }
  }

  async function openSidePanel() {
    // 优先用原生 sidePanel（Chrome / Edge 支持）；Arc 等浏览器不支持
    // chrome.sidePanel API，open() 会抛错——此时降级为独立面板窗口，
    // 否则错误被 void 静默吞掉，用户看到"点了没反应"。
    try {
      if (chrome.sidePanel?.open) {
        const win = await chrome.windows.getCurrent();
        await chrome.sidePanel.open({ windowId: win.id! });
        window.close();
        return;
      }
    } catch {
      // 落到下方降级方案
    }
    await chrome.windows.create({
      url: chrome.runtime.getURL('/sidepanel.html'),
      type: 'panel',
      width: 520,
      height: 760,
    });
    window.close();
  }

  const statusKey = siteState?.status ?? 'unconfigured';
  const statusText =
    statusKey === 'enabled'
      ? // 同时显示实际生效的拦截方案，所见即所得（跟随当前方案或显式绑定）
        `${t.popup.siteEnabled}${siteState?.scheme ? ` · ${siteState.scheme.name}` : ''}`
      : statusKey === 'disabled'
        ? t.popup.siteDisabled
        : statusKey === 'no-permission'
          ? t.popup.siteNoPermission
          : t.popup.siteUnconfigured;

  // 渐进授权按钮：list 模式下未配置/无权限可一键启用当前站点；
  // global 模式下无 *://*/* 权限可一键开启全局拦截。
  const canEnableHere =
    scope === 'list' && (statusKey === 'unconfigured' || statusKey === 'no-permission');
  const canEnableGlobal = scope === 'global' && statusKey === 'no-permission';
  const showEnableButton = !busy && (canEnableHere || canEnableGlobal);
  const enableLabel = busy
    ? t.popup.enabling
    : canEnableGlobal
      ? t.popup.enableGlobal
      : t.popup.enableHere;
  const onEnable = canEnableGlobal ? enableGlobal : enableCurrentSite;

  return (
    <div className="w-72 p-4" style={{ background: 'var(--vesper-bg-2)' }}>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-base font-bold">
          <span style={{ color: 'var(--vesper-accent)' }}>✳</span> {t.appName}
        </span>
        <div className="flex items-center gap-1.5 text-xs text-[var(--vesper-text-dim)]">
          <span className="cursor-pointer" onClick={() => void toggleGlobal()}>
            {t.popup.globalSwitch}
          </span>
          <Toggle
            checked={globalEnabled}
            onChange={() => void toggleGlobal()}
            title={globalEnabled ? t.common.disable : t.common.enable}
          />
        </div>
      </div>
      <div className="mb-3 text-[11px] text-[var(--vesper-text-dim)]">{t.slogan}</div>

      <div className="mb-3">
        <div className="mb-1 text-xs text-[var(--vesper-text-dim)]">{t.popup.activeScheme}</div>
        <select
          className="w-full rounded-md border border-[var(--vesper-border)] bg-[#ffffff] px-2 py-1.5 text-sm"
          value={schemeId}
          onChange={(e) => switchScheme(e.target.value)}
        >
          {schemes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.isDefault ? `（${t.common.defaultTag}）` : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-2 flex items-center justify-between rounded-md border border-[var(--vesper-border)] px-3 py-2 text-xs">
        <span className="text-[var(--vesper-text-dim)]">{t.popup.siteState}</span>
        <span className={STATUS_CLS[statusKey]}>{statusText}</span>
      </div>

      {showEnableButton && (
        <button
          className="mb-3 w-full rounded-md bg-black px-3 py-2 text-xs font-medium text-white hover:brightness-150"
          onClick={() => void onEnable()}
        >
          {enableLabel}
        </button>
      )}

      <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
        <button
          className="rounded-md bg-[var(--vesper-accent)] px-2 py-2 font-medium text-white hover:brightness-110"
          onClick={() => void sendMessage({ type: 'OPEN_WORKBENCH' })}
        >
          {t.popup.openWorkbench}
        </button>
        <button
          className="rounded-md border border-[var(--vesper-border)] px-2 py-2 hover:border-[var(--vesper-accent)]"
          onClick={() => void chrome.runtime.openOptionsPage()}
        >
          {t.popup.openOptions}
        </button>
        <button
          className="rounded-md border border-[var(--vesper-border)] px-2 py-2 hover:border-[var(--vesper-accent)]"
          onClick={() => void openSidePanel()}
        >
          {t.popup.openSidePanel}
        </button>
      </div>

      <div className="text-center text-[11px] text-[var(--vesper-text-dim)]">
        {t.popup.todayCount} <span className="text-[var(--vesper-accent)]">{count}</span>{' '}
        {t.popup.times}
      </div>
    </div>
  );
}
