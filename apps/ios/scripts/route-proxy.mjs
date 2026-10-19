#!/usr/bin/env node
// A second route to the itest relay (TASKS.md IO-20): a TCP proxy on its own
// port, so a pairing link can carry two addresses of one relay. A small HTTP
// controller takes the route down and back up, as walking off the Wi-Fi would:
//   node route-proxy.mjs <route-port> <relay-port> <ctl-port>
//   GET http://127.0.0.1:<ctl-port>/down   stop listening and cut every open connection
//   GET http://127.0.0.1:<ctl-port>/up     listen again
// Prints NEKKO_ROUTE_READY once both listen. Loopback only.
import { createServer as createHttp } from 'node:http';
import { connect, createServer } from 'node:net';

const [routePort, relayPort, ctlPort] = process.argv.slice(2).map(Number);
if (!routePort || !relayPort || !ctlPort) {
  console.error('usage: route-proxy.mjs <route-port> <relay-port> <ctl-port>');
  process.exit(2);
}

const open = new Set();
let proxy = null;

function up() {
  if (proxy) return Promise.resolve();
  proxy = createServer((client) => {
    const relay = connect(relayPort, '127.0.0.1');
    open.add(client);
    open.add(relay);
    const drop = () => {
      client.destroy();
      relay.destroy();
      open.delete(client);
      open.delete(relay);
    };
    client.on('error', drop).on('close', drop);
    relay.on('error', drop).on('close', drop);
    client.pipe(relay).pipe(client);
  });
  return new Promise((done) => proxy.listen(routePort, '127.0.0.1', done));
}

function down() {
  const p = proxy;
  proxy = null;
  for (const s of open) s.destroy();
  open.clear();
  return new Promise((done) => (p ? p.close(() => done()) : done()));
}

await up();
createHttp(async (req, res) => {
  if (req.url === '/down') await down();
  else if (req.url === '/up') await up();
  else return res.writeHead(404).end();
  console.log(`route ${req.url.slice(1)}`);
  res.end('ok');
}).listen(ctlPort, '127.0.0.1', () => console.log(`NEKKO_ROUTE_READY ${routePort} -> ${relayPort}`));
process.on('SIGTERM', () => process.exit(0));
