import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  WEBAUTHN_CANCELLED,
  WEBAUTHN_CEREMONY_TIMEOUT_MS,
  stepUpEnableBlocker,
  stepUpEnableWarning,
  stepUpRefusalOf,
  type SecurityCredentialKind,
  type SecurityMethodAdded,
  type SecurityStatus,
  type SecurityTotpBegin,
} from '@nekko-agent/shared';
import { StatusDot } from '../primitives/index.js';
import { useStore } from '../../store.js';
import { askStepUpProof } from '../../stepUp.js';
import { pageRpId, platformPasskeyAvailable, webAuthnUnavailableReason } from '../../secureContext.js';
import { UntestedHardwareNote } from './UntestedHardwareNote.js';

/** The anchor the Remote access card's *Protect this computer* prompt scrolls to. */
export const SECURITY_SECTION_ID = 'settings-security-card';

/** The window API this component calls; narrowed so the key ceremony can be tested without a renderer. */
type SecurityApi = Pick<Window['nekko'], 'securityRegisterBegin' | 'securityRegisterKey' | 'webAuthnCeremony'>;

/**
 * Runs the WebAuthn *create* ceremony and registers what the key gave back.
 * Null when the owner cancelled the ceremony: nothing was registered, so the
 * caller keeps the name they typed (#2390). A refusal throws instead, to be
 * shown.
 */
export async function registerKey(api: SecurityApi, kind: SecurityCredentialKind, name: string): Promise<SecurityMethodAdded | null> {
  const begin = await api.securityRegisterBegin!(kind);
  const r = await api.webAuthnCeremony!({
    mode: 'create',
    rpName: begin.rpName,
    userId: begin.userId,
    userName: begin.userName,
    userDisplayName: begin.userDisplayName,
    challenge: begin.challenge,
    attachment: begin.attachment,
    excludeCredentials: begin.excludeCredentials.map((c) => c.id),
    timeoutMs: Math.min(begin.timeoutMs, WEBAUTHN_CEREMONY_TIMEOUT_MS),
  });
  if (!r.ok) {
    // Only the owner closing the window passes in silence: a key that never answered has something to say.
    if (r.cancelled && r.error === WEBAUTHN_CANCELLED) return null;
    throw new Error(r.error);
  }
  if (r.mode !== 'create') throw new Error('The key gave an unexpected answer.');
  return await api.securityRegisterKey!({ name, kind, rpId: r.rpId, id: r.id, clientDataJSON: r.clientDataJSON, attestationObject: r.attestationObject });
}

/**
 * Settings → Security (SK-4, SK-5): the second factors this computer accepts
 * for its guarded actions, registered and verified on this computer. Keys
 * and passkeys through WebAuthn, a one-time code app through a QR, ten
 * recovery codes shown once, and the switch that turns step-up on (with two
 * methods at least).
 */
