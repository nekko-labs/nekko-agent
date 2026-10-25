import React, { useEffect, useState } from 'react';
import {
  STEP_UP_ACTION_LABELS,
  WEBAUTHN_CEREMONY_TIMEOUT_MS,
  stepUpRefusalOf,
  type DesktopStepUpChallenge,
  type DesktopStepUpProof,
} from '@nekko-agent/shared';
import { Modal } from '../primitives/index.js';
import { settleStepUp, useStepUp, type StepUpAsk } from '../../stepUp.js';
import { pageRpId, webAuthnUnavailableReason } from '../../secureContext.js';
import { UntestedHardwareNote } from './UntestedHardwareNote.js';

/**
 * The step-up sheet (SK-4, SK-5): *Confirm with your security key*, a
 * *Use a code* fallback, and (turning step-up off or removing a method) a
 * recovery code. Opens on any guarded call the computer refused
 * `step-up-required`; the computer checks the answer, and says which key
 * answered. Cancel leaves everything as it was.
 */
export function StepUpSheet() {
  const ask = useStepUp((s) => s.current);
  if (!ask) return null;
  return <StepUpSheetHost key={ask.id} ask={ask} />;
}

type Phase = 'idle' | 'key' | 'checking' | 'done';
type Entry = 'code' | 'recovery' | null;

/** The keys this page can ask: registered under its own relying-party id, and not the one being removed. */
export function usableKeys(challenge: DesktopStepUpChallenge | null, rpId: string, not?: string | null) {
  return (challenge?.credentials ?? []).filter((c) => (c.rpId ?? '') === rpId && c.id !== not);
}

function StepUpSheetHost({ ask }: { ask: StepUpAsk }) {
  const api = window.nekko;
  const [challenge, setChallenge] = useState<DesktopStepUpChallenge | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [entry, setEntry] = useState<Entry>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [answered, setAnswered] = useState<string | null>(null);
  const not = ask.mode === 'proof' ? ask.not : null;
  const rpId = pageRpId(window as never);
  const blocked = webAuthnUnavailableReason(window as never);

  useEffect(() => {
    void api.securityChallenge?.().then(setChallenge).catch((e) => setError(String((e as Error)?.message ?? e)));
  }, []);

  const keys = usableKeys(challenge, rpId, not);
  const cancel = () => settleStepUp(ask.id, ask.mode === 'cover' ? false : null);

  const finish = async (proof: DesktopStepUpProof, keyName: string | null) => {
    if (ask.mode === 'proof') {
      setAnswered(keyName);
      setPhase('done');
      setTimeout(() => settleStepUp(ask.id, proof), keyName ? 700 : 0);
      return;
    }
    setPhase('checking');
    try {
      const r = await api.securityConfirm!(ask.action ?? '', proof);
      setAnswered(r.name ?? keyName);
      setPhase('done');
      setTimeout(() => settleStepUp(ask.id, true), 900);
    } catch (e) {
      setError(stepUpRefusalOf(e)?.message ?? String((e as Error)?.message ?? e));
      setPhase('idle');
      setCode('');
    }
  };

  const useKey = async () => {
    setError(null);
    setPhase('key');
    try {
      // Each answer spends its challenge: a fresh one for every try.
      const c = await api.securityChallenge!();
      setChallenge(c);
      const allow = usableKeys(c, rpId, not);
      const r = await api.webAuthnCeremony!({ mode: 'get', challenge: c.challenge, allowCredentials: allow.map((k) => k.id), timeoutMs: WEBAUTHN_CEREMONY_TIMEOUT_MS });
      if (!r.ok || r.mode !== 'get') {
        setError(r.ok ? 'The key gave an unexpected answer.' : r.error);
        setPhase('idle');
        return;
      }
      const name = allow.find((k) => k.id === r.credentialId)?.name ?? null;
      await finish({ credentialId: r.credentialId, authenticatorData: r.authenticatorData, clientDataJSON: r.clientDataJSON, signature: r.signature }, name);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setPhase('idle');
    }
  };

  const submitCode = () => {
    setError(null);
    if (entry === 'recovery') void finish({ recovery: code.trim() }, null);
    else void finish({ totp: code.replace(/\D/g, '') }, null);
  };

  const title = ask.mode === 'cover' ? 'Confirm with your security key' : ask.title;
  const what = ask.mode === 'cover' ? STEP_UP_ACTION_LABELS[(ask.action ?? '') as keyof typeof STEP_UP_ACTION_LABELS] ?? null : STEP_UP_ACTION_LABELS.stepUpOff;
  return (
    <Modal title={title} onClose={cancel} closeOnScrimClick={false} zIndex={80}>
      <StepUpSheetView
        title={title}
        what={what}
        message={ask.mode === 'cover' ? ask.message : not ? 'Use a different method than the one you are removing, or a recovery code.' : 'Use any registered method, or a recovery code.'}
        loading={!challenge && !error}
        keyNames={keys.map((k) => k.name)}
        keysElsewhere={(challenge?.credentials.length ?? 0) > 0 && keys.length === 0 && !not}
        blocked={blocked}
        totp={!!challenge?.totp && not !== 'totp'}
        recovery={ask.mode === 'proof' && !!challenge?.recovery}
        phase={phase}
        entry={entry}
        code={code}
        error={error}
        answered={answered}
        onUseKey={() => void useKey()}
        onEntry={(e) => { setEntry(e); setCode(''); setError(null); }}
        onCode={setCode}
        onSubmitCode={submitCode}
        onCancel={cancel}
      />
    </Modal>
  );
}

