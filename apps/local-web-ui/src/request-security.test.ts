import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiSecurityHook } from './request-security.js';

const servers: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  for (const app of servers.splice(0)) await app.close();
});

function upgrade(port: number, origin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write([
        'GET /api/events HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...(origin ? [`Origin: ${origin}`] : []),
        '\r\n',
      ].join('\r\n'));
    });
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\r\n\r\n')) {
        resolve(data);
        socket.destroy();
      }
    });
    socket.on('error', reject);
  });
}

describe('API security hook on WebSocket upgrades', () => {
  it('rejects cross-origin upgrades and accepts same-origin and no-Origin clients', async () => {
    const app = Fastify();
    await app.register(websocket);
    app.addHook('onRequest', createApiSecurityHook({
      host: '127.0.0.1',
      port: 0,
      token: '',
      allowedHosts: [],
      allowedOrigins: [],
    }));
    app.get('/api/events', { websocket: true }, (socket) => socket.send('ok'));
    await app.listen({ host: '127.0.0.1', port: 0 });
    servers.push(app);
    const port = (app.server.address() as { port: number }).port;
    const same = await upgrade(port, `http://127.0.0.1:${port}`);
    expect(same).toMatch(/^HTTP\/1\.1 101/);

    const noOrigin = await upgrade(port);
    expect(noOrigin).toMatch(/^HTTP\/1\.1 101/);

    const cross = await upgrade(port, 'https://evil.example');
    expect(cross).toMatch(/^HTTP\/1\.1 403/);
  });
});

function raw(port: number, target: string, headers: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write([
        `POST ${target} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Content-Type: application/json',
        'Content-Length: 11',
        'Connection: close',
        ...headers,
        '',
        '{"args":[]}',
      ].join('\r\n'));
    });
    let data = '';
    socket.on('data', (chunk) => (data += chunk.toString()));
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

describe('API security hook on request targets', () => {
  async function server(): Promise<{ port: number; reached: string[] }> {
    const reached: string[] = [];
    const app = Fastify();
    app.addHook('onRequest', createApiSecurityHook({
      host: '127.0.0.1',
      port: 0,
      token: 'secret-token',
      allowedHosts: [],
      allowedOrigins: [],
    }));
    app.get('/health', async () => ({ ok: true }));
    app.post<{ Params: { channel: string } }>('/api/:channel', async (req) => {
      reached.push(req.params.channel);
      return { ok: true };
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    servers.push(app);
    return { port: (app.server.address() as { port: number }).port, reached };
  }

  it('checks the token on a plain API path', async () => {
    const { port, reached } = await server();
    expect(await raw(port, '/api/daemon:info')).toMatch(/^HTTP\/1\.1 401/);
    expect(await raw(port, '/api/daemon:info', ['Authorization: Bearer secret-token'])).toMatch(/^HTTP\/1\.1 200/);
    expect(reached).toEqual(['daemon:info']);
  });

  it('checks the token on every spelling of a path that routes to the API', async () => {
    const { port, reached } = await server();
    for (const target of ['/%61pi/daemon:info', '/a%70i/daemon:info', '/%61%70%69/daemon:info']) {
      expect(await raw(port, target)).toMatch(/^HTTP\/1\.1 401/);
    }
    expect(reached).toEqual([]);
  });

  it('refuses request targets that are not origin-form', async () => {
    const { port, reached } = await server();
    expect(await raw(port, 'http://x/api/daemon:info')).toMatch(/^HTTP\/1\.1 400/);
    expect(await raw(port, 'http://x/api/daemon:info', ['Authorization: Bearer secret-token'])).toMatch(/^HTTP\/1\.1 400/);
    expect(reached).toEqual([]);
  });

  it('leaves routes outside the API open', async () => {
    const { port } = await server();
    const res = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write(`GET /health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
      let data = '';
      socket.on('data', (c) => (data += c.toString()));
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    expect(res).toMatch(/^HTTP\/1\.1 200/);
  });
});
