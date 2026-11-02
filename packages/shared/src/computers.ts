/**
 * Other computers this desktop is connected to (Settings > Computers).
 * `nekkod` holds a relay link to each, the way a phone reaches a computer.
 * `computers:*` answers for the desktop window only.
 */

/** A paired computer, as `computers.json` holds it: no secrets. */
export interface PairedComputer {
  /** 8 hex chars, chosen at pairing. */
  id: string;
  /** Renameable; starts as the other computer's own name. */
  name: string;
  /** `process.platform` there: darwin, win32, linux. */
  platform?: string;
  relayUrl: string;
  alts: string[];
  pairedAt: number;
  /** An index into the computer palette. */
  color: number;
}

export type ComputerState =
  | 'connecting'
  | 'online'
  /** Asleep, its app closed, or Connections has this switched off. */
  | 'offline'
  /** It removed this computer. */
  | 'denied'
  /** Its build is too old for computers. */
  | 'update';

export interface ComputerStatus extends PairedComputer {
  state: ComputerState;
  /** The address in use, when connected. */
  route: string | null;
  /** The switches it set for this computer, as of its last welcome. */
  read: boolean;
  change: boolean;
  /** Its `machineIcon`, when it has one. */
  icon?: string;
}

/** What `computers:pair` takes: a parsed pairing link. */
export interface ComputerPairingLink {
  relayUrl: string;
  room: string;
  key: string;
  pair?: string;
  alts: string[];
}

/** A computer's providers and folders, for its pickers. Holds no secrets. Their ids are qualified. */
export interface ComputerCatalog {
  providers: import('./models.js').ProviderConfig[];
  workspaces: import('./workspace.js').WorkspaceFolder[];
}

/** One of these per computer. None is a status color: those mean working, warning, needs input and error. */
export const COMPUTER_COLORS = ['#5b8def', '#a57cf0', '#2fb7b1', '#e26fb4', '#7f8cf5', '#8aa0b8'] as const;

export function computerColor(c: { color: number }): string {
  return COMPUTER_COLORS[c.color % COMPUTER_COLORS.length];
}

/**
 * The computer a chat or folder id belongs to, or null for this one. An id from
 * another computer reads `@<computerId>:<rawId>`; a local id never starts with `@`.
 */
export function computerIdOf(id: string | null | undefined): string | null {
  if (!id?.startsWith('@')) return null;
  const end = id.indexOf(':');
  return end > 1 ? id.slice(1, end) : null;
}

/**
 * The icons a computer can have. Set in that machine's settings (`machineIcon`),
 * so every device that connects shows the same one. Unset, nothing shows.
 */
export const COMPUTER_ICONS = [
  'laptop', 'desktop', 'tower', 'mini', 'server', 'rack', 'cloud', 'gpu',
  'chip', 'home', 'office', 'lab', 'bolt', 'moon', 'sun', 'star',
  'flame', 'leaf', 'globe', 'cube', 'rocket', 'shield', 'terminal', 'cat',
] as const;

export type ComputerIcon = (typeof COMPUTER_ICONS)[number];
