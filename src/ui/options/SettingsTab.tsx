/**
 * 设置与数据 Tab（文档 4.4）：总开关、导入/导出（含敏感提醒）、
 * 映射保留开关（默认关 + 风险提示）、一键清除、关于与隐私声明。
 */
import { useEffect, useRef, useState } from 'react';
import { sendMessage } from '../../messages';
import {
  clearAll,
  exportAll,
  getSettings,
  importAll,
  updateSettings,
  validateImport,
  type ExportBundle,
  type Settings,
} from '../../storage';
import { t } from '../../i18n';
import Toggle from '../Toggle';

const GITHUB_URL = 'https://github.com/K1ngfy/vesper';

export default function SettingsTab() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [notice, setNotice] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void getSettings().then((s) => s && setSettings(s));
  }, []);

  async function update(patch: Partial<Settings>) {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    await updateSettings(patch);
  }

  async function onExport() {
    if (!window.confirm(t.options.exportWarn)) return;
    const bundle = await exportAll();
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vesper-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function onImportFile(file: File) {
    try {
      const data: unknown = JSON.parse(await file.text());
      const err = validateImport(data);
      if (err) {
        setNotice(`${t.options.importInvalid}${err}`);
        return;
      }
      await importAll(data as ExportBundle);
      await sendMessage({ type: 'REFRESH_SITE_REGISTRATIONS' });
      setNotice('导入成功');
      const s = await getSettings();
      if (s) setSettings(s);
    } catch {
      setNotice(`${t.options.importInvalid}JSON 解析失败`);
    }
  }

  async function onClearAll() {
    if (!window.confirm(t.options.clearAllConfirm)) return;
    if (!window.confirm(t.options.clearAllConfirm)) return; // 二次确认
    await clearAll();
    const perms = await chrome.permissions.getAll().catch(() => ({ origins: [] as string[] }));
    const optionalOrigins = (perms.origins ?? []).filter((o) => /^(?:\*|https?):\/\//.test(o));
    if (optionalOrigins.length > 0) {
      await chrome.permissions.remove({ origins: optionalOrigins }).catch(() => {});
    }
    await sendMessage({ type: 'REFRESH_SITE_REGISTRATIONS' });
    const s = await getSettings();
    if (s) setSettings(s);
    setNotice('已清除并重置为初始状态');
  }

  async function onTogglePersistMappings(checked: boolean) {
    if (checked && !window.confirm(t.options.persistMappingsRisk)) return;
    await update({ persistMappings: checked });
  }

  const version = chrome.runtime.getManifest().version;

  return (
    <div className="max-w-xl space-y-6">
      <section className="space-y-3">
        <label className="flex items-center justify-between rounded-lg border border-[var(--vesper-border)] bg-[#ffffff] px-4 py-3 text-sm">
          {t.popup.globalSwitch}
          <Toggle
            checked={settings?.globalEnabled ?? true}
            onChange={(v) => update({ globalEnabled: v })}
          />
        </label>

        <label className="flex items-start justify-between gap-4 rounded-lg border border-[var(--vesper-border)] bg-white px-4 py-3 text-sm">
          <span>
            <span className="font-medium">{t.options.persistMappings}</span>
            <span className="mt-1 block text-[11px] leading-relaxed text-[var(--vesper-text-dim)]">
              {t.options.persistMappingsDesc}
            </span>
          </span>
          <Toggle
            checked={settings?.persistMappings ?? false}
            onChange={(v) => void onTogglePersistMappings(v)}
          />
        </label>
      </section>

      <section className="flex gap-3">
        <button
          className="rounded-md border border-[var(--vesper-border)] px-4 py-2 text-sm hover:border-[var(--vesper-accent)]"
          onClick={() => void onExport()}
        >
          {t.common.export} JSON
        </button>
        <button
          className="rounded-md border border-[var(--vesper-border)] px-4 py-2 text-sm hover:border-[var(--vesper-accent)]"
          onClick={() => fileRef.current?.click()}
        >
          {t.common.import} JSON
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onImportFile(f);
            e.target.value = '';
          }}
        />
        <button
          className="ml-auto rounded-md border border-neutral-300 px-4 py-2 text-sm text-neutral-500 hover:border-black"
          onClick={() => void onClearAll()}
        >
          {t.options.clearAll}
        </button>
      </section>

      {notice && <div className="text-sm text-neutral-600">{notice}</div>}

      <section className="rounded-lg border border-[var(--vesper-border)] bg-[#ffffff] p-4 text-sm">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-medium">{t.options.about}</span>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t.options.githubRepo}
            title={GITHUB_URL}
            className="inline-flex items-center justify-center rounded-md p-1 text-[var(--vesper-text-dim)] transition-colors hover:bg-neutral-100 hover:text-[var(--vesper-accent)]"
          >
            <svg
              viewBox="0 0 24 24"
              width={18}
              height={18}
              fill="currentColor"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.438 9.8 8.205 11.387.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.73.083-.73 1.205.085 1.838 1.238 1.838 1.238 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.295 24 17.798 24 12.5 24 5.87 18.627.5 12 .5z" />
            </svg>
          </a>
        </div>
        <div className="space-y-1 text-xs text-[var(--vesper-text-dim)]">
          <div>
            VESPER v{version} · {t.slogan}
          </div>
          <div>{t.options.privacy}</div>
          <div className="pt-1 font-mono text-[10px]">
            VESPER processes all text locally on your device. It collects, stores remotely, and
            transmits no data. Your rules and texts never leave your browser.
          </div>
        </div>
      </section>
    </div>
  );
}
