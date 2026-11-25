/**
 * 规则编辑表单：用于规则新建/编辑弹窗。
 * 提供清晰的字段分组，以及大尺寸双栏多行「即时测试预览」区（高亮展示命中与替换结果）。
 */
import { useEffect, useMemo, useState } from 'react';
import { DETECTOR_LIST } from '../../core/detectors';
import { startEngineJob } from '../../core/worker-job';
import type { DesensitizeResult, Rule } from '../../core/types';
import { t } from '../../i18n';

interface Props {
  rule: Rule;
  onChange: (rule: Rule) => void;
  /** 是否显示多行「即时测试预览」测试台（默认显示） */
  showTest?: boolean;
}

const NUMBER_SLOT_RE = /(?<![A-Za-z0-9])n(?![A-Za-z0-9])/;
const HIGHLIGHT_LIMIT = 500;

function parseMaskKeep(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

function validateRegexSyntax(pattern: string, rawFlags?: string): string | null {
  try {
    let flags = rawFlags ?? 'g';
    if (!flags.includes('g')) flags += 'g';
    new RegExp(pattern, flags);
    return null;
  } catch (err) {
    return `${t.options.errRegexInvalid}${(err as Error).message}`;
  }
}

export default function RuleForm({ rule, onChange, showTest = true }: Props) {
  const [sample, setSample] = useState('');
  const [testRes, setTestRes] = useState<DesensitizeResult | null>(null);
  const [testErr, setTestErr] = useState('');
  const [testing, setTesting] = useState(false);

  const detector =
    rule.type === 'builtin' ? DETECTOR_LIST.find((d) => d.id === rule.pattern) : undefined;

  const needsPattern = rule.type !== 'builtin' && !rule.pattern.trim();
  const showNumberedHint =
    rule.mode === 'numbered' &&
    Boolean(rule.replacement.trim()) &&
    !NUMBER_SLOT_RE.test(rule.replacement);

  function update(patch: Partial<Rule>) {
    onChange({ ...rule, ...patch });
  }

  useEffect(() => {
    if (!showTest || !sample) {
      setTestRes(null);
      setTestErr('');
      setTesting(false);
      return;
    }
    if (needsPattern) {
      setTestRes(null);
      setTestErr('');
      setTesting(false);
      return;
    }
    if (rule.type === 'regex') {
      const syntaxErr = validateRegexSyntax(rule.pattern, rule.regexFlags);
      if (syntaxErr) {
        setTestRes(null);
        setTestErr(syntaxErr);
        setTesting(false);
        return;
      }
    }

    let cancelled = false;
    let job: ReturnType<typeof startEngineJob> | undefined;
    setTesting(true);
    const timer = setTimeout(async () => {
      try {
        job = startEngineJob(
          sample,
          {
            id: 'sample',
            name: 'sample',
            enabled: true,
            isDefault: false,
            createdAt: 0,
            updatedAt: 0,
            rules: [{ ...rule, enabled: true }],
          },
          true,
        );
        const result = await job.result;
        if (cancelled) return;
        setTestRes(result);
        setTestErr('');
        setTesting(false);
      } catch (err) {
        if (cancelled) return;
        setTestRes(null);
        setTesting(false);
        const message = (err as Error).message;
        setTestErr(
          message === 'engine-timeout'
            ? '规则执行超时（可能存在回溯风险）'
            : message || '无法运行此规则',
        );
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      job?.cancel();
    };
  }, [showTest, sample, rule, needsPattern]);

  const highlightedPreview = useMemo(() => {
    if (!testRes) return null;
    if (testRes.hits.length === 0) return testRes.output;
    const parts: React.ReactNode[] = [];
    let cursor = 0;
    testRes.hits.slice(0, HIGHLIGHT_LIMIT).forEach((h, i) => {
      if (h.index > cursor) parts.push(testRes.output.slice(cursor, h.index));
      parts.push(
        <mark
          key={i}
          className="vesper-mark"
          title={`${h.ruleName || rule.pattern}：${h.original}`}
        >
          {h.replaced}
        </mark>,
      );
      cursor = h.index + h.replaced.length;
    });
    parts.push(testRes.output.slice(cursor));
    return parts;
  }, [testRes, rule.pattern]);

  return (
    <div className="space-y-4 text-sm">
      {/* 行1：名称 + 匹配源 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--vesper-text-dim)]">
            {t.options.ruleFieldName}
          </span>
          <input
            className="w-full rounded-md border border-[var(--vesper-border)] bg-white px-2.5 py-1.5 text-xs outline-none focus:border-black"
            value={rule.name}
            onChange={(e) => update({ name: e.target.value })}
            placeholder={t.options.ruleNamePlaceholder}
          />
        </label>

        <label className="block sm:col-span-2">
          <span className="mb-1 block text-xs font-medium text-[var(--vesper-text-dim)]">
            {rule.type === 'builtin' ? t.options.ruleFieldDetector : t.options.ruleFieldPattern}
          </span>
          {rule.type === 'builtin' ? (
            <select
              className="w-full rounded-md border border-[var(--vesper-border)] bg-white px-2.5 py-1.5 text-xs outline-none focus:border-black"
              value={rule.pattern}
              onChange={(e) => {
                const det = DETECTOR_LIST.find((d) => d.id === e.target.value)!;
                const shouldSyncName = !rule.name.trim() || rule.name === detector?.name;
                const shouldSyncReplacement =
                  !rule.replacement.trim() || rule.replacement === detector?.defaultReplacement;
                update({
                  pattern: det.id,
                  ...(shouldSyncReplacement ? { replacement: det.defaultReplacement } : {}),
                  ...(shouldSyncName ? { name: det.name } : {}),
                });
              }}
            >
              {DETECTOR_LIST.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="w-full rounded-md border border-[var(--vesper-border)] bg-white px-2.5 py-1.5 font-mono text-xs outline-none focus:border-black"
              value={rule.pattern}
              onChange={(e) => update({ pattern: e.target.value })}
              placeholder={
                rule.type === 'keyword' ? t.options.keywordPlaceholder : t.options.regexPlaceholder
              }
            />
          )}
        </label>
      </div>

      {/* 行2：替换方式 + 替换文本 / 掩码设置 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--vesper-text-dim)]">
            {t.options.ruleFieldMode}
          </span>
          <select
            className="w-full rounded-md border border-[var(--vesper-border)] bg-white px-2.5 py-1.5 text-xs outline-none focus:border-black"
            value={rule.mode}
            onChange={(e) => {
              const nextMode = e.target.value as Rule['mode'];
              const numberedDefault = detector?.defaultReplacement ?? '[MASKED_n]';
              const fixedDefault = numberedDefault.replace(/_n(?=\]|$)/, '');
              let replacement = rule.replacement;
              if (nextMode === 'fixed' && replacement === numberedDefault) {
                replacement = fixedDefault;
              } else if (nextMode === 'numbered' && replacement === fixedDefault) {
                replacement = numberedDefault;
              }
              update({ mode: nextMode, replacement });
            }}
          >
            <option value="fixed">{t.options.modeFixed}</option>
            <option value="numbered">{t.options.modeNumbered}</option>
            <option value="mask">{t.options.modeMask}</option>
          </select>
        </label>

        <div className="sm:col-span-2">
          <span className="mb-1 block text-xs font-medium text-[var(--vesper-text-dim)]">
            {rule.mode === 'mask' ? t.options.ruleFieldMask : t.options.ruleFieldReplacement}
          </span>
          {rule.mode !== 'mask' ? (
            <>
              <input
                className="w-full rounded-md border border-[var(--vesper-border)] bg-white px-2.5 py-1.5 font-mono text-xs outline-none focus:border-black"
                value={rule.replacement}
                onChange={(e) => update({ replacement: e.target.value })}
                placeholder={t.options.replacementPlaceholder}
              />
              {showNumberedHint && (
                <p className="mt-1 text-[11px] text-[var(--vesper-text-dim)]">
                  {t.options.numberedSlotHint}
                </p>
              )}
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--vesper-border)] bg-neutral-50/70 px-2.5 py-1.5 text-xs text-[var(--vesper-text-dim)]">
              <label className="flex items-center gap-1.5">
                {t.options.maskHead}
                <input
                  type="number"
                  min={0}
                  step={1}
                  className="w-14 rounded border border-[var(--vesper-border)] bg-white px-1.5 py-0.5 text-black outline-none focus:border-black"
                  value={rule.maskKeep?.head ?? 1}
                  onChange={(e) =>
                    update({
                      maskKeep: {
                        head: parseMaskKeep(e.target.value),
                        tail: rule.maskKeep?.tail ?? 1,
                      },
                    })
                  }
                />
              </label>
              <label className="flex items-center gap-1.5">
                {t.options.maskTail}
                <input
                  type="number"
                  min={0}
                  step={1}
                  className="w-14 rounded border border-[var(--vesper-border)] bg-white px-1.5 py-0.5 text-black outline-none focus:border-black"
                  value={rule.maskKeep?.tail ?? 1}
                  onChange={(e) =>
                    update({
                      maskKeep: {
                        head: rule.maskKeep?.head ?? 1,
                        tail: parseMaskKeep(e.target.value),
                      },
                    })
                  }
                />
              </label>
              <label className="ml-1 flex items-center gap-1.5 text-black">
                <input
                  type="checkbox"
                  className="accent-black"
                  checked={rule.maskKeepDomain ?? false}
                  onChange={(e) => update({ maskKeepDomain: e.target.checked })}
                />
                {t.options.maskKeepDomain}
              </label>
            </div>
          )}
        </div>
      </div>

      {/* 行3：类型相关选项与说明 */}
      {rule.type === 'builtin' && detector && (
        <div className="rounded-md bg-neutral-50 px-3 py-2 text-xs text-[var(--vesper-text-dim)]">
          {detector.description}
        </div>
      )}
      {rule.type === 'regex' && (
        <div className="flex flex-wrap items-center gap-3 rounded-md bg-neutral-50 px-3 py-2 text-xs text-[var(--vesper-text-dim)]">
          <label className="flex shrink-0 items-center gap-1.5 text-black">
            <span>flags</span>
            <input
              className="w-16 rounded border border-[var(--vesper-border)] bg-white px-1.5 py-0.5 font-mono text-xs outline-none focus:border-black"
              value={rule.regexFlags ?? 'g'}
              onChange={(e) => update({ regexFlags: e.target.value })}
            />
          </label>
          <span className="text-[11px]">{t.options.regexCatastrophicHint}</span>
        </div>
      )}
      {rule.type === 'keyword' && (
        <div className="flex flex-wrap items-center gap-4 rounded-md bg-neutral-50 px-3 py-2 text-xs text-black">
          <span className="text-[var(--vesper-text-dim)]">{t.options.ruleFieldOptions}</span>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              className="accent-black"
              checked={rule.caseSensitive ?? false}
              onChange={(e) => update({ caseSensitive: e.target.checked })}
            />
            {t.options.caseSensitive}
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              className="accent-black"
              checked={rule.wholeWord ?? false}
              onChange={(e) => update({ wholeWord: e.target.checked })}
            />
            {t.options.wholeWord}
          </label>
        </div>
      )}

      {/* 行4：大尺寸双栏多行测试预览台 */}
      {showTest && (
        <div className="rounded-lg border border-[var(--vesper-border)] bg-neutral-50/70 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-black">{t.options.ruleTestTitle}</span>
            <div className="text-xs">
              {testing ? (
                <span className="text-[var(--vesper-text-dim)]">{t.options.ruleTestRunning}</span>
              ) : testErr ? (
                <span className="font-medium text-red-600">⚠ {testErr}</span>
              ) : sample && testRes ? (
                testRes.hits.length > 0 ? (
                  <span className="rounded-full bg-black px-2 py-0.5 text-[11px] font-medium text-white">
                    {t.options.ruleTestHits(testRes.hits.length)}
                  </span>
                ) : (
                  <span className="rounded-full border border-[var(--vesper-border)] bg-white px-2 py-0.5 text-[11px] text-[var(--vesper-text-dim)]">
                    {t.options.ruleTestNoHits}
                  </span>
                )
              ) : null}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[11px] text-[var(--vesper-text-dim)]">
                {t.options.ruleTestInputLabel}
              </span>
              <textarea
                data-testid="rule-test-input"
                rows={5}
                className="min-h-[128px] w-full resize-y rounded-md border border-[var(--vesper-border)] bg-white p-2.5 font-mono text-xs leading-5 outline-none focus:border-black"
                placeholder={t.options.ruleTestPlaceholder}
                value={sample}
                onChange={(e) => setSample(e.target.value)}
                spellCheck={false}
              />
            </label>

            <div className="flex flex-col">
              <span className="mb-1 block text-[11px] text-[var(--vesper-text-dim)]">
                {t.options.ruleTestOutputLabel}
              </span>
              <div
                data-testid="rule-test-output"
                className="min-h-[128px] max-h-[240px] flex-1 overflow-auto whitespace-pre-wrap break-all rounded-md border border-[var(--vesper-border)] bg-white p-2.5 font-mono text-xs leading-5"
              >
                {!sample ? (
                  <span className="font-sans text-[var(--vesper-text-dim)]">
                    {t.options.ruleTestOutputPlaceholder}
                  </span>
                ) : needsPattern ? (
                  <span className="font-sans text-[var(--vesper-text-dim)]">
                    {t.options.ruleTestNeedPattern}
                  </span>
                ) : testErr ? (
                  <span className="font-sans text-red-600">⚠ {testErr}</span>
                ) : (
                  highlightedPreview
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