export function SecuritySettings() {
  const api = window.nekko;
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [totp, setTotp] = useState<(SecurityTotpBegin & { qr: string }) | null>(null);
  const [phones, setPhones] = useState(0);

  const load = () => void api.securityStatus?.().then(setStatus).catch((e) => setError(String((e as Error)?.message ?? e)));
  useEffect(() => {
    load();
    void api.listRemoteDevices?.().then((d) => setPhones(d.filter((x) => !x.revoked).length)).catch(() => {});
  }, []);

  if (!api.securityStatus) return null;

  /** Run a change, showing what the computer said when it refuses. Returns false on a refusal. */
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(stepUpRefusalOf(e)?.message ?? String((e as Error)?.message ?? e).replace(/^Error:\s*/, ''));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const added = (r: SecurityMethodAdded) => {
    setStatus(r.status);
    if (r.recoveryCodes?.length) setCodes(r.recoveryCodes);
  };

  /** Registers a key. Resolves true only when the method was actually added, so the view keeps the typed name after a cancel or a refusal. */
  const addKey = async (kind: SecurityCredentialKind, name: string) => {
    let registered = false;
    const ok = await run(async () => {
      const r = await registerKey(api, kind, name);
      if (!r) return;
      added(r);
      registered = true;
    });
    return ok && registered;
  };

  const beginTotp = () =>
    run(async () => {
      const t = await api.securityTotpBegin!();
      setTotp({ ...t, qr: await QRCode.toDataURL(t.uri, { margin: 1, width: 200 }).catch(() => '') });
    });
  const confirmTotp = (code: string) =>
    run(async () => {
      added(await api.securityTotpConfirm!(code));
      setTotp(null);
    });

  const enable = () => {
    if (!status) return;
    const warning = stepUpEnableWarning(status, phones);
    if (warning && !confirm(`${warning}\n\nTurn on step-up anyway?`)) return;
    void run(async () => setStatus(await api.securityEnable!()));
  };
  const disable = async () => {
    const proof = await askStepUpProof('Turn off step-up');
    if (!proof) return;
    void run(async () => setStatus(await api.securityDisable!(proof)));
  };
  const remove = async (id: string, name: string) => {
    if (!confirm(`Remove “${name}” from this computer?`)) return;
    let proof = null;
    if (status?.enabled) {
      proof = await askStepUpProof(`Remove ${name}`, id);
      if (!proof) return;
    }
    void run(async () => setStatus(await api.securityRemoveMethod!(id, proof)));
  };
  const newCodes = () => {
    if (!confirm('Make ten new recovery codes? The ones you have now stop working.')) return;
    void run(async () => setCodes(await api.securityRecoveryCodes!()));
  };

  return (
    <SecuritySettingsView
      status={status}
      busy={busy}
      error={error}
      codes={codes}
      totp={totp}
      pairedPhones={phones}
      webAuthnBlocked={webAuthnUnavailableReason(window as never)}
      passkeys={platformPasskeyAvailable(window.nekkoChrome?.platform ?? (navigator.userAgent.includes('Linux') ? 'linux' : undefined))}
      rpId={pageRpId(window as never)}
      onAddKey={(kind, name) => addKey(kind, name)}
      onTotpBegin={() => void beginTotp()}
      onTotpConfirm={(code) => void confirmTotp(code)}
      onTotpCancel={() => setTotp(null)}
      onCodesSaved={() => setCodes(null)}
      onEnable={enable}
      onDisable={() => void disable()}
      onRemove={(id, name) => void remove(id, name)}
      onNewCodes={newCodes}
      onCopyCodes={(list) => {
        void navigator.clipboard?.writeText(list.join('\n')).then(() => useStore.getState().pushToast('info', 'Recovery codes copied'));
      }}
    />
  );
}

