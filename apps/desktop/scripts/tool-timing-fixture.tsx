// The real activity UI, with deterministic synthetic tool and public-summary events.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ActivityGroup } from '../src/renderer/components/agent-console/ActivityGroup';
import { RowKeyContext, RowMemoryContext } from '../src/renderer/components/agent-console/rowState';
import '../src/renderer/styles.css';
import '@fontsource-variable/inter-tight';
import '@fontsource-variable/jetbrains-mono';
const T = 1_760_000_000_000;
let clock = T + 1000;
Date.now = () => clock;
const memory = new Map<string, unknown>([['timing:purpose-1-open', true]]);
function Fixture() {
  const [phase, setPhase] = useState(0);
  (window as any).timingFixture = { tick: () => { clock += 200; }, phase: setPhase };
  const items: any[] = [
    { kind: 'tool', call: { id: 'older', name: 'read_file', input: { path: 'src/long-running.ts' } }, startedAt: T, ...(phase > 0 ? { endedAt: T + 3000, result: { toolCallId: 'older', output: 'Read complete' } } : {}) },
    { kind: 'tool', call: { id: 'newer', name: 'read_file', input: { path: 'src/quick-read.ts' } }, startedAt: T + 200, endedAt: T + 700, result: { toolCallId: 'newer', output: 'Read complete' } },
  ];
  if (phase === 2) items.push({ kind: 'reasoning', text: 'The files use the same settings store. I am checking how a new window reads the latest effort choice.', duration: null });
  return <main style={{ padding: 32, width: 820, minHeight: 330, background: 'var(--bg)', color: 'var(--ink)' }}>
    <h1 style={{ fontSize: 18, marginBottom: 16 }}>Nekko Agent · desktop tool timing</h1>
    <p style={{ color: 'var(--ink-faint)', fontSize: 12, marginBottom: 20 }}>Synthetic events, real activity components. No provider or tool execution.</p>
    <RowMemoryContext.Provider value={memory}><RowKeyContext.Provider value="timing">
      <ActivityGroup items={items} streaming={phase < 3} />
    </RowKeyContext.Provider></RowMemoryContext.Provider>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
