import React, { forwardRef, useLayoutEffect, useRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { composerMarkdownNodes } from './ComposerHighlight.js';
import { revealEditorCaret } from './editorCaret.js';
import { ComposerEditingTools } from './ComposerEditingTools.js';

/** Textarea-compatible selection API, backed by the browser's visible editable text. */
export type MarkdownEditorElement = HTMLDivElement & {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  setSelectionRange: (start: number, end: number) => void;
};

function offsets(el: HTMLElement): [number, number] {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !el.contains(selection.anchorNode) || !el.contains(selection.focusNode)) return [0, 0];
  const range = selection.getRangeAt(0);
  const before = range.cloneRange();
  before.selectNodeContents(el);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  return [start, start + range.toString().length];
}

function select(el: HTMLElement, start: number, end: number) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let node: Node | null;
  let pos = 0;
  let found = false;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (!found && start <= pos + length) { range.setStart(node, Math.max(0, start - pos)); found = true; }
    if (found && end <= pos + length) { range.setEnd(node, Math.max(0, end - pos)); break; }
    pos += length;
  }
  if (!found) { range.selectNodeContents(el); range.collapse(false); }
  else if (!node) { range.setEnd(el, el.childNodes.length); }
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  requestAnimationFrame(() => revealEditorCaret(el));
}

