#!/usr/bin/env node
// Is a relay reachable from here, and does it route? Joins a fresh room as an
// agent and as a phone, sends a frame each way and prints the round trip.
// Content-free and room-scoped: it never touches a paired computer's room.
//   node scripts/relay-hello.mjs ws://gomi.tailfd6474.ts.net:4400 [ws://100.114.173.86:4400 ...]
// Used for TASKS.md IO-19 (Tailscale end to end) from another tailnet node.
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

export function hello(base, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const room = 'hello-' + randomBytes(6).toString('hex');
    const key = randomBytes(16).toString('hex');
    const started = Date.now();
    const sockets = [];
    const done = (fn, v) => {
      clearTimeout(timer);
      sockets.forEach((s) => s.terminate());
      fn(v);
    };
    const timer = setTimeout(() => done(reject, new Error(`${base}: no answer in ${timeoutMs} ms`)), timeoutMs);
    const agent = new WebSocket(`${base}/relay?room=${room}&role=agent&key=${key}`);
    sockets.push(agent);
    agent.on('error', (e) => done(reject, new Error(`${base}: ${e.code ?? e.message}`)));
    agent.on('message', (d) => {
      const f = JSON.parse(String(d));
      if (f.type === 'c' && f.data === 'ping') agent.send(JSON.stringify({ type: 'd', cid: f.cid, data: 'pong' }));
    });
    agent.on('open', () => {
      const phone = new WebSocket(`${base}/relay?room=${room}&role=client&key=${key}`);
      sockets.push(phone);
      phone.on('error', (e) => done(reject, new Error(`${base}: ${e.code ?? e.message}`)));
      phone.on('message', (d) => {
        const s = String(d);
        if (s.includes('"agent-online"')) phone.send('ping');
        else if (s === 'pong') done(resolve, { relay: base, ok: true, roundTripMs: Date.now() - started });
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const urls = process.argv.slice(2);
  if (!urls.length) {
    console.error('usage: node scripts/relay-hello.mjs <ws(s)://relay[:port]> [...]');
    process.exit(2);
  }
  let failed = 0;
  for (const url of urls) {
    try {
      console.log(JSON.stringify(await hello(url.replace(/\/+$/, ''))));
    } catch (e) {
      failed++;
      console.log(JSON.stringify({ relay: url, ok: false, error: e.message }));
    }
  }
  process.exit(failed ? 1 : 0);
}
