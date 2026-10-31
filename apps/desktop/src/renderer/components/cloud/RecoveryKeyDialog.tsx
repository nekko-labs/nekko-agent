import { useState } from 'react';
import QRCode from 'qrcode';
import { cloudError } from '@nekko-agent/shared';
import './cloud.css';

/**
 * The recovery key, shown once when sync is turned on, then typed back so we
 * know it was saved. It is the only way back to the synced chats if every
 * device is lost: Nekko Labs doesn't have it and can't reset it.
 */
export function RecoveryKeyDialog({ recoveryKey, email, onDone }: { recoveryKey: string | null; email: string; onDone: () => void }) {
  const [step, setStep] = useState<'show' | 'confirm'>(recoveryKey ? 'show' : 'confirm');
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const groups = recoveryKey?.split('-') ?? [];

  const copy = async () => {
    if (!recoveryKey) return;
    await navigator.clipboard.writeText(recoveryKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      await window.nekko.syncConfirmRecoveryKey(typed);
      onDone();
    } catch (e) {
      setError(cloudError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cloud-signin-backdrop" role="presentation">
      <div className="cloud-signin" style={{ width: 'min(460px, 100%)' }} role="dialog" aria-modal="true" aria-labelledby="recovery-title" data-testid="recovery-dialog">
        {step === 'show' && recoveryKey ? (
          <>
            <h1 id="recovery-title">Save your recovery key</h1>
            <p className="cloud-lede">If you ever lose every device, this key is the only way to get your synced chats back. Nekko Labs doesn't have it and can't reset it.</p>
            <div className="recovery-key mt-5" data-testid="recovery-key" aria-label="Recovery key">
              {groups.map((g, i) => <span key={i}>{g}</span>)}
            </div>
            <div className="mt-3 flex gap-2">
              <button className="btn btn-outline flex-1 py-1.5! text-xs!" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
              <button className="btn btn-outline flex-1 py-1.5! text-xs!" onClick={() => void saveKit(recoveryKey, email)} data-testid="recovery-kit">Save recovery kit</button>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-ink-faint">Keep it somewhere other than this computer: a password manager, or the printed kit with your important papers. Anyone with this key and your sign-in can read your synced chats.</p>
            <label className="mt-4 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} data-testid="recovery-saved" />
              I've saved my recovery key somewhere safe
            </label>
            <div className="mt-4 flex gap-2">
              <button className="btn btn-ghost flex-1 text-xs!" onClick={onDone}>Remind me later</button>
              <button className="btn btn-primary flex-1" disabled={!saved} onClick={() => setStep('confirm')} data-testid="recovery-continue">Continue</button>
            </div>
          </>
        ) : (
          <>
            <h1 id="recovery-title">Check your recovery key</h1>
            <p className="cloud-lede">Type or paste it from where you saved it, to make sure it's right.</p>
            <textarea className="input mt-5 h-20 w-full resize-none font-mono text-sm tracking-wider" placeholder="XXXXX-XXXXX-XXXXX-…" value={typed}
              onChange={(e) => setTyped(e.target.value)} spellCheck={false} aria-label="Recovery key" data-testid="recovery-typed" />
            {error && <p role="alert" className="mt-2 text-xs text-(--danger)">{error}</p>}
            <div className="mt-4 flex gap-2">
              <button className="btn btn-ghost flex-1 text-xs!" onClick={onDone}>Later</button>
              <button className="btn btn-primary flex-1" disabled={busy || typed.replace(/[\s-]/g, '').length < 55} onClick={() => void confirm()} data-testid="recovery-confirm">
                {busy ? 'Checking…' : 'Confirm'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** A one-page recovery kit (HTML, prints well) with the key as text and as a QR code for the phone. */
async function saveKit(key: string, email: string) {
  const qr = await QRCode.toDataURL(key, { margin: 1, width: 220, errorCorrectionLevel: 'M' });
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Nekko Agent recovery kit</title>
<style>body{font:14px/1.5 system-ui,sans-serif;color:#17171d;max-width:640px;margin:40px auto;padding:0 24px}
h1{font-size:22px;margin:0 0 4px}.muted{color:#52525e}.key{display:grid;grid-template-columns:repeat(4,auto);gap:8px 16px;justify-content:start;font:600 18px/1.3 ui-monospace,monospace;letter-spacing:.06em;padding:18px;border:1.5px solid #6d5efc;border-radius:12px;margin:20px 0}
.row{display:flex;gap:28px;align-items:flex-start}ol{padding-left:18px}.box{border:1px dashed #b9b9c6;border-radius:8px;height:46px;margin-top:4px}</style></head>
<body><h1>Nekko Agent recovery kit</h1><p class="muted">For ${esc(email)} · made ${esc(date)}</p>
<div class="key">${key.split('-').map((g) => `<span>${g}</span>`).join('')}</div>
<div class="row"><img src="${qr}" width="180" height="180" alt="Recovery key QR code"><div>
<p><strong>What this is.</strong> Your chats sync end-to-end encrypted. This key can unlock them if you lose every device you use Nekko Agent on. Nekko Labs doesn't have it and can't reset it.</p>
<ol><li>Sign in to Nekko Cloud on the new device.</li><li>In Settings → Sync, choose <em>Use my recovery key</em>.</li><li>Type the key above, or scan the code with the Nekko Agent iPhone app.</li></ol></div></div>
<p><strong>Keep it safe.</strong> Store this page with your important papers or in a password manager. Anyone with this key and your sign-in can read your synced chats.</p>
<p class="muted">Where I keep this:</p><div class="box"></div></body></html>`;
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'Nekko Agent recovery kit.html';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
