// Integration check for relay push routing (no real APNs creds needed):
// agent + client connect → client registers a push token → client disconnects →
// agent sends `notify` → relay should attempt a push for the stored token
// (logs "APNs not configured" since creds are absent), proving the routing.
import { spawn } from 'node:child_process';

const PORT = 4456;
const relay = spawn('node', ['apps/relay-server/dist/index.js'], {
  env: { ...process.env, NEKKO_RELAY_PORT: String(PORT), APNS_KEY_P8: '', APNS_KEY_ID: '', APNS_TEAM_ID: '' },
});
let log = '';
relay.stdout.on('data', (d) => (log += d.toString()));
relay.stderr.on('data', (d) => (log += d.toString()));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = (url) => new Promise((res, rej) => { const w = new WebSocket(url); w.onopen = () => res(w); w.onerror = rej; });
const base = `ws://127.0.0.1:${PORT}/relay`;

let code = 1;
try {
  await sleep(1200);
  const agent = await open(`${base}?role=agent&room=t&key=k`);
  const client = await open(`${base}?role=client&room=t&key=k`);
  await sleep(200);
  client.send(JSON.stringify({ type: 'register-push', token: 'TESTTOKEN', platform: 'ios' }));
  await sleep(200);
  client.close(); // phone goes offline
  await sleep(300);
  agent.send(JSON.stringify({ type: 'notify', title: 'Nekko Agent finished', body: 'done' }));
  await sleep(600);

  if (log.includes('APNs not configured')) {
    console.log('PASS, notify routed to the push sender for the offline client’s token');
    code = 0;
  } else {
    console.log('FAIL, expected a push attempt; relay log:\n' + log);
  }
} catch (e) {
  console.log('FAIL, ' + e.message);
} finally {
  relay.kill();
  process.exit(code);
}
