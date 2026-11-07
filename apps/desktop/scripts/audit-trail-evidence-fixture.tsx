import React from 'react';
import { createRoot } from 'react-dom/client';
import type { AuditEvent } from '@nekko-agent/shared';
import { AuditTrail } from '../src/renderer/components/AuditTrail.js';
import '../src/renderer/styles.css';

// A chat that read a file, posted through MCP after a phone approved it, then
// went YOLO. Fixed times so the capture is stable. No bridge, network or real data.
const t0 = Date.UTC(2026, 10, 7, 0, 41, 0);
const trail: AuditEvent[] = [
  { at: t0, turnId: 't1', type: 'turn', mode: 'guardrails', model: 'claude-opus-5-5' },
  { at: t0 + 2000, turnId: 't1', type: 'tool', tool: 'read_file', ms: 4, outputChars: 812, detail: { path: '~/code/shop/app.ts' } },
  { at: t0 + 5000, turnId: 't1', type: 'tool', tool: 'fetch_url', ms: 412, outputChars: 5230, detail: { host: 'wiki.example.com' } },
  { at: t0 + 5100, turnId: 't1', type: 'taint', by: 'fetch_url' },
  { at: t0 + 9000, turnId: 't1', type: 'approval', tool: 'mcp__slack__post_message', severity: 'high', answer: 'approved', by: { via: 'phone', device: 'dev_7f3a91' } },
  { at: t0 + 9800, turnId: 't1', type: 'tool', tool: 'mcp__slack__post_message', ms: 640, outputChars: 12, detail: { server: 'slack', recipients: 1 } },
  { at: t0 + 12000, turnId: 't1', type: 'approval', tool: 'fetch_url', severity: 'high', answer: 'denied', by: { via: 'this computer' } },
  { at: t0 + 12100, turnId: 't1', type: 'redactions', counts: { PII_EMAIL: 2, API_KEY: 1 } },
  { at: t0 + 60000, turnId: 't2', type: 'turn', mode: 'yolo', model: 'claude-opus-5-5' },
  { at: t0 + 61000, turnId: 't2', type: 'approval', tool: 'bash', severity: 'medium', answer: 'approved', by: { via: 'yolo' } },
  { at: t0 + 63000, turnId: 't2', type: 'tool', tool: 'bash', ms: 2310, outputChars: 940, detail: { program: 'npm' } },
];
const empty = new URLSearchParams(location.search).has('empty') || (window as unknown as { auditEmpty?: boolean }).auditEmpty;
createRoot(document.getElementById('root')!).render(
  <main className="min-h-screen bg-surface text-ink">
    <AuditTrail sessionId="s_evidence" incognito={Boolean(empty)} onClose={() => {}} load={async () => (empty ? [] : trail)} />
  </main>,
);
