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
}

/** What `computers:pair` takes: a parsed pairing link. */
export interface ComputerPairingLink {
  relayUrl: string;
  room: string;
  key: string;
  pair?: string;
  alts: string[];
}
