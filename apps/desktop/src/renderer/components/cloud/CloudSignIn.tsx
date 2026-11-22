import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type BillingPlan, type CloudOAuthProvider, type CloudStatus, cloudError } from '@nekko-agent/shared';
import { CloudWelcomeScene, type WelcomeScene } from './CloudWelcomeScene.js';
import { PlanStep, TestCheckout } from './CloudWelcomePlan.js';
import { RecoveryKeySteps } from './RecoveryKeyDialog.js';
import { planLabel } from './PlanAndBilling.js';
import './cloud.css';

/** An emailed sign-in code waiting to be typed. */
export interface PendingCode { email: string; sentAt: number }

const RESEND_AFTER_S = 30;
/** Matches the Supabase project's email code lifetime (10 minutes); an older code is no use, so the window starts over. */
export const CODE_LIFETIME_MS = 10 * 60_000;
/** Set once this device has signed in to Nekko Cloud: later sign-ins skip the Welcome step. */
export const WELCOMED_KEY = 'nekko.cloud.welcomed';

export function hasBeenWelcomed() {
  try { return localStorage.getItem(WELCOMED_KEY) === '1'; } catch { return false; }
}

type Step = 'welcome' | 'account' | 'in' | 'plan' | 'checkout' | 'stripe' | 'sync' | 'done';
type SyncState = { state: 'working' } | { state: 'key'; key: string } | { state: 'join' } | { state: 'on' } | { state: 'error'; message: string };
const PROVIDER_NAMES: Record<CloudOAuthProvider, string> = { github: 'GitHub', google: 'Google', apple: 'Apple' };
const SYNCING = ['idle', 'syncing', 'paused', 'error'];

/**
 * Sign in to Nekko Cloud, as a walkthrough (#3187,
 * nekko-designs/cloud-welcome-walkthrough-design.html): Welcome (the first
 * time on this device, or Create an account), Account (GitHub, Google, Apple
 * or an emailed code), You're in, Choose a plan, Sync with the recovery key,
 * All set. One frosted window whose picture morphs from step to step.
 *
 * Supabase Auth checks who you are; the engine keeps the resulting device
 * token, and the renderer never sees it. A code already sent lives in the
 * parent (`pending`), so closing this window and opening it again goes
 * straight back to typing that code.
 *
 * Billing is test mode until it is switched on for the account: Pro goes
 * through `TestCheckout`, which charges nothing and changes no plan. With
 * billing on, Pro opens the real Stripe Checkout in the browser.
 */
