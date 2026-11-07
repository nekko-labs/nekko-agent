// Real live-turn components driven by synthetic events; no provider or tool execution.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LiveTurn } from '../src/renderer/components/agent-console/LiveTurn';
import { useExpertMode } from '../src/renderer/simpleMode';
import { applyEvent, getLiveRun } from '../src/renderer/liveRuns';
import { RowKeyContext, RowMemoryContext } from '../src/renderer/components/agent-console/rowState';
import '../src/renderer/styles.css';
import '@fontsource-variable/inter-tight';
import '@fontsource-variable/jetbrains-mono';
localStorage.setItem('nekko.chatMode', 'expert');
const T = 1_760_000_000_000;
let clock = T + 1000;
Date.now = () => clock;
const memory = new Map<string, unknown>([['timing:purpose-1-open', true]]);
const sessionId = 'isolated-tool-timing';
applyEvent({ type: 'tool_call', sessionId, call: { id: 'older', name: 'read_file', input: { path: 'src/long-running.ts' } } }, T);
applyEvent({ type: 'tool_call', sessionId, call: { id: 'newer', name: 'read_file', input: { path: 'src/quick-read.ts' } } }, T + 200);
applyEvent({ type: 'tool_result', sessionId, result: { toolCallId: 'newer', output: 'Read complete' } }, T + 700);
function Fixture() {
  const [, mode] = useExpertMode();
  const [held, setHeld] = useState<ReturnType<typeof getLiveRun>>(undefined);
  (window as any).timingFixture = {
    mode,
    tick: () => { clock += 200; },
    phase: (phase: number) => {
      if (phase === 1) applyEvent({ type: 'tool_result', sessionId, result: { toolCallId: 'older', output: 'Command failed: CI still running', isError: true } }, T + 1100);
      if (phase === 2) applyEvent({ type: 'reasoning', sessionId, delta: 'The files use the same settings store. I am checking how a new window reads the latest effort choice.' }, clock);
      if (phase === 3) {
        setHeld(getLiveRun(sessionId));
        applyEvent({ type: 'done', sessionId, messageId: 'finished' }, clock);
      }
    },
  };
  return <main style={{ padding: 32, width: '100%', maxWidth: 820, minHeight: 330, background: 'var(--bg)', color: 'var(--ink)' }}>
    <h1 style={{ fontSize: 18, marginBottom: 16 }}>Nekko Agent · desktop tool timing</h1>
    <p style={{ color: 'var(--ink-faint)', fontSize: 12, marginBottom: 20 }}>Synthetic events, real activity components. No provider or tool execution.</p>
    <RowMemoryContext.Provider value={memory}><RowKeyContext.Provider value="timing">
      <LiveTurn sessionId={sessionId} held={held ?? null} />
    </RowKeyContext.Provider></RowMemoryContext.Provider>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
