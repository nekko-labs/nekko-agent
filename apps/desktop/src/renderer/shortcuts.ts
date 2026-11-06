/**
 * Global keyboard shortcuts, defined once so the handler that listens for a
 * chord and the hint we render next to a menu item can never drift apart.
 */

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

const MOD = isMac ? '⌘' : 'Ctrl+';

/** Ctrl on Windows/Linux, Cmd on macOS. */
const mod = (e: KeyboardEvent) => e.ctrlKey || e.metaKey;

export interface Shortcut {
  /** Hint to show in menus and tooltips, e.g. "⌘N" or "Ctrl+N". */
  label: string;
  /** Whether a keydown is this chord. */
  matches: (e: KeyboardEvent) => boolean;
}

export const SHORTCUTS: Record<'palette' | 'newAgent' | 'newTerminal' | 'newMedia' | 'searchChats' | 'contextPanel' | 'findInChat', Shortcut> = {
  // Handled by the chat window that has focus (or the one the user is
  // driving), not by App: it opens that chat's own search bar.
  findInChat: {
    label: `${MOD}F`,
    matches: (e) => mod(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f',
  },
  palette: {
    label: `${MOD}K`,
    matches: (e) => mod(e) && !e.shiftKey && e.key.toLowerCase() === 'k',
  },
  // Keep the earlier new-chat chord as an alias.
  newAgent: {
    label: `${MOD}T`,
    matches: (e) => mod(e) && !e.altKey && !e.shiftKey && ['t', 'n'].includes(e.key.toLowerCase()),
  },
  // Backtick is the terminal key in VS Code, Cursor, and Zed (Ctrl+` opens the
  // terminal there, Ctrl+Shift+` adds another). Nekko Agent has no terminal panel to
  // toggle, so both chords just spawn one. Shift+` arrives as "~" on US layouts.
  // ⌘J keeps working for anyone used to the shortcut shipped before the rename.
  newTerminal: {
    label: `${MOD}Shift+T`,
    matches: (e) => mod(e) && !e.altKey && ((e.shiftKey && e.key.toLowerCase() === 't') || e.key === '`' || e.key === '~' || e.key.toLowerCase() === 'j'),
  },
  newMedia: {
    label: `${MOD}Shift+I`,
    matches: (e) => mod(e) && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'i',
  },
  searchChats: {
    label: `${MOD}Shift+F`,
    matches: (e) => mod(e) && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'f',
  },
  contextPanel: {
    label: `${MOD}\\`,
    matches: (e) => mod(e) && e.key === '\\',
  },
};
