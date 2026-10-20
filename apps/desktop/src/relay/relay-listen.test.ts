import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { lanHostsFromEnv, listenAlso } from './relay-listen.js';

describe('listenAlso (relay on this computer, IO-20)', () => {
  const servers: Server[] = [];
  afterEach(() => servers.splice(0).forEach((s) => s.close()));

  it('never listens anywhere but RFC 1918, whatever it is handed', async () => {
    const relay = createServer();
    servers.push(relay);
    const { bound, servers: extra } = await listenAlso(relay, ['0.0.0.0', '::', '127.0.0.1', '8.8.8.8', '169.254.1.1', 'localhost', ''], 0);
    expect(bound).toEqual([]);
    expect(extra).toEqual([]);
  });

  it("skips an address it can't bind instead of failing", async () => {
    const relay = createServer();
    servers.push(relay);
    // RFC 1918, but almost surely not an address of this machine.
    const { bound } = await listenAlso(relay, ['10.255.255.254'], 0);
    expect(bound).toEqual([]);
  });

  it('hands requests and upgrades on an extra address to the relay', async () => {
    const seen: string[] = [];
    const relay = createServer((req, res) => {
      seen.push(`request ${req.url}`);
      res.end('ok');
    });
    relay.on('upgrade', (req, socket) => {
      seen.push(`upgrade ${req.url}`);
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    servers.push(relay);
    // Loopback stands in for a LAN address, which a test machine may not have.
    const { bound, servers: extra } = await listenAlso(relay, ['127.0.0.1', '8.8.8.8'], 0, (h) => h === '127.0.0.1');
    servers.push(...extra);
    expect(bound).toEqual(['127.0.0.1']);
    const port = (extra[0].address() as AddressInfo).port;
    expect(await (await fetch(`http://127.0.0.1:${port}/healthz`)).text()).toBe('ok');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`);
    await new Promise((r) => ws.addEventListener('error', r, { once: true }));
    expect(seen).toEqual(['request /healthz', 'upgrade /relay']);
  });

  it('reads the hosts from the environment', () => {
    expect(lanHostsFromEnv(undefined)).toEqual([]);
    expect(lanHostsFromEnv('')).toEqual([]);
    expect(lanHostsFromEnv(' 192.168.1.20, ,10.0.0.5 ')).toEqual(['192.168.1.20', '10.0.0.5']);
  });
});
