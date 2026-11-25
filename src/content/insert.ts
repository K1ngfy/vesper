type Field = HTMLTextAreaElement | HTMLInputElement;

function isField(el: HTMLElement): el is Field {
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
}

export function getEditableTarget(el: Element | null): HTMLElement | null {
  if (!(el instanceof HTMLElement)) return null;
  if (isField(el)) {
    if (el.matches(':disabled') || el.readOnly) return null;
    if (
      el instanceof HTMLInputElement &&
      !['text', 'search', 'url', 'tel', 'email'].includes(el.type)
    ) {
      return null;
    }
    return el;
  }
  if (!el.isContentEditable) return null;
  while (el.parentElement?.isContentEditable) el = el.parentElement;
  return el as HTMLElement;
}

function writeField(el: Field, value: string, cursor: number): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  if (el.selectionStart != null) el.setSelectionRange(cursor, cursor);
  el.dispatchEvent(
    new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText' }),
  );
}

function within(el: HTMLElement, range: Range): boolean {
  return el.contains(range.startContainer) && el.contains(range.endContainer);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildProseMirrorHtml(text: string): string {
  const lines = text.split('\n');
  const parts = new Array<string>(lines.length);
  for (let i = 0; i < lines.length; i += 1) {
    parts[i] = `<p>${escapeHtml(lines[i]!)}</p>`;
  }
  return `<div data-pm-slice="1 1 []">${parts.join('')}</div>`;
}

function isLegacyQuill1(el: HTMLElement): boolean {
  return (
    el.classList.contains('ql-editor') && Boolean(el.parentElement?.querySelector('.ql-clipboard'))
  );
}

function pasteIntoRichEditor(
  el: HTMLElement,
  selection: Selection,
  text: string,
  includeProseMirrorHtml: boolean,
): boolean {
  const savedRange = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  const data = new DataTransfer();
  data.setData('text/plain', text);
  if (includeProseMirrorHtml) {
    // An open ProseMirror slice joins the first and last lines to the surrounding
    // paragraph and preserves empty paragraphs and indentation between them.
    // Build markup only from the chosen text. Source HTML may contain hidden originals.
    data.setData('text/html', buildProseMirrorHtml(text));
  }
  const handled = !el.dispatchEvent(
    new ClipboardEvent('paste', {
      bubbles: true,
      composed: true,
      cancelable: true,
      clipboardData: data,
    }),
  );
  if (!handled && savedRange) {
    const current = selection.rangeCount ? selection.getRangeAt(0) : null;
    if (!current || !within(el, current)) {
      el.focus();
      if (within(el, savedRange)) {
        selection.removeAllRanges();
        selection.addRange(savedRange);
      }
    }
  }
  return handled;
}

function insertTextAtCaret(el: HTMLElement, selection: Selection, text: string): boolean {
  if (!selection.rangeCount) return false;
  const range = selection.getRangeAt(0);
  if (!within(el, range)) return false;
  const beforeText = text ? el.textContent : null;
  const inputOptions = { bubbles: true, composed: true, inputType: 'insertText', data: text };
  if (!el.dispatchEvent(new InputEvent('beforeinput', { ...inputOptions, cancelable: true }))) {
    // 若富文本框架（如 Slate / Lexical）在 beforeinput 中自行接管并写入了内容，视为回填成功
    return Boolean(text && el.textContent !== beforeText);
  }
  if (!within(el, range)) return false;
  range.deleteContents();
  if (text) {
    const node =
      el.contentEditable === 'plaintext-only'
        ? document.createTextNode(text)
        : document.createElement('span');
    if (node instanceof HTMLElement) {
      node.style.whiteSpace = 'break-spaces';
      node.textContent = text;
    }
    range.insertNode(node);
    range.setStartAfter(node);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  el.dispatchEvent(new InputEvent('input', inputOptions));
  return true;
}

// 富文本编辑器直接回填上限：超过后直接走“复制脱敏结果 + 二次粘贴原生放行”，
// 避免在 contenteditable（尤其 Gemini 的 Quill 1）里循环注入大量 DOM 节点导致 O(N²) 假死，
// 同时保留站点原生的“超长粘贴转附件”能力。
const RICH_DIRECT_MAX_SIZE = 128 * 1024;
const RICH_DIRECT_MAX_LINES = 2000;
const QUILL1_DIRECT_MAX_SIZE = 32 * 1024;
const QUILL1_DIRECT_MAX_LINES = 500;

const CARET_BATCH_SIZE = 16 * 1024;
const CARET_MIN_BATCH_SIZE = 4 * 1024;
const CARET_BATCH_LINES = 400;
const CARET_MIN_BATCH_LINES = 64;
const CARET_BATCH_BUDGET_MS = 24;
// 兜底熔断：分批回填累计超时即中止并复制剩余文本，杜绝页面无响应。
const MAX_BATCH_TOTAL_MS = 1500;

export type InsertOutcome =
  { status: 'inserted' } | { status: 'too-large' } | { status: 'incomplete'; offset: number };

function batchEnd(text: string, offset: number, size: number, maxLines: number): number {
  let end = Math.min(offset + size, text.length);
  const batch = text.slice(offset, end);
  let newline = batch.indexOf('\n');
  for (let lines = 1; newline !== -1; lines += 1) {
    if (lines === maxLines) return offset + newline + 1;
    newline = batch.indexOf('\n', newline + 1);
  }
  // Keep UTF-16 surrogate pairs and CRLF together.
  if (end < text.length) {
    const before = text.charCodeAt(end - 1);
    const after = text.charCodeAt(end);
    if (
      (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) ||
      (before === 13 && after === 10)
    )
      end -= 1;
  }
  return end;
}

async function insertRichText(
  el: HTMLElement,
  selection: Selection,
  text: string,
  insertBatch: (text: string) => boolean,
  canContinue: () => boolean,
): Promise<InsertOutcome> {
  const startedAt = performance.now();
  let offset = 0;
  let size = CARET_BATCH_SIZE;
  let lines = CARET_BATCH_LINES;
  let fastBatches = 0;
  let interrupted = false;
  const controller = new AbortController();
  const onInteraction = (event: Event) => {
    if (event.isTrusted) interrupted = true;
  };
  for (const type of ['keydown', 'pointerdown', 'compositionstart']) {
    el.addEventListener(type, onInteraction, { capture: true, signal: controller.signal });
  }
  const canResume = () =>
    !interrupted &&
    canContinue() &&
    el.matches(':focus-within') &&
    selection.isCollapsed &&
    selection.rangeCount > 0 &&
    within(el, selection.getRangeAt(0));
  try {
    while (offset < text.length) {
      const end = batchEnd(text, offset, size, lines);
      const start = performance.now();
      if (!insertBatch(text.slice(offset, end))) return { status: 'incomplete', offset };
      offset = end;
      if (offset === text.length) return { status: 'inserted' };

      // Allow editor mutation observers to reconcile the DOM and caret first.
      await Promise.resolve();
      const now = performance.now();
      if (now - startedAt >= MAX_BATCH_TOTAL_MS) return { status: 'incomplete', offset };
      const elapsed = now - start;
      if (elapsed > CARET_BATCH_BUDGET_MS) {
        size = Math.max(CARET_MIN_BATCH_SIZE, Math.floor(size / 2));
        lines = Math.max(CARET_MIN_BATCH_LINES, Math.floor(lines / 2));
        fastBatches = 0;
      } else if (elapsed < CARET_BATCH_BUDGET_MS / 2) {
        fastBatches += 1;
        if (fastBatches === 3) {
          size = Math.min(CARET_BATCH_SIZE, size * 2);
          lines = Math.min(CARET_BATCH_LINES, lines * 2);
          fastBatches = 0;
        }
      } else {
        fastBatches = 0;
      }
      if (!canResume()) return { status: 'incomplete', offset };
      const caret = selection.getRangeAt(0).cloneRange();
      // Yield to rendering and input before the next edit without artificial 16ms sleep.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (
        performance.now() - startedAt >= MAX_BATCH_TOTAL_MS ||
        !canResume() ||
        caret.compareBoundaryPoints(Range.START_TO_START, selection.getRangeAt(0)) !== 0
      )
        return { status: 'incomplete', offset };
    }
  } catch {
    return { status: 'incomplete', offset };
  } finally {
    controller.abort();
  }
  return { status: 'inserted' };
}

/** Capture the paste destination before the preview moves focus. */
export function captureInsertion(el: HTMLElement, event: Event) {
  const field = isField(el) ? el : null;
  const value = field?.value;
  const hasSelectionRange = field != null && field.selectionStart != null;
  const start = field?.selectionStart ?? value?.length ?? 0;
  const end = field?.selectionEnd ?? start;
  const selection = window.getSelection();
  const selected = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const drop =
    event instanceof DragEvent && typeof document.caretRangeFromPoint === 'function'
      ? document.caretRangeFromPoint(event.clientX, event.clientY)
      : null;
  const range =
    drop && within(el, drop)
      ? drop
      : selected && within(el, selected)
        ? selected.cloneRange()
        : null;
  let edited = false;
  let writing = false;
  let undoField: (() => void) | undefined;
  const noteEdit = () => {
    if (!writing) edited = true;
  };
  el.addEventListener('input', noteEdit);

  return {
    target: el,
    release: () => el.removeEventListener('input', noteEdit),
    getUndo() {
      if (!undoField) return undefined;
      const undo = undoField;
      // Continue tracking edits until the toast is dismissed.
      const controller = new AbortController();
      const markEdited = () => {
        edited = true;
      };
      el.addEventListener('input', markEdited, { signal: controller.signal });
      return { undo, dispose: () => controller.abort() };
    },
    /** Return the start of the uninserted text, or null on completion. */
    async insert(text: string, isCurrent: () => boolean): Promise<InsertOutcome> {
      const canContinue = () =>
        isCurrent() && !edited && el.isConnected && getEditableTarget(el) === el;
      if (!canContinue()) return { status: 'incomplete', offset: 0 };
      if (field) {
        if (field.value !== value) return { status: 'incomplete', offset: 0 };
        field.focus();
        if (document.activeElement !== field && field.getRootNode() instanceof Document)
          return { status: 'incomplete', offset: 0 };
        if (field.value !== value) return { status: 'incomplete', offset: 0 };
        const previous = field.value;
        writing = true;
        try {
          // input[type=email] 等不支持 selectionStart 的控件优先尝试 execCommand 保留选区替换语义
          if (!hasSelectionRange) {
            const singleLine = text.replace(/[\r\n]+/g, '');
            if (
              !document.execCommand('insertText', false, singleLine) ||
              field.value === previous
            ) {
              writeField(field, singleLine, singleLine.length);
            }
          } else {
            writeField(
              field,
              previous.slice(0, start) + text + previous.slice(end),
              start + text.length,
            );
          }
        } finally {
          writing = false;
        }
        const inserted = field.value;
        edited = false;
        undoField = () => {
          if (
            edited ||
            !field.isConnected ||
            getEditableTarget(field) !== field ||
            field.value !== inserted
          )
            return;
          field.focus();
          if (field.value === inserted) writeField(field, previous, start);
        };
        return { status: 'inserted' };
      }
      if (!selection) return { status: 'incomplete', offset: 0 };
      el.focus();
      if (!canContinue() || !el.matches(':focus-within'))
        return { status: 'incomplete', offset: 0 };
      const caret = range ?? document.createRange();
      if (range && !within(el, range)) return { status: 'incomplete', offset: 0 };
      if (!range) {
        caret.selectNodeContents(el);
        caret.collapse(false);
      }
      selection.removeAllRanges();
      selection.addRange(caret);

      const legacyQuill1 = isLegacyQuill1(el);
      const maxSize = legacyQuill1 ? QUILL1_DIRECT_MAX_SIZE : RICH_DIRECT_MAX_SIZE;
      const maxLines = legacyQuill1 ? QUILL1_DIRECT_MAX_LINES : RICH_DIRECT_MAX_LINES;
      if (batchEnd(text, 0, maxSize, maxLines) < text.length) {
        return { status: 'too-large' };
      }

      const isProseMirror = el.classList.contains('ProseMirror');
      const needsCaretBatch = batchEnd(text, 0, CARET_BATCH_SIZE, CARET_BATCH_LINES) < text.length;
      const preserveWhitespace = needsCaretBatch || /[\r\n\t]| {2}|^ | $/.test(text);

      // Fast path 1: short single-line plain text via native execCommand (preserves browser undo).
      if (!preserveWhitespace) {
        writing = true;
        try {
          if (document.execCommand('insertText', false, text)) return { status: 'inserted' };
        } finally {
          writing = false;
        }
      }

      // Fast path 2: single-shot synthetic paste handled natively by modern rich editors
      // (ProseMirror, Lexical, Slate, Quill 2, CodeMirror, CKEditor, etc.).
      if (!legacyQuill1) {
        writing = true;
        try {
          if (pasteIntoRichEditor(el, selection, text.replace(/\r\n?/g, '\n'), isProseMirror)) {
            return { status: 'inserted' };
          }
        } finally {
          writing = false;
        }
      }

      // Fallback path: direct DOM insertion at caret (batched with a hard time cap).
      const insertCaretBatch = (batch: string) => {
        writing = true;
        try {
          return insertTextAtCaret(el, selection, batch.replace(/\r\n?/g, '\n'));
        } finally {
          writing = false;
        }
      };
      if (needsCaretBatch) {
        return insertRichText(el, selection, text, insertCaretBatch, canContinue);
      }
      return insertCaretBatch(text) ? { status: 'inserted' } : { status: 'incomplete', offset: 0 };
    },
  };
}
