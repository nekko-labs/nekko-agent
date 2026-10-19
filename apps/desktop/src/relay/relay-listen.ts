import { createServer, type Server } from 'node:http';
import { isRfc1918IPv4 } from '@nekko-agent/shared';

/**
 * More addresses for one relay (TASKS.md IO-20): the relay on this computer
 * listens on its tailnet address and, next to it, on the computer's private
 * LAN addresses. Fastify listens once, so each extra address is a plain HTTP
 * server that hands its requests and WebSocket upgrades to the relay's own
 * server: one process, one room table, so a phone on either address meets the
 * same agent.
 *
 * Only RFC 1918 addresses are accepted, whatever the caller passes: never
 * 0.0.0.0, link-local or a public address. An address that can't be bound
 * (it went away, the port is taken there) is skipped, not fatal: the tailnet
 * address still works. Resolves to the addresses actually listening.
 */
export async function listenAlso(
  relay: Server,
  hosts: string[],
  port: number,
  /** Which hosts may be bound: RFC 1918 only. Tests widen it to loopback. */
  allow: (host: string) => boolean = isRfc1918IPv4,
): Promise<{ bound: string[]; servers: Server[] }> {
  const bound: string[] = [];
  const servers: Server[] = [];
  for (const host of new Set(hosts)) {
    if (!allow(host)) continue;
    const extra = createServer((req, res) => relay.emit('request', req, res));
    extra.on('upgrade', (req, socket, head) => relay.emit('upgrade', req, socket, head));
    const ok = await new Promise<boolean>((done) => {
      extra.once('error', () => done(false));
      extra.listen(port, host, () => done(true));
    });
    if (ok) {
      bound.push(host);
      servers.push(extra);
    }
  }
  return { bound, servers };
}

/** `NEKKO_RELAY_LAN_HOSTS`: comma-separated, blanks dropped. */
export function lanHostsFromEnv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
}
