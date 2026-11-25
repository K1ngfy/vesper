/**
 * 工作台主组件（VESPEER.md 4.3 / 4.7，T6/T10）。
 * 同时被 workbench 页与 side panel 复用。
 *
 * 行为要点：
 * - 输入即脱敏（防抖 150ms）；大文本和自定义正则走 Web Worker。
 * - 结果区高亮被替换片段，悬停显示原值与命中规则名（原值仅本地显示）。
 * - 还原模式：跟随当前浏览器会话内最近一次脱敏的映射，按设置决定是否跨会话保留。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { desensitize } from '../core/engine';
import { createRestorer } from '../core/restore';
import type { DesensitizeResult, Scheme } from '../core/types';
import { sendMessage } from '../messages';
import {
  getLatestMapping,
  LAST_MAPPING_KEY,
  MAPPING_HISTORY_KEY,
  type MappingRecord,
  type Settings,
} from '../storage';
import { t } from '../i18n';
import { startEngineJob } from '../core/worker-job';
import VesperLogo from './VesperLogo';

const WORKER_THRESHOLD = 12 * 1024;
const HIGHLIGHT_LIMIT = 500;
const DISPLAY_CHAR_LIMIT = 256 * 1024;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const FILE_EXTS = ['.txt', '.log', '.md', '.json', '.csv'];

type Mode = 'desensitize' | 'restore';

export default function WorkbenchApp() {
  const [schemes, setSchemes] = useState<Scheme[]>([]);
  const [schemeId, setSchemeId] = useState('');
  const [input, setInput] = useState('');
  const [completed, setCompleted] = useState<{
    input: string;
    scheme: Scheme;
    result: DesensitizeResult;
  } | null>(null);
  const [mode, setMode] = useState<Mode>('desensitize');
  const [restoreInput, setRestoreInput] = useState('');
  const [notice, setNotice] = useState('');
  const [dragOver, setDragOver] = useState(false);

  const [lastMapping, setLastMapping] = useState<Record<string, string>>({});
  const mappingRevision = useRef(0);
  const noticeTimer = useRef<number | null>(null);

  const resultRef = useRef<HTMLDivElement>(null);

  const scheme = useMemo(
    () => schemes.find((s) => s.id === schemeId) ?? schemes[0],
    [schemes, schemeId],
  );

  const res =
    completed && completed.input === input && completed.scheme === scheme ? completed.result : null;
  const pending = Boolean(input && scheme && !res);
  const displayRes = input ? (res ?? completed?.result ?? null) : null;

  function showNotice(message: string, durationMs = 0) {
    if (noticeTimer.current != null) {
      window.clearTimeout(noticeTimer.current);
      noticeTimer.current = null;
    }
    setNotice(message);
    if (durationMs > 0) {
      noticeTimer.current = window.setTimeout(() => {
        noticeTimer.current = null;
        setNotice('');
      }, durationMs);
    }
  }

  useEffect(() => {
    return () => {
      if (noticeTimer.current != null) window.clearTimeout(noticeTimer.current);
    };
  }, []);

  // 订阅先于读取，防止启动时较旧的读取结果覆盖网页刚写入的最新映射；同时实时同步方案与设置变更。
  useEffect(() => {
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local') {
        const history = changes[MAPPING_HISTORY_KEY];
        if (history && history.newValue === undefined) {
          const rev = ++mappingRevision.current;
          void getLatestMapping()
            .then((record) => {
              if (rev === mappingRevision.current) setLastMapping(record?.mapping ?? {});
            })
            .catch(() => {});
        }
        const schemesChange = changes['vesper:schemes'];
        if (schemesChange && Array.isArray(schemesChange.newValue)) {
          const nextList = schemesChange.newValue as Scheme[];
          setSchemes(nextList);
          setSchemeId((current) =>
            nextList.some((s) => s.id === current)
              ? current
              : (nextList.find((s) => s.isDefault)?.id ?? nextList[0]?.id ?? ''),
          );
        }
        const settingsChange = changes['vesper:settings'];
        if (settingsChange?.newValue) {
          const prevActive = (settingsChange.oldValue as Settings | undefined)?.activeSchemeId;
          const nextActive = (settingsChange.newValue as Settings).activeSchemeId;
          if (nextActive && nextActive !== prevActive) setSchemeId(nextActive);
        }
        return;
      }
      if (area !== 'session') return;
      const pendingChange = changes['vesper:pendingInput'];
      if (
        typeof pendingChange?.newValue === 'string' &&
        pendingChange.newValue &&
        location.pathname.endsWith('/workbench.html')
      ) {
        setMode('desensitize');
        setInput(pendingChange.newValue);
        void chrome.storage.session.remove('vesper:pendingInput').catch(() => {});
      }
      const change = changes[LAST_MAPPING_KEY];
      if (!change) return;
      mappingRevision.current += 1;
      setLastMapping((change.newValue as MappingRecord | undefined)?.mapping ?? {});
    };
    chrome.storage.onChanged.addListener(onChange);
    const revision = ++mappingRevision.current;
    void getLatestMapping()
      .then((record) => {
        if (revision === mappingRevision.current) setLastMapping(record?.mapping ?? {});
      })
      .catch(() => {});
    return () => {
      mappingRevision.current += 1;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, []);

  // 初始化：取方案列表和右键菜单带入的文本。
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
  }, []);

  useEffect(() => {
    if (!scheme || !input) {
      if (!input) showNotice('');
      return;
    }
    if (!scheme.enabled) {
      setCompleted({
        input,
        scheme,
        result: { output: input, hits: [], mapping: {}, durationMs: 0 },
      });
      showNotice(t.workbench.schemeDisabledHint);
      return;
    }
    let cancelled = false;
    let job: ReturnType<typeof startEngineJob> | undefined;
    const timer = setTimeout(async () => {
      try {
        const asyncEngine =
          input.length >= WORKER_THRESHOLD ||
          scheme.rules.some((rule) => rule.enabled && rule.type === 'regex');
        if (asyncEngine) job = startEngineJob(input, scheme);
        const result = job ? await job.result : desensitize(input, scheme, true);
        if (cancelled) return;
        setCompleted({ input, scheme, result });
        showNotice('');
        if (result.hits.length > 0) {
          mappingRevision.current += 1;
          setLastMapping(result.mapping);
          void sendMessage({
            type: 'RECORD_MAPPING',
            schemeId: scheme.id,
            mapping: result.mapping,
          }).catch(() => {});
        }
      } catch {
        if (!cancelled) showNotice('脱敏未完成，请检查规则或缩短文本后重试。');
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      job?.cancel();
    };
  }, [input, scheme]);

  // 还原结果：output 为纯文本（供复制），marks 标记每个被还原片段位置（供高亮）
  const restoreText = useMemo(
    () => (mode === 'restore' ? createRestorer(lastMapping) : null),
    [mode, lastMapping],
  );
  const restoreResult = useMemo(
    () => restoreText?.(restoreInput) ?? { output: '', marks: [] },
    [restoreText, restoreInput],
  );
  const restoreOutput = restoreResult.output;

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      showNotice(t.common.copied, 1500);
    } catch {
      showNotice('复制失败', 2000);
    }
  }

  function importFile(file: File) {
    const okExt = FILE_EXTS.some((ext) => file.name.toLowerCase().endsWith(ext));
    if (!okExt) {
      showNotice(t.workbench.fileTypeUnsupported);
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      showNotice(t.workbench.fileTooLarge);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setInput(String(reader.result ?? ''));
    reader.onerror = () => showNotice('读取文件失败');
    reader.readAsText(file);
  }

  /** 命中清单聚合：规则名 × 次数，点击定位到首个高亮 */
  const hitGroups = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number }>();
    for (const h of displayRes?.hits ?? []) {
      const g = map.get(h.ruleId) ?? { id: h.ruleId, name: h.ruleName, count: 0 };
      g.count += 1;
      map.set(h.ruleId, g);
    }
    return [...map.values()];
  }, [displayRes]);

  const highlightedRuleIds = useMemo(
    () => new Set(displayRes?.hits.slice(0, HIGHLIGHT_LIMIT).map((hit) => hit.ruleId)),
    [displayRes],
  );

  function locateHit(ruleId: string) {
    const el = resultRef.current?.querySelector(`[data-rule="${CSS.escape(ruleId)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /** 结果区渲染：按 hit.index 高亮被替换片段，悬停显示原值与规则名；超大文本截断 DOM 预览防卡顿 */
  const highlighted = useMemo(() => {
    if (!displayRes) return null;
    const truncated = displayRes.output.length > DISPLAY_CHAR_LIMIT;
    const maxEnd = truncated ? DISPLAY_CHAR_LIMIT : displayRes.output.length;
    const parts: React.ReactNode[] = [];
    let cursor = 0;
    const visibleHits = displayRes.hits.slice(0, HIGHLIGHT_LIMIT);
    for (let i = 0; i < visibleHits.length; i += 1) {
      const h = visibleHits[i]!;
      if (h.index >= maxEnd) break;
      if (h.index > cursor) parts.push(displayRes.output.slice(cursor, h.index));
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
    }
    if (cursor < maxEnd) parts.push(displayRes.output.slice(cursor, maxEnd));
    if (truncated) {
      parts.push(
        <div key="truncated" className="mt-2 text-xs text-[var(--vesper-text-dim)]">
          {t.workbench.previewTruncated(DISPLAY_CHAR_LIMIT / 1024)}
        </div>,
      );
    }
    return parts;
  }, [displayRes]);

  /** 还原模式渲染：按 mark.index 高亮被还原片段（原占位符位置 → 现原值），悬停显示占位符 */
  const restoredHighlighted = useMemo(() => {
    const { output, marks } = restoreResult;
    const truncated = output.length > DISPLAY_CHAR_LIMIT;
    const maxEnd = truncated ? DISPLAY_CHAR_LIMIT : output.length;
    if (marks.length === 0 && !truncated) return output;
    const parts: React.ReactNode[] = [];
    let cursor = 0;
    const visibleMarks = marks.slice(0, HIGHLIGHT_LIMIT);
    for (let i = 0; i < visibleMarks.length; i += 1) {
      const mk = visibleMarks[i]!;
      if (mk.index >= maxEnd) break;
      if (mk.index > cursor) parts.push(output.slice(cursor, mk.index));
      parts.push(
        <mark key={i} className="vesper-mark" title={`${mk.placeholder} → ${mk.original}`}>
          {output.slice(mk.index, mk.index + mk.length)}
        </mark>,
      );
      cursor = mk.index + mk.length;
    }
    if (cursor < maxEnd) parts.push(output.slice(cursor, maxEnd));
    if (truncated) {
      parts.push(
        <div key="truncated" className="mt-2 text-xs text-[var(--vesper-text-dim)]">
          {t.workbench.previewTruncated(DISPLAY_CHAR_LIMIT / 1024)}
        </div>,
      );
    }
    return parts;
  }, [restoreResult]);

  const mappingSize = useMemo(() => Object.keys(lastMapping).length, [lastMapping]);

  return (
    <div className="flex h-screen flex-col">
      {/* 顶部：品牌 + 方案选择 + 模式切换 */}
      <header className="flex items-center gap-4 border-b border-[var(--vesper-border)] px-4 py-3">
        <span className="inline-flex items-center gap-1.5 text-lg font-bold">
          <VesperLogo size={22} />
          <span>{t.appName}</span>
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
              {!s.enabled ? `（${t.common.disabled}）` : ''}
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
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setDragOver(false);
              }
            }}
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
              {pending && <span>{t.workbench.processing}</span>}
              <button
                className="ml-auto rounded border border-[var(--vesper-border)] px-2 py-0.5 hover:border-[var(--vesper-accent)] disabled:opacity-50"
                disabled={!res}
                onClick={() => res && copyText(res.output)}
              >
                {t.workbench.copyResult}
              </button>
            </div>
            <div
              ref={resultRef}
              className={`min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-sm transition-opacity ${
                pending ? 'opacity-60' : ''
              }`}
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
                      key={g.id}
                      disabled={!highlightedRuleIds.has(g.id)}
                      className="rounded-full border border-[var(--vesper-border)] px-2 py-0.5 text-xs hover:border-[var(--vesper-accent)]"
                      onClick={() => locateHit(g.id)}
                    >
                      {g.name} × {g.count}
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
                disabled={!restoreInput}
                onClick={() => copyText(restoreOutput)}
              >
                {t.common.copy}
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-sm">
              {restoredHighlighted}
              {mappingSize === 0 || (restoreInput && restoreResult.marks.length === 0) ? (
                <p className="mt-3 text-xs text-[var(--vesper-text-dim)]">
                  {mappingSize === 0
                    ? t.workbench.restoreNoMappingHint
                    : t.workbench.restoreNoMatch}
                </p>
              ) : null}
            </div>
            <div className="px-3 py-1 text-[10px] text-[var(--vesper-text-dim)]">
              {t.workbench.noMapping}
            </div>
          </div>
        </div>
      )}

      {/* 底部状态条 */}
      <footer className="flex items-center gap-4 border-t border-[var(--vesper-border)] px-4 py-1.5 text-xs text-[var(--vesper-text-dim)]">
        {mode === 'desensitize' ? (
          <>
            <span>
              {t.workbench.chars} {input.length}
            </span>
            <span>
              {t.workbench.hits} {res?.hits.length ?? 0}
            </span>
            <span>
              {t.workbench.duration} {res?.durationMs ?? 0}ms
            </span>
          </>
        ) : (
          <>
            <span>
              {t.workbench.chars} {restoreInput.length}
            </span>
            <span>
              {t.workbench.restoredHits} {restoreResult.marks.length}
            </span>
          </>
        )}
        <span className="ml-auto text-[var(--vesper-accent)]">{notice}</span>
      </footer>
    </div>
  );
}
