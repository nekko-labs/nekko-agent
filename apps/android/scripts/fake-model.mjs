// A fake OpenAI-compatible model server for the Android relay integration test.
//
//   node fake-model.mjs <port>
//
// Prompts containing "approve" get a tool call that the host guardrails must
// hold for approval (`rm -rf ./nekko-itest-dist`); once the tool result comes
// back, or for any other prompt, it streams "Hello from your computer.".
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
    } else {
      for (const w of ['Hello ', 'from ', 'your ', 'computer.']) res.write(chunk({ content: w }));
      res.write(chunk({}, 'stop'));
    }
    res.end('data: [DONE]\n\n');
  });
}).listen(port, '127.0.0.1', () => console.log(`fake model on ${port}`));
