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

function pasteIntoRichEditor(el: HTMLElement, text: string): boolean {
  const data = new DataTransfer();
  data.setData('text/plain', text);
  const wrapper = document.createElement('div');
  // An open ProseMirror slice joins the first and last lines to the surrounding
  // paragraph and preserves empty paragraphs and indentation between them.
  wrapper.dataset.pmSlice = '1 1 []';
  for (const line of text.split('\n')) {
    const paragraph = document.createElement('p');
    paragraph.textContent = line;
    wrapper.appendChild(paragraph);
  }
  // Build markup only from the chosen text. Source HTML may contain hidden originals.
  data.setData('text/html', wrapper.outerHTML);
  return !el.dispatchEvent(
    new ClipboardEvent('paste', {
      bubbles: true,
      composed: true,
      cancelable: true,
      clipboardData: data,
    }),
  );
}

function insertTextAtCaret(el: HTMLElement, selection: Selection, text: string): boolean {
  if (!selection.rangeCount) return false;
  const range = selection.getRangeAt(0);
  if (!within(el, range)) return false;
  const inputOptions = { bubbles: true, composed: true, inputType: 'insertText', data: text };
  if (!el.dispatchEvent(new InputEvent('beforeinput', { ...inputOptions, cancelable: true }))) {
    return false;
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

const RICH_TEXT_BATCH_SIZE = 4 * 1024;
const MIN_BATCH_SIZE = 256;
const MAX_BATCH_LINES = 32;
const MIN_BATCH_LINES = 4;
const BATCH_BUDGET_MS = 8;

function batchEnd(text: string, offset: number, size: number, maxLines = MAX_BATCH_LINES): number {
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
): Promise<number | null> {
  let offset = 0;
  let size = RICH_TEXT_BATCH_SIZE;
  let lines = MAX_BATCH_LINES;
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
    do {
      const end = batchEnd(text, offset, size, lines);
      const start = performance.now();
      if (!insertBatch(text.slice(offset, end))) return offset;
      offset = end;
      if (offset === text.length) return null;

      // Allow editor mutation observers to reconcile the DOM and caret first.
      await Promise.resolve();
      const elapsed = performance.now() - start;
      if (elapsed > BATCH_BUDGET_MS) {
        size = Math.max(MIN_BATCH_SIZE, Math.floor(size / 2));
        lines = Math.max(MIN_BATCH_LINES, Math.floor(lines / 2));
        fastBatches = 0;
      } else if (elapsed < BATCH_BUDGET_MS / 2) {
        fastBatches += 1;
        if (fastBatches === 3) {
          size = Math.min(RICH_TEXT_BATCH_SIZE, size * 2);
          lines = Math.min(MAX_BATCH_LINES, lines * 2);
          fastBatches = 0;
        }
      } else {
        fastBatches = 0;
      }
      if (!canResume()) return offset;
      const caret = selection.getRangeAt(0).cloneRange();
      // Yield to rendering and input before the next native edit.
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
      if (
        !canResume() ||
        caret.compareBoundaryPoints(Range.START_TO_START, selection.getRangeAt(0)) !== 0
      )
        return offset;
    } while (offset < text.length);
  } catch {
    return offset;
  } finally {
    controller.abort();
  }
  return null;
}

/** Capture the paste destination before the preview moves focus. */
export function captureInsertion(el: HTMLElement, event: Event) {
  const field = isField(el) ? el : null;
  const value = field?.value;
  const start = field?.selectionStart ?? value?.length ?? 0;
  const end = field?.selectionEnd ?? start;
  const selection = window.getSelection();
  const selected = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const drop =
    event instanceof DragEvent ? document.caretRangeFromPoint(event.clientX, event.clientY) : null;
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
    async insert(text: string, isCurrent: () => boolean): Promise<number | null> {
      const canContinue = () =>
        isCurrent() && !edited && el.isConnected && getEditableTarget(el) === el;
      if (!canContinue()) return 0;
      if (field) {
        if (field.value !== value) return 0;
        field.focus();
        if (document.activeElement !== field && field.getRootNode() instanceof Document) return 0;
        if (field.value !== value) return 0;
        const previous = field.value;
        writeField(
          field,
          previous.slice(0, start) + text + previous.slice(end),
          start + text.length,
        );
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
        return null;
      }
      if (!selection) return 0;
      el.focus();
      if (!canContinue() || !el.matches(':focus-within')) return 0;
      const caret = range ?? document.createRange();
      if (range && !within(el, range)) return 0;
      if (!range) {
        caret.selectNodeContents(el);
        caret.collapse(false);
      }
      selection.removeAllRanges();
      selection.addRange(caret);
      const batched = batchEnd(text, 0, RICH_TEXT_BATCH_SIZE) < text.length;
      const preserveWhitespace = batched || /[\r\n\t]| {2}|^ | $/.test(text);
      const insertBatch = (batch: string) => {
        writing = true;
        try {
          if (!preserveWhitespace && document.execCommand('insertText', false, batch)) return true;
          const normalized = batch.replace(/\r\n?/g, '\n');
          if (el.classList.contains('ProseMirror') && pasteIntoRichEditor(el, normalized))
            return true;
          return insertTextAtCaret(el, selection, normalized);
        } finally {
          writing = false;
        }
      };
      if (batched) {
        return insertRichText(el, selection, text, insertBatch, canContinue);
      }
      return insertBatch(text) ? null : 0;
    },
  };
}
