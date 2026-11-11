// The chat's secret box (#2594) in the real ChatPane, with synthetic,
// local-only state. No host writes; the "engine" is this file.
// Through ../src/renderer so a baseline run (NEKKO_TEST_SOURCE), which copies
// this file elsewhere and rewrites that prefix, loads the base's fixture too.
import '../src/renderer/../../scripts/layout-evidence-fixture';

const call = { id: 'secret-1', name: 'request_secret', input: { name: 'NPM_TOKEN', reason: 'To publish @acme/widgets to npm. Create an automation token at npmjs.com → Access Tokens.' } };
const request = { callId: call.id, name: call.input.name, reason: call.input.reason, requestedAt: 1 };
const fixture: any = { provided: [] as (string | null)[] };
(window as any).secretBoxFixture = fixture;

fixture.show = async () => {
  const f = (window as any).layoutFixture;
  const record = f.records[0];
  record.title = 'Publish the widgets package';
  record.messages = [
    { id: 'u1', role: 'user', content: 'Publish the widgets package to npm.', createdAt: Date.now() - 4000 },
  ];
  f.putCachedSession({ ...record });
  // What the engine would answer: the value stops here, the agent hears a name.
  f.bridge.provideSecret = async (_sid: string, callId: string, value: string | null) => {
    fixture.provided.push(value);
    setTimeout(() => {
      f.emit({ type: 'secret_resolved', callId, provided: value !== null });
      f.emit({ type: 'tool_result', result: { toolCallId: callId, output: 'The user provided NPM_TOKEN.' } });
      f.emit({ type: 'tool_call', call: { id: 'pub', name: 'bash', input: { command: 'npm publish --access public' } } });
      f.emit({ type: 'tool_result', result: { toolCallId: 'pub', output: '+ @acme/widgets@1.4.0\nnpm notice Publishing with token [secret NPM_TOKEN]' } });
    }, 50);
    return true;
  };
  await f.showRetry();
  const r = f.records[0];
  r.messages = [{ id: 'u1', role: 'user', content: 'Publish the widgets package to npm.', createdAt: Date.now() - 4000 }];
  f.putCachedSession({ ...r });
  f.store.setState({ activeSessionId: 'a' });
  // showRetry seeds an interrupted chat; re-read ours instead.
  f.emit({ type: 'session_meta' });
  await new Promise((done) => setTimeout(done, 300));
  f.emit({ type: 'text', delta: 'The package builds and its tests pass. Publishing needs an npm token, so I’ll ask for one.' });
  f.emit({ type: 'tool_call', call });
  f.emit({ type: 'secret_request', request });
};
