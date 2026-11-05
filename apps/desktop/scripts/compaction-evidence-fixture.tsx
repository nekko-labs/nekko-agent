import React from 'react';
import { createRoot } from 'react-dom/client';
import { CompactionSummary } from '../src/renderer/components/agent-console/CompactionSummary.js';
import '../src/renderer/styles.css';
import type { ChatMessage } from '@nekko-agent/shared';

const message = {
  id: 'compaction-evidence', role: 'system', createdAt: 1793757600000,
  content: '## Goal and constraints\n\nResolve conflicts and land the queued pull requests.\n\n- Preserve existing work.\n- Verify each change before landing.\n\n## Next steps\n\nInspect the current checks and continue the work.',
  compaction: { summarized: 198 },
} as ChatMessage;
createRoot(document.getElementById('root')!).render(
  <main className="min-h-screen bg-surface p-4 text-ink">
    <div className="mx-auto max-w-3xl space-y-4">
      <p className="text-sm text-ink-soft">Continue with the queued pull requests.</p>
      <CompactionSummary message={message} latest />
      <p className="text-sm text-ink-soft">I’ll inspect the checks and continue from the saved summary.</p>
    </div>
  </main>,
);
