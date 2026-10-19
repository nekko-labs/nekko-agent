import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonProcess, findNekkod } from 'nekko-agent/engine';
import { forwardCall, isSocketRoute, upgradeAllowed, upstreamPath } from './proxy.js';

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'nekko-proxy-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('socket proxy checks', () => {
  const security = { host: '127.0.0.1', port: 1440, token: 'public-token-0123456789', allowedHosts: [], allowedOrigins: [] };
  const req = (headers: Record<string, string>) => ({ headers, socket: {} }) as never;

  it('knows the daemon socket routes', () => {
    expect(isSocketRoute('/api/events')).toBe(true);
    expect(isSocketRoute('/api/ws')).toBe(true);
    expect(isSocketRoute('/api/term/term_1')).toBe(true);
    expect(isSocketRoute('/api/term/a/b')).toBe(false);
    expect(isSocketRoute('/api/settings:get')).toBe(false);
  });

  it('strips the public token from the upstream path and keeps the rest', () => {
    expect(upstreamPath(new URL('http://x/api/events?token=abc'))).toBe('/api/events');
    expect(upstreamPath(new URL('http://x/api/ws?termData=1&token=abc'))).toBe('/api/ws?termData=1');
    expect(upstreamPath(new URL('http://x/api/term/t%201'))).toBe('/api/term/t%201');
  });

  it('applies the Host, Origin and token rules of the HTTP hook', () => {
    const url = (q = '') => new URL(`http://127.0.0.1:1440/api/events${q}`);
    const host = { host: '127.0.0.1:1440' };
    expect(upgradeAllowed(req({ host: 'evil.example:1440' }), url(), security)).toMatchObject({ ok: false, status: 400 });
    expect(upgradeAllowed(req({ ...host, origin: 'https://evil.example' }), url('?token=public-token-0123456789'), security)).toMatchObject({ ok: false, status: 403 });
    expect(upgradeAllowed(req(host), url(), security)).toMatchObject({ ok: false, status: 401 });
    expect(upgradeAllowed(req(host), url('?token=wrong'), security)).toMatchObject({ ok: false, status: 401 });
    expect(upgradeAllowed(req({ ...host, origin: 'http://127.0.0.1:1440' }), url('?token=public-token-0123456789'), security)).toEqual({ ok: true });
    expect(upgradeAllowed(req({ ...host, authorization: 'Bearer public-token-0123456789' }), url(), security)).toEqual({ ok: true });
    expect(upgradeAllowed(req(host), url(), { ...security, token: '' })).toEqual({ ok: true });
  });
});

// The real daemon, when this checkout has one (CI builds it before the tests).
const here = dirname(fileURLToPath(import.meta.url));
const real = findNekkod({ here: resolve(here, '../dist') });

describe.skipIf(!real)('DaemonProcess against the real nekkod', () => {
  it('answers calls itself, comes back after a crash, and stops cleanly', async () => {
    const dir = scratch();
    const daemon = new DaemonProcess({ exe: real!.path, dataDir: dir, autoStartEngine: false, log: () => {} });
    daemon.start();
    try {
      const up = await daemon.endpoint(20_000);
      const res = await forwardCall(up, 'workspace:list', JSON.stringify({ args: [] }));
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
      // No TS backend behind it: a channel nothing serves is unknown.
      const unknown = await forwardCall(up, 'x:echo', JSON.stringify({ args: [1, 'two'] }));
      expect(unknown.status).toBeGreaterThanOrEqual(400);
      expect(JSON.parse(unknown.body)).toEqual({ error: 'unknown channel x:echo' });

      // A wrong token is refused.
      const refused = await forwardCall({ port: up.port, token: 'not-the-token-0123456789' }, 'workspace:list', '{}');
      expect(refused.status).toBe(401);

      const firstPid = daemon.pid!;
      process.kill(firstPid, 'SIGKILL');
      await new Promise((r) => setTimeout(r, 200));
      const again = await daemon.endpoint(20_000);
      expect(daemon.pid).not.toBe(firstPid);
      expect(daemon.restarts).toBe(1);
      expect((await forwardCall(again, 'workspace:list', '{}')).status).toBe(200);
    } finally {
      await daemon.stop();
    }
    expect(daemon.ready).toBe(false);
  }, 60_000);
});
