import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { AgentCdpTransport, type AgentCdpHost, type AgentTarget } from './agentCdpTransport.js';

/** A single authenticated WebSocket, scoped to one explicitly owned page. */
export async function startNativeRelay(host: AgentCdpHost, target: AgentTarget): Promise<{ endpoint: string; close(): void }> {
  const secret = randomBytes(32).toString('hex');
  const route = `/native-${randomBytes(16).toString('hex')}`;
  const transport = new AgentCdpTransport({ ...host, nativeDiscovery: true });
  // Attach before discovery; the transport does not enumerate global Electron targets.
  transport.send({ id: 0, method: 'Target.setAutoAttach', params: { autoAttach: true } });
  await transport.add(target);
  const server = createServer((_req, res) => { res.writeHead(403); res.end(); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1_048_576, perMessageDeflate: false });
  let claimed = false;
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const provided = url.searchParams.get('capability') ?? '';
    const authenticated = Buffer.byteLength(provided) === Buffer.byteLength(secret) && timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
    if (claimed || req.headers.origin !== undefined || url.pathname !== route || !authenticated) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    claimed = true;
    sockets.handleUpgrade(req, socket, head, (ws) => {
      transport.onmessage = (message) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message)); };
      ws.on('message', (data, binary) => {
        try {
          if (binary) throw new Error('Binary frame.');
          const message = JSON.parse(data.toString());
          if (!Number.isSafeInteger(message.id) || typeof message.method !== 'string') throw new Error('Invalid command.');
          transport.send(message);
        } catch { ws.close(1008); }
      });
      ws.on('close', () => transport.close());
      transport.onclose = () => ws.close();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Native relay did not listen.');
  return { endpoint: `ws://127.0.0.1:${address.port}${route}?capability=${secret}`, close() { transport.close(); for (const ws of sockets.clients) ws.terminate(); sockets.close(); server.close(); server.closeAllConnections(); } };
}
