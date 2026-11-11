// Run a suggested command in the chat's terminal (#2595): the real ChatPane
// with a synthetic reply holding shell blocks, and a local fake terminal.
// No host, shell or network: the "terminal" echoes what Run typed.
import './layout-evidence-fixture';

const now = Date.now();
const reply = [
  'The build needs its dependencies first. Run these in the project folder:',
  '',
  '```bash',
  'npm ci',
  'npm run build',
  '```',
  '',
  'Then check the tests pass:',
  '',
  '```console',
  '$ npm test',
  '',
  '> app@1.0.0 test',
  '> vitest run',
  '```',
].join('\n');

const fixture: any = { created: [], runs: [], terminals: [] };
(window as any).runFixture = fixture;
const encoder = new TextEncoder();
const streams = new Map<string, Set<(bytes: Uint8Array) => void>>();
const buffers = new Map<string, string>();
const output = (id: string, text: string) => {
  buffers.set(id, (buffers.get(id) ?? '') + text);
  for (const write of streams.get(id) ?? []) write(encoder.encode(text));
};
const prompt = '\x1b[32m~/code/app\x1b[0m $ ';

fixture.show = async () => {
  const f = (window as any).layoutFixture;
  const bridge = f.bridge;
  bridge.listTerminals = async () => fixture.terminals;
  bridge.createTerminal = async (opts: any) => {
    fixture.created.push(opts);
    const t = { id: `term-${fixture.created.length}`, title: opts.title ?? 'Terminal', cwd: opts.cwd ?? '/', shell: '/bin/zsh', createdAt: Date.now(), running: true, sessionId: opts.sessionId, workspaceId: opts.workspaceId };
    fixture.terminals.push(t);
    output(t.id, prompt);
    return t;
  };
  bridge.runInTerminal = async (id: string, command: string) => {
    fixture.runs.push({ id, command });
    for (const line of command.split('\r')) {
      output(id, `${line}\r\n`);
      if (line === 'npm ci') output(id, '\r\nadded 312 packages in 4s\r\n');
      if (line === 'npm run build') output(id, '\r\n> app@1.0.0 build\r\n> vite build\r\n\r\n\x1b[32m✓\x1b[0m built in 1.2s\r\n');
      if (line === 'npm test') output(id, '\r\n \x1b[32m✓\x1b[0m 42 tests passed\r\n');
      output(id, prompt);
    }
  };
  bridge.terminalSnapshot = async (id: string) => {
    const info = fixture.terminals.find((t: any) => t.id === id);
    return info ? { info, buffer: buffers.get(id) ?? '', cols: 80, rows: 12 } : null;
  };
  bridge.openTerminalStream = async (id: string, handlers: any) => {
    const info = fixture.terminals.find((t: any) => t.id === id);
    const set = streams.get(id) ?? new Set();
    streams.set(id, set);
    set.add(handlers.onData);
    const replay = buffers.get(id) ?? '';
    handlers.onHello?.({ cols: 80, rows: 12, running: true, replay: replay.length, info });
    if (replay) handlers.onData(encoder.encode(replay));
    return { write: (d: string) => output(id, d), resize: () => {}, ack: () => {}, close: () => set.delete(handlers.onData) };
  };
  f.settings.workspaces = [{ id: 'w1', path: '/Users/me/code/app', name: 'app' }];
  const record = f.records[0];
  record.workspaceId = 'w1';
  record.messages = [
    { id: 'u1', role: 'user', content: 'The build fails on a fresh clone. What should I run?', createdAt: now - 4000 },
    { id: 'a1', role: 'assistant', content: reply, createdAt: now - 3000 },
  ];
  f.putCachedSession(record);
  const [{ createRoot }, React, { ChatPane }] = await Promise.all([import('react-dom/client'), import('react'), import('../src/renderer/components/ChatPane')]);
  f.store.setState({ settings: { ...f.settings }, terminals: [], activeSessionId: 'a' });
  const node = document.createElement('div');
  node.id = 'run-fixture';
  // The App underneath shows the same chat: the journey looks only in here.
  (window as any).fx = () => node;
  node.style.cssText = 'position:fixed;inset:0;z-index:999;background:var(--paper)';
  document.body.append(node);
  createRoot(node).render(React.createElement('div', { style: { height: '100vh' } }, React.createElement(ChatPane, { sessionId: 'a' })));
};
