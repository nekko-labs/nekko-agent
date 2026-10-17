// Bench only: loaded into the TS backend with `--require` (bench-chat-turn.mjs
// `--fanout`), it counts what crosses the backend's loopback wire, so the
// same numbers can be taken from any revision without changing its code:
//   - `in`: request bodies the backend receives, by channel (`POST /api/:channel`,
//     which is how the daemon calls back, `turn:event` included);
//   - `out`: bytes the backend writes on each socket route (`/api/events`,
//     which the daemon reads every host event from).
// Written as JSON to NEKKO_BENCH_METER every 200 ms and on exit.
'use strict';
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');

const file = process.env.NEKKO_BENCH_METER;
if (file) {
  const meter = { in: {}, inFrames: {}, out: {}, outWrites: {} };
  const add = (o, k, n) => { o[k] = (o[k] || 0) + n; };
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event, req, resOrSocket) {
    if (event === 'request' && req.method === 'POST') {
      const channel = decodeURIComponent((req.url || '').split('?')[0].replace(/^\/api\//, ''));
      add(meter.inFrames, channel, 1);
      req.on('data', (chunk) => add(meter.in, channel, chunk.length));
    } else if (event === 'upgrade' && resOrSocket) {
      resOrSocket.__benchRoute = (req.url || '').split('?')[0];
    }
    return emit.apply(this, arguments);
  };
  const write = net.Socket.prototype.write;
  net.Socket.prototype.write = function (data) {
    const route = this.__benchRoute;
    if (route && data && typeof data.length === 'number') {
      add(meter.out, route, typeof data === 'string' ? Buffer.byteLength(data) : data.length);
      add(meter.outWrites, route, 1);
    }
    return write.apply(this, arguments);
  };
  const flush = () => { try { fs.writeFileSync(file, JSON.stringify(meter)); } catch { /* bench dir gone */ } };
  setInterval(flush, 200).unref();
  process.on('exit', flush);
}
