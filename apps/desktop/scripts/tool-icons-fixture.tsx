// Synthetic transcript only: no host, provider, settings or network access.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ActivityGroup } from '../src/renderer/components/agent-console/ActivityGroup';
import { ReplyActivityIcon } from '../src/renderer/components/agent-console/ReplyStatus';
import '../src/renderer/styles.css';
import '@fontsource-variable/inter-tight';
import '@fontsource-variable/jetbrains-mono';
const calls = [
  ['bash', { command: 'python3 analyze.py' }],
  ['read_file', { path: 'src/App.tsx' }],
  ['grep', { pattern: 'render', path: 'src' }],
  ['write_file', { path: 'src/report.ts', content: 'export const ready = true;' }],
  ['bash', { command: 'npm test' }],
  ['bash', { command: 'git status --short' }],
  ['fetch_url', { url: 'https://example.com/docs' }],
  ['update_plan', { steps: [{ title: 'Verify the report', status: 'active' }] }],
  ['custom_tool', {}],
] as const;
const items = calls.map(([name, input], i) => ({ kind: 'tool', call: { id: `tool-${i}`, name, input }, result: { content: 'Synthetic result' }, startedAt: 1000, endedAt: 1400 }));
createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 24, background: 'var(--surface)', color: 'var(--ink)', minHeight: '100vh' }}>
    <h1 style={{ fontSize: 18, marginBottom: 16 }}>Chat tool activity</h1>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>Current work <ReplyActivityIcon state="terminal" /> Running Python</div>
    <ActivityGroup items={items as never} streaming />
  </main>,
);
