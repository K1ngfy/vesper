/**
 * 工作台主组件（VESPEER.md 4.3 / 4.7，T6/T10）。
 * 同时被 workbench 页与 side panel 复用。
 *
 * 行为要点：
 * - 输入即脱敏（防抖 150ms）；>500KB 走 Web Worker。
 * - 结果区高亮被替换片段，悬停显示原值与命中规则名（原值仅本地显示）。
 * - 还原模式：映射仅保存于本组件内存（session 级），关闭页面即销毁；
 *   同时上报 background（仅当用户在设置中开启本地保留时才落盘）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { desensitize } from '../core/engine';
import { restore } from '../core/restore';
import type { DesensitizeResult, Hit, Scheme } from '../core/types';
import { sendMessage } from '../messages';
import { t } from '../i18n';
// vite 环境类型（vite/client，WXT 已引入）声明了 ?worker 模块导出
import EngineWorker from '../core/engine.worker?worker';

const WORKER_THRESHOLD = 500 * 1024; // 500KB
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const FILE_EXTS = ['.txt', '.log', '.md', '.json', '.csv'];

type Mode = 'desensitize' | 'restore';

export default function WorkbenchApp() {
  const [schemes, setSchemes] = useState<Scheme[]>([]);
  const [schemeId, setSchemeId] = useState('');
  const [input, setInput] = useState('');
  const [res, setRes] = useState<DesensitizeResult | null>(null);
  const [mode, setMode] = useState<Mode>('desensitize');
  const [restoreInput, setRestoreInput] = useState('');
  const [notice, setNotice] = useState('');
  const [dragOver, setDragOver] = useState(false);

  // 最近一次映射：仅内存（文档 4.7）
  const lastMapping = useRef<Record<string, string>>({});
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const workerRef = useRef<Worker | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const scheme = useMemo(
    () => schemes.find((s) => s.id === schemeId) ?? schemes[0],
    [schemes, schemeId],
  );

  // 初始化：取方案列表 + 右键菜单带入的文本
  useEffect(() => {
    void (async () => {
      const list = await sendMessage({ type: 'GET_SCHEMES' });
      setSchemes(list);
      const active = await sendMessage({ type: 'GET_ACTIVE_SCHEME' });
      if (active) setSchemeId(active.id);
      const pending = await chrome.storage.session.get('vesper:pendingInput');
      const text = pending['vesper:pendingInput'];
      if (typeof text === 'string' && text) {
        setInput(text);
        await chrome.storage.session.remove('vesper:pendingInput');
      }
    })();
    return () => workerRef.current?.terminate();
  }, []);

  const runEngine = useCallback((text: string, sch: Scheme) => {
    if (!text) {
      setRes(null);
      return;
    }
    if (text.length > WORKER_THRESHOLD) {
      workerRef.current?.terminate();
      const w: Worker = new EngineWorker();
      workerRef.current = w;
      w.onmessage = (e: MessageEvent<DesensitizeResult>) => {
        applyResult(e.data, sch);
        w.terminate();
      };
      w.postMessage({ text, scheme: sch });
    } else {
      applyResult(desensitize(text, sch), sch);
    }
  }, []);

  function applyResult(r: DesensitizeResult, sch: Scheme) {
    setRes(r);
    if (Object.keys(r.mapping).length > 0) {
      lastMapping.current = r.mapping;
      void sendMessage({ type: 'RECORD_MAPPING', schemeId: sch.id, mapping: r.mapping });
    }
  }

  // 输入即脱敏，防抖 150ms
  useEffect(() => {
    if (!scheme) return;
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => runEngine(input, scheme), 150);
    return () => clearTimeout(debounceTimer.current);
  }, [input, scheme, runEngine]);

  const restoreOutput = useMemo(
    () => (mode === 'restore' ? restore(restoreInput, lastMapping.current) : ''),
    [mode, restoreInput],
  );

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(t.common.copied);
      setTimeout(() => setNotice(''), 1500);
    } catch {
      setNotice('复制失败');
    }
  }

  function importFile(file: File) {
    const okExt = FILE_EXTS.some((ext) => file.name.toLowerCase().endsWith(ext));
    if (!okExt) {
      setNotice(t.workbench.fileTypeUnsupported);
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setNotice(t.workbench.fileTooLarge);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setInput(String(reader.result ?? ''));
    reader.readAsText(file);
  }

  /** 命中清单聚合：规则名 × 次数，点击定位到首个高亮 */
  const hitGroups = useMemo(() => {
    const map = new Map<string, { name: string; hits: Hit[] }>();
    for (const h of res?.hits ?? []) {
      const g = map.get(h.ruleId) ?? { name: h.ruleName, hits: [] };
      g.hits.push(h);
      map.set(h.ruleId, g);
    }
    return [...map.values()];
  }, [res]);

  function locateHit(ruleId: string) {
    const el = resultRef.current?.querySelector(`[data-rule="${ruleId}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /** 结果区渲染：按 hit.index 高亮被替换片段，悬停显示原值与规则名 */
  const highlighted = useMemo(() => {
    if (!res) return null;
    const parts: React.ReactNode[] = [];
    let cursor = 0;
    res.hits.forEach((h, i) => {
      if (h.index > cursor) parts.push(res.output.slice(cursor, h.index));
      parts.push(
        <mark
          key={i}
          className="vesper-mark"
          data-rule={h.ruleId}
          title={`${h.ruleName}：${h.original}`}
        >
          {h.replaced}
        </mark>,
      );
      cursor = h.index + h.replaced.length;
    });
    parts.push(res.output.slice(cursor));
    return parts;
  }, [res]);

  const mappingSize = Object.keys(lastMapping.current).length;

  return (
    <div className="flex h-screen flex-col">
      {/* 顶部：品牌 + 方案选择 + 模式切换 */}
      <header className="flex items-center gap-4 border-b border-[var(--vesper-border)] px-4 py-3">
        <span className="text-lg font-bold">
          <span style={{ color: 'var(--vesper-accent)' }}>✳</span> VESPER
        </span>
        <select
          className="rounded-md border border-[var(--vesper-border)] bg-[#ffffff] px-2 py-1 text-sm"
          value={scheme?.id ?? ''}
          onChange={(e) => {
            setSchemeId(e.target.value);
            void sendMessage({ type: 'SET_ACTIVE_SCHEME', schemeId: e.target.value });
          }}
        >
          {schemes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.isDefault ? `（${t.common.defaultTag}）` : ''}
            </option>
          ))}
        </select>
        <div className="ml-auto flex gap-2 text-sm">
          <button
            className={`rounded-md px-3 py-1 ${mode === 'desensitize' ? 'bg-[var(--vesper-accent)] text-white' : 'border border-[var(--vesper-border)]'}`}
            onClick={() => setMode('desensitize')}
          >
            {t.workbench.desensitizeMode}
          </button>
          <button
            className={`rounded-md px-3 py-1 ${mode === 'restore' ? 'bg-[var(--vesper-accent)] text-white' : 'border border-[var(--vesper-border)]'}`}
            onClick={() => setMode('restore')}
          >
            {t.workbench.restoreMode}
          </button>
        </div>
      </header>

      {mode === 'desensitize' ? (
        <div className="flex min-h-0 flex-1">
          {/* 左：原文 */}
          <div
            className={`flex w-1/2 flex-col border-r border-[var(--vesper-border)] ${dragOver ? 'bg-[#f3f4f6]' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) importFile(f);
            }}
          >
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--vesper-text-dim)]">
              <span>{t.workbench.original}</span>
              <label className="ml-auto cursor-pointer rounded border border-[var(--vesper-border)] px-2 py-0.5 hover:border-[var(--vesper-accent)]">
                {t.workbench.importFile}
                <input
                  type="file"
                  className="hidden"
                  accept=".txt,.log,.md,.json,.csv"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) importFile(f);
                    e.target.value = '';
                  }}
                />
              </label>
              <button
                className="rounded border border-[var(--vesper-border)] px-2 py-0.5 hover:border-[var(--vesper-accent)]"
                onClick={() => setInput('')}
              >
                {t.common.clear}
              </button>
            </div>
            <textarea
              className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-sm outline-none"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="粘贴或拖入文本…"
            />
          </div>

          {/* 右：结果 + 命中清单 */}
          <div className="flex w-1/2 min-w-0 flex-col">
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--vesper-text-dim)]">
              <span>{t.workbench.result}</span>
              <button
                className="ml-auto rounded border border-[var(--vesper-border)] px-2 py-0.5 hover:border-[var(--vesper-accent)]"
                onClick={() => res && copyText(res.output)}
              >
                {t.workbench.copyResult}
              </button>
            </div>
            <div
              ref={resultRef}
              className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-sm"
            >
              {highlighted}
            </div>
            {hitGroups.length > 0 && (
              <div className="max-h-36 overflow-auto border-t border-[var(--vesper-border)] px-3 py-2">
                <div className="mb-1 text-xs text-[var(--vesper-text-dim)]">
                  {t.workbench.hitList}
                </div>
                <div className="flex flex-wrap gap-2">
                  {hitGroups.map((g) => (
                    <button
                      key={g.name}
                      className="rounded-full border border-[var(--vesper-border)] px-2 py-0.5 text-xs hover:border-[var(--vesper-accent)]"
                      onClick={() => locateHit(g.hits[0]!.ruleId)}
                    >
                      {g.name} × {g.hits.length}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* 还原模式（4.7） */
        <div className="flex min-h-0 flex-1">
          <textarea
            className="w-1/2 resize-none border-r border-[var(--vesper-border)] bg-transparent p-3 font-mono text-sm outline-none"
            value={restoreInput}
            onChange={(e) => setRestoreInput(e.target.value)}
            placeholder={t.workbench.restorePlaceholder}
          />
          <div className="flex w-1/2 flex-col">
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--vesper-text-dim)]">
              <span>
                {mappingSize > 0 ? t.workbench.mappingCount(mappingSize) : t.workbench.restoreEmpty}
              </span>
              <button
                className="ml-auto rounded border border-[var(--vesper-border)] px-2 py-0.5 hover:border-[var(--vesper-accent)]"
                onClick={() => copyText(restoreOutput)}
              >
                {t.common.copy}
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-sm">
              {restoreOutput}
            </div>
            <div className="px-3 py-1 text-[10px] text-[var(--vesper-text-dim)]">
              {t.workbench.noMapping}
            </div>
          </div>
        </div>
      )}

      {/* 底部状态条 */}
      <footer className="flex items-center gap-4 border-t border-[var(--vesper-border)] px-4 py-1.5 text-xs text-[var(--vesper-text-dim)]">
        <span>
          {t.workbench.chars} {input.length}
        </span>
        <span>
          {t.workbench.hits} {res?.hits.length ?? 0}
        </span>
        <span>
          {t.workbench.duration} {res?.durationMs ?? 0}ms
        </span>
        <span className="ml-auto text-[var(--vesper-accent)]">{notice}</span>
      </footer>
    </div>
  );
}
