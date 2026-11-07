import React from 'react';
import { createRoot } from 'react-dom/client';
import { ApprovalBar } from '../src/renderer/components/agent-console/ApprovalBar.js';
import '../src/renderer/styles.css';

// An MCP call the egress gate asks about in a chat that read outside content,
// and a shell command for comparison. No bridge, network or real data.
const mcp = {
  call: { id: 'c-mcp', name: 'mcp__slack__post_message', input: { channel: 'general', text: 'Onboarding summary' } },
  reason: 'Call mcp__slack__post_message? This chat has read content from the web or a tool, which can carry instructions to the agent. An MCP tool can send data out of this computer.',
  severity: 'high' as const,
};
const bash = {
  call: { id: 'c-bash', name: 'bash', input: { command: 'npm test' } },
  reason: 'Run command',
  severity: 'medium' as const,
};
const decisions: { approved: boolean; scope: string | undefined }[] = [];
Object.assign(window, { approvalDecisions: decisions });
const onDecide = async (approved: boolean, scope?: string) => { decisions.push({ approved, scope }); };
createRoot(document.getElementById('root')!).render(
  <main className="min-h-screen bg-surface text-ink">
    <div data-approval="mcp"><ApprovalBar approval={mcp} onDecide={onDecide} /></div>
    <div className="h-6" />
    <div data-approval="bash"><ApprovalBar approval={bash} onDecide={onDecide} /></div>
  </main>,
);
