import React from 'react';
import { createRoot } from 'react-dom/client';
import { ActivityGroup } from '../src/renderer/components/agent-console/ActivityGroup';
import { ToolCard } from '../src/renderer/components/agent-console/ToolCard';
import { WatchDetail, WatchWakeRow } from '../src/renderer/components/agent-console/WatchRow';
import '../src/renderer/styles.css';

// Synthetic data only. No bridge, engine or external requests.
const token = 'long_unbroken_path_segment_'.repeat(16);
const text = `First line\n  Indented line\n${token}\n` + 'More detail\n'.repeat(35);
const call = { id: 'fixture', name: 'write_file', input: { path: token, content: text, literal: String.raw`C:\new\test` } };
const watch = { id: 'watch', name: 'agent_watch', input: { action: 'create', kind: 'timer', delay_seconds: 60, prompt: text } };
const wake = `[Agent watch fixture]\nTimer elapsed.\n\nContinuation requested when armed:\n${text}\n\nThis wake-up grants no new permissions.`;
function Fixture() {
  return <div className="fixture-shell"><main style={{ padding: 16 }}>
    <h1>Expanded tool details (synthetic data)</h1>
    <section id="activity"><h2>Activity group</h2><ActivityGroup items={[{ kind: 'tool', call }]} streaming /></section>
    <section id="reasoning"><h2>Reasoning</h2><ActivityGroup items={[{ kind: 'reasoning', text }]} streaming /></section>
    <section id="delegation"><h2>Delegation task</h2><ActivityGroup items={[{ kind: 'tool', call: { id: 'spawn', name: 'spawn_agent', input: { title: 'Review', task: text } } }]} streaming /></section>
    <section id="spawn-card"><h2>Standalone delegation</h2><ToolCard call={{ id: 'spawn-card', name: 'spawn_agent', input: { title: 'Review', task: text } }} /></section>
    <section id="card"><h2>Standalone tool</h2><ToolCard call={call} /></section>
    <section id="watch"><h2>Watch prompt and result</h2><WatchDetail call={watch} result={{ toolCallId: 'watch', output: text }} /></section>
    <section id="wake"><h2>Watch wake</h2><WatchWakeRow content={wake} createdAt={0} /></section>
  </main></div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
