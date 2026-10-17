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
