/**
 * Pairing links. The desktop's Settings → Remote access shows a QR that
 * carries `nekko-agent-pair:?relay=&room=&key=&pair=` (or, from the web
 * edition, `https://host/?relay=…`), plus one `alt=` per extra route to the
 * same relay (TASKS.md IO-20). Either form, or a bare query string, parses to
 * the same credentials. A port of `packages/shared/src/pairing-link.ts`, held
 * to it by the shared fixture (`pairing-links.json`).
 */
export interface PairingLink {
  relayUrl: string;
  room: string;
  key: string;
  /** One-time enrollment code; absent when re-using an existing pairing. */
  pair?: string;
  /** Other addresses of the same relay, in the link's order. Not dialed yet in this app. */
  alts: string[];
}

const MAX_ALTS = 4;

export function parsePairingLink(input: string): PairingLink | null {
  const raw = input.trim();
  if (!raw) return null;
  const q = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : raw;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(q.split('#')[0]);
  } catch {
    return null;
  }
  const relay = params.get('relay')?.trim();
  const room = params.get('room')?.trim();
  const key = params.get('key')?.trim();
  if (!relay || !room || !key) return null;
  if (!/^wss?:\/\//i.test(relay)) return null;
  // Room is 16 hex chars and the secret 32; accept anything hex-shaped so a
  // future longer secret still pairs, but refuse obvious garbage.
  if (!/^[0-9a-f]{8,128}$/i.test(room) || !/^[0-9a-f]{16,256}$/i.test(key)) return null;
  const pair = params.get('pair')?.trim().toUpperCase() || undefined;
  const relayUrl = trimSlashes(relay);
  const alts: string[] = [];
  for (const v of params.getAll('alt')) {
    const url = trimSlashes(v.trim());
    if (!url || !usableRoute(url) || url === relayUrl || alts.includes(url)) continue;
    alts.push(url);
    if (alts.length === MAX_ALTS) break;
  }
  return { relayUrl, room, key, pair, alts };
}

/** Without trailing '/': a loop, since /\/+$/ backtracks on long runs of '/'. */
function trimSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end--;
  return url.slice(0, end);
}

/** Relay host for display ("nekko-agent-relay.fly.dev"). */
export function relayHost(relayUrl: string): string {
  return relayUrl.replace(/^wss?:\/\//i, '').replace(/\/.*$/, '');
}

/** No `relayUrlProblem` (relay-route.ts): `wss://` anywhere, plain `ws://` only to private networks. */
function usableRoute(url: string): boolean {
  if (!/^wss?:\/\/[^/?#]/i.test(url)) return false;
  return !/^ws:\/\//i.test(url) || !onInternet(host(url));
}

function host(url: string): string {
  let s = url.trim().slice(url.trim().indexOf('://') + 3);
  const authority = s.match(/^[^/?#]*/)?.[0] ?? '';
  const at = authority.lastIndexOf('@');
  if (at >= 0) s = s.slice(at + 1);
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    return end < 0 ? '' : s.slice(1, end).toLowerCase();
  }
  return (s.match(/^[^/:?#]*/)?.[0] ?? '').toLowerCase();
}

function onInternet(h: string): boolean {
  if (h === 'localhost' || h === '::1' || h.startsWith('127.')) return false;
  if (h === 'ts.net' || h.endsWith('.ts.net') || h.startsWith('fd7a:115c:a1e0:') || h.endsWith('.local')) return false;
  if (h.includes(':') && (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:'))) return false;
  const parts = h.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
    const [a, b] = parts.map(Number);
    if (parts.map(Number).some((x) => x > 255)) return true;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return false;
  }
  return true;
}
