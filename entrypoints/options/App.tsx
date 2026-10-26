/**
 * 配置页（VESPEER.md 4.4，T5）：方案管理 | 站点拦截 | 设置与数据。
 */
import { useState } from 'react';
import SchemesTab from '@/src/ui/options/SchemesTab';
import SitesTab from '@/src/ui/options/SitesTab';
import SettingsTab from '@/src/ui/options/SettingsTab';
import { t } from '@/src/i18n';

type Tab = 'schemes' | 'sites' | 'settings';

export default function App() {
  const [tab, setTab] = useState<Tab>('schemes');
  const tabs: { id: Tab; label: string }[] = [
    { id: 'schemes', label: t.options.tabSchemes },
    { id: 'sites', label: t.options.tabSites },
    { id: 'settings', label: t.options.tabSettings },
  ];

  return (
    <div className="mx-auto min-h-screen max-w-7xl p-6">
      <header className="mb-6 flex items-center gap-3">
        <span className="text-2xl font-bold">
          <span style={{ color: 'var(--vesper-accent)' }}>✳</span> {t.appName}
        </span>
        <span className="text-xs text-[var(--vesper-text-dim)]">{t.slogan}</span>
      </header>

      <nav className="mb-6 flex gap-2 border-b border-[var(--vesper-border)] pb-2">
        {tabs.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`rounded-t-md px-4 py-2 text-sm ${
              tab === id
                ? 'bg-[var(--vesper-accent)] font-medium text-white'
                : 'text-[var(--vesper-text-dim)] hover:text-[var(--vesper-text)]'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'schemes' && <SchemesTab />}
      {tab === 'sites' && <SitesTab />}
      {tab === 'settings' && <SettingsTab />}
    </div>
  );
}
