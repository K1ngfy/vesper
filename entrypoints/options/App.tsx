/**
 * 配置页（VESPEER.md 4.4，T5）：方案管理 | 站点拦截 | 设置与数据。
 */
import { useEffect, useState } from 'react';
import { hasAvailableUpdate, type UpdateState } from '@/src/core/update';
import { getUpdateState, UPDATE_STATE_KEY } from '@/src/storage';
import SchemesTab from '@/src/ui/options/SchemesTab';
import SitesTab from '@/src/ui/options/SitesTab';
import SettingsTab from '@/src/ui/options/SettingsTab';
import VesperLogo from '@/src/ui/VesperLogo';
import { t } from '@/src/i18n';

type Tab = 'schemes' | 'sites' | 'settings';

export default function App() {
  const [tab, setTab] = useState<Tab>(() =>
    location.hash === '#settings' ? 'settings' : 'schemes',
  );
  const [updateState, setUpdateState] = useState<UpdateState | undefined>(undefined);
  const version = chrome.runtime.getManifest().version;
  const hasUpdate = hasAvailableUpdate(version, updateState);

  useEffect(() => {
    void getUpdateState().then((s) => setUpdateState(s));
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && UPDATE_STATE_KEY in changes) {
        setUpdateState(changes[UPDATE_STATE_KEY]?.newValue as UpdateState | undefined);
      }
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const tabs: { id: Tab; label: string; showDot?: boolean }[] = [
    { id: 'schemes', label: t.options.tabSchemes },
    { id: 'sites', label: t.options.tabSites },
    { id: 'settings', label: t.options.tabSettings, showDot: hasUpdate },
  ];

  return (
    <div className="mx-auto min-h-screen max-w-7xl p-6">
      <header className="mb-6 flex items-center gap-3">
        <span className="inline-flex items-center gap-2 text-2xl font-bold">
          <VesperLogo size={28} />
          <span>{t.appName}</span>
        </span>
        <span className="text-xs text-[var(--vesper-text-dim)]">{t.slogan}</span>
      </header>

      <nav className="mb-6 flex gap-2 border-b border-[var(--vesper-border)] pb-2">
        {tabs.map(({ id, label, showDot }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`inline-flex items-center gap-1.5 rounded-t-md px-4 py-2 text-sm ${
              tab === id
                ? 'bg-[var(--vesper-accent)] font-medium text-white'
                : 'text-[var(--vesper-text-dim)] hover:text-[var(--vesper-text)]'
            }`}
          >
            <span>{label}</span>
            {showDot && (
              <span
                data-testid="options-update-dot"
                title={
                  updateState?.latestVersion
                    ? t.options.updateAvailableText(updateState.latestVersion)
                    : t.options.updateAvailableBadge
                }
                aria-label={t.options.updateAvailableBadge}
                className="inline-block h-2 w-2 shrink-0 rounded-full bg-red-500"
              />
            )}
          </button>
        ))}
      </nav>

      {tab === 'schemes' && <SchemesTab />}
      {tab === 'sites' && <SitesTab />}
      {tab === 'settings' && <SettingsTab />}
    </div>
  );
}
