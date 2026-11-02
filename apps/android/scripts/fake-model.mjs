// A fake OpenAI-compatible model server for the Android relay integration test.
//
//   node fake-model.mjs <port>
//
// Prompts containing "approve" get a tool call that the host guardrails must
// hold for approval (`rm -rf ./nekko-itest-dist`); once the tool result comes
// back, or for any other prompt, it streams "Hello from your computer.".
// Prompts containing "slow" stream one word a second for ~20 s, so a run can be
// watched with the app in the background (keep-alive, local notifications);
// "long run" does the same for 90 s.
// Prompts containing "ask me" call `ask_user` with one two-option question.
// Prompts containing "make a plan" call `update_plan` with a four-step plan
// (one done, one active), for the phone's plan sheet.
// Prompts containing "write a note" call `write_file` for `nekko-itest-note.txt`,
// so the phone's read-only Changes view has a real edit to show.
// Prompts containing "show previews" stream the text of the file named by
// NEKKO_FAKE_PREVIEWS (a reply linking files and a dev server, for the
// phone's preview cards and window).
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.argv[2] || 4700);
const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

createServer((req, res) => {
  if (req.url?.includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
    return;
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    let messages = [];
    try {
      messages = JSON.parse(body).messages ?? [];
    } catch {
      /* not JSON */
    }
    const last = messages[messages.length - 1];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const userText = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (last?.role === 'user' && /approve/i.test(userText)) {
      res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_itest', type: 'function', function: { name: 'bash', arguments: '' } }] }));
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: 'rm -rf ./nekko-itest-dist' }) } }] }));
      res.write(chunk({}, 'tool_calls'));
    } else if (last?.role === 'user' && /ask me/i.test(userText)) {
      const args = { questions: [{ header: 'Target', question: 'Which platform should I build first?', options: ['iOS', 'Android'] }] };
      res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_ask', type: 'function', function: { name: 'ask_user', arguments: '' } }] }));
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }));
      res.write(chunk({}, 'tool_calls'));
    } else if (last?.role === 'user' && /make a plan/i.test(userText)) {
      const args = {
        steps: [
          { title: 'Read the composer code', status: 'done', kind: 'explore', note: 'Found the message box' },
          { title: 'Draw the plan sheet', status: 'active', kind: 'build', note: 'Tucked behind the composer' },
          { title: 'Check it on the phone', status: 'pending', kind: 'verify' },
          { title: 'Open a pull request', status: 'pending', kind: 'ship' },
        ],
      };
      res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_plan', type: 'function', function: { name: 'update_plan', arguments: '' } }] }));
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }));
      res.write(chunk({}, 'tool_calls'));
    } else if (last?.role === 'user' && /write a note/i.test(userText)) {
      const args = { path: 'nekko-itest-note.txt', content: 'first line\nwritten by the agent\n' };
      res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_write', type: 'function', function: { name: 'write_file', arguments: '' } }] }));
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }));
      res.write(chunk({}, 'tool_calls'));
    } else if (last?.role === 'user' && /show previews/i.test(userText) && process.env.NEKKO_FAKE_PREVIEWS) {
      const text = readFileSync(process.env.NEKKO_FAKE_PREVIEWS, 'utf8');
      for (const piece of text.match(/[\s\S]{1,24}/g) ?? []) res.write(chunk({ content: piece }));
      res.write(chunk({}, 'stop'));
    } else if (last?.role === 'user' && /markdown/i.test(userText)) {
      const md = '## Build steps\n\n1. Install with **npm ci**\n2. Run `npm test`\n- [x] lint\n\n```sh\nnpm ci && npm test -- --reporter=dot --run-in-band\n```\n\nSee [the docs](https://nekkoagent.com/docs).';
      for (const piece of md.match(/[\s\S]{1,12}/g)) res.write(chunk({ content: piece }));
      res.write(chunk({}, 'stop'));
    } else if (last?.role === 'user' && /slow|long run/i.test(userText)) {
      // "long run": 90 s, long enough for a slow simulator to queue and edit a follow-up.
      const words = Array.from({ length: /long run/i.test(userText) ? 90 : 20 }, (_, i) => `word${i + 1} `);
      let i = 0;
      const timer = setInterval(() => {
        if (i < words.length) return void res.write(chunk({ content: words[i++] }));
        clearInterval(timer);
        res.write(chunk({}, 'stop'));
        res.end('data: [DONE]\n\n');
      }, 1000);
      res.on('close', () => clearInterval(timer));
      return;
    } else {
      for (const w of ['Hello ', 'from ', 'your ', 'computer.']) res.write(chunk({ content: w }));
      res.write(chunk({}, 'stop'));
    }
    res.end('data: [DONE]\n\n');
  });
}).listen(port, '127.0.0.1', () => console.log(`fake model on ${port}`));
