import type { WebAuthnCeremonyRequest, WebAuthnCeremonyResult } from '@nekko-agent/shared';

/**
 * A WebAuthn ceremony (SK-4): `navigator.credentials.create()` to register a
 * security key or passkey, `get()` to answer a step-up, with every binary
 * field in and out as unpadded base64url.
 *
 * Shared by the two places WebAuthn can run: the page itself in a browser
 * (the Local Web UI, a secure context on `localhost` or `https`), and the
 * desktop's ceremony window, a small `http://localhost` page Electron main
 * opens because the app's own `file://` page has no origin WebAuthn accepts.
 * Main runs `runWebAuthnCeremony` there through `executeJavaScript`, so it
 * is written to be self-contained: no imports or outer names in its body
 * (a test evaluates its source on its own).
 */

/** The IPC channel between the preload and main for the desktop's ceremony window (not an engine channel). */
export const WEBAUTHN_CEREMONY_CHANNEL = 'security:webauthnCeremony';

/** Minimal `CredentialsContainer`, so tests can pass a software authenticator. */
export interface CeremonyCredentials {
  create(options: { publicKey: unknown }): Promise<unknown>;
  get(options: { publicKey: unknown }): Promise<unknown>;
}

export async function runWebAuthnCeremony(req: WebAuthnCeremonyRequest, credentials: CeremonyCredentials): Promise<WebAuthnCeremonyResult> {
  const fromB64url = (text: string): Uint8Array => {
    const std = text.replace(/-/g, '+').replace(/_/g, '/');
    const s = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  };
  const toB64url = (buf: ArrayBuffer | ArrayBufferView): string => {
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const rpId = req.rpId || location.hostname;
  try {
    if (req.mode === 'create') {
      const options = {
        rp: { id: rpId, name: req.rpName },
        user: { id: fromB64url(req.userId), name: req.userName, displayName: req.userDisplayName },
        challenge: fromB64url(req.challenge),
        // ES256 only: the computer's verifiers check P-256 signatures.
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        timeout: req.timeoutMs,
        attestation: 'none',
        excludeCredentials: req.excludeCredentials.map((id) => ({ type: 'public-key', id: fromB64url(id) })),
        authenticatorSelection: {
          authenticatorAttachment: req.attachment,
          // A key holds few resident credentials; the computer keeps the id itself.
          residentKey: 'discouraged',
          requireResidentKey: false,
          userVerification: 'preferred',
        },
      };
      const cred = (await credentials.create({ publicKey: options })) as {
        rawId: ArrayBuffer;
        response: { clientDataJSON: ArrayBuffer; attestationObject: ArrayBuffer };
      } | null;
      if (!cred) return { ok: false, error: 'No key answered.', cancelled: true };
      return {
        ok: true,
        mode: 'create',
        rpId,
        id: toB64url(cred.rawId),
        clientDataJSON: toB64url(cred.response.clientDataJSON),
        attestationObject: toB64url(cred.response.attestationObject),
      };
    }
    const options = {
      rpId,
      challenge: fromB64url(req.challenge),
      timeout: req.timeoutMs,
      userVerification: 'preferred',
      allowCredentials: req.allowCredentials.map((id) => ({ type: 'public-key', id: fromB64url(id) })),
    };
    const cred = (await credentials.get({ publicKey: options })) as {
      rawId: ArrayBuffer;
      response: { authenticatorData: ArrayBuffer; clientDataJSON: ArrayBuffer; signature: ArrayBuffer };
    } | null;
    if (!cred) return { ok: false, error: 'No key answered.', cancelled: true };
    return {
      ok: true,
      mode: 'get',
      rpId,
      credentialId: toB64url(cred.rawId),
      authenticatorData: toB64url(cred.response.authenticatorData),
      clientDataJSON: toB64url(cred.response.clientDataJSON),
      signature: toB64url(cred.response.signature),
    };
  } catch (e) {
    const name = e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
    const message = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
    // The browser says NotAllowedError for a cancel, a timeout and a key that isn't registered alike.
    if (name === 'NotAllowedError' || name === 'AbortError') return { ok: false, error: 'Cancelled, timed out, or that key isn’t registered here.', cancelled: true };
    if (name === 'InvalidStateError') return { ok: false, error: 'That key is already registered on this computer.' };
    if (name === 'SecurityError') return { ok: false, error: 'This page can’t use security keys (it needs https, or localhost).' };
    if (name === 'NotSupportedError') return { ok: false, error: 'This key or this computer doesn’t support what was asked (ES256).' };
    return { ok: false, error: message || 'The security key didn’t answer.' };
  }
}

/** Whether `req` (from the renderer, so untrusted by main) is a ceremony request of the right shape and size. */
export function validCeremonyRequest(req: unknown): req is WebAuthnCeremonyRequest {
  if (!req || typeof req !== 'object') return false;
  const r = req as Record<string, unknown>;
  const b64 = (v: unknown, max = 1024) => typeof v === 'string' && v.length > 0 && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);
  const text = (v: unknown, max = 200) => typeof v === 'string' && v.length <= max;
  const ids = (v: unknown) => Array.isArray(v) && v.length <= 64 && v.every((x) => b64(x));
  const timeout = typeof r.timeoutMs === 'number' && r.timeoutMs > 0 && r.timeoutMs <= 10 * 60 * 1000;
  if (r.rpId !== undefined && !(typeof r.rpId === 'string' && /^[a-z0-9.-]{1,253}$/i.test(r.rpId))) return false;
  if (r.mode === 'create') {
    return b64(r.challenge) && b64(r.userId, 128) && text(r.rpName) && text(r.userName) && text(r.userDisplayName)
      && (r.attachment === 'platform' || r.attachment === 'cross-platform') && ids(r.excludeCredentials) && timeout;
  }
  if (r.mode === 'get') return b64(r.challenge) && ids(r.allowCredentials) && timeout;
  return false;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * The ceremony window's page: what to do, in the app's colors, with the
 * untested-hardware note. Static: no script of its own (main runs the
 * ceremony in it), served with a CSP that allows only its inline style.
 */
export function ceremonyPage(mode: 'create' | 'get', attachment: 'platform' | 'cross-platform' | undefined, note: string): string {
  const title = mode === 'create'
    ? attachment === 'platform' ? 'Set up a passkey on this computer' : 'Register your security key'
    : 'Confirm with your security key';
  const body = mode === 'create' && attachment === 'platform'
    ? 'Follow your computer’s prompt: Windows Hello or Touch ID.'
    : 'Insert or tap your key, then touch it when it blinks. Your computer may ask for the key’s PIN.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="color-scheme" content="light dark">
<style>
:root{color-scheme:light dark;--bg:#fbfbfa;--ink:#1b1b1d;--faint:#6b6b70;--line:#e3e3e0}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--ink:#ececee;--faint:#9a9aa0;--line:#2a2a2e}}
html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{padding:28px 28px 16px;display:flex;flex-direction:column;gap:10px;height:100%;box-sizing:border-box}
h1{font-size:16px;margin:0}p{margin:0;color:var(--faint)}
.key{width:40px;height:40px;border-radius:10px;border:1px solid var(--line);display:grid;place-items:center;font-size:20px}
small{margin-top:auto;font-size:11px;color:var(--faint)}
</style></head><body><main><div class="key" aria-hidden="true">🔑</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>
<p>Closing this window cancels.</p><small>${escapeHtml(note)}</small></main></body></html>`;
}

/** The CSP the ceremony page is served with: nothing but its inline style. */
export const CEREMONY_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
