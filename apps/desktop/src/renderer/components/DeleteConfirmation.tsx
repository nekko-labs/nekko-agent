import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Modal } from './primitives/Modal.js';
import { useStore } from '../store.js';

let pending = false;

export async function confirmDeletion(message: string): Promise<boolean> {
  if (pending) return false;
  if (useStore.getState().settings?.skipDeleteConfirmation === true) return true;
  pending = true;
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const previous = document.activeElement;
    const finish = (approved: boolean) => {
      root.unmount();
      host.remove();
      pending = false;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      resolve(approved);
    };
    root.render(<DeleteConfirmation message={message} finish={finish} />);
  });
}

function DeleteConfirmation({ message, finish }: { message: string; finish: (approved: boolean) => void }) {
  const [skip, setSkip] = useState(false);
  const [busy, setBusy] = useState(false);
  return <Modal title="Confirm deletion" labelledBy="delete-confirm-title" description={message} onClose={() => { if (!busy) finish(false); }} closeOnEscape={!busy} closeOnScrimClick={false} zIndex={100} className="card mx-4 w-full max-w-sm p-5">
      <h2 id="delete-confirm-title" className="font-semibold">Confirm deletion</h2>
      <p id="delete-confirm-message" className="mt-3 text-sm text-ink-soft">{message}</p>
      <label className="mt-4 flex items-center gap-2 text-xs"><input type="checkbox" checked={skip} disabled={busy} onChange={(e) => setSkip(e.target.checked)} />Skip future deletion confirmations</label>
      <p className="mt-1 text-2xs text-ink-faint">You can turn confirmations back on in Settings. This is separate from Show tips.</p>
      <div className="mt-5 flex justify-end gap-2">
        <button autoFocus disabled={busy} className="btn btn-outline" onClick={() => finish(false)}>Cancel</button>
        <button disabled={busy} className="btn btn-primary" onClick={async () => {
          setBusy(true);
          try {
            if (skip) {
              const settings = await window.nekko.updateSettings({ skipDeleteConfirmation: true });
              useStore.setState({ settings });
            }
            finish(true);
          } catch (error) {
            useStore.getState().pushToast('error', `Could not save confirmation preference: ${String(error)}`);
            setBusy(false);
          }
        }}>Delete</button>
      </div>
  </Modal>;
}
