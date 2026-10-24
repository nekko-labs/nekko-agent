/**
 * Step-up on the desktop and the Local Web UI (SK-4, SK-5): Settings →
 * Security's channels and shapes, how a guarded call's refusal reads, and
 * the plain words the step-up sheet shows. The daemon answers and checks all
 * of it (`crates/nekkod/src/security.rs`); `step-up.ts` keeps the guarded
 * list, the challenge and the verifier.
 *
 * A guarded call made while step-up is on and not confirmed is refused
 * `Step-up needed (step-up-required) [<action class>]: <sentence>`. The page
 * then opens the step-up sheet, answers a fresh `security:challenge`, sends
 * the answer with `security:confirm(action, proof)`, and calls again: one
 * confirmation covers that action class on that surface for five minutes.
 */
import { STEP_UP_DESKTOP_GUARDED, STEP_UP_MESSAGES, type SecurityCredentialKind, type StepUpAssertion, type StepUpCode, type StepUpDesktopAction } from './step-up.js';

/** Settings → Security's channels. Desktop and Local Web UI only: never in `PHONE_CHANNELS` (a test pins it). */
export const SECURITY_DESKTOP_CHANNELS = {
  status: 'security:status',
  challenge: 'security:challenge',
  confirm: 'security:confirm',
  registerBegin: 'security:registerBegin',
  registerKey: 'security:registerKey',
  totpBegin: 'security:totpBegin',
  totpConfirm: 'security:totpConfirm',
  enable: 'security:enable',
  disable: 'security:disable',
  removeMethod: 'security:removeMethod',
  recoveryCodes: 'security:recoveryCodes',
} as const;

/**
 * Adding a method or new recovery codes while step-up is on needs a step-up
 * too, or anyone at the keyboard could register their own key and answer
 * with it (the daemon's `METHODS_CHANNELS`).
 */
export const STEP_UP_DESKTOP_METHODS = {
  action: 'securityMethods',
  channels: ['security:registerBegin', 'security:registerKey', 'security:totpBegin', 'security:totpConfirm', 'security:recoveryCodes'],
} as const;

/** An action class a desktop confirmation covers. */
export type DesktopStepUpAction = Exclude<StepUpDesktopAction, 'modeRaise' | 'stepUpOff'> | typeof STEP_UP_DESKTOP_METHODS.action;

/** The action class a desktop channel's step-up covers, or null when unguarded here. */
export function desktopStepUpAction(channel: string): DesktopStepUpAction | null {
  if ((STEP_UP_DESKTOP_METHODS.channels as readonly string[]).includes(channel)) return STEP_UP_DESKTOP_METHODS.action;
  for (const [action, list] of Object.entries(STEP_UP_DESKTOP_GUARDED)) {
    if (action === 'modeRaise' || action === 'stepUpOff') continue;
    if ((list as readonly string[]).includes(channel)) return action as DesktopStepUpAction;
  }
  return null;
}

/** What the sheet says it is confirming, in plain words. */
export const STEP_UP_ACTION_LABELS: Record<DesktopStepUpAction | 'stepUpOff', string> = {
  remoteAccess: 'Turn on remote access or change how phones connect',
  pairing: 'Pair a phone or sign out all phones',
  phoneAccess: 'Change what a phone may do',
  providerKeys: 'Add, show or change a provider key or account',
  securityMethods: 'Add a sign-in method or new recovery codes',
  stepUpOff: 'Turn off step-up or remove a method',
};

/** A step-up refusal from the computer, read out of an error message. */
export interface StepUpRefusal {
  code: StepUpCode;
  action: string | null;
  /** The sentence to show. */
  message: string;
}

/** The refusal in `error` (an Error or its text), or null when it is not one. */
export function stepUpRefusalOf(error: unknown): StepUpRefusal | null {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const m = /\((step-up-(?:required|invalid|stale|replayed))\)(?:\s*\[([A-Za-z]+)\])?(?::\s*(.*))?/.exec(text);
  if (!m) return null;
  const code = m[1] as StepUpCode;
  return { code, action: m[2] ?? null, message: (m[3] ?? '').trim() || STEP_UP_MESSAGES[code] };
}

