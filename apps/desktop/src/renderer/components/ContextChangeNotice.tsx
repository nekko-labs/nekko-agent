import React, { useId, useRef, useState } from 'react';
import type { AppSettings } from '@nekko-agent/shared';
import { useStore } from '../store.js';
import { Modal } from './primitives/Modal.js';
import { Toggle } from './primitives/Toggle.js';

/** Existing installations keep the notice until they explicitly opt out. */
export const showContextChangeNotice = (settings: AppSettings | null | undefined) => settings?.developer?.showContextChangeNotice !== false;

export function ContextChangeNotice({ tokens, change, hasAttachments, onClose, onMove }: {
  tokens?: number;
  change: 'model' | 'effort';
  hasAttachments: boolean;
  onClose: () => void;
  onMove: () => Promise<void>;
}) {
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [pending, setPending] = useState<'continue' | 'move' | null>(null);
  const [error, setError] = useState<string>();
  const helpId = useId();
  const titleId = useId();
  const gotIt = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  const acknowledge = async (action: 'continue' | 'move') => {
    if (busy.current) return;
    busy.current = true;
    setPending(action);
    setError(undefined);
    try {
      if (dontShowAgain) {
        try {
          const developer = useStore.getState().settings?.developer;
          const settings = await window.nekko.updateSettings({ developer: { ...developer, showContextChangeNotice: false } });
          useStore.setState({ settings });
        } catch {
          setError('Could not save your preference. Try again.');
          return;
        }
      }
      if (action === 'move') await onMove();
      else onClose();
    } catch {
      setError('Could not open a new chat. Your draft is still here.');
    } finally {
      busy.current = false;
      setPending(null);
    }
  };
  return <Modal title="Resend chat history?" labelledBy={titleId} initialFocus={gotIt} zIndex={100} overlayClassName="p-4" className="w-full max-w-md rounded-xl border border-line bg-surface p-5 text-ink shadow-(--shadow-float)" onClose={() => { if (!busy.current) onClose(); }}>
    <h2 id={titleId} className="font-semibold">Resend chat history?</h2>
    <p className="mt-2 text-sm text-ink">Changing {change === 'model' ? 'models' : 'reasoning effort'} resends this chat’s history on your next turn{tokens == null ? '. The token estimate is unavailable.' : <> (about <strong>{tokens.toLocaleString()} input tokens</strong>).</>} Continue here, or move your prompt to a new chat to save tokens. The new chat won’t have this history.</p>
    {hasAttachments && <p className="mt-1 text-xs text-ink-soft">Attachments stay in this chat.</p>}
    <div className="mt-3 flex items-center gap-2 text-sm">
      <Toggle label="Don’t show me again" describedBy={helpId} value={dontShowAgain} onChange={setDontShowAgain} disabled={pending !== null} />
      <span>Don’t show me again</span>
    </div>
    <p id={helpId} className="mt-0.5 text-xs text-ink-faint">Turn back on in Settings → System → Developer.</p>
    {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    <div className="mt-4 flex flex-wrap justify-end gap-2">
      <button className="btn" disabled={pending !== null} onClick={() => void acknowledge('move')}>{pending === 'move' ? 'Moving…' : 'Move to new chat'}</button>
      <button ref={gotIt} className="btn btn-primary" disabled={pending !== null} onClick={() => void acknowledge('continue')}>{pending === 'continue' ? 'Saving…' : 'Got it'}</button>
    </div>
  </Modal>;
}
