import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  WEBAUTHN_CEREMONY_TIMEOUT_MS,
  stepUpEnableBlocker,
  stepUpEnableWarning,
  stepUpRefusalOf,
  type SecurityCredentialKind,
  type SecurityMethodAdded,
  type SecurityStatus,
  type SecurityTotpBegin,
} from '@nekko-agent/shared';
import { Badge } from '../primitives/index.js';
import { LockIcon } from '../../icons.js';
import { useStore } from '../../store.js';
import { askStepUpProof } from '../../stepUp.js';
import { pageRpId, platformPasskeyAvailable, webAuthnUnavailableReason } from '../../secureContext.js';
import { UntestedHardwareNote } from './UntestedHardwareNote.js';

/** The anchor the Remote access card's *Protect this computer* prompt scrolls to. */
export const SECURITY_SECTION_ID = 'settings-security-card';

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

  const addKey = (kind: SecurityCredentialKind, name: string) =>
    run(async () => {
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
        if (r.cancelled) return;
        throw new Error(r.error);
      }
      if (r.mode !== 'create') throw new Error('The key gave an unexpected answer.');
      added(await api.securityRegisterKey!({ name, kind, rpId: r.rpId, id: r.id, clientDataJSON: r.clientDataJSON, attestationObject: r.attestationObject }));
    });

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
      onAddKey={(kind, name) => void addKey(kind, name)}
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
  onAddKey: (kind: SecurityCredentialKind, name: string) => void;
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
  return (
    <section id={SECURITY_SECTION_ID} data-shot="security-settings" className="card mt-5 p-5">
      <div className="flex items-center gap-2">
        <LockIcon className="h-4 w-4" />
        <h2 className="font-semibold">Security</h2>
        {s && (
          <Badge tone={s.enabled ? 'success' : 'neutral'} variant="soft">
            {s.enabled ? 'Step-up on' : 'Step-up off'}
          </Badge>
        )}
      </div>
      <p className="mt-1 text-[12px] text-ink-faint">
        Ask for a security key, a passkey or a one-time code before anyone at this computer, or on a paired phone, turns on
        remote access, pairs a phone, signs phones out, changes what a phone may do, touches a provider key, or raises a
        chat to Guardrails or YOLO from a phone. This computer checks every answer itself; nothing goes to Nekko Cloud.
      </p>

      {s?.damaged && (
        <p className="mt-2 rounded border border-line px-2 py-1.5 text-[12px]" style={{ color: 'var(--danger)' }}>
          security.json can’t be read, so every guarded action is refused. Restore it, or remove it with access to this computer to start over.
        </p>
      )}
      {p.webAuthnBlocked && <p className="mt-2 rounded border border-line px-2 py-1.5 text-[12px] text-ink-soft" data-needs-https>{p.webAuthnBlocked}</p>}

      {/* Registered methods */}
      <ul className="mt-3 divide-y divide-line rounded-lg border border-line" aria-label="Registered methods">
        {(s?.methods ?? []).map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[12.5px]" data-method={m.id}>
            <span aria-hidden>{m.kind === 'passkey' ? '👤' : '🔑'}</span>
            <span className="font-medium">{m.name}</span>
            <span className="text-ink-faint">{m.kind === 'passkey' ? 'Passkey' : 'Security key'}</span>
            {m.cloned && (
              <Badge tone="danger" variant="soft" title="Its signature counter went backwards: someone may have copied it. Remove it and register the key again.">
                possibly cloned
              </Badge>
            )}
            <span className="ml-auto text-ink-faint">added {when(m.addedAt, now)} · used {when(m.lastUsedAt, now)}</span>
            <button className="btn btn-ghost py-0.5 text-[12px]" style={{ color: 'var(--danger)' }} onClick={() => p.onRemove(m.id, m.name)} disabled={p.busy}>
              Remove
            </button>
          </li>
        ))}
        {s?.totp && (
          <li className="flex flex-wrap items-center gap-2 px-3 py-2 text-[12.5px]" data-method="totp">
            <span aria-hidden>🔢</span>
            <span className="font-medium">One-time code app</span>
            {s.totp.lockedUntil ? <Badge tone="warning" variant="soft">locked for a minute after wrong codes</Badge> : null}
            <span className="ml-auto text-ink-faint">added {when(s.totp.addedAt, now)} · used {when(s.totp.lastUsedAt, now)}</span>
            <button className="btn btn-ghost py-0.5 text-[12px]" style={{ color: 'var(--danger)' }} onClick={() => p.onRemove('totp', 'the one-time code app')} disabled={p.busy}>
              Remove
            </button>
          </li>
        )}
        {s && s.methods.length === 0 && !s.totp && <li className="px-3 py-2 text-[12px] text-ink-faint">Nothing registered yet.</li>}
      </ul>

      {/* Add a method */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          className="input max-w-[200px] py-1.5 text-[12.5px]"
          placeholder="Name, e.g. YubiKey 5C"
          aria-label="Name for the new key"
          value={keyName}
          maxLength={60}
          onChange={(e) => setKeyName(e.target.value)}
        />
        <button className="btn btn-outline py-1.5 text-[12.5px]" disabled={p.busy || !!p.webAuthnBlocked} onClick={() => { p.onAddKey('security-key', keyName); setKeyName(''); }}>
          Add security key
        </button>
        {p.passkeys && (
          <button className="btn btn-outline py-1.5 text-[12.5px]" disabled={p.busy || !!p.webAuthnBlocked} onClick={() => { p.onAddKey('passkey', keyName); setKeyName(''); }}>
            Add passkey on this computer
          </button>
        )}
        {!s?.totp && !p.totp && (
          <button className="btn btn-outline py-1.5 text-[12.5px]" disabled={p.busy} onClick={p.onTotpBegin}>
            Set up a one-time code app
          </button>
        )}
      </div>
      <p className="mt-1 text-[11.5px] text-ink-faint">
        A key is registered per computer: touch it once on each computer you protect. Keys that hold only a few
        passkeys still work here, since this computer keeps the key’s id itself.{!p.passkeys && ' On Linux, use a security key: there is no built-in passkey.'}
        {p.rpId !== 'localhost' && ` Keys registered here work at ${p.rpId} only.`}
      </p>

      {/* TOTP setup: the QR, shown once */}
      {p.totp && (
        <div data-shot="security-totp" className="mt-3 flex flex-col gap-3 rounded-lg border border-line p-3 sm:flex-row sm:items-center">
          {p.totp.qr && <img src={p.totp.qr} alt="One-time code QR" width={140} height={140} className="rounded-lg border border-line" />}
          <div className="min-w-0 text-[12.5px]">
            <div className="font-medium">Scan with an authenticator app, then type the code it shows.</div>
            <details className="mt-1">
              <summary className="cursor-pointer text-[12px] text-ink-faint">Can’t scan? Type the key</summary>
              <code className="mt-1 block break-all rounded px-2 py-1 font-mono text-[11.5px]" style={{ background: 'var(--surface-2)' }}>
                {p.totp.secret}
              </code>
            </details>
            <form
              className="mt-2 flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                p.onTotpConfirm(code);
                setCode('');
              }}
            >
              <input
                className="input max-w-[140px] py-1.5 font-mono tracking-widest"
                inputMode="numeric"
                autoComplete="one-time-code"
                aria-label="Code from the app"
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <button className="btn btn-primary py-1.5 text-[12.5px]" type="submit" disabled={p.busy || code.replace(/\D/g, '').length !== 6}>
                Confirm
              </button>
              <button className="btn btn-ghost py-1.5 text-[12px]" type="button" onClick={p.onTotpCancel}>
                Cancel
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Recovery codes: shown once */}
      {p.codes && (
        <div data-shot="security-recovery" className="mt-3 rounded-lg border p-3" style={{ borderColor: 'var(--warning)' }} role="alert">
          <div className="text-[13px] font-medium">Save these recovery codes now</div>
          <p className="mt-0.5 text-[12px] text-ink-faint">
            Each one turns step-up off once, when every key and code app is lost. They are shown only this once, and
            Nekko Labs can’t reset step-up for you.
          </p>
          <ol className="mt-2 grid grid-cols-2 gap-x-6 gap-y-0.5 font-mono text-[12.5px] sm:grid-cols-5">
            {p.codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ol>
          <div className="mt-2 flex gap-2">
            <button className="btn btn-outline py-1 text-[12px]" onClick={() => p.onCopyCodes(p.codes!)}>
              Copy
            </button>
            <button className="btn btn-primary py-1 text-[12px]" onClick={p.onCodesSaved}>
              I saved them
            </button>
          </div>
        </div>
      )}

      {/* The switch */}
      {s && (
        <div className="mt-4 flex flex-wrap items-start justify-between gap-3 rounded-md border border-line p-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">Require a step-up</div>
            <p className="mt-0.5 text-[12px] text-ink-faint">
              {s.enabled
                ? 'On. One confirmation covers the same kind of action here for five minutes. Turning it off needs a method or a recovery code.'
                : blocker ?? 'Two methods are registered: you can turn it on.'}
            </p>
            {!s.enabled && !blocker && warning && <p className="mt-1 text-[12px]" style={{ color: 'var(--warning)' }}>{warning}</p>}
            <p className="mt-1 text-[11.5px] text-ink-faint">
              {s.recoveryLeft} recovery code{s.recoveryLeft === 1 ? '' : 's'} left.{' '}
              {(s.methods.length > 0 || s.totp) && (
                <button className="underline" onClick={p.onNewCodes} disabled={p.busy}>
                  Make new ones
                </button>
              )}
            </p>
          </div>
          {s.enabled ? (
            <button className="btn btn-outline py-1.5 text-[12.5px]" onClick={p.onDisable} disabled={p.busy}>
              Turn off…
            </button>
          ) : (
            <button className="btn btn-primary py-1.5 text-[12.5px]" onClick={p.onEnable} disabled={p.busy || !!blocker}>
              Turn on
            </button>
          )}
        </div>
      )}

      {p.error && (
        <p className="mt-2 text-[12px]" style={{ color: 'var(--danger)' }} role="alert">
          {p.error}
        </p>
      )}
      <UntestedHardwareNote className="mt-3" />
    </section>
  );
}
