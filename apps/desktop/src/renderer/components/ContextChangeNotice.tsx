import React, { useState } from 'react';
import type { AppSettings } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { Modal } from './primitives/Modal.js';

/** Existing installations keep the notice until they explicitly opt out. */
export const showContextChangeNotice = (settings: AppSettings | null | undefined) => settings?.developer?.showContextChangeNotice !== false;

export function ContextChangeNotice({ tokens, onClose }: { tokens?: number; onClose: () => void }) {
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const acknowledge = async () => {
    if (!dontShowAgain) { onClose(); return; }
    setSaving(true);
    setError(false);
    try {
      const developer = useStore.getState().settings?.developer;
      const settings = await window.nekko.updateSettings({ developer: { ...developer, showContextChangeNotice: false } });
      useStore.setState({ settings });
      onClose();
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };
  return <Modal title="Tokens on your next turn" zIndex={100} overlayClassName="p-4" className="w-full max-w-md rounded-xl border border-line bg-surface p-5 text-ink shadow-(--shadow-float)" onClose={() => { if (!saving) onClose(); }}>
    <h2 className="font-semibold">Tokens on your next turn</h2>
    <p className="mt-3 text-sm text-ink">{tokens == null
      ? 'Your next turn will resend this chat’s context. The input token estimate is unavailable.'
      : <>Your next turn with this selection will use about <strong>{tokens.toLocaleString()} input tokens</strong> to send this chat’s context.</>}</p>
    <p className="mt-3 text-sm text-ink-soft">To save tokens, open a new chat instead and bring only what you need. That avoids resending this chat’s history.</p>
    <p className="mt-3 text-xs text-ink-faint">Nothing is sent until your next turn. Actual token use and cost depend on context trimming and provider caching and billing.</p>
    <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-ink">
      <input type="checkbox" checked={dontShowAgain} disabled={saving} onChange={e => setDontShowAgain(e.target.checked)} />
      Got it. Don’t show me again.
    </label>
    <p className="mt-1 text-xs text-ink-faint">You can turn this notice back on in Settings → System → Developer.</p>
    {error && <p role="alert" className="mt-3 text-sm text-danger">Could not save your preference. Try again.</p>}
    <button className="btn btn-primary mt-4" disabled={saving} onClick={() => void acknowledge()}>{saving ? 'Saving…' : 'Got it'}</button>
  </Modal>;
}