function when(ts: number | undefined, now: number): string {
  if (!ts) return 'never';
  const d = Math.floor((now - ts) / 86_400_000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  return new Date(ts).toLocaleDateString();
}

export function SecuritySettingsView(p: {
  status: SecurityStatus | null;
  busy?: boolean;
  error?: string | null;
  codes: string[] | null;
  totp: (SecurityTotpBegin & { qr: string }) | null;
  pairedPhones: number;
  webAuthnBlocked: string | null;
  passkeys: boolean;
  rpId: string;
  now?: number;
  /** Resolves true when the method was registered; false when the ceremony was cancelled or refused, and the name is kept. */
  onAddKey: (kind: SecurityCredentialKind, name: string) => boolean | Promise<boolean>;
  onTotpBegin: () => void;
  onTotpConfirm: (code: string) => void;
  onTotpCancel: () => void;
  onCodesSaved: () => void;
  onEnable: () => void;
  onDisable: () => void;
  onRemove: (id: string, name: string) => void;
  onNewCodes: () => void;
  onCopyCodes: (codes: string[]) => void;
}) {
  const [keyName, setKeyName] = useState('');
  const [code, setCode] = useState('');
  const s = p.status;
  const now = p.now ?? Date.now();
  const blocker = s ? stepUpEnableBlocker(s) : null;
  const warning = s ? stepUpEnableWarning(s, p.pairedPhones) : null;
  /** Clear the typed name only once the method is registered, so a cancelled or refused ceremony leaves it to try again with. */
  const add = async (kind: SecurityCredentialKind) => {
    if (await p.onAddKey(kind, keyName)) setKeyName('');
  };
  const methodRow = (id: string, title: string, detail: string, removeName: string, extra?: React.ReactNode) => (
    <li key={id} className="quiet-row min-h-(--q-row) gap-2 px-2!" data-method={id} data-quiet-row>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{title}</span>
        <span className="truncate text-xs text-ink-faint">{detail}</span>
      </span>
      {extra}
      <button className="btn btn-ghost quiet-row-action py-1 text-xs text-danger-text" onClick={() => p.onRemove(id, removeName)} disabled={p.busy}>
        Remove
      </button>
    </li>
  );
  return (
    <section id={SECURITY_SECTION_ID} data-shot="security-settings" className="mt-(--q-section) min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">Security</h2>
        {s && (
          <span className="inline-flex items-center gap-1.5 text-xs text-ink-soft">
            <StatusDot tone={s.enabled ? 'success' : 'neutral'} size={7} />
            {s.enabled ? 'Step-up on' : 'Step-up off'}
          </span>
        )}
      </div>
      <p className="mt-(--q-tight) text-xs text-ink-faint">Ask for a key, a passkey or a code before risky actions. This computer checks every answer itself.</p>
      <details className="mt-(--q-tight) text-xs text-ink-faint">
        <summary className="w-fit cursor-pointer transition-colors duration-(--dur-fast) hover:text-ink">Which actions</summary>
        <p className="mt-(--q-tight)">
          Turning on remote access, pairing a phone, signing phones out, changing what a phone may do, touching a provider key, and
          raising a chat to Ask when it matters or No restrictions from a phone. Nothing goes to Nekko Cloud.
        </p>
      </details>

      {s?.damaged && (
        <p className="mt-(--q-inline) text-xs text-danger-text">
          security.json can’t be read, so every guarded action is refused. Restore it, or remove it with access to this computer to start over.
        </p>
      )}
      {p.webAuthnBlocked && <p className="mt-(--q-inline) text-xs text-ink-soft" data-needs-https>{p.webAuthnBlocked}</p>}

      <div className="mt-(--q-group)">
        <div className="quiet-group-label mb-(--q-heading)">Methods</div>
        <ul className="-mx-2" aria-label="Registered methods">
          {(s?.methods ?? []).map((m) =>
            methodRow(
              m.id,
              m.name,
              `${m.kind === 'passkey' ? 'Passkey' : 'Security key'} · added ${when(m.addedAt, now)} · used ${when(m.lastUsedAt, now)}`,
              m.name,
              m.cloned ? (
                <span className="shrink-0 text-xs text-danger-text" title="Its signature counter went backwards: someone may have copied it. Remove it and register the key again.">
                  possibly cloned
                </span>
              ) : undefined,
            ),
          )}
          {s?.totp &&
            methodRow(
              'totp',
              'One-time code app',
              `Authenticator · added ${when(s.totp.addedAt, now)} · used ${when(s.totp.lastUsedAt, now)}`,
              'the one-time code app',
              s.totp.lockedUntil ? <span className="shrink-0 text-xs text-warning-text">locked for a minute after wrong codes</span> : undefined,
            )}
          {s && s.methods.length === 0 && !s.totp && <li className="px-2 py-(--q-inline) text-xs text-ink-faint">Nothing registered yet.</li>}
        </ul>

        <div className="mt-(--q-inline) flex flex-wrap items-center gap-2">
          <input
            className="quiet-field max-w-[200px] py-1.5 text-xs"
            placeholder="Name, e.g. YubiKey 5C"
            aria-label="Name for the new key"
            value={keyName}
            maxLength={60}
            onChange={(e) => setKeyName(e.target.value)}
          />
          <button className="btn btn-ghost py-1 text-xs" disabled={p.busy || !!p.webAuthnBlocked} onClick={() => void add('security-key')}>
            Add security key
          </button>
          {p.passkeys && (
            <button className="btn btn-ghost py-1 text-xs" disabled={p.busy || !!p.webAuthnBlocked} onClick={() => void add('passkey')}>
              Add passkey on this computer
            </button>
          )}
          {!s?.totp && !p.totp && (
            <button className="btn btn-ghost py-1 text-xs" disabled={p.busy} onClick={p.onTotpBegin}>
              Set up a one-time code app
            </button>
          )}
        </div>
        <details className="mt-(--q-tight) text-xs text-ink-faint">
          <summary className="w-fit cursor-pointer transition-colors duration-(--dur-fast) hover:text-ink">About keys</summary>
          <p className="mt-(--q-tight)">
            A key is registered per computer: touch it once on each computer you protect. Keys that hold only a few passkeys still work here,
            since this computer keeps the key’s id itself.{!p.passkeys && ' On Linux, use a security key: there is no built-in passkey.'}
            {p.rpId !== 'localhost' && ` Keys registered here work at ${p.rpId} only.`}
          </p>
        </details>
      </div>

      {p.totp && (
        <div data-shot="security-totp" className="mt-(--q-group) flex flex-col gap-4 sm:flex-row sm:items-center">
          {p.totp.qr && <img src={p.totp.qr} alt="One-time code QR" width={140} height={140} className="rounded-lg" />}
          <div className="min-w-0 text-xs">
            <div className="text-sm font-medium">Scan with an authenticator app, then type the code it shows.</div>
            <details className="mt-(--q-tight)">
              <summary className="w-fit cursor-pointer text-ink-faint transition-colors duration-(--dur-fast) hover:text-ink">Can’t scan? Type the key</summary>
              <code className="mt-(--q-tight) block break-all rounded-lg px-2 py-1 font-mono text-xs" style={{ background: 'var(--surface-2)' }}>
                {p.totp.secret}
              </code>
            </details>
            <form
              className="mt-(--q-inline) flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                p.onTotpConfirm(code);
                setCode('');
              }}
            >
              <input
                className="quiet-field max-w-[140px] py-1.5 font-mono tracking-widest"
                inputMode="numeric"
                autoComplete="one-time-code"
                aria-label="Code from the app"
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <button className="btn btn-primary py-1 text-xs" type="submit" disabled={p.busy || code.replace(/\D/g, '').length !== 6}>
                Confirm
              </button>
              <button className="btn btn-ghost py-1 text-xs" type="button" onClick={p.onTotpCancel}>
                Cancel
              </button>
            </form>
          </div>
        </div>
      )}

      {p.codes && (
        <div data-shot="security-recovery" className="mt-(--q-group) rounded-xl p-4" style={{ background: 'var(--warning-soft)' }} role="alert">
          <div className="text-sm font-medium">Save these recovery codes now</div>
          <p className="mt-(--q-tight) text-xs text-ink-soft">Each turns step-up off once, if every key and code app is lost. Shown only this once.</p>
          <ol className="mt-(--q-inline) grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-xs sm:grid-cols-5">
            {p.codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ol>
          <div className="mt-(--q-inline) flex gap-2">
            <button className="btn btn-ghost py-1 text-xs" onClick={() => p.onCopyCodes(p.codes!)}>
              Copy
            </button>
            <button className="btn btn-primary py-1 text-xs" onClick={p.onCodesSaved}>
              I saved them
            </button>
          </div>
        </div>
      )}

      {s && (
        <div className="mt-(--q-group)">
          <div className="quiet-group-label mb-(--q-heading)">When to ask</div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">Require a step-up</div>
              <p className="mt-(--q-tight) text-xs text-ink-faint">
                {s.enabled ? 'On. One confirmation covers the same kind of action for five minutes.' : blocker ?? 'Two methods are registered: you can turn it on.'}
              </p>
              {!s.enabled && !blocker && warning && <p className="mt-(--q-tight) text-xs text-warning-text">{warning}</p>}
              <p className="mt-(--q-tight) text-xs text-ink-faint">
                {s.recoveryLeft} recovery code{s.recoveryLeft === 1 ? '' : 's'} left.{' '}
                {(s.methods.length > 0 || s.totp) && (
                  <button className="text-accent hover:underline" onClick={p.onNewCodes} disabled={p.busy}>
                    Make new ones
                  </button>
                )}
              </p>
            </div>
            {s.enabled ? (
              <button className="btn btn-ghost py-1 text-xs" onClick={p.onDisable} disabled={p.busy}>
                Turn off…
              </button>
            ) : (
              <button className="btn btn-primary py-1 text-xs" onClick={p.onEnable} disabled={p.busy || !!blocker}>
                Turn on
              </button>
            )}
          </div>
        </div>
      )}

      {p.error && (
        <p className="mt-(--q-inline) text-xs text-danger-text" role="alert">
          {p.error}
        </p>
      )}
      <UntestedHardwareNote className="mt-(--q-group)" />
    </section>
  );
}