/** One registered key or passkey, as Settings → Security lists it (never its public key). */
export interface SecurityMethodInfo {
  id: string;
  name: string;
  kind: SecurityCredentialKind;
  addedAt: number;
  lastUsedAt?: number;
  /** An assertion's counter did not rise: the key may have been copied. */
  cloned: boolean;
}

/** `security:status`. */
export interface SecurityStatus {
  /** False without a data folder (nothing can be saved). */
  available: boolean;
  enabled: boolean;
  /** `security.json` exists but cannot be read: every guarded call is refused. */
  damaged?: boolean;
  methods: SecurityMethodInfo[];
  totp: { addedAt: number; lastUsedAt?: number; lockedUntil?: number | null } | null;
  recoveryLeft: number;
  minMethods: number;
  coverMs: number;
  /** Action classes this surface confirmed, and until when. */
  covered: Record<string, number>;
}

/** `security:challenge` on the desktop: like a phone's, with the keys by name. */
export interface DesktopStepUpChallenge {
  challenge: string;
  expiresAt: number;
  required: boolean;
  methods: Array<SecurityCredentialKind | 'totp'>;
  credentials: Array<{ id: string; name: string; kind: SecurityCredentialKind; rpId?: string | null }>;
  totp: boolean;
  recovery: boolean;
}

/** What answers the sheet: a key or passkey, a code, or (to turn step-up off or remove a method) a recovery code. */
export type DesktopStepUpProof = StepUpAssertion | { totp: string } | { recovery: string };

/** `security:confirm`. */
export interface StepUpConfirmed {
  ok: true;
  required: boolean;
  method?: 'fido2' | 'totp';
  /** The registered name of the key that answered, or "a one-time code". */
  name?: string;
  credentialId?: string | null;
  coveredUntil?: number;
}

/** `security:registerBegin`: what `navigator.credentials.create()` needs; the page adds `rp.id` (its own host). */
export interface SecurityRegisterBegin {
  challenge: string;
  rpName: string;
  userId: string;
  userName: string;
  userDisplayName: string;
  kind: SecurityCredentialKind;
  attachment: 'platform' | 'cross-platform';
  excludeCredentials: Array<{ id: string }>;
  timeoutMs: number;
}

/** `security:registerKey`'s argument. */
export interface SecurityRegisterKeyInput {
  name: string;
  kind: SecurityCredentialKind;
  /** The relying-party id the page used (its host). */
  rpId: string;
  id: string;
  clientDataJSON: string;
  attestationObject: string;
}

/** A method added: the new status, and (first method only) the recovery codes, shown once. */
export interface SecurityMethodAdded {
  status: SecurityStatus;
  recoveryCodes: string[] | null;
  name?: string;
}

/** `security:totpBegin`: the secret, shown once as a QR. */
export interface SecurityTotpBegin {
  secret: string;
  uri: string;
  account: string;
}

/**
 * A WebAuthn ceremony in JSON form (every binary field unpadded base64url),
 * run where WebAuthn works: the page itself in a browser, a loopback
 * ceremony window on the desktop (a `file://` page has no origin WebAuthn
 * accepts).
 */
export type WebAuthnCeremonyRequest =
  | {
      mode: 'create';
      rpId?: string;
      rpName: string;
      userId: string;
      userName: string;
      userDisplayName: string;
      challenge: string;
      attachment: 'platform' | 'cross-platform';
      excludeCredentials: string[];
      timeoutMs: number;
    }
  | { mode: 'get'; rpId?: string; challenge: string; allowCredentials: string[]; timeoutMs: number };

