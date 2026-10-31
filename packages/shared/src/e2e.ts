/**
 * End-to-end encryption for relayed traffic. The relay only ever forwards opaque
 * ciphertext, it can't read requests, responses, or model output. Both the
 * local agent and the remote client derive the same AES-GCM key from the shared
 * pairing secret (+ room as salt) via PBKDF2. Uses WebCrypto, which is available
 * both in the browser and in Node 20+ (globalThis.crypto.subtle).
 */

export async function deriveKey(secret: string, salt: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    // PROTOCOL CONSTANT: every paired device derived its key with this exact
    // salt prefix. Changing it breaks E2E decryption for every existing pairing.
    { name: 'PBKDF2', salt: enc.encode(`nekko-relay:${salt}`), iterations: 100_000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * The room credential presented to the relay as `key=`: hex of HMAC-SHA256
 * keyed with the pairing secret over `"nekko-relay-auth:" + room` (decision
 * 0035). One-way, so the relay can check both ends hold the same pairing
 * without ever seeing the secret the E2E key derives from.
 */
export async function relayAuth(secret: string, room: string): Promise<string> {
  const enc = new TextEncoder();
  // PROTOCOL CONSTANT: the label every client and computer derives the relay credential with.
  const mac = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', mac, enc.encode(`nekko-relay-auth:${room}`)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** How saved pairings reach the relay: 2 is `relayAuth` (decision 0035). Older saved pairings must pair again. */
export const RELAY_PAIRING_VERSION = 2;

/** Encrypt a JSON-serializable value → a base64 string (iv ‖ ciphertext). */
export async function seal(key: CryptoKey, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return toB64(packed);
}

/** Decrypt a base64 string produced by seal() back into the original value. */
export async function open<T = unknown>(key: CryptoKey, blob: string): Promise<T> {
  const packed = fromB64(blob);
  const iv = packed.slice(0, 12);
  const ct = packed.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
