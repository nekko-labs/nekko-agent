import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/renderer/styles.css';
import { ActivityGroup } from '../src/renderer/components/agent-console/ActivityGroup.js';

// Long enough that the hover card's details box has to scroll.
const content = Array.from({ length: 40 }, (_, i) => `export const step${i + 1} = await runStep(${i + 1}, { retries: 2, timeoutMs: 30_000 });`).join('\n');
createRoot(document.getElementById('root')!).render(
  <div style={{ padding: 32, maxWidth: 900 }}>
    <ActivityGroup streaming items={[
      { kind: 'tool', call: { id: 'read', name: 'read_file', input: { path: '/workspace/nekko-agent/apps/desktop/src/renderer/components/agent-console/ActivityGroup.tsx', start_line: 1, end_line: 220 } } },
      { kind: 'tool', call: { id: 'write', name: 'write_file', input: { path: '/workspace/nekko-agent/apps/desktop/src/renderer/steps.ts', content } } },
    ]} />
  </div>,
);
