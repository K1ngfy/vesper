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

// Large inserts can block rich text editors even after redaction has finished.
const CE_INSERT_LIMIT = 16 * 1024;

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
  let undoField: (() => void) | undefined;
  const noteEdit = () => {
    edited = true;
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
    insert(text: string): boolean {
      if (edited || !el.isConnected || getEditableTarget(el) !== el) return false;
      if (field) {
        if (field.value !== value) return false;
        field.focus();
        if (document.activeElement !== field && field.getRootNode() instanceof Document)
          return false;
        if (field.value !== value) return false;
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
        return true;
      }
      if (!selection || text.length > CE_INSERT_LIMIT) return false;
      el.focus();
      const caret = range ?? document.createRange();
      if (range && !within(el, range)) return false;
      if (!range) {
        caret.selectNodeContents(el);
        caret.collapse(false);
      }
      selection.removeAllRanges();
      selection.addRange(caret);
      if (document.execCommand('insertText', false, text)) return true;
      const beforeInput = new InputEvent('beforeinput', {
        bubbles: true,
        composed: true,
        cancelable: true,
        inputType: 'insertText',
        data: text,
      });
      if (!el.dispatchEvent(beforeInput) || !within(el, caret)) return false;
      caret.deleteContents();
      const node = document.createTextNode(text);
      caret.insertNode(node);
      caret.setStartAfter(node);
      caret.collapse(true);
      selection.removeAllRanges();
      selection.addRange(caret);
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertText',
          data: text,
        }),
      );
      return true;
    },
  };
}
