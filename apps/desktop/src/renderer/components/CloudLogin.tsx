import React, { useState } from 'react';
import { NekkoAvatar } from './Mascot.js';

/** Matches the token key the web-client reads for the Bearer header. */
const LS_TOKEN = 'nekko_token';

/**
 * Decide whether to show the Nekko Cloud login gate before mounting the app.
 * Returns false for the desktop app (Electron preload present) and the plain
 * self-hosted server (no `/api/auth/config`), so only the hosted edition gates.
 */
export async function cloudAuthRequired(): Promise<boolean> {
  if ((window as any).nekko) return false; // Electron preload, never cloud
  try {
    const cfg = await fetch('/api/auth/config');
    if (!cfg.ok) return false;
    const { cloud } = await cfg.json();
    if (!cloud) return false;
  } catch {
    return false; // no server / offline → not the cloud edition
  }
  // Cloud: authed already if the stored token still resolves to an account.
  const token = sessionStorage.getItem(LS_TOKEN);
  if (token) {
    try {
      const me = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
      if (me.ok) return false;
    } catch {
      /* fall through to login */
    }
    sessionStorage.removeItem(LS_TOKEN);
  }
  return true;
}

/**
 * Full-screen sign-in / sign-up for Nekko Cloud. On success it stores the
 * account session token (which the existing web-client sends as a Bearer) and
 * calls `onAuthed` so the host app mounts. The app UI itself is untouched -
 * cloud auth is a thin gate in front of the same renderer every edition uses.
 */
export function CloudLogin({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      sessionStorage.setItem(LS_TOKEN, data.token);
      onAuthed();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center p-6" style={{ background: 'var(--paper)' }}>
      <div className="mb-5 grid h-16 w-16 place-items-center rounded-2xl" style={{ background: 'var(--accent-soft)' }}><NekkoAvatar size={40} /></div>
      <h1 className="text-xl font-semibold">{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
      <p className="mt-2 max-w-sm text-center text-[13px] text-ink-faint">
        Nekko Cloud, your chats, memory, and workspaces, hosted. The desktop and self-hosted editions never ask you to sign in.
      </p>
      <form className="mt-5 flex w-full max-w-sm flex-col gap-3" onSubmit={submit}>
        <input
          className="input"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          className="input"
          type="password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          placeholder={mode === 'login' ? 'Password' : 'Password (8+ characters)'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <p className="text-center text-[12px]" style={{ color: 'var(--danger)' }}>{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy || !email || !password}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Sign up'}
        </button>
      </form>
      <button
        className="mt-4 text-[12px] text-ink-faint hover:text-ink-soft"
        onClick={() => { setError(''); setMode(mode === 'login' ? 'signup' : 'login'); }}
      >
        {mode === 'login' ? 'Need an account? Sign up' : 'Already have an account? Log in'}
      </button>
    </div>
  );
}
