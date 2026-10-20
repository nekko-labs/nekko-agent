/**
 * What kind of network path a relay address is, and the transport rule
 * (TASKS.md PH1): `wss://` anywhere; plain `ws://` only toward private
 * networks, where something else already encrypts or confines the hop: a
 * Tailscale tailnet (WireGuard), the LAN, or loopback. Frames are end-to-end
 * sealed on every path; the rule keeps metadata off the open internet.
 *
 * The same rules as the iPhone app's `RelayRoute.swift`, so the desktop refuses
 * the links the phone would refuse.
 */
export type RelayRoute = 'tailscale' | 'lan' | 'loopback' | 'internet';

export function relayRoute(relayUrl: string): RelayRoute {
  const h = relayHost(relayUrl);
  if (h === 'localhost' || h === '::1' || h.startsWith('127.')) return 'loopback';
  if (h === 'ts.net' || h.endsWith('.ts.net') || isTailscaleIPv4(h) || h.startsWith('fd7a:115c:a1e0:')) return 'tailscale';
  if (h.endsWith('.local') || isPrivateIPv4(h) || isPrivateIPv6(h)) return 'lan';
  return 'internet';
}

/**
 * Why `relayUrl` can't be used as this computer's relay, or undefined when it
 * can. Only shape and the plaintext rule: reachability is the relay's to answer.
 */
export function relayUrlProblem(relayUrl: string): string | undefined {
  const url = relayUrl.trim();
  if (!/^wss?:\/\/[^/?#]/i.test(url)) return 'A relay address starts with wss:// (or ws:// on your Tailscale network or LAN).';
  if (/^ws:\/\//i.test(url) && relayRoute(url) === 'internet') {
    return 'This relay is not encrypted (ws://) and is on the open internet. Use a wss:// relay, or a relay on your Tailscale network.';
  }
  return undefined;
}

/** The host part of a ws/wss/http(s) URL, lowercased, IPv6 without brackets. */
export function relayHost(url: string): string {
  let s = url.trim();
  const scheme = s.indexOf('://');
  if (scheme >= 0) s = s.slice(scheme + 3);
  // Userinfo (`user:pass@`) only counts inside the authority, not in a path.
  const authority = s.match(/^[^/?#]*/)?.[0] ?? '';
  const at = authority.lastIndexOf('@');
  if (at >= 0) s = s.slice(at + 1);
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    return end < 0 ? '' : s.slice(1, end).toLowerCase();
  }
  return (s.match(/^[^/:?#]*/)?.[0] ?? '').toLowerCase();
}

function ipv4(h: string): number[] | undefined {
  const parts = h.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return undefined;
  const n = parts.map(Number);
  return n.every((x) => x <= 255) ? n : undefined;
}

/** 100.64.0.0/10: the range Tailscale gives every device on a tailnet. */
export function isTailscaleIPv4(h: string): boolean {
  const n = ipv4(h);
  return !!n && n[0] === 100 && n[1] >= 64 && n[1] <= 127;
}

/**
 * RFC 1918 (10/8, 172.16/12, 192.168/16): the only LAN addresses the relay on
 * this computer listens on besides the tailnet one (TASKS.md IO-20). Never
 * link-local, never a public address.
 */
export function isRfc1918IPv4(h: string): boolean {
  const n = ipv4(h);
  return !!n && (n[0] === 10 || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) || (n[0] === 192 && n[1] === 168));
}

function isPrivateIPv4(h: string): boolean {
  const n = ipv4(h);
  if (!n) return false;
  return n[0] === 10 || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) || (n[0] === 192 && n[1] === 168) || (n[0] === 169 && n[1] === 254);
}

function isPrivateIPv6(h: string): boolean {
  return h.includes(':') && (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:'));
}

/**
 * The relay the desktop app can run itself, on this computer's Tailscale
 * address and, unless switched off, its private LAN addresses (Settings →
 * Remote access → Relay on this computer). Desktop only.
 */
export interface LocalRelayStatus {
  /** False where this edition can't run one (the web app); the card is hidden then. */
  available?: boolean;
  /** The relay is listening. */
  running: boolean;
  /** Switched on: it starts with the app, and comes back when Tailscale does. */
  enabled: boolean;
  port: number;
  /** This computer's Tailscale address, when Tailscale is connected. */
  tailnetIp?: string;
  /** Its MagicDNS name (`name.tailnet.ts.net`), when the Tailscale CLI reports one. */
  tailnetName?: string;
  /** The address phones use: the MagicDNS name when known, else the tailnet address. */
  url?: string;
  /** Why it isn't running, in words for the settings card. */
  error?: string;
  /**
   * Also listen on this computer's private LAN addresses (RFC 1918), so a phone
   * on the same Wi-Fi skips the tailnet (TASKS.md IO-20). On unless switched off.
   */
  lan?: boolean;
  /** The LAN addresses phones can dial while it runs; pairing links carry them as `alt` routes. */
  lanUrls?: string[];
}

export const LOCAL_RELAY_PORT = 4400;

/**
 * "Visible on this network" (Settings → Remote access): the desktop answers
 * mDNS for `_nekko-agent._tcp` so phones on the same Wi-Fi can list it. Off by
 * default. It says only the computer's name, its own relay's address when it
 * runs one, and a version; never anything that gets a phone into the room.
 */
export interface NetworkVisibilityStatus {
  /** False where this edition can't advertise (the web app); the switch is hidden then. */
  available?: boolean;
  enabled: boolean;
  /** Answering on the local network right now. */
  advertising: boolean;
  /** What phones see, while advertising. */
  name?: string;
  addresses?: string[];
  relayUrl?: string;
  /** Why it isn't advertising, in words for the settings card. */
  error?: string;
}
