import { useEffect, useRef, useState } from 'react';
import { type CloudOAuthProvider, type CloudStatus, cloudError } from '@nekko-agent/shared';
import { NekkoAvatar } from '../Mascot.js';
import './cloud.css';

/**
 * Sign in to Nekko Cloud: GitHub, Google or Apple in the browser, or a code
 * emailed to you. Supabase Auth checks who you are; the engine keeps the
 * resulting device token, and the renderer never sees it.
 */
export function CloudSignIn({ status, onClose }: { status: CloudStatus | null; onClose: () => void }) {
  const [step, setStep] = useState<'start' | 'code'>('start');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<'' | 'email' | 'code' | CloudOAuthProvider>('');
  const [error, setError] = useState('');
  const [resendIn, setResendIn] = useState(0);

  // Signed in (from here or from the browser callback): done.
  useEffect(() => {
    if (status?.signedIn) onClose();
  }, [status?.signedIn, onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const close = () => {
    if (status?.oauthPending) void window.nekko.cloudCancelOAuth().catch(() => {});
    onClose();
  };

  const run = async (what: typeof busy, work: () => Promise<unknown>) => {
    setError('');
    setBusy(what);
    try { await work(); } catch (e) { setError(cloudError(e)); } finally { setBusy(''); }
  };

  const sendCode = () => run('email', async () => {
    await window.nekko.cloudSendCode(email.trim());
    setStep('code');
    setResendIn(30);
  });

  const oauth = (provider: CloudOAuthProvider) => run(provider, async () => {
    const { authUrl } = await window.nekko.cloudBeginOAuth(provider);
    await window.nekko.openPath(authUrl);
  });

  const waitingForBrowser = !!status?.oauthPending;

  return (
    <div className="cloud-signin-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="cloud-signin" role="dialog" aria-modal="true" aria-labelledby="cloud-signin-title" data-testid="cloud-signin">
        <button className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-lg text-ink-faint hover:bg-surface-2 hover:text-ink" aria-label="Close" onClick={close}>
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl" style={{ background: 'var(--accent-soft)' }}><NekkoAvatar size={36} /></div>
        {step === 'start' ? (
          <>
            <h1 id="cloud-signin-title">Sign in to Nekko Cloud</h1>
            <p className="cloud-lede">Keep your chats on every device, end-to-end encrypted. Nekko Labs can't read them.</p>
            {waitingForBrowser ? (
              <div className="mt-6 rounded-xl border border-line p-4 text-center" role="status">
                <div className="mx-auto mb-3 h-5 w-5 animate-spin rounded-full border-2 border-(--accent) border-t-transparent" />
                <p className="text-sm text-ink">Finish signing in in your browser.</p>
                <p className="mt-1 text-xs text-ink-faint">This window updates by itself when you're done.</p>
                <button className="btn btn-outline mt-3 py-1! text-xs!" onClick={() => void window.nekko.cloudCancelOAuth()}>Cancel</button>
              </div>
            ) : (
              <div className="mt-6 space-y-2.5">
                <button className="cloud-provider" disabled={!!busy} onClick={() => void oauth('github')} data-testid="cloud-github"><GitHubMark /> Continue with GitHub</button>
                <button className="cloud-provider" disabled={!!busy} onClick={() => void oauth('google')} data-testid="cloud-google"><GoogleMark /> Continue with Google</button>
                <button className="cloud-provider" disabled={!!busy} onClick={() => void oauth('apple')} data-testid="cloud-apple"><AppleMark /> Continue with Apple</button>
              </div>
            )}
            <div className="cloud-or">or</div>
            <form onSubmit={(e) => { e.preventDefault(); void sendCode(); }} className="space-y-2.5">
              <input className="input w-full" type="email" autoComplete="email" placeholder="you@example.com" aria-label="Email"
                value={email} onChange={(e) => setEmail(e.target.value)} data-testid="cloud-email" />
              <button className="btn btn-primary w-full" type="submit" disabled={!!busy || !/\S+@\S+\.\S+/.test(email)} data-testid="cloud-send-code">
                {busy === 'email' ? 'Sending…' : 'Email me a sign-in code'}
              </button>
            </form>
          </>
        ) : (
          <CodeStep email={email} busy={busy === 'code'} resendIn={resendIn}
            onVerify={(code) => run('code', () => window.nekko.cloudVerifyCode(email.trim(), code))}
            onResend={() => void sendCode()}
            onBack={() => { setStep('start'); setError(''); }} />
        )}
        {error && <p role="alert" className="mt-3 text-center text-xs text-(--danger)">{error}</p>}
        <p className="cloud-fineprint">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="3" y="7" width="10" height="7" rx="2" stroke="currentColor" strokeWidth="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" strokeWidth="1.5" /></svg>
          <span>Your chats are encrypted on this device before they're uploaded, with keys that never leave your devices. Signing in only tells Nekko Cloud who you are.</span>
        </p>
      </div>
    </div>
  );
}

function CodeStep({ email, busy, resendIn, onVerify, onResend, onBack }: {
  email: string; busy: boolean; resendIn: number; onVerify: (code: string) => void; onResend: () => void; onBack: () => void;
}) {
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', '']);
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  useEffect(() => { refs.current[0]?.focus(); }, []);
  const code = digits.join('');
  useEffect(() => { if (code.length === 6 && !busy) onVerify(code); }, [code]); // eslint-disable-line react-hooks/exhaustive-deps

  const put = (i: number, value: string) => {
    const only = value.replace(/\D/g, '');
    if (only.length > 1) {
      // A pasted code fills every box.
      const next = only.slice(0, 6).split('');
      setDigits([...next, ...Array(6 - next.length).fill('')]);
      refs.current[Math.min(next.length, 5)]?.focus();
      return;
    }
    setDigits((d) => d.map((x, j) => (j === i ? only : x)));
    if (only && i < 5) refs.current[i + 1]?.focus();
  };

  return (
    <>
      <h1 id="cloud-signin-title">Check your email</h1>
      <p className="cloud-lede">We sent a 6-digit code to <strong className="text-ink">{email}</strong>.</p>
      <div className="cloud-otp mt-6" role="group" aria-label="Sign-in code">
        {digits.map((d, i) => (
          <input key={i} ref={(el) => { refs.current[i] = el; }} value={d} inputMode="numeric" autoComplete={i === 0 ? 'one-time-code' : 'off'}
            aria-label={`Digit ${i + 1}`} maxLength={i === 0 ? 6 : 1} disabled={busy} data-testid={`cloud-otp-${i}`}
            onChange={(e) => put(i, e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Backspace' && !d && i > 0) refs.current[i - 1]?.focus(); }} />
        ))}
      </div>
      <button className="btn btn-primary mt-5 w-full" disabled={busy || code.length < 6} onClick={() => onVerify(code)} data-testid="cloud-verify">
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <div className="mt-3 flex justify-between text-xs">
        <button className="text-ink-faint hover:text-ink-soft" onClick={onBack}>Use a different email</button>
        <button className="text-ink-faint hover:text-ink-soft disabled:opacity-50" disabled={resendIn > 0} onClick={onResend}>
          {resendIn > 0 ? `Send again in ${resendIn}s` : 'Send a new code'}
        </button>
      </div>
    </>
  );
}

function GitHubMark() {
  return <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" /></svg>;
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.72A5.41 5.41 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}

function AppleMark() {
  return <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11.18 8.5c-.02-1.66 1.36-2.46 1.42-2.5-.78-1.13-1.98-1.29-2.41-1.3-1.02-.1-2 .6-2.52.6-.53 0-1.32-.59-2.18-.57-1.12.02-2.15.65-2.73 1.65-1.17 2.02-.3 5 .84 6.64.56.8 1.22 1.7 2.08 1.67.84-.03 1.15-.54 2.16-.54 1 0 1.3.54 2.18.52.9-.01 1.47-.81 2.02-1.62.64-.93.9-1.83.91-1.88-.02 0-1.75-.67-1.77-2.67ZM9.53 3.63c.46-.56.77-1.33.68-2.1-.66.03-1.46.44-1.93 1-.42.48-.79 1.27-.69 2.02.73.06 1.48-.37 1.94-.92Z" /></svg>;
}
