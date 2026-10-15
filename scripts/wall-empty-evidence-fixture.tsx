import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CommandWall } from '../apps/desktop/src/renderer/components/CommandWall';
import { DEFAULT_WALL_STATE } from '../apps/desktop/src/renderer/commandWall';
import { useStore } from '../apps/desktop/src/renderer/store';
import '../apps/desktop/src/renderer/styles.css';
import '../apps/desktop/src/renderer/components/commandWallLayouts.css';
Object.assign(window, { nekko: new Proxy({}, { get: (_, k: string) => k.startsWith('on') ? () => () => {} : () => Promise.resolve(null) }) });
useStore.setState({ workspaces: [] });
const noop = () => {};
function Fixture() {
  const [scenario, setScenario] = useState('empty');
  Object.assign(window, { evidence: { configure: setScenario, append: () => (window as any).appendFixture() } });
  const root = scenario === 'filtered' || scenario === 'streaming' ? { id: 'agent-pane', kind: 'chat' as const, refId: 'agent' } : null;
  const state = { ...DEFAULT_WALL_STATE, root, filter: scenario === 'filtered' ? 'terminal' as const : 'all' as const, layout: { mode: 'grid' as const, cols: 1, rows: 1 }, folded: {} };
  return <main className="bg-paper" style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <CommandWall state={state} setState={noop} sessions={[{ id: 'agent', title: 'Streaming agent', createdAt: 1, updatedAt: 1, mode: 'agent', providerId: 'fixture', modelId: 'fixture' } as any]} terminals={[]} running={scenario === 'streaming' ? new Set(['agent']) : new Set()} pending={{}} childrenOf={new Map()} projects={[]} flash={null} selectedId={null} onSelect={noop} onAspect={noop} onOpenChat={noop} onOpenTerminal={noop} onNewChat={async () => 'agent'} onNewTerminal={async () => 'terminal'} onAddWindow={() => setScenario('creation')} addContent={scenario === 'creation' ? <div style={{ padding: 20 }}><h2>New agent</h2><p>Choose a project and model for this window.</p><button className="text-accent">Create agent</button></div> : undefined} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