export type WebAuthnCeremonyResult =
  | { ok: true; mode: 'create'; rpId: string; id: string; clientDataJSON: string; attestationObject: string }
  | { ok: true; mode: 'get'; rpId: string; credentialId: string; authenticatorData: string; clientDataJSON: string; signature: string }
  | { ok: false; error: string; cancelled?: boolean };

/** The step-up sheet answers a ceremony this long at most (the challenge's life). */
export const WEBAUTHN_CEREMONY_TIMEOUT_MS = 2 * 60 * 1000;

/** Why turning step-up on deserves a second thought, or null when it does not. */
export function stepUpEnableWarning(status: Pick<SecurityStatus, 'methods' | 'totp'>, pairedPhones: number): string | null {
  const keys = status.methods.filter((m) => m.kind === 'security-key').length;
  const total = status.methods.length + (status.totp ? 1 : 0);
  // The spec's warn-not-refuse case: the second method is a code app, likely on a phone this protects.
  if (status.totp && total === 2 && pairedPhones > 0) {
    return keys === 1
      ? 'Your second method is a one-time code app. If it is on a phone you paired, losing that phone loses both the phone and the code: keep your recovery codes safe, or add a second security key.'
      : 'Your second method is a one-time code app. If it is on a phone you paired, one lost phone could take both methods: keep your recovery codes safe, or add a security key.';
  }
  return null;
}

/** Why step-up cannot be turned on yet, or null. */
export function stepUpEnableBlocker(status: Pick<SecurityStatus, 'methods' | 'totp' | 'minMethods' | 'available'>): string | null {
  if (!status.available) return 'Security needs this computer’s data folder.';
  const total = status.methods.length + (status.totp ? 1 : 0);
  const min = Math.max(2, status.minMethods);
  if (total >= min) return null;
  const left = min - total;
  return `Add ${left === 1 ? 'one more method' : `${left} methods`} first, so a lost key never locks you out: two security keys, or a key and a one-time code app.`;
}

/** The docs page *Protect this computer with a security key* (SK-10), at nekkoagent.com. */
export const PROTECT_COMPUTER_DOCS_PATH = '/docs/protect-this-computer-with-a-security-key';
export const PROTECT_COMPUTER_DOCS_URL = `https://nekkoagent.com${PROTECT_COMPUTER_DOCS_PATH}`;

/** The hub event a phone's safety exit sends (`remote:safetyExit`, nekkod remote.rs). */
export const REMOTE_SAFETY_EXIT_EVENT = 'remote:safetyExit';

export interface RemoteSafetyExit {
  channel: 'device:signOut' | 'remote:stop' | 'app:quit';
  deviceId: string;
  name?: string | null;
  at: number;
}

/** A time of day as the owner reads it (`14:02`). */
export function clockTime(at: number, locale?: string): string {
  return new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

/** The desktop notification for a safety exit, or null for anything else. */
export function safetyExitNotice(exit: RemoteSafetyExit, time: (at: number) => string = (at) => clockTime(at)): { title: string; body: string } | null {
  const who = exit.name?.trim() || 'A paired phone';
  const at = time(exit.at);
  switch (exit.channel) {
    case 'device:signOut':
      return { title: 'A phone signed itself out', body: `${who} signed out of this computer at ${at}. It needs a new pairing code to connect again.` };
    case 'remote:stop':
      return { title: 'Remote access was stopped', body: `Remote access was stopped from ${who} at ${at}. Turn it on again from Settings → Phone pairing.` };
    case 'app:quit':
      return { title: 'Nekko Agent is quitting', body: `${who} asked Nekko Agent to quit at ${at}. Open it again on this computer to continue.` };
    default:
      return null;
  }
}

/** The Remote access card's banner after `remote:stop` (`RemoteStatus.stoppedBy`). */
export function remoteStoppedBanner(stoppedBy: { name?: string | null; at: number }, time: (at: number) => string = (at) => clockTime(at)): string {
  const who = stoppedBy.name?.trim() || 'a paired phone';
  return `Remote access was stopped from ${who} at ${time(stoppedBy.at)}. Turn it on again from here.`;
}
