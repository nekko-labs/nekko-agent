import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import { join } from 'path';
import { expect, it } from 'vitest';
import { detectHypergate, resolveHypergate } from './mcp.js';

/**
 * Hypergate discovery as the TS host does it, against scripted Hypergate
 * answers, which the engine daemon's port (crates/nekkod/src/hypergate.rs)
 * must reproduce for the same answers. Writes
 * crates/nekkod/tests/golden/hypergate.json; fails if it is stale (rewrite
 * with UPDATE_GOLDEN=1). The port each scenario ran on reads as PORT.
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekkod', 'tests', 'golden', 'hypergate.json');

type Reply = { status: number; body: string } | null;
interface Scenario { name: string; health: Reply; gateway: Reply; resolve: Reply }

const ok = (body: unknown): Reply => ({ status: 200, body: JSON.stringify(body) });
const SCENARIOS: Scenario[] = [
  { name: 'current hypergate, agent token', health: ok({ service: 'hypergated', version: '1.4.0', servers: 3 }), gateway: ok({ url: 'http://127.0.0.1:9/mcp', uiUrl: 'http://127.0.0.1:9/ui', token: 'gw-token' }), resolve: ok({ token: 'agent-token', name: 'Nekko Agent' }) },
  { name: 'older hypergate, gateway token', health: ok({ service: 'hypergated' }), gateway: ok({ url: 'http://127.0.0.1:9/mcp', token: 'gw-token' }), resolve: null },
  { name: 'resolve answers without a token', health: ok({ service: 'hypergated', version: '2', servers: 0 }), gateway: ok({ url: 'u' }), resolve: ok({ name: 'x' }) },
  { name: 'resolve refused', health: ok({ service: 'hypergated', servers: 1 }), gateway: ok({ url: 'u', token: 't' }), resolve: { status: 403, body: JSON.stringify({ token: 'nope' }) } },
  { name: 'something else on the port', health: ok({ service: 'not-hypergate' }), gateway: ok({ url: 'u' }), resolve: null },
  { name: 'health is not json', health: { status: 200, body: '<html>' }, gateway: ok({ url: 'u' }), resolve: null },
  { name: 'health null', health: ok(null), gateway: ok({ url: 'u' }), resolve: null },
  { name: 'gateway null', health: ok({ service: 'hypergated' }), gateway: ok(null), resolve: null },
  { name: 'gateway without url, health with nulls', health: ok({ service: 'hypergated', version: null, servers: null }), gateway: ok({ uiUrl: null }), resolve: null },
  { name: 'health as an error page with json', health: { status: 500, body: JSON.stringify({ service: 'hypergated' }) }, gateway: { status: 404, body: '{}' }, resolve: null },
];

/** A Hypergate that answers as the scenario says (a null reply is a 404 with no JSON body). */
async function serve(s: Scenario): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const reply = req.url === '/health' ? s.health : req.url === '/api/gateway' ? s.gateway : req.url === '/api/clients/resolve' && req.method === 'POST' ? s.resolve : null;
    req.resume();
    if (!reply) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(reply.body);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  return { server, port: typeof address === 'object' && address ? address.port : 0 };
}

const normalize = (v: unknown, port: number) =>
  JSON.parse(JSON.stringify(v ?? null).split(`"port":${port}`).join('"port":"PORT"').split(String(port)).join('PORT'));

it('hypergate discovery matches the daemon golden set', async () => {
  const out = [];
  for (const s of SCENARIOS) {
    const { server, port } = await serve(s);
    try {
      // `localhost`, as the host asks; the fake listens on IPv4 loopback.
      const detect = normalize(await detectHypergate(port), port);
      const resolve = normalize(await resolveHypergate(port), port);
      out.push({ ...s, detected: detect, resolved: resolve });
    } finally {
      await new Promise((done) => server.close(done));
    }
  }
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(join(golden, '..'), { recursive: true });
    writeFileSync(golden, `${JSON.stringify(out, null, 1)}\n`);
  }
  expect(JSON.parse(readFileSync(golden, 'utf8'))).toEqual(out);
});
