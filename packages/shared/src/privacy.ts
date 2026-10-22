/**
 * Privacy Shield: what a chat sends a cloud model. With the shield on, the
 * engine swaps private values (emails, phone numbers, card numbers, ids,
 * public IPs, secrets, the account name in home-folder paths, and the
 * user's own terms) for placeholders like `[PII_EMAIL_1]` before a request
 * leaves the computer, and swaps them back in what the model returns, so
 * tools and the saved chat keep the real values. Local models never need it;
 * Claude Agent chats are out of its reach (Claude Code sends those requests).
 *
 * Engine: `crates/nekko-privacy`. Design:
 * `docs/superpowers/specs/2026-10-22-privacy-shield-design.md`.
 */

export type PrivacyKind = 'email' | 'phone' | 'card' | 'ssn' | 'my-number' | 'ip' | 'secret' | 'username' | 'term';

export const PRIVACY_KINDS: PrivacyKind[] = ['email', 'phone', 'card', 'ssn', 'my-number', 'ip', 'secret', 'username', 'term'];

export const PRIVACY_KIND_LABELS: Record<PrivacyKind, string> = {
  email: 'Email addresses',
  phone: 'Phone numbers',
  card: 'Card numbers',
  ssn: 'US Social Security numbers',
  'my-number': 'My Number (マイナンバー)',
  ip: 'Public IP addresses',
  secret: 'API keys, tokens and passwords',
  username: 'Your account name in file paths',
  term: 'Your own terms',
};

export type PrivacyMode = 'off' | 'redact';

/** A chat's own shield options (`Session.privacy`); unset fields follow the app's. */
export interface SessionPrivacy {
  /** Unset: `AppSettings.privacyMode`, else off. */
  mode?: PrivacyMode;
  /** Kinds this chat sends as they are. Unset: `AppSettings.privacyDisabledKinds`. */
  disabledKinds?: PrivacyKind[];
  /** Exact values the user chose to send as they are in this chat. */
  allow?: string[];
}

/** One value the shield would replace. */
export interface PrivacyFinding {
  kind: PrivacyKind;
  value: string;
  /** What the model reads instead, e.g. `[PII_EMAIL_1]`. */
  token: string;
  /** How many times it occurs in what would be sent. */
  count: number;
  /** In the message being written. */
  inDraft: boolean;
  /** In the chat so far. */
  inChat: boolean;
}

/** `privacy:preview(sessionId, draft)`. */
export interface PrivacyPreview {
  /** Whether the shield is on for this chat (its own mode, else the app's). */
  enabled: boolean;
  /**
   * Where this chat's model is: `cloud` gets the shield, `local` never needs
   * it, `external` (Claude Agent) is out of its reach.
   */
  reach: 'cloud' | 'local' | 'external';
  /** The draft as the model would read it. */
  draft: string;
  findings: PrivacyFinding[];
  /** Values the user allowed that occur in this chat. */
  allowed: { kind: PrivacyKind; value: string }[];
  disabledKinds: PrivacyKind[];
  terms: string[];
  kinds: PrivacyKind[];
}

/** The chat's shield mode, as the engine resolves it. */
export function privacyMode(session: { privacy?: SessionPrivacy } | null | undefined, settings: { privacyMode?: PrivacyMode } | null | undefined): PrivacyMode {
  return session?.privacy?.mode ?? settings?.privacyMode ?? 'off';
}

/** `privacy` with `patch` applied, for `setSessionOptions`. */
export function patchPrivacy(privacy: SessionPrivacy | undefined, patch: Partial<SessionPrivacy>): SessionPrivacy {
  return { ...privacy, ...patch };
}

/** `allow` with `value` added or removed. */
export function toggleAllowed(allow: string[] | undefined, value: string, allowed: boolean): string[] {
  const rest = (allow ?? []).filter((v) => v !== value);
  return allowed ? [...rest, value] : rest;
}
