import React, { useState } from 'react';
import type { ProviderKind } from '@nekko-agent/shared';
import { PROVIDER_DEFAULTS } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { AddProvider } from './AddProvider.js';
import { ProviderChoices, SetupIllustration } from './ProviderChoices.js';

export function FirstProviderSetup() {
  const [kind, setKind] = useState<ProviderKind>();
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const step = connected ? 3 : kind ? 2 : 1;
  const finish = async () => {
    setBusy(true);
    setError('');
    try {
      await useStore.getState().refreshProviders();
      const store = useStore.getState();
      if (store.activeSessionId) store.setView('command');
      else await store.newChat();
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return <section className="mx-auto max-w-3xl px-6 py-8">
    <div className="flex flex-col items-center text-center">
      <SetupIllustration />
      <p className="text-xs font-medium text-ink-soft">Your first agent · Step {step} of 3</p>
      <h1 className="mt-3 text-2xl font-semibold">{connected ? 'Your provider is connected' : kind ? `Connect ${kind === 'anthropic' ? 'Claude' : PROVIDER_DEFAULTS[kind].label}` : 'Bring your first agent to life'}</h1>
      <p className="mt-2 max-w-lg text-sm text-ink-soft">{connected ? 'Next, choose a model and give your agent its first task.' : kind ? 'Follow the steps below. You can change your choice at any time.' : 'Choose where your agent gets its AI. Use an account you already have, or connect models on your computer.'}</p>
      <ol className="my-6 flex gap-5 text-xs text-ink-soft" aria-label="Setup progress">
        {['Choose', 'Connect', 'Start'].map((label, index) => <li key={label} aria-current={step === index + 1 ? 'step' : undefined} style={{ color: step === index + 1 ? 'var(--accent)' : undefined }}>{index + 1}. {label}</li>)}
      </ol>
    </div>
    <div key={connected ? 'done' : kind ?? 'choose'} className="provider-step">
      {connected ? <div className="card p-6 text-center">
        <p className="mb-4 text-sm text-ink-soft">You’re in control: your conversation is only sent when you send a message.</p>
        {error && <p role="alert">{error}</p>}
        <button className="btn btn-primary" disabled={busy} onClick={finish}>{busy ? 'Opening…' : 'Continue to my agent'}</button>
      </div> : kind ? <>
        <button className="btn btn-ghost mb-3" onClick={() => setKind(undefined)}>← Choose a different provider</button>
        <AddProvider fixedKind={kind} onCancel={() => setKind(undefined)} onDone={() => setConnected(true)} />
      </> : <>
        <ProviderChoices onPick={setKind} />
        <button className="btn btn-outline mt-5 w-full" onClick={() => useStore.getState().setView('modelserver')}>Run a model with Nekko Agent instead →</button>
        <p className="mt-4 text-center text-xs text-ink-faint">Online providers receive the messages you send them. Local models run on your computer. Paid plans or usage charges may apply.</p>
      </>}
    </div>
  </section>;
}