export interface MarkdownEdit { text: string; start: number; end: number }
/** Pure edit operations keep markdown as the stored/sent format. */
export function markdownEdit(text: string, start: number, end: number, key: string, shift = false, command = false): MarkdownEdit | null {
  const replace = (from: number, to: number, insert: string, a = from + insert.length, b = a) => ({ text: text.slice(0, from) + insert + text.slice(to), start: a, end: b });
  if (command && ['b', 'i', 'e'].includes(key.toLowerCase())) {
    const mark = key.toLowerCase() === 'b' ? '**' : key.toLowerCase() === 'i' ? '*' : '`';
    if (text.slice(start - mark.length, start) === mark && text.slice(end, end + mark.length) === mark) {
      return replace(start - mark.length, end + mark.length, text.slice(start, end), start - mark.length, end - mark.length);
    }
    return replace(start, end, mark + text.slice(start, end) + mark, start + mark.length, end + mark.length);
  }
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const line = text.slice(lineStart, start);
  const fenced = (text.slice(0, lineStart).match(/^\s*```/gm)?.length ?? 0) % 2 === 1;
  if (key === 'Enter' && shift) {
    if (fenced) return replace(start, end, '\n' + (line.match(/^\s*/)?.[0] ?? ''));
    const list = line.match(/^(\s*)([-+*]|(\d+)([.)]))\s+(?:\[([ xX])\]\s+)?(.*)$/);
    if (list) {
      if (!list[6].trim()) return replace(lineStart, end, '');
      const marker = list[3] ? `${Number(list[3]) + 1}${list[4]}` : list[2];
      return replace(start, end, `\n${list[1]}${marker} ${list[5] !== undefined ? '[ ] ' : ''}`);
    }
    const quote = line.match(/^(\s*>\s?)(.*)$/);
    if (quote) return quote[2].trim() ? replace(start, end, '\n' + quote[1]) : replace(lineStart, end, '');
    return replace(start, end, '\n');
  }
  if (key === 'Tab' && !fenced && /^\s*(?:[-+*]|\d+[.)])\s/.test(line)) {
    const last = text.indexOf('\n', end);
    const to = last < 0 ? text.length : last;
    const block = text.slice(lineStart, to);
    const updated = block.split('\n').map((s) => shift ? s.replace(/^(?: {1,2}|\t)/, '') : '  ' + s).join('\n');
    const firstDelta = updated.split('\n')[0].length - block.split('\n')[0].length;
    return replace(lineStart, to, updated, Math.max(lineStart, start + firstDelta), end + updated.length - block.length);
  }
  return null;
}

export const MarkdownEditor = forwardRef<MarkdownEditorElement, {
  value: string; onChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent<MarkdownEditorElement>) => void;
  onPaste?: (e: React.ClipboardEvent<MarkdownEditorElement>) => void;
  className: string; placeholder: string; disabled: boolean;
  'aria-expanded': boolean; 'aria-controls'?: string;
}>(function MarkdownEditor({ value, onChange, onKeyDown, onPaste, disabled, placeholder, ...props }, ref) {
  const local = useRef<MarkdownEditorElement | null>(null);
  const composing = useRef(false);
  const pending = useRef<[number, number] | null>(null);
  const history = useRef<MarkdownEdit[]>([]);
  const redo = useRef<MarkdownEdit[]>([]);
  const previous = useRef(value);
  const remember = (el: MarkdownEditorElement) => {
    history.current.push({ text: previous.current, start: el.selectionStart, end: el.selectionEnd });
    if (history.current.length > 200) history.current.shift();
    redo.current = [];
  };
  const paint = (el: MarkdownEditorElement, text: string) => {
    const html = text ? renderToStaticMarkup(<>{composerMarkdownNodes(text)}</>) + (text.endsWith('\n') ? '<br>' : '') : '<br>';
    // Most keys leave the highlighting as it was: the browser's own edit
    // already reads the same, caret included. Rewriting it anyway and putting
    // the caret back forced a layout of the whole page on every key.
    if (!pending.current && el.innerHTML === html) return;
    const selection = pending.current ?? offsets(el);
    pending.current = null;
    el.innerHTML = html;
    if (document.activeElement === el) select(el, ...selection);
  };
  useLayoutEffect(() => {
    const el = local.current;
    if (el && !composing.current && el.value !== value) paint(el, value);
    previous.current = value;
  }, [value]);
  const apply = (el: MarkdownEditorElement, edit: MarkdownEdit, record = true) => {
    if (record) remember(el);
    pending.current = [edit.start, edit.end];
    paint(el, edit.text);
    previous.current = edit.text;
    onChange(edit.text);
  };
  return <><div {...props}
    ref={(el) => {
      if (el && !Object.getOwnPropertyDescriptor(el, 'value')) {
        Object.defineProperties(el, {
          value: { get: () => el.textContent ?? '' },
          selectionStart: { get: () => offsets(el)[0] },
          selectionEnd: { get: () => offsets(el)[1] },
          setSelectionRange: { value: (a: number, b: number) => select(el, a, b) },
        });
      }
      local.current = el as MarkdownEditorElement | null;
      if (typeof ref === 'function') ref(local.current); else if (ref) ref.current = local.current;
    }}
    role="combobox" aria-multiline="true" aria-autocomplete="list" aria-disabled={disabled}
    contentEditable={disabled ? false : 'plaintext-only'} suppressContentEditableWarning
    data-placeholder={placeholder}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={(e) => { composing.current = false; onChange(e.currentTarget.textContent ?? ''); }}
    onInput={(e) => {
      if (composing.current) return;
      const el = e.currentTarget as MarkdownEditorElement;
      const text = el.textContent ?? '';
      remember(el);
      paint(el, text);
      previous.current = text;
      onChange(text);
    }}
    onKeyDown={(event) => {
      const e = event as React.KeyboardEvent<MarkdownEditorElement>;
      if (!e.nativeEvent.isComposing && !disabled) {
        if ((e.ctrlKey || e.metaKey) && ['z', 'y'].includes(e.key.toLowerCase())) {
          e.preventDefault();
          const restoring = e.shiftKey || e.key.toLowerCase() === 'y';
          const source = restoring ? redo.current : history.current;
          const destination = restoring ? history.current : redo.current;
          const edit = source.pop();
          if (edit) {
            destination.push({ text: e.currentTarget.value, start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd });
            apply(e.currentTarget, edit, false);
          }
          return;
        }
        const edit = markdownEdit(e.currentTarget.value, e.currentTarget.selectionStart, e.currentTarget.selectionEnd, e.key, e.shiftKey, e.metaKey || e.ctrlKey);
        if (edit) { e.preventDefault(); apply(e.currentTarget, edit); return; }
      }
      onKeyDown(e);
    }}
    onPaste={(event) => {
      const e = event as React.ClipboardEvent<MarkdownEditorElement>;
      onPaste?.(e);
      if (e.defaultPrevented) return;
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart;
      const pasted = e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
      apply(el, { text: el.value.slice(0, start) + pasted + el.value.slice(el.selectionEnd), start: start + pasted.length, end: start + pasted.length });
    }}
  />
    <ComposerEditingTools editor={local} disabled={disabled} value={value} apply={apply} onPaste={onPaste} composing={composing} />
  </>;
});
