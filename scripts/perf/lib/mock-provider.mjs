/**
 * A scripted OpenAI-compatible provider. A prompt containing `PERF-STREAM`
 * gets a long markdown reply streamed at a fixed token rate, one SSE chunk per
 * token; anything else (titles, reply suggestions) gets a short answer at once,
 * so the harness never waits on side traffic.
 */
import { createServer } from 'node:http';
import { streamTokens } from './content.mjs';

export const STREAM_TRIGGER = 'PERF-STREAM';
/** A prompt containing this gets the shorter reply of LONG_REPLY_CHARS characters, for the long-reply probe. */
export const LONG_TRIGGER = 'PERF-LONG';
/** About 16 KB of mixed markdown (headings, lists, fenced code), inside the 10-20 KB the long-reply probe is for. */
export const LONG_REPLY_CHARS = 16_000;

function lastUserText(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'user') continue;
    const c = msgs[i].content;
    return typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text ?? '').join(' ') : '';
  }
  return '';
}

export async function startMockProvider({ port, tokensPerSecond, replyTokens }) {
  const tokens = streamTokens(replyTokens);
  const longTokens = streamTokens(LONG_REPLY_CHARS / 4, 7);
  const state = { streamsStarted: 0, streamsFinished: 0 };

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'mock-1', object: 'model', created: 0, owned_by: 'perf', context_length: 1_000_000 }],
      }));
      return;
    }
    if (req.method === 'POST' && req.url?.startsWith('/v1/chat/completions')) {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch { /* treat as empty */ }
        const prompt = lastUserText(body);
        const longReply = prompt.includes(LONG_TRIGGER);
        const long = longReply || prompt.includes(STREAM_TRIGGER);
        const reply = longReply ? longTokens : tokens;
        const short = prompt.includes('follow-up')
          ? '{"options":["Run the tests","Explain the diff"],"next":"Run the tests."}'
          : 'OK.';
        if (body.stream === false) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            id: 'perf', object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: short }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const chunk = (delta) => `data: ${JSON.stringify({ id: 'perf', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] })}\n\n`;
        const finish = (n) => {
          res.write(`data: ${JSON.stringify({ id: 'perf', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: 'perf', choices: [], usage: { prompt_tokens: 1000, completion_tokens: n, total_tokens: 1000 + n } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        };
        res.write(chunk({ role: 'assistant' }));
        if (!long) {
          res.write(chunk({ content: short }));
          finish(2);
          return;
        }
        state.streamsStarted++;
        // Due tokens are sent every few milliseconds, each as its own chunk, so
        // the rate holds without relying on sub-millisecond timers.
        const started = performance.now();
        let sent = 0;
        // The response's close, not the request's: a request emits 'close' as
        // soon as its body has been read, which is long before the client goes.
        let closed = false;
        res.on('close', () => { closed = true; });
        const timer = setInterval(() => {
          if (closed) { clearInterval(timer); return; }
          const due = Math.min(reply.length, Math.floor(((performance.now() - started) / 1000) * tokensPerSecond));
          let out = '';
          while (sent < due) out += chunk({ content: reply[sent++] });
          if (out) res.write(out);
          if (sent >= reply.length) {
            clearInterval(timer);
            finish(sent);
            state.streamsFinished++;
          }
        }, 4);
      });
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { state, close: () => new Promise((r) => server.close(r)), streamSeconds: tokens.length / tokensPerSecond };
}
