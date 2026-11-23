import { createPublicKey, type KeyObject, verify } from 'node:crypto';

/**
 * Nekko Cloud Relay tickets (decision 0116), checked here without calling
 * anyone: the Cloud API signs them with an Ed25519 key and the relay is
 * started with its public half (`NEKKO_RELAY_TICKET_KEY`). The format is
 * apps/nekko-agent-api/src/relay.ts's, held equal by relay-ticket-vector.json.
 *
 *   nkr1.<base64url(JSON payload)>.<base64url(signature over "nkr1.<payload>")>
 */

export const TICKET_PREFIX = 'nkr1';
/** The longest a ticket may run from now; the API issues six hours. A ticket claiming more is refused. */
export const MAX_TICKET_SECONDS = 24 * 60 * 60;

export interface Ticket {
  v: 1;
  scope: 'agent' | 'account';
  /** Opaque account id (a hash): the account channel groups devices by it. */
  acct: string;
  /** The device it was issued to. */
  dev: string;
  /** For agent tickets: the one room it may claim. */
  room?: string;
  plan: string;
  iat: number;
  exp: number;
}

const OPAQUE = /^[A-Za-z0-9:_-]{1,80}$/;

/** The relay's public key from its environment: the raw 32 bytes in base64url. */
export function parseTicketKey(text: string): KeyObject {
  const raw = Buffer.from(text.trim(), 'base64url');
  if (raw.length !== 32) throw new Error('NEKKO_RELAY_TICKET_KEY must be a 32-byte Ed25519 public key in base64url');
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/** A ticket's payload when the signature is the API's and it has not expired; else null. */
export function checkTicket(key: KeyObject, text: string, nowSeconds = Math.floor(Date.now() / 1000)): Ticket | null {
  if (typeof text !== 'string' || text.length > 2048) return null;
  const parts = text.split('.');
  if (parts.length !== 3 || parts[0] !== TICKET_PREFIX) return null;
  const sig = Buffer.from(parts[2], 'base64url');
  if (sig.length !== 64) return null;
  let ok = false;
  try {
    ok = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, sig);
  } catch {
    ok = false;
  }
  if (!ok) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Ticket;
    if (p?.v !== 1 || (p.scope !== 'agent' && p.scope !== 'account')) return null;
    if (typeof p.exp !== 'number' || !Number.isFinite(p.exp) || p.exp <= nowSeconds) return null;
    if (p.exp - nowSeconds > MAX_TICKET_SECONDS) return null;
    if (typeof p.acct !== 'string' || !OPAQUE.test(p.acct) || typeof p.dev !== 'string' || !OPAQUE.test(p.dev)) return null;
    if (p.scope === 'agent' && typeof p.room !== 'string') return null;
    return p;
  } catch {
    return null;
  }
}
