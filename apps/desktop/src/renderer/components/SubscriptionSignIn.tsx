import React, { useEffect, useRef, useState } from 'react';
import type { OAuthProvider, OAuthSessionInfo, OAuthStatus } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { ExternalIcon } from '../icons.js';

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting'; session: OAuthSessionInfo }
  | { kind: 'error'; message: string };

/**
 * Subscription sign-in flow (browser OAuth + paste fallback). Renders only the
 * controls; the parent decides what to persist via `onConnected`, which gets a
 * sanitized OAuthStatus — the access token itself never crosses into the
 * renderer. Shared by the ChatGPT and OpenRouter flows, and by Claude's only if
 * its approved-client slot is ever filled (`oauthProviderOffered('claude')`).
 */
export function SubscriptionSignIn({
  oauthProvider,
  label,
  onConnected,
}: {
  oauthProvider: OAuthProvider;
  label?: string;
  onConnected: (status: OAuthStatus) => void | Promise<void>;
}) {
  const pushToast = useStore((s) => s.pushToast);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [pasted, setPasted] = useState('');
  const [finishing, setFinishing] = useState(false);
  const [importing, setImporting] = useState(false);
  const sessionRef = useRef<OAuthSessionInfo | null>(null);
  const signInLabel =
    label ??
    (oauthProvider === 'claude'
      ? 'Sign in with Claude'
      : oauthProvider === 'chatgpt'
        ? 'Sign in with ChatGPT'
        : 'Sign in with OpenRouter');
  // The official first-party CLI whose credential file the host can import as
  // a zero-browser sign-in path: only the Codex CLI's. Claude Code's
  // credentials are never read.
  const cliName = oauthProvider === 'chatgpt' ? 'the Codex CLI' : undefined;
  // OpenAI only issues ChatGPT subscription tokens to its own registered OAuth
  // client, so that sign-in goes through the Codex CLI's client id and the
  // consent screen names it, not us - say so up front, because an unexplained
  // "Codex CLI wants access" reads like the wrong app opened. OpenRouter's
  // PKCE flow creates an API key for this app.
  const consentNote =
    oauthProvider === 'openrouter'
      ? 'Approving in the browser creates an API key on your OpenRouter account and hands it to this app. Usage bills to your OpenRouter balance, and you can revoke the key from openrouter.ai at any time.'
      : oauthProvider === 'chatgpt'
        ? "The authorization page will say Codex CLI, not Nekko Agent: a plan can only be used through its provider's own sign-in client, and Nekko Agent connects through that."
        : undefined;
  const onConnectedRef = useRef(onConnected);
  useEffect(() => {
    onConnectedRef.current = onConnected;
  });

  // The host emits oauthStatus as the flow advances: 'pending' on begin,
  // 'success' when the loopback callback (or a pasted code) exchanged, and
  // 'error' if the exchange failed. Completion can also arrive as the
  // oauthFinish return value, so whichever path lands first wins by clearing
  // sessionRef; the other sees null and stands down.
  useEffect(() => {
    const off = window.nekko.onOAuthStatus((s) => {
      const session = sessionRef.current;
      if (s.provider !== oauthProvider || !session) return;
      if (s.state === 'success' && s.connected) {
        sessionRef.current = null;
        setPasted('');
        setPhase({ kind: 'idle' });
        // The parent's save (e.g. saveProvider) can still fail; surface it as
        // a phase error instead of an unhandled rejection.
        Promise.resolve()
          .then(() => onConnectedRef.current(s))
          .catch((e) => {
            setPhase({ kind: 'error', message: (e as Error).message });
          });
      } else if (s.state === 'error') {
        // A failed exchange leaves the host session (and its loopback
        // listener) open, so close it out before dropping the ref.
        void window.nekko.oauthCancel(session.id).catch(() => {});
        sessionRef.current = null;
        setPhase({ kind: 'error', message: s.message ?? 'Sign-in failed.' });
      }
    });
    return off;
  }, [oauthProvider]);

  // Abandon a dangling session (closed mid-flow, or the view changed) so its
  // loopback listener and expiry timer don't linger host-side.
  useEffect(
    () => () => {
      if (sessionRef.current) void window.nekko.oauthCancel(sessionRef.current.id);
    },
    [],
  );

  const begin = async () => {
    setPhase({ kind: 'starting' });
    try {
      const session = await window.nekko.oauthBegin(oauthProvider);
      sessionRef.current = session;
      setPhase({ kind: 'waiting', session });
      // Desktop maps this to shell.openExternal; the web build window.open()s it.
      await window.nekko.openPath(session.authUrl).catch(() => {});
    } catch (e) {
      sessionRef.current = null;
      setPhase({ kind: 'error', message: (e as Error).message });
    }
  };

  const cancel = async () => {
    const session = sessionRef.current;
    sessionRef.current = null;
    setPasted('');
    setPhase({ kind: 'idle' });
    if (session) await window.nekko.oauthCancel(session.id).catch(() => {});
  };

  const finish = async () => {
    const session = sessionRef.current;
    const text = pasted.trim();
    if (!session || !text || finishing) return;
    // Claim the session synchronously so a second Enter/click, or a success
    // event landing while oauthFinish is in flight, can't complete it twice.
    sessionRef.current = null;
    setFinishing(true);
    try {
      const status = await window.nekko.oauthFinish(session.id, text);
      setPasted('');
      setPhase({ kind: 'idle' });
      await onConnectedRef.current(status);
    } catch (e) {
      setPhase({ kind: 'error', message: (e as Error).message });
      // The failed exchange left the host session open; close it so its
      // loopback listener and expiry timer don't linger.
      void window.nekko.oauthCancel(session.id).catch(() => {});
    } finally {
      setFinishing(false);
    }
  };

  // Zero-browser path: reuse the sign-in the user already did in the official
  // CLI. The host reads the Codex CLI's auth file (~/.codex/auth.json) into
  // its token store under the provider's token key and reports only that it
  // found one.
  const importCli = async () => {
    setImporting(true);
    try {
      const found = await window.nekko.importCliAuth();
      if (found[oauthProvider]) {
        await onConnectedRef.current({
          tokenKey: oauthProvider,
          provider: oauthProvider,
          connected: true,
          state: 'success',
        });
      } else {
        pushToast('info', `No ${cliName} sign-in found on this machine.`);
      }
    } catch (e) {
      pushToast('error', (e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  if (phase.kind === 'waiting') {
    const { session } = phase;
    return (
      <div className="space-y-2">
        <p className="text-xs text-ink-faint">
          {session.mode === 'loopback'
            ? oauthProvider === 'openrouter'
              ? 'Approve the key request in the browser tab that opened; the key lands here automatically.'
              : 'Finish signing in in the browser tab that opened; this window updates automatically.'
            : oauthProvider === 'chatgpt'
              ? 'Your browser could not reach back to the app, so sign-in finishes manually: after you authorize, the tab lands on a page that cannot connect. Copy that tab\'s whole address (it carries your sign-in code) and paste it below.'
              : 'Your browser could not reach back to the app, so sign-in finishes manually: after you authorize, copy the code the page shows and paste it below.'}
        </p>
        {consentNote && <p className="text-xs text-ink-faint">{consentNote}</p>}
        <button
          className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
          onClick={() => void window.nekko.openPath(session.authUrl).catch(() => {})}
        >
          <ExternalIcon className="h-3 w-3" /> Reopen the sign-in page
        </button>
        {session.mode === 'manual' && (
          <div className="flex gap-2">
            <input
              className="input py-1.5 text-xs"
              aria-label="Paste the sign-in code"
              placeholder={oauthProvider === 'chatgpt' ? 'Paste the redirect URL (or code)' : 'Paste the code (code#state)'}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !finishing && void finish()}
              disabled={finishing}
              autoFocus
            />
            <button className="btn btn-primary py-1.5 text-xs" onClick={() => void finish()} disabled={finishing || !pasted.trim()}>
              {finishing ? 'Signing in…' : 'Complete sign-in'}
            </button>
          </div>
        )}
        <button
          className="btn btn-ghost py-1 text-xs"
          onClick={() => void cancel()}
          disabled={finishing}
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <button className="btn btn-primary" onClick={() => void begin()} disabled={phase.kind === 'starting'}>
        {phase.kind === 'starting' ? 'Opening…' : signInLabel}
      </button>
      {phase.kind === 'error' && (
        <p className="text-xs" style={{ color: 'var(--danger)' }}>
          {phase.message}
        </p>
      )}
      {consentNote && <p className="text-xs text-ink-faint">{consentNote}</p>}
      {cliName && (
        <p className="text-xs text-ink-faint">
          Already signed in to {cliName}?{' '}
          <button className="text-accent hover:underline" onClick={() => void importCli()} disabled={importing}>
            {importing ? 'Importing…' : 'Import that sign-in'}
          </button>
        </p>
      )}
    </div>
  );
}
