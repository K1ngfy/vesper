/**
 * Popup（VESPEER.md 4.5，T7）：总开关、方案切换、当前站点状态、
 * 渐进授权（list 模式「在此站点启用」/ global 模式「开启全局拦截」）、
 * 三个入口（工作台/配置/侧边栏）、今日脱敏次数。
 *
 * 渐进授权：list 模式下未配置/无权限的当前标签页可一键申请该域两条 origin
 * 并加入名单启用，替代「全局权限」诉求，守住 D5 最小权限。
 */
import { useEffect, useRef, useState } from 'react';
import type { Scheme, SiteRule, SiteScope } from '@/src/core/types';
import { hasAvailableUpdate, type UpdateState } from '@/src/core/update';
import { sendMessage, type SiteStateResponse } from '@/src/messages';
import {
  ensureSeeded,
  getSettings,
  updateSettings,
  getSites,
  saveSites,
  getUpdateState,
  hostToOrigins,
  UPDATE_STATE_KEY,
  urlToHost,
} from '@/src/storage';
import { genId, normalizeHost } from '@/src/core/presets';
import { t } from '@/src/i18n';
import Toggle from '@/src/ui/Toggle';
import VesperLogo from '@/src/ui/VesperLogo';

const STATUS_CLS: Record<string, string> = {
  enabled: 'text-black',
  disabled: 'text-neutral-500',
  unconfigured: 'text-neutral-400',
  'no-permission': 'font-medium text-red-600',
};