export function StepUpSheetView(p: {
  title: string;
  what: string | null;
  message: string;
  loading?: boolean;
  keyNames: string[];
  /** Keys exist, but none registered for this page's address. */
  keysElsewhere?: boolean;
  blocked: string | null;
  totp: boolean;
  recovery: boolean;
  phase: Phase;
  entry: Entry;
  code: string;
  error: string | null;
  answered: string | null;
  onUseKey: () => void;
  onEntry: (e: Entry) => void;
  onCode: (c: string) => void;
  onSubmitCode: () => void;
  onCancel: () => void;
}) {
  const busy = p.phase === 'key' || p.phase === 'checking';
  const canKey = p.keyNames.length > 0 && !p.blocked;
  return (
    <div data-shot="step-up-sheet" className="card w-[420px] max-w-[92vw] p-5" style={{ background: 'var(--surface)' }}>
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-[18px]">🔑</span>
        <h2 className="font-semibold">{p.title}</h2>
      </div>
      {p.what && <p className="mt-2 text-[13px] text-ink-soft">{p.what}</p>}
      <p className="mt-1 text-[12px] text-ink-faint">{p.message}</p>

      {p.phase === 'done' ? (
        <p className="mt-4 text-[13px]" style={{ color: 'var(--success)' }} role="status">
          {p.answered ? `Confirmed with ${p.answered}.` : 'Confirmed.'}
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {p.loading && <p className="text-[12px] text-ink-faint">Checking which methods this computer has…</p>}
          {canKey && p.entry === null && (
            <div>
              <button className="btn btn-primary py-1.5 text-[13px]" onClick={p.onUseKey} disabled={busy}>
                {p.phase === 'key' ? 'Touch your key…' : p.phase === 'checking' ? 'Checking…' : 'Use security key'}
              </button>
              <p className="mt-1 text-[11.5px] text-ink-faint">
                {p.keyNames.length === 1 ? p.keyNames[0] : `${p.keyNames.slice(0, -1).join(', ')} or ${p.keyNames.at(-1)}`}. Insert or tap it, then touch it.
              </p>
            </div>
          )}
          {p.blocked && p.keyNames.length > 0 && <p className="text-[12px] text-ink-soft">{p.blocked}</p>}
          {p.keysElsewhere && !p.blocked && (
            <p className="text-[12px] text-ink-soft">Your keys were registered from another address of this computer, so this page can’t use them. Use a code.</p>
          )}
          {p.entry !== null ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                p.onSubmitCode();
              }}
            >
              <input
                className="input max-w-[200px] py-1.5 font-mono text-[14px] tracking-widest"
                autoFocus
                inputMode={p.entry === 'code' ? 'numeric' : 'text'}
                autoComplete="one-time-code"
                aria-label={p.entry === 'code' ? 'Six-digit code' : 'Recovery code'}
                placeholder={p.entry === 'code' ? '123456' : 'xxxxx-xxxxx'}
                value={p.code}
                onChange={(e) => p.onCode(e.target.value)}
              />
              <button className="btn btn-primary py-1.5 text-[12.5px]" type="submit" disabled={busy || !p.code.trim()}>
                {p.phase === 'checking' ? 'Checking…' : 'Confirm'}
              </button>
              <button className="btn btn-ghost py-1.5 text-[12px]" type="button" onClick={() => p.onEntry(null)}>Back</button>
            </form>
          ) : (
            <div className="flex flex-wrap gap-3 text-[12.5px]">
              {p.totp && <button className="underline" onClick={() => p.onEntry('code')} disabled={busy}>Use a code</button>}
              {p.recovery && <button className="underline" onClick={() => p.onEntry('recovery')} disabled={busy}>Use a recovery code</button>}
            </div>
          )}
          {p.error && <p className="text-[12px]" style={{ color: 'var(--danger)' }} role="alert">{p.error}</p>}
        </div>
      )}

      <div className="mt-4 flex items-end justify-between gap-3">
        <UntestedHardwareNote className="max-w-[300px]" />
        {p.phase !== 'done' && <button className="btn btn-ghost py-1.5 text-[12.5px]" onClick={p.onCancel}>Cancel</button>}
      </div>
    </div>
  );
}
