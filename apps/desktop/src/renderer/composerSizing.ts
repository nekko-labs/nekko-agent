/** Two text rows plus the editor's vertical padding. */
export const WALL_EDITOR_MIN_HEIGHT = 64;

/** Saved shell height is a preference, not a ceiling on the draft. */
export function wallEditorHeight({ content, chrome, extra, preferred, viewport }: {
  content: number;
  chrome: number;
  extra: number;
  preferred: number | null;
  viewport: number;
}): number {
  const cap = Math.max(WALL_EDITOR_MIN_HEIGHT, Math.min(480, viewport * 0.5) - chrome);
  const minimum = Math.max(WALL_EDITOR_MIN_HEIGHT, (preferred ?? 0) - Math.max(0, chrome - extra));
  return Math.ceil(Math.min(cap, Math.max(minimum, content)));
}

/**
 * Measure real rendered text, including wrapping and trailing newlines. Temporarily
 * releasing the height allows deletion to shrink too; restore scroll position so
 * measuring a capped draft doesn't jump it back to the beginning.
 */
export function measureEditorContent(editor: HTMLElement): number {
  const height = editor.style.height;
  const scroll = editor.scrollTop;
  editor.style.height = 'auto';
  const content = editor.scrollHeight;
  editor.style.height = height;
  editor.scrollTop = scroll;
  return content;
}

/** Owns only the wall editor's height. No state updates on each keystroke. */
export function observeWallComposer(panel: HTMLElement, preferred: number | null): () => void {
  const column = panel.closest<HTMLElement>('.wall-column');
  let frame = 0;
  let disposed = false;
  let observed: Element[] = [];
  const schedule = () => {
    if (!frame && !disposed) frame = requestAnimationFrame(measure);
  };
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  const measure = () => {
    frame = 0;
    const editor = panel.querySelector<HTMLElement>('.composer-editor-wrap > [contenteditable]');
    const composer = panel.querySelector<HTMLElement>('.composer');
    if (!editor || !composer) return;
    // Include queue, header, footer, attachments, skills and editing-tool rows.
    // Ancestors of the editor are excluded to avoid observing our own height writes.
    const rows = [...composer.querySelectorAll<HTMLElement>('*')].filter((row) =>
      row.parentElement && (row.parentElement === composer || row.parentElement.classList.contains('composer-editing-body') || row.parentElement.classList.contains('composer-editor-wrap')) &&
      row !== editor && !row.contains(editor) && getComputedStyle(row).position !== 'absolute');
    if (rows.length !== observed.length || rows.some((row, i) => row !== observed[i])) {
      observed.forEach((row) => ro?.unobserve(row));
      rows.forEach((row) => ro?.observe(row));
      observed = rows;
    }
    const chrome = Math.max(0, composer.getBoundingClientRect().height - editor.getBoundingClientRect().height);
    const extras = [...composer.querySelectorAll<HTMLElement>('[data-composer-attachments], [data-composer-skill], .collapse-wrap')];
    const extra = extras.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0);
    const viewport = Math.min(window.innerHeight, column?.clientHeight || window.innerHeight);
    const next = wallEditorHeight({ content: measureEditorContent(editor), chrome, extra, preferred, viewport });
    if (editor.style.height !== `${next}px`) editor.style.height = `${next}px`;
  };
  // Text repaint, queue insertion/removal, and class changes (queue expansion).
  // Ignore inline style writes made by this measurer.
  const mo = new MutationObserver(schedule);
  mo.observe(panel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
  panel.addEventListener('input', schedule);
  window.addEventListener('resize', schedule);
  // Only width changes on the panel are relevant; height is our own output.
  let width = panel.getBoundingClientRect().width;
  const widthObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    const next = panel.getBoundingClientRect().width;
    if (next !== width) { width = next; schedule(); }
  });
  widthObserver?.observe(panel);
  if (column) ro?.observe(column);
  measure();
  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    mo.disconnect();
    ro?.disconnect();
    widthObserver?.disconnect();
    panel.removeEventListener('input', schedule);
    window.removeEventListener('resize', schedule);
  };
}
