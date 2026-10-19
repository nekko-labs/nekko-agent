// The relay for the phone itests, under a small loopback control server so a
// test can kill it mid-send and start it again on the same port:
//
//   node relay-ctl.mjs <control-port>      (relay settings from NEKKO_RELAY_* as usual)
//   GET /stop   kill the relay (SIGKILL: no goodbye frames, like a crash) and wait for it to exit
//   GET /start  start it again and wait until it accepts connections
//
// Stopping this process (SIGTERM, SIGINT) stops the relay with it.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { createServer as createHttp } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ctlPort = Number(process.argv[2]);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const relayPort = Number(process.env.NEKKO_RELAY_PORT);
const host = process.env.NEKKO_RELAY_HOST || '127.0.0.1';
let child = null;

function start() {
  child = spawn(process.execPath, [join(root, 'apps/relay-server/dist/index.js')], { stdio: 'inherit', env: process.env });
  const mine = child;
  mine.on('exit', () => {
    if (child === mine) child = null;
  });
}

function listening() {
  return new Promise((resolve) => {
    const s = connect(relayPort, host, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
  });
}

async function waitFor(cond, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function stop() {
  const c = child;
  if (!c) return Promise.resolve();
  return new Promise((resolve) => {
    c.once('exit', () => resolve());
    c.kill('SIGKILL');
  });
}

start();
const ctl = createHttp(async (req, res) => {
  if (req.url === '/stop') {
    await stop();
    res.end('stopped');
  } else if (req.url === '/start') {
    if (!child) start();
    const up = await waitFor(listening, 10_000);
    res.statusCode = up ? 200 : 500;
    res.end(up ? 'started' : 'relay did not start');
  } else {
    res.statusCode = 404;
    res.end();
  }
});
ctl.listen(ctlPort, '127.0.0.1', () => console.log(`relay control on ${ctlPort}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (child) child.kill('SIGKILL');
    process.exit(0);
  });
}
