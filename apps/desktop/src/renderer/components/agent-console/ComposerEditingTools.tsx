import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { composerToolbarPlacement, type SelectionAnchor } from './composerToolbarPlacement.js';
import './ComposerEditingTools.css';
import { ContextAction, ContextMenu } from '../ContextMenu.js';
import type { MarkdownEdit, MarkdownEditorElement } from './MarkdownEditor.js';
import { clipboardMarkdown, formatMarkdown, markdownActive, markdownControls, type MarkdownAction } from './composerFormatting.js';

/** A name for a clipboard blob, from its type: `clipboard.png`, `clipboard.pdf`. */
export function clipboardFileName(type: string): string {
  const sub = type.split('/')[1]?.split(';')[0].replace(/^x-/, '').replace(/^vnd\..*\.(\w+)$/, '$1') ?? 'bin';
  const ext = sub === 'jpeg' ? 'jpg' : sub === 'svg+xml' ? 'svg' : sub === 'quicktime' ? 'mov' : sub;
  return `clipboard.${ext}`;
}

export function ComposerEditingTools({ editor, disabled, value, apply, onPaste, composing }: {
  editor: React.RefObject<MarkdownEditorElement | null>; disabled: boolean; value: string;
  apply: (el: MarkdownEditorElement, edit: MarkdownEdit) => void;
  onPaste?: (e: React.ClipboardEvent<MarkdownEditorElement>) => void;
  composing: React.RefObject<boolean>;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [toolbar, setToolbar] = useState<SelectionAnchor | null>(null);
  const [placement, setPlacement] = useState<ReturnType<typeof composerToolbarPlacement> | null>(null);
  const [error, setError] = useState('');
  const saved = useRef<[number, number]>([0, 0]);
  const tools = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!toolbar || !tools.current) { setPlacement(null); return; }
    const position = () => {
      const { width, height } = tools.current!.getBoundingClientRect();
      setPlacement(composerToolbarPlacement(toolbar, width, height, innerWidth, innerHeight));
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(tools.current);
    return () => observer.disconnect();
  }, [toolbar]);
  useEffect(() => {
    const el = editor.current;
    if (!el || disabled) { setMenu(null); setToolbar(null); return; }
    const selection = () => {
      const s = window.getSelection();
      if (composing.current || document.activeElement !== el || !s?.rangeCount || !el.contains(s.anchorNode) || !el.contains(s.focusNode)) return;
      saved.current = [el.selectionStart, el.selectionEnd];
      if (saved.current[0] === saved.current[1]) { setToolbar(null); return; }
      const range = s.getRangeAt(0);
      // Anchor a multiline selection to actual text, not the blank center of its union.
      const box = el.getBoundingClientRect();
      const rect = Array.from(range.getClientRects()).find(r => r.width && r.height && r.bottom > Math.max(0, box.top) && r.top < Math.min(innerHeight, box.bottom)) ?? range.getBoundingClientRect();
      setToolbar({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
    };
    const context = (e: MouseEvent) => {
      if (composing.current) return;
      e.preventDefault(); saved.current = [el.selectionStart, el.selectionEnd];
      setToolbar(null); setError(''); setMenu({ x: e.clientX, y: e.clientY });
    };
    const dismiss = () => setToolbar(null);
    const outside = (e: PointerEvent) => { if (!tools.current?.contains(e.target as Node) && !el.contains(e.target as Node)) dismiss(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss(); };
    const focus = (e: FocusEvent) => { if (e.target !== el && !tools.current?.contains(e.target as Node)) dismiss(); };
    el.addEventListener('contextmenu', context);
    el.addEventListener('compositionstart', dismiss);
    document.addEventListener('selectionchange', selection);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    document.addEventListener('focusin', focus);
    document.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      el.removeEventListener('contextmenu', context); el.removeEventListener('compositionstart', dismiss);
      document.removeEventListener('selectionchange', selection); document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key); document.removeEventListener('focusin', focus); document.removeEventListener('scroll', dismiss, true); window.removeEventListener('resize', dismiss);
    };
  }, [editor, disabled, composing]);
  const restore = () => { editor.current?.focus(); editor.current?.setSelectionRange(...saved.current); };
  const format = (action: MarkdownAction) => {
    const el = editor.current;
    if (!el || disabled || composing.current) return;
    restore();
    const edit = formatMarkdown(el.value, ...saved.current, action);
    apply(el, edit); saved.current = [edit.start, edit.end]; setMenu(null);
  };
  const clipboard = async (mode: 'copy' | 'paste' | 'markdown' | 'plain') => {
    const el = editor.current;
    if (!el || disabled || composing.current) return;
    const selection = [...saved.current] as [number, number];
    const original = el.value;
    setError('');
    try {
      if (mode === 'copy') { await navigator.clipboard.writeText(original.slice(...selection)); restore(); }
      else {
        let plain = ''; let html = '';
        const data = new DataTransfer();
        if (navigator.clipboard.read && mode !== 'plain') {
          let items: ClipboardItem[] = [];
          try { items = await navigator.clipboard.read(); }
          catch { plain = await navigator.clipboard.readText(); }
          for (const item of items) {
            for (const type of item.types) {
              if (type === 'text/plain') plain = await (await item.getType(type)).text();
              else if (type === 'text/html') { if (mode === 'markdown') html = await (await item.getType(type)).text(); }
              // Anything that is not text is a file: a photo, a video, a PDF
              // copied from a browser. The composer decides how each travels.
              else if (mode === 'paste' && !type.startsWith('text/')) {
                const blob = await item.getType(type);
                data.items.add(new File([blob], clipboardFileName(type), { type }));
              }
            }
          }
        } else plain = await navigator.clipboard.readText();
        if (editor.current !== el || el.value !== original || el.contentEditable === 'false' || composing.current) return;
        el.focus(); el.setSelectionRange(...selection);
        if (mode === 'paste' && data.files.length && onPaste) {
          const event = { currentTarget: el, clipboardData: data, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
          onPaste(event as React.ClipboardEvent<MarkdownEditorElement>);
          if (event.defaultPrevented) { setMenu(null); return; }
        }
        const text = mode === 'markdown' ? clipboardMarkdown(html, plain) : plain.replace(/\r\n?/g, '\n');
        apply(el, { text: original.slice(0, selection[0]) + text + original.slice(selection[1]), start: selection[0] + text.length, end: selection[0] + text.length });
      }
      setMenu(null);
    } catch { setError('Clipboard access failed. Use the keyboard shortcut or allow clipboard access.'); }
  };
  const controls = <div role="toolbar" aria-label="Markdown formatting" className={`composer-format-controls${menu ? ' composer-format-controls--menu' : ''}`}>
    {markdownControls.map(([action, label, icon]) => <button key={action} type="button" title={label} aria-label={label}
      aria-pressed={markdownActive(value, ...saved.current, action)} disabled={disabled}
      className="composer-format-control" data-format={action}
      onMouseDown={e => e.preventDefault()} onClick={() => format(action)}>{icon}</button>)}
  </div>;
  return <>
    {menu && !disabled && <ContextMenu x={menu.x} y={menu.y} onClose={() => { setMenu(null); restore(); }}>
      {controls}<hr className="my-1 opacity-20" />
      <ContextAction disabled={saved.current[0] === saved.current[1]} onClick={() => { void clipboard('copy'); }}>Copy</ContextAction>
      <ContextAction onClick={() => { void clipboard('paste'); }}>Paste</ContextAction>
      <ContextAction onClick={() => { void clipboard('markdown'); }}>Paste as Markdown</ContextAction>
      <ContextAction onClick={() => { void clipboard('plain'); }}>Paste without formatting</ContextAction>
      {error && <p role="alert" className="px-2 text-xs">{error}</p>}
    </ContextMenu>}
    {toolbar && !menu && !disabled && createPortal(<div ref={tools} data-composer-toolbar className="composer-selection-toolbar" data-side={placement?.side} style={{ left: placement?.x ?? 0, top: placement?.y ?? 0, visibility: placement ? undefined : 'hidden', '--selection-pointer': `${placement?.pointer ?? 14}px` } as React.CSSProperties}>{controls}</div>, document.body)}
  </>;
}