export default function App() {
  const [globalEnabled, setGlobalEnabled] = useState(true);
  const [schemes, setSchemes] = useState<Scheme[]>([]);
  const [schemeId, setSchemeId] = useState('');
  const [activeHost, setActiveHost] = useState('');
  const [siteState, setSiteState] = useState<SiteStateResponse | null>(null);
  const [scope, setScope] = useState<SiteScope>('list');
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState | undefined>(undefined);
  const windowIdRef = useRef<number | undefined>(undefined);
  const tabIdRef = useRef<number | undefined>(undefined);
  const bypassNativeSidePanelRef = useRef(false);
  const hasUpdate = hasAvailableUpdate(chrome.runtime.getManifest().version, updateState);

  async function refreshSiteState() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId != null) windowIdRef.current = tab.windowId;
    if (tab?.id != null) tabIdRef.current = tab.id;
    if (tab?.url?.startsWith('arc://')) {
      bypassNativeSidePanelRef.current = true;
      void chrome.storage.local.set({ 'vesper:isArc': true }).catch(() => {});
    }
    setActiveHost(urlToHost(tab?.url ?? ''));
    setSiteState(tab?.url ? await sendMessage({ type: 'GET_SITE_STATE', url: tab.url }) : null);
  }

  useEffect(() => {
    const checkOwnArcStyles = () => {
      try {
        const s = getComputedStyle(document.documentElement);
        if (
          s.getPropertyValue('--arc-palette-title').trim() ||
          s.getPropertyValue('--arc-palette-background').trim() ||
          s.getPropertyValue('--arc-background-simple-color').trim()
        ) {
          bypassNativeSidePanelRef.current = true;
          void chrome.storage.local.set({ 'vesper:isArc': true }).catch(() => {});
        }
      } catch {
        // 忽略样式探测异常
      }
    };
    checkOwnArcStyles();
    const arcStyleTimer = window.setTimeout(checkOwnArcStyles, 200);

    void Promise.all([
      chrome.storage.local.get('vesper:isArc').catch(() => ({}) as Record<string, unknown>),
      chrome.storage.session
        .get('vesper:nativeSidePanelBroken')
        .catch(() => ({}) as Record<string, unknown>),
    ]).then(([localObj, sessionObj]) => {
      if (localObj['vesper:isArc'] || sessionObj['vesper:nativeSidePanelBroken']) {
        bypassNativeSidePanelRef.current = true;
      }
    });

    // 立即预取当前窗口与活动标签 ID，同时借助 activeTab 探测宿主是否为 Arc 浏览器
    void chrome.windows
      .getCurrent()
      .then((win) => {
        if (win?.id != null) windowIdRef.current = win.id;
      })
      .catch(() => {});
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => {
        if (tab?.windowId != null) windowIdRef.current = tab.windowId;
        if (tab?.id != null) tabIdRef.current = tab.id;
        if (tab?.url?.startsWith('arc://')) {
          bypassNativeSidePanelRef.current = true;
          void chrome.storage.local.set({ 'vesper:isArc': true }).catch(() => {});
        } else if (tab?.id != null && /^https?:\/\//.test(tab.url ?? '')) {
          void chrome.scripting
            ?.executeScript({
              target: { tabId: tab.id },
              func: () => {
                const s = getComputedStyle(document.documentElement);
                return Boolean(
                  s.getPropertyValue('--arc-palette-title').trim() ||
                  s.getPropertyValue('--arc-palette-background').trim() ||
                  s.getPropertyValue('--arc-background-simple-color').trim(),
                );
              },
            })
            .then((res) => {
              if (res?.[0]?.result === true) {
                bypassNativeSidePanelRef.current = true;
                void chrome.storage.local.set({ 'vesper:isArc': true }).catch(() => {});
              }
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
    void (async () => {
      await ensureSeeded();
      const [settings, list, c, upd] = await Promise.all([
        getSettings(),
        sendMessage({ type: 'GET_SCHEMES' }),
        sendMessage({ type: 'GET_DAILY_COUNT' }),
        getUpdateState(),
      ]);
      if (settings) {
        setGlobalEnabled(settings.globalEnabled);
        setScope(settings.siteScope ?? 'list');
      }
      setUpdateState(upd);
      const effectiveScheme =
        list.find((s) => s.id === settings?.activeSchemeId) ??
        list.find((s) => s.isDefault) ??
        list[0];
      setSchemeId(effectiveScheme?.id ?? '');
      setSchemes(list);
      setCount(c);
      await refreshSiteState();
    })();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && UPDATE_STATE_KEY in changes) {
        setUpdateState(changes[UPDATE_STATE_KEY]?.newValue as UpdateState | undefined);
      }
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      window.clearTimeout(arcStyleTimer);
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, []);

  async function toggleGlobal() {
    const settings = await getSettings();
    if (!settings) return;
    const enabled = !settings.globalEnabled;
    await updateSettings({ globalEnabled: enabled });
    setGlobalEnabled(enabled);
    // 状态行跟随刷新：关闭后当前站点应立即显示「已停用」
    await refreshSiteState();
  }

  async function switchScheme(id: string) {
    setSchemeId(id);
    await sendMessage({ type: 'SET_ACTIVE_SCHEME', schemeId: id });
    await refreshSiteState();
  }

  /** list 模式渐进授权：申请当前域名两条 origin 并加入名单启用 */
  async function enableCurrentSite() {
    setBusy(true);
    try {
      const host = activeHost;
      if (!host) return;
      const origins = hostToOrigins(siteState?.site?.host ?? host);
      const granted = await chrome.permissions.request({ origins });
      if (!granted) return;
      const sites = await getSites();
      const existing = siteState?.site ?? sites.find((s) => normalizeHost(s.host) === host);
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
      await updateSettings({ siteScope: 'global' });
      setScope('global');
      await sendMessage({ type: 'REFRESH_SITE_REGISTRATIONS' });
      await refreshSiteState();
    } finally {
      setBusy(false);
    }
  }

  async function openSidePanel() {
    const windowId = windowIdRef.current;
    const tabId = tabIdRef.current;

    // 已知为 Arc 或原生侧边栏不可见的浏览器时，零延迟直接拉起贴边独立侧边栏窗口
    if (bypassNativeSidePanelRef.current || !chrome.sidePanel?.open) {
      await sendMessage({ type: 'OPEN_SIDE_PANEL_FALLBACK', windowId }).catch(() => {});
      window.close();
      return;
    }

    // 关键约束：chrome.sidePanel.open 必须在点击手势的同步栈帧内直接调用（禁止前置 await）
    let openTask: Promise<void> | undefined;
    if (windowId != null || tabId != null) {
      try {
        openTask =
          windowId != null
            ? chrome.sidePanel.open({ windowId })
            : chrome.sidePanel.open({ tabId: tabId! });
      } catch {
        openTask = undefined;
      }
    }

    if (!openTask) {
      await sendMessage({ type: 'OPEN_SIDE_PANEL_FALLBACK', windowId }).catch(() => {});
      window.close();
      return;
    }

    // 立即通知后台启动真实可见性探活（即便 openTask 在 Arc 中永不 resolve 或创建隐藏幽灵视图也能兜底）
    void sendMessage({ type: 'VERIFY_SIDE_PANEL_OPENED', windowId }).catch(() => {});

    const outcome = await Promise.race([
      openTask.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      ),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 350)),
    ]);

    if (outcome === 'rejected') {
      await sendMessage({ type: 'OPEN_SIDE_PANEL_FALLBACK', windowId }).catch(() => {});
    }
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
          ? scope === 'global'
            ? t.popup.globalNoPermission
            : t.popup.siteNoPermission
          : t.popup.siteUnconfigured;

  // 渐进授权按钮：总开关开启时，list 模式下未配置/无权限/站点未启用可一键启用当前站点；
  // global 模式下无 *://*/* 权限可一键开启全局拦截。
  const canEnableHere =
    globalEnabled &&
    !!activeHost &&
    scope === 'list' &&
    (statusKey === 'unconfigured' ||
      statusKey === 'no-permission' ||
      (statusKey === 'disabled' && siteState?.site?.enabled === false));
  const canEnableGlobal =
    globalEnabled && !!activeHost && scope === 'global' && statusKey === 'no-permission';
  const modeLabel =
    siteState?.site &&
    {
      preview: t.options.modePreview,
      auto: t.options.modeAuto,
      'warn-only': t.options.modeWarnOnly,
    }[siteState.site.mode];
  const showEnableButton = canEnableHere || canEnableGlobal;
  const enableLabel = busy
    ? t.popup.enabling
    : canEnableGlobal
      ? t.popup.enableGlobal
      : t.popup.enableHere;
  const onEnable = canEnableGlobal ? enableGlobal : enableCurrentSite;

  return (
    <div className="w-72 p-4" style={{ background: 'var(--vesper-bg-2)' }}>
      <div className="mb-1 flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 text-base font-bold">
          <VesperLogo size={20} />
          <span>{t.appName}</span>
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
              {!s.enabled ? `（${t.common.disabled}）` : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-2 flex items-center justify-between rounded-md border border-[var(--vesper-border)] px-3 py-2 text-xs">
        <span className="text-[var(--vesper-text-dim)]">{t.popup.siteState}</span>
        <span className={STATUS_CLS[statusKey]}>
          {statusText}
          {statusKey === 'enabled' && modeLabel && ` · ${modeLabel}`}
        </span>
      </div>

      {showEnableButton && (
        <button
          disabled={busy}
          className="mb-3 w-full rounded-md bg-black px-3 py-2 text-xs font-medium text-white hover:brightness-150 disabled:cursor-wait disabled:opacity-60"
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
          className="relative rounded-md border border-[var(--vesper-border)] px-2 py-2 hover:border-[var(--vesper-accent)]"
          onClick={() => void chrome.runtime.openOptionsPage()}
        >
          {t.popup.openOptions}
          {hasUpdate && (
            <span
              data-testid="popup-update-dot"
              title={
                updateState?.latestVersion
                  ? t.options.updateAvailableText(updateState.latestVersion)
                  : t.options.updateAvailableBadge
              }
              aria-label={t.options.updateAvailableBadge}
              className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-red-500"
            />
          )}
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
