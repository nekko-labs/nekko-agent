export type WindowAction = 'complete' | 'minimize' | 'delete';
const modifier = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? 'Cmd+' : 'Ctrl+';
export const WINDOW_HOTKEYS = { complete: `${modifier}Shift+E`, minimize: `${modifier}Shift+M`, delete: `${modifier}Shift+Delete` };

export function windowActionForKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'repeat' | 'isComposing' | 'defaultPrevented'>): WindowAction | null {
  if (e.defaultPrevented || e.repeat || e.isComposing || e.altKey || !e.shiftKey || !(e.ctrlKey || e.metaKey) || (e.ctrlKey && e.metaKey)) return null;
  return e.key.toLowerCase() === 'e' ? 'complete' : e.key.toLowerCase() === 'm' ? 'minimize' : e.key === 'Delete' ? 'delete' : null;
}

const panes = new Map<string, { element: HTMLElement; run: (action: WindowAction) => void }>();
let focused: string | null = null;
export function focusWindow(id: string) { focused = id; }
function onKey(e: KeyboardEvent) {
  const action = windowActionForKey(e);
  if (!action || document.querySelector('[aria-modal="true"], dialog[open]')) return;
  const element = document.activeElement?.closest<HTMLElement>('[data-shortcut-pane]');
  if (!element && document.activeElement && document.activeElement !== document.body) return;
  const id = element?.dataset.shortcutPane ?? focused;
  const pane = id ? panes.get(id) : undefined;
  if (!pane || !pane.element.isConnected || pane.element.closest('[inert], [aria-hidden="true"]') || !pane.element.getClientRects().length) return;
  e.preventDefault();
  e.stopPropagation();
  pane.run(action);
}
export function registerWindow(id: string, element: HTMLElement, run: (action: WindowAction) => void) {
  if (!panes.size) window.addEventListener('keydown', onKey, true);
  panes.set(id, { element, run });
  return () => {
    panes.delete(id);
    if (focused === id) focused = null;
    if (!panes.size) window.removeEventListener('keydown', onKey, true);
  };
}
