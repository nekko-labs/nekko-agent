import type { Session } from 'electron';
import { connectionAllowed, type ConnectionSettings } from '@nekko-agent/shared';

/** How long a read of `settings.connections` is reused. */
const CACHE_MS = 2000;

/** True for a URL on this computer (or not on the network at all). */
export function isLocalUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return true; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') return true;
  const h = u.hostname.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\./.test(h);
}

/**
 * Settings > Connections for the pages Chromium loads itself (the browser
 * pane, the agent's browser windows): nekkod's switch cannot see them, so
 * their session cancels each request off this computer while `id` is off.
 * Fails open when the settings cannot be read, like an engine that is down.
 */
export function guardSession(session: Session, id: string, read: () => Promise<ConnectionSettings | undefined>, only?: (webContentsId: number | undefined) => boolean): void {
  let cached: { at: number; s: ConnectionSettings | undefined } | null = null;
  const current = async () => {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.s;
    const s = await read().catch(() => undefined);
    cached = { at: Date.now(), s };
    return s;
  };
  session.webRequest.onBeforeRequest((details, callback) => {
    if (isLocalUrl(details.url) || (only && !only(details.webContentsId))) return callback({});
    void current().then((s) => callback({ cancel: !connectionAllowed(s, id) }));
  });
}
