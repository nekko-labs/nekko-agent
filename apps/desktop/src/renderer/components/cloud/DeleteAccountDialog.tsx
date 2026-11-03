import { useState } from 'react';
import { type CloudStatus, cloudError } from '@nekko-agent/shared';
import { Modal } from '../primitives/Modal.js';

/** The typed email must match the account's, ignoring case and spaces around it. */
export const emailMatches = (typed: string, email: string) => email !== '' && typed.trim().toLowerCase() === email.trim().toLowerCase();

/**
 * Settings > Sync > Delete account: Nekko Cloud erases the account (`DELETE
 * /v1/account`), then this computer forgets its sign-in and keys. Asks for
 * the account's email first, so one stray click can't do it.
 */
export function DeleteAccountDialog({ email, onClose, onDeleted }: { email: string; onClose: () => void; onDeleted: (s: CloudStatus) => void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      onDeleted(await window.nekko.cloudDeleteAccount());
    } catch (e) {
      setError(cloudError(e));
      setBusy(false);
    }
  };
  return (
    <Modal title="Delete Nekko Cloud account" labelledBy="cloud-delete-title" onClose={() => { if (!busy) onClose(); }} closeOnEscape={!busy} closeOnScrimClick={false} zIndex={100} className="card mx-4 w-full max-w-md p-5">
      <h2 id="cloud-delete-title" className="font-semibold">Delete your Nekko Cloud account?</h2>
      <p className="mt-2 text-sm text-ink-soft">Nekko Cloud deletes your account, your synced chats and keys, your devices and sign-ins, and any cloud computer. Every device is signed out.</p>
      <p className="mt-2 text-sm text-ink-soft">Chats on this computer and your other devices stay. To remove them too, use Delete everything in Settings &gt; System.</p>
      <label className="mt-4 block text-xs text-ink-soft" htmlFor="cloud-delete-email">Type <strong className="text-ink">{email}</strong> to confirm</label>
      <input id="cloud-delete-email" className="input mt-1 w-full" autoComplete="off" spellCheck={false} data-cloud-delete-email
        value={typed} disabled={busy} onChange={(e) => setTyped(e.target.value)} />
      {error && <p role="alert" className="mt-3 text-xs text-(--danger)">{error}</p>}
      <p className="mt-4 text-xs font-medium text-(--danger)">This can't be undone.</p>
      <div className="mt-4 flex justify-end gap-2">
        <button autoFocus className="btn btn-outline" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="btn text-white!" style={{ background: 'var(--danger)' }} data-cloud-delete-confirm
          disabled={busy || !emailMatches(typed, email)} onClick={() => void confirm()}>
          {busy ? 'Deleting…' : 'Delete account'}
        </button>
      </div>
    </Modal>
  );
}
