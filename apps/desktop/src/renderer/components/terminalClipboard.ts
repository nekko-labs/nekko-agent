/**
 * Clipboard keys for the terminal pane, following Windows Terminal and VS Code:
 * Ctrl+C copies when text is selected and otherwise stays the interrupt (^C to
 * the shell). Ctrl+Shift+C and Ctrl+Insert always copy; Ctrl+V, Ctrl+Shift+V
 * and Shift+Insert paste.
 *
 * macOS is left alone: Cmd+C/V reach the clipboard through the app menu there,
 * and Ctrl+C must always be the interrupt.
 */
export type TerminalKeyAction = 'copy' | 'paste' | null;

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>;

export const isMacPlatform = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

export function terminalKeyAction(e: KeyLike, hasSelection: boolean, canPaste: boolean, mac = isMacPlatform()): TerminalKeyAction {
  if (mac || e.metaKey || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (e.ctrlKey && key === 'c') return e.shiftKey || hasSelection ? 'copy' : null;
  if (e.ctrlKey && !e.shiftKey && key === 'insert') return 'copy';
  if (e.ctrlKey && key === 'v') return canPaste ? 'paste' : null;
  if (!e.ctrlKey && e.shiftKey && key === 'insert') return canPaste ? 'paste' : null;
  return null;
}

/** Shortcut hints shown in the context menu, matching the platform. */
export function terminalKeyLabels(mac = isMacPlatform()) {
  return mac ? { copy: 'Cmd+C', paste: 'Cmd+V' } : { copy: 'Ctrl+C', paste: 'Ctrl+V' };
}