export function CloudSignIn({ status, pending, onPending, onClose, start = 'account' }: {
  status: CloudStatus | null; pending: PendingCode | null; onPending: (p: PendingCode | null) => void; onClose: () => void;
  /** `welcome` the first time on this device and for Create an account; `account` to sign in straight away. */
  start?: 'welcome' | 'account';
}) {
  const firstRun = start === 'welcome';
  const [step, setStepRaw] = useState<Step>(pending ? 'account' : start);
  const [dir, setDir] = useState<'fwd' | 'back'>('fwd');
  const [intent, setIntent] = useState<'create' | 'signin'>(firstRun ? 'create' : 'signin');
  const [sub, setSub] = useState<'start' | 'code'>(pending ? 'code' : 'start');
  const [email, setEmail] = useState(pending?.email ?? '');
  const [busy, setBusy] = useState<'' | 'email' | 'code' | 'checkout' | CloudOAuthProvider>('');
  const [error, setError] = useState('');
  const [resendIn, setResendIn] = useState(pending ? Math.max(0, RESEND_AFTER_S - Math.floor((Date.now() - pending.sentAt) / 1000)) : 0);
  const [oauth, setOAuth] = useState<{ provider: CloudOAuthProvider; url: string } | null>(null);
  const [plan, setPlan] = useState<BillingPlan | null>(null);
  const [testPro, setTestPro] = useState(false);
  const [checkout, setCheckout] = useState<'ready' | 'paying' | 'paid'>('ready');
  const [sync, setSync] = useState<SyncState | null>(null);
  const [keyConfirmed, setKeyConfirmed] = useState(false);
  // Whether this account needed a plan when it signed in; fixes the step dots from then on.
  const [planNeeded, setPlanNeeded] = useState<boolean | null>(null);

  const go = (next: Step, d: 'fwd' | 'back' = 'fwd') => { setDir(d); setError(''); setStepRaw(next); };
  const signedIn = !!status?.signedIn;
  const canSync = !!status?.account?.canSync;
  const phase = status?.sync.phase ?? 'signed-out';

  // Signed in (from here or from the browser callback): on to You're in.
  useEffect(() => {
    if (!signedIn || (step !== 'welcome' && step !== 'account')) return;
    try { localStorage.setItem(WELCOMED_KEY, '1'); } catch { /* private window: Welcome shows again next time */ }
    setPlanNeeded(!canSync);
    go('in');
  }, [signedIn]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  // Paying on Stripe: look again whenever this window comes back, and move on once the plan syncs.
  useEffect(() => {
    if (step !== 'stripe') return;
    const refresh = () => { void window.nekko.cloudRefresh().catch(() => {}); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [step]);
  useEffect(() => { if (step === 'stripe' && canSync) go('sync'); }, [step, canSync]); // eslint-disable-line react-hooks/exhaustive-deps

  // The Sync step turns sync on for this computer, which makes the recovery key.
  useEffect(() => {
    if (step !== 'sync' || sync) return;
    if (SYNCING.includes(phase)) { setSync({ state: 'on' }); go('done'); return; }
    if (phase === 'needs-join' || phase === 'awaiting-approval') { setSync({ state: 'join' }); return; }
    void turnOnSync();
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  const turnOnSync = async () => {
    setSync({ state: 'working' });
    try {
      const r = await window.nekko.syncTurnOn();
      if (r.recoveryKey) setSync({ state: 'key', key: r.recoveryKey });
      else { setSync({ state: 'on' }); go('done'); }
    } catch (e) {
      if (String(e).includes('needs-join')) setSync({ state: 'join' });
      else setSync({ state: 'error', message: cloudError(e) });
    }
  };

  const close = () => {
    if (status?.oauthPending) void window.nekko.cloudCancelOAuth().catch(() => {});
    onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const run = async (what: typeof busy, work: () => Promise<unknown>) => {
    setError('');
    setBusy(what);
    try { await work(); } catch (e) { setError(cloudError(e)); } finally { setBusy(''); }
  };

  const sendCode = () => run('email', async () => {
    await window.nekko.cloudSendCode(email.trim());
    onPending({ email: email.trim(), sentAt: Date.now() });
    setDir('fwd');
    setSub('code');
    setResendIn(RESEND_AFTER_S);
  });

  const beginOAuth = (provider: CloudOAuthProvider) => run(provider, async () => {
    const { authUrl } = await window.nekko.cloudBeginOAuth(provider);
    setOAuth({ provider, url: authUrl });
    await window.nekko.openPath(authUrl);
  });

  const afterPlan = () => go(canSync ? 'sync' : 'done');
  const afterIn = () => go(planNeeded ? 'plan' : canSync ? 'sync' : 'done');

  const startStripe = (p: BillingPlan) => run('checkout', async () => {
    setPlan(p);
    const { url } = await window.nekko.cloudBillingCheckout('pro');
    await window.nekko.openPath(url);
    go('stripe');
  });

  // What the picture shows.
  const waitingForBrowser = step === 'account' && !!status?.oauthPending;
  const syncOn = sync?.state === 'on' || sync?.state === 'key' || (signedIn && SYNCING.includes(phase));
  const scene: WelcomeScene | null =
    step === 'welcome' ? 'welcome'
      : step === 'account' ? (waitingForBrowser ? 'browser' : sub === 'code' ? 'code' : 'account')
        : step === 'in' ? 'in'
          : step === 'plan' || step === 'stripe' ? 'plan'
            : step === 'sync' ? 'sync'
              : step === 'done' ? (syncOn ? 'done' : 'in')
                : null;

  // The step dots, first run only.
  const dots: Step[] = [
    'welcome', 'account',
    ...((planNeeded ?? true) ? ['plan' as Step] : []),
    ...((planNeeded === null || canSync) ? ['sync' as Step] : []),
    'done',
  ];
  const dotFor: Step = step === 'in' ? dots[dots.indexOf('account') + 1]! : step === 'checkout' || step === 'stripe' ? 'plan' : step;
  const dotIndex = dots.indexOf(dotFor);

  const back = (): (() => void) | null => {
    if (step === 'account' && sub === 'code') return () => { onPending(null); setDir('back'); setSub('start'); setError(''); };
    if (step === 'account' && waitingForBrowser) return null;
    if (step === 'account' && firstRun) return () => go('welcome', 'back');
    if ((step === 'checkout' && checkout === 'ready') || step === 'stripe') return () => go('plan', 'back');
    return null;
  };
  const onBack = back();
  const stepKey = `${step}:${sub}:${waitingForBrowser}`;

  return (
    <div className="cloud-signin-backdrop cw-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="cloud-signin cw" role="dialog" aria-modal="true" aria-labelledby="cw-title" data-testid="cloud-signin" data-step={step}>
        <button className="cw-close absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-lg text-ink-faint hover:bg-surface-2 hover:text-ink" aria-label="Close" onClick={close} data-testid="cw-close">
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
        <AutoHeight>
          <div className={`cw-scene${scene === 'plan' ? ' is-compact' : ''}${scene ? '' : ' is-hidden'}`}>
            <CloudWelcomeScene scene={scene ?? 'plan'} />
          </div>
          <div key={stepKey} className={`cw-body-in${dir === 'back' ? ' is-back' : ''}`}>
            {step === 'welcome' && (
              <>
                <h1 id="cw-title">Your Nekko, on every device</h1>
                <p className="cloud-lede">One account keeps your chats in step on your computers and iPhone, end-to-end encrypted.</p>
                <div className="cw-stagger mt-(--q-group) flex flex-col gap-2">
                  <button className="btn btn-primary w-full" onClick={() => { setIntent('create'); go('account'); }} data-testid="cw-create">Create your account</button>
                  <button className="btn btn-ghost w-full text-ink-soft! text-xs!" onClick={() => { setIntent('signin'); go('account'); }} data-testid="cw-have-account">I already have an account</button>
                </div>
              </>
            )}

            {step === 'account' && waitingForBrowser && (
              <>
                <h1 id="cw-title">Finish in your browser</h1>
                <p className="cloud-lede" role="status">We opened {oauth ? PROVIDER_NAMES[oauth.provider] : 'the sign-in page'} in your browser. This window moves on by itself when you're done.</p>
                <div className="cw-stagger mt-(--q-group) flex flex-col gap-2">
                  {oauth && <button className="btn btn-ghost w-full" onClick={() => void window.nekko.openPath(oauth.url)}>Open the page again</button>}
                  <button className="btn btn-ghost w-full text-ink-soft! text-xs!" onClick={() => void window.nekko.cloudCancelOAuth()} data-testid="cw-oauth-cancel">Use another way</button>
                </div>
              </>
            )}

            {step === 'account' && !waitingForBrowser && sub === 'start' && (
              <>
                <h1 id="cw-title">{intent === 'create' ? 'Create your account' : 'Sign in to Nekko Cloud'}</h1>
                <p className="cloud-lede">{intent === 'create' ? 'Pick how you\'d like to sign in. It\'s the same for signing in later.' : 'Keep your chats on every device, end-to-end encrypted. Nekko Labs can\'t read them.'}</p>
                <div className="cw-stagger mt-(--q-group) space-y-2">
                  <button className="cloud-provider" disabled={!!busy} onClick={() => void beginOAuth('github')} data-testid="cloud-github"><GitHubMark /> Continue with GitHub</button>
                  <button className="cloud-provider" disabled={!!busy} onClick={() => void beginOAuth('google')} data-testid="cloud-google"><GoogleMark /> Continue with Google</button>
                  <button className="cloud-provider" disabled={!!busy} onClick={() => void beginOAuth('apple')} data-testid="cloud-apple"><AppleMark /> Continue with Apple</button>
                </div>
                <div className="cloud-or">or</div>
                <form onSubmit={(e) => { e.preventDefault(); void sendCode(); }} className="space-y-2">
                  <input className="input w-full" type="email" autoComplete="email" placeholder="you@example.com" aria-label="Email"
                    value={email} onChange={(e) => setEmail(e.target.value)} data-testid="cloud-email" />
                  <button className={`btn ${validEmail(email) ? 'btn-primary' : 'btn-ghost'} w-full`} type="submit" disabled={!!busy || !validEmail(email)} data-testid="cloud-send-code">
                    {busy === 'email' ? 'Sending…' : 'Email me a sign-in code'}
                  </button>
                </form>
              </>
            )}

            {step === 'account' && !waitingForBrowser && sub === 'code' && (
              <CodeStep email={email} busy={busy === 'code'} resendIn={resendIn}
                onVerify={(code) => run('code', () => window.nekko.cloudVerifyCode(email.trim(), code))}
                onResend={() => void sendCode()}
                onCancel={() => { onPending(null); setDir('back'); setSub('start'); setError(''); }} />
            )}

            {step === 'in' && (
              <>
                <h1 id="cw-title">You're in</h1>
                <p className="cloud-lede">Signed in as <strong className="text-ink">{status?.account?.email}</strong>.{(planNeeded || canSync) ? ' A couple of quick steps and you\'re set.' : ''}</p>
                <div className="cw-stagger mt-(--q-group)">
                  <button className="btn btn-primary w-full" onClick={afterIn} data-testid="cw-continue">Continue</button>
                </div>
              </>
            )}

            {step === 'plan' && (
              <PlanStep live={!!status?.account?.features?.billing} onError={setError}
                onFree={() => { setTestPro(false); afterPlan(); }}
                onPro={(p) => { if (status?.account?.features?.billing) void startStripe(p); else { setPlan(p); go('checkout'); } }} />
            )}

            {step === 'stripe' && (
              <>
                <h1 id="cw-title">Finish paying in your browser</h1>
                <p className="cloud-lede" role="status">Stripe opened in your browser. This window moves on once your plan is Pro.</p>
                <div className="cw-stagger mt-(--q-group) flex flex-col gap-2">
                  <button className="btn btn-ghost w-full" onClick={() => void run('checkout', () => window.nekko.cloudRefresh())}>Check again</button>
                </div>
              </>
            )}

            {step === 'checkout' && plan && (
              <TestCheckout plan={plan} email={status?.account?.email ?? ''} onState={setCheckout} onPaid={() => { setTestPro(true); afterPlan(); }} />
            )}

            {step === 'sync' && (
              <SyncStep sync={sync} email={status?.account?.email ?? ''} onRetry={() => void turnOnSync()}
                onKeyDone={(confirmed) => { setKeyConfirmed(confirmed); go('done'); }} onSkip={() => go('done')} />
            )}

            {step === 'done' && (
              <>
                <h1 id="cw-title">You're all set</h1>
                <ul className="cw-rows" data-testid="cw-done">
                  <DoneRow ok title={status?.account?.email ?? ''} detail={testPro ? 'Nekko Cloud Pro (test mode)' : planLabel(status?.account?.plan)} />
                  {syncOn ? <DoneRow ok title="Sync is on" detail={keyConfirmed || status?.sync.recoveryConfirmed ? 'Recovery key saved' : 'Confirm your recovery key in Settings > Sync'} />
                    : sync?.state === 'join' ? <DoneRow title="Finish adding this computer" detail="In Settings > Sync" />
                      : !canSync ? <DoneRow title="Sync is waiting for Pro" detail="Your chats stay on this computer" />
                        : <DoneRow title="Sync is off" detail="Turn it on in Settings > Sync" />}
                  <DoneRow title="Add your iPhone" detail="Sign in on it with the same account" />
                </ul>
                <button className="btn btn-primary mt-(--q-group) w-full" onClick={onClose} data-testid="cw-finish">Start using Nekko Agent</button>
              </>
            )}

            {error && <p role="alert" className="mt-3 text-center text-xs text-danger-text">{error}</p>}
            {step === 'account' && sub === 'start' && !waitingForBrowser && (
              <p className="cloud-fineprint">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="2" stroke="currentColor" strokeWidth="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" strokeWidth="1.5" /></svg>
                <span>Your chats are encrypted on this device before they're uploaded, with keys that never leave your devices. Signing in only tells Nekko Cloud who you are.</span>
              </p>
            )}
          </div>
        </AutoHeight>
        {(firstRun || onBack) && (
          <div className="cw-foot">
            <span>{onBack && <button className="cw-back" onClick={onBack} data-testid="cw-back">Back</button>}</span>
            {firstRun ? (
              <div className="cw-dots" role="img" aria-label={`Step ${dotIndex + 1} of ${dots.length}`}>
                {dots.map((d, i) => <i key={d} className={i === dotIndex ? 'is-on' : i < dotIndex ? 'is-done' : ''} />)}
              </div>
            ) : <span />}
            <span />
          </div>
        )}
      </div>
    </div>
  );
}

function validEmail(email: string) { return /\S+@\S+\.\S+/.test(email); }

/** The window eases to each step's height instead of jumping. */
function AutoHeight({ children }: { children: React.ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return <div className="cw-size" style={h === null ? undefined : { height: h }}><div ref={inner}>{children}</div></div>;
}

function SyncStep({ sync, email, onRetry, onKeyDone, onSkip }: {
  sync: SyncState | null; email: string; onRetry: () => void; onKeyDone: (confirmed: boolean) => void; onSkip: () => void;
}) {
  if (sync?.state === 'key') return <RecoveryKeySteps recoveryKey={sync.key} email={email} onDone={onKeyDone} inWalkthrough />;
  if (sync?.state === 'join') {
    return (
      <>
        <h1 id="cw-title">Add this computer</h1>
        <p className="cloud-lede">Your account already syncs on another device. Finish in Settings &gt; Sync with your recovery key, or approve this computer from that device.</p>
        <button className="btn btn-primary mt-(--q-group) w-full" onClick={onSkip} data-testid="cw-continue">Continue</button>
      </>
    );
  }
  if (sync?.state === 'error') {
    return (
      <>
        <h1 id="cw-title">Sync didn't turn on</h1>
        <p role="alert" className="cloud-lede text-danger-text!">{sync.message}</p>
        <div className="mt-(--q-group) flex gap-2">
          <button className="btn btn-ghost flex-1" onClick={onSkip}>Skip for now</button>
          <button className="btn btn-primary flex-1" onClick={onRetry}>Try again</button>
        </div>
      </>
    );
  }
  return (
    <>
      <h1 id="cw-title">Turning on sync</h1>
      <p className="cloud-lede" role="status">Making this computer's keys. Your chats are locked here before anything is uploaded.</p>
      <div className="mt-(--q-group) grid place-items-center"><span className="cw-spin text-(--accent)" aria-hidden="true" /></div>
    </>
  );
}

function DoneRow({ ok = false, title, detail }: { ok?: boolean; title: string; detail: string }) {
  return (
    <li className={ok ? '' : 'is-waiting'}>
      {ok
        ? <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor" /><path d="M4.8 8.2l2.1 2.1 4.3-4.6" className="cw-row-tick" strokeWidth="1.6" fill="none" strokeLinecap="round" /></svg>
        : <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>}
      <span className="min-w-0"><span className="block truncate text-sm text-ink">{title}</span><span className="block text-xs text-ink-faint">{detail}</span></span>
    </li>
  );
}

function CodeStep({ email, busy, resendIn, onVerify, onResend, onCancel }: {
  email: string; busy: boolean; resendIn: number; onVerify: (code: string) => void; onResend: () => void; onCancel: () => void;
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
      <h1 id="cw-title">Check your email</h1>
      <p className="cloud-lede">We sent a 6-digit code to <strong className="text-ink">{email}</strong>.</p>
      <div className="cloud-otp mt-6" role="group" aria-label="Sign-in code">
        {digits.map((d, i) => (
          <input key={i} ref={(el) => { refs.current[i] = el; }} value={d} inputMode="numeric" autoComplete={i === 0 ? 'one-time-code' : 'off'}
            aria-label={`Digit ${i + 1}`} maxLength={i === 0 ? 6 : 1} disabled={busy} data-testid={`cloud-otp-${i}`} className={d ? 'is-filled' : ''}
            onChange={(e) => put(i, e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Backspace' && !d && i > 0) refs.current[i - 1]?.focus(); }} />
        ))}
      </div>
      <button className="btn btn-primary mt-5 w-full" disabled={busy || code.length < 6} onClick={() => onVerify(code)} data-testid="cloud-verify">
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <div className="mt-3 flex justify-between text-xs">
        <button className="text-ink-faint hover:text-ink-soft" onClick={onCancel} data-testid="cloud-code-cancel">Cancel</button>
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
