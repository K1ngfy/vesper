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
  saveSettings,
  validateImport,
  type ExportBundle,
  type Settings,
} from '../../storage';
import { t } from '../../i18n';

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
    await saveSettings(next);
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
          <input
            type="checkbox"
            className="accent-[var(--vesper-accent)]"
            checked={settings?.globalEnabled ?? true}
            onChange={(e) => update({ globalEnabled: e.target.checked })}
          />
        </label>

        <label className="flex items-start justify-between gap-4 rounded-lg border border-[var(--vesper-border)] bg-white px-4 py-3 text-sm">
          <span>
            <span className="font-medium">{t.options.persistMappings}</span>
            <span className="mt-1 block text-[11px] leading-relaxed text-[var(--vesper-text-dim)]">
              {t.options.persistMappingsDesc}
            </span>
          </span>
          <input
            type="checkbox"
            className="mt-1 shrink-0 accent-black"
            checked={settings?.persistMappings ?? false}
            onChange={(e) => void onTogglePersistMappings(e.target.checked)}
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
        <div className="mb-2 font-medium">{t.options.about}</div>
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
