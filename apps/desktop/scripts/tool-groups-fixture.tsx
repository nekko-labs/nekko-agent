import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ActivityGroup } from '../src/renderer/components/agent-console/ActivityGroup';
import '../src/renderer/styles.css';

// A synthetic turn that reads the guidance, explores, edits and runs the tests
// (spec/chat/tool-calls-grouped-by-purpose.md). Fixed times so captures match.
const T = 1_760_000_000_000;
let n = 0;
const tool = (name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const i = n++;
  return { kind: 'tool', call: { id: `c${i}`, name, input }, startedAt: T + i * 1500, endedAt: T + i * 1500 + 400 + (i % 3) * 700, ...extra };
};
const thought = (text: string) => ({ kind: 'reasoning', text, duration: 2 });

const turn: any[] = [
  thought('The user wants tool calls grouped. I should read the project guidance first.'),
  tool('read_file', { path: 'AGENTS.md' }),
  tool('read_file', { path: 'CLAUDE.md' }),
  tool('read_file', { path: 'docs/runbooks/landing-a-pr.md' }),
  thought('So the labels come from summarizeToolCall; let me look at the transcript model.'),
  tool('read_file', { path: 'apps/desktop/src/renderer/components/agent-console/transcript.ts' }),
  tool('grep', { pattern: 'summarizeToolCall', path: 'packages' }),
  tool('read_file', { path: 'apps/desktop/src/renderer/components/agent-console/ActivityGroup.tsx' }),
  tool('bash', { command: 'rg -n "Worked on" apps/desktop/src' }),
  tool('write_file', { path: 'packages/shared/src/tool-purpose.ts', content: '…' }),
  tool('edit_file', { path: 'apps/desktop/src/renderer/components/agent-console/transcript.ts', old_string: 'a', new_string: 'b' }),
  tool('edit_file', { path: 'apps/desktop/src/renderer/components/agent-console/ActivityGroup.tsx', old_string: 'a', new_string: 'b' }),
  tool('bash', { command: 'npx vitest run packages/shared', description: 'Run the shared tests' }),
  tool('bash', { command: 'npm run typecheck', description: 'Typecheck the workspace' }),
  tool('bash', { command: 'git add -A && git commit -m "Group tool calls by purpose"' }),
  tool('bash', { command: 'git push -u origin feat/tool-groups-by-purpose' }),
];

n = 100;
const failing: any[] = [
  tool('edit_file', { path: 'src/parser.ts', old_string: 'a', new_string: 'b' }),
  tool('bash', { command: 'npm test -- parser' }, { failed: true, result: { toolCallId: 'c101', output: '2 failed', isError: true } }),
  tool('bash', { command: 'npm run lint' }),
];

n = 200;
const live: any[] = [
  thought('Start with the project guidance.'),
  tool('read_file', { path: 'AGENTS.md' }),
  tool('read_file', { path: 'CLAUDE.md' }),
  tool('read_file', { path: 'docs/runbooks/visual-evidence.md' }),
  tool('read_file', { path: 'src/chat.ts' }),
  tool('grep', { pattern: 'ToolRow' }),
  tool('read_file', { path: 'src/rows.ts' }),
];

function Live() {
  const [count, setCount] = useState(1);
  (window as any).__advance = () => setCount((c) => Math.min(live.length, c + 1));
  // The newest call is still running: no end time yet.
  const items = live.slice(0, count).map((it) => (it.kind === 'tool' ? { ...it, startedAt: undefined, endedAt: undefined } : it));
  return <ActivityGroup items={items} streaming />;
}

function Fixture() {
  return <div className="fixture-shell"><header>Nekko Agent <span>Tool calls grouped by purpose · synthetic transcript</span></header><main>
    <p className="fixture-label">Finished turn</p>
    <div data-scene="turn"><ActivityGroup items={turn} /></div>
    <p className="fixture-label">A failed check</p>
    <div data-scene="failing"><ActivityGroup items={failing} /></div>
    <p className="fixture-label">Live turn</p>
    <div data-scene="live"><Live /></div>
  </main></div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
