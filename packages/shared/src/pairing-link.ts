import { relayUrlProblem } from './relay-route.js';

/**
 * Pairing links (TASKS.md IO-20). Settings → Remote access shows a QR carrying
 * `nekko-agent-pair:?relay=&room=&key=&pair=` (or, from the Local Web UI,
 * `https://host/?relay=…`), plus one `alt=` per extra route to the same relay:
 * the relay on this computer listens on its LAN addresses next to the tailnet
 * one, so a phone on the same Wi-Fi can skip the tailnet.
 *
 * The phone parsers follow this one exactly: the iPhone's `Pairing.swift`,
 * Android's `Pairing.kt` and the Expo app's `pairing.ts`, held together by the
 * fixture `apps/ios/Protocol/Tests/NekkoProtocolTests/Fixtures/pairing-links.json`
 * (written by `packages/host/src/pairing-link.golden.test.ts`). A link without `alt` is the old link and
 * parses as before; an `alt` that fails the PH1 rule (`relayUrlProblem`) is
 * dropped, never the whole link.
 */
export interface PairingLink {
  relayUrl: string;
  room: string;
  key: string;
  /** One-time enrollment code; absent when re-using an existing pairing. */
  pair?: string;
  /** Other addresses of the same relay, in the link's order. */
  alts: string[];
}

/** At most this many `alt` routes are kept from a link. */
export const MAX_PAIRING_ALTS = 4;

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
  return { relayUrl, room, key, pair, alts: pairingAlts(params.getAll('alt'), relayUrl) };
}

/** The usable `alt` values: PH1-clean, without trailing slashes, no repeats of the relay or each other. */
export function pairingAlts(values: string[], relayUrl: string): string[] {
  const out: string[] = [];
  for (const v of values) {
    const url = trimSlashes(v.trim());
    if (!url || relayUrlProblem(url) || url === relayUrl || out.includes(url)) continue;
    out.push(url);
    if (out.length === MAX_PAIRING_ALTS) break;
  }
  return out;
}

/**
 * The link a QR carries. `base` is `nekko-agent-pair:` in the desktop app, or
 * the Local Web UI's origin plus `/`.
 */
export function pairingLink(
  base: string,
  p: { relayUrl: string; room: string; key: string; pair?: string; alts?: string[] },
): string {
  let link = `${base}?relay=${encodeURIComponent(p.relayUrl)}&room=${p.room}&key=${p.key}`;
  if (p.pair) link += `&pair=${p.pair}`;
  for (const alt of pairingAlts(p.alts ?? [], trimSlashes(p.relayUrl))) link += `&alt=${encodeURIComponent(alt)}`;
  return link;
}

function trimSlashes(url: string): string {
  // A loop, not /\/+$/: that regex backtracks on long runs of '/' (CodeQL js/polynomial-redos).
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end--;
  return url.slice(0, end);
}
