import React, { Suspense, lazy, useState } from 'react';
import { NekkoAvatar } from './Mascot.js';

// Lazy so jsQR is code-split out of the main bundle (only fetched when scanning).
const QrScanner = lazy(() => import('./QrScanner.js').then((m) => ({ default: m.QrScanner })));

/** Persisted relay pairing creds (set here, read by web-client.ts). */
const LS_RELAY = 'op_relay';

function isNativeApp(): boolean {
  return typeof window !== 'undefined' && !!(window as { Capacitor?: unknown }).Capacitor;
}

function alreadyPaired(): boolean {
  const q = new URLSearchParams(location.search);
  if (q.get('relay') && q.get('room') && q.get('key')) return true;
  try {
    const s = JSON.parse(localStorage.getItem(LS_RELAY) || 'null');
    return !!(s?.relay && s?.room && s?.key);
  } catch {
    return false;
  }
}

/** Parse a pairing link (`…/?relay=&room=&key=&pair=`) or raw query string. */
function parsePairing(input: string): { relay: string; room: string; key: string; pair?: string } | null {
  try {
    const q = input.includes('?') ? new URLSearchParams(input.slice(input.indexOf('?') + 1)) : new URLSearchParams(input);
    const relay = q.get('relay');
    const room = q.get('room');
    const key = q.get('key');
    if (relay && room && key) return { relay, room, key, pair: q.get('pair') ?? undefined };
  } catch {
    /* ignore */
  }
  return null;
}

/** Why the last pairing attempt was rejected (set by web-client on `denied`). */
function deniedReason(): string {
  const r = sessionStorage.getItem('op_relay_denied');
  switch (r) {
    case 'revoked':
      return 'This device was revoked on your computer. Pair it again with a fresh QR.';
    case 'bad-code':
      return 'That pairing code expired or was already used. Generate a new QR on your computer.';
    case 'unknown-device':
      return 'This device isn’t paired yet. Use a pairing QR (Settings → Remote access → Pair a device).';
    default:
      return '';
  }
}

/**
 * First-run pairing for the native mobile app: paste the pairing link shown in
 * the desktop app's Settings → Remote access (QR scanning is added in the
 * native build). On success we persist the creds and reload; web-client then
 * connects to your computer over the encrypted relay. Renders nothing unless
 * running inside the Capacitor shell and not yet paired.
 */
export function RelayPairing() {
  const [show] = useState(() => isNativeApp() && !alreadyPaired());
  const [input, setInput] = useState('');
  const [error, setError] = useState(() => deniedReason());
  const [scanning, setScanning] = useState(false);

  if (!show) return null;

  const commit = (raw: string): boolean => {
    const creds = parsePairing(raw.trim());
    if (!creds) {
      setError('That doesn’t look like a pairing link. Copy it from Settings → Remote access on your computer.');
      return false;
    }
    sessionStorage.removeItem('op_relay_denied');
    localStorage.setItem(LS_RELAY, JSON.stringify(creds));
    location.reload();
    return true;
  };

  const pair = () => commit(input);

  if (scanning) {
    return (
      <Suspense fallback={<div className="fixed inset-0 z-60 bg-black" />}>
        <QrScanner
          onClose={() => setScanning(false)}
          onResult={(text) => {
            setScanning(false);
            if (!commit(text)) setError('That QR isn’t a Nekko Agent pairing code.');
          }}
        />
      </Suspense>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center p-6" style={{ background: 'var(--paper)' }}>
      <div className="mb-5 grid h-16 w-16 place-items-center rounded-2xl" style={{ background: 'var(--accent-soft)' }}><NekkoAvatar size={40} /></div>
      <h1 className="text-xl font-semibold">Pair with your computer</h1>
      <p className="mt-2 max-w-sm text-center text-sm text-ink-faint">
        Nekko Agent on your desktop → <span className="font-medium text-ink-soft">Settings → Remote access</span>, pick Tailscale or Nekko Cloud, then paste the pairing link here. Your phone drives the model on your computer, end-to-end encrypted.
      </p>
      <textarea
        className="input mt-5 max-w-sm"
        rows={3}
        placeholder="Paste the pairing link (…/?relay=…&room=…&key=…)"
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      {error && <p className="mt-2 max-w-sm text-center text-xs" style={{ color: 'var(--danger)' }}>{error}</p>}
      <button className="btn btn-primary mt-4 w-full max-w-sm" onClick={pair} disabled={!input.trim()}>Pair</button>
      <div className="my-3 flex w-full max-w-sm items-center gap-3 text-2xs text-ink-faint">
        <span className="h-px flex-1" style={{ background: 'var(--line)' }} /> or <span className="h-px flex-1" style={{ background: 'var(--line)' }} />
      </div>
      <button className="btn btn-outline w-full max-w-sm" onClick={() => { setError(''); setScanning(true); }}>
        📷 Scan QR code
      </button>
    </div>
  );
}
