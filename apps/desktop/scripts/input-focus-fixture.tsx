// Real composer, question and approval components with synthetic local state.
// No host bridge, providers, user data or network access.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QuestionCard } from '../src/renderer/components/QuestionCard';
import { MarkdownEditor } from '../src/renderer/components/agent-console/MarkdownEditor';
import { ApprovalBar } from '../src/renderer/components/agent-console/ApprovalBar';
import type { AskRequest } from '@nekko-agent/shared';
import '@fontsource-variable/inter-tight';
import '@fontsource-variable/jetbrains-mono';
import '../src/renderer/styles.css';

const request: AskRequest = { callId: 'question-1', askedAt: 0, questions: [
  { id: 'scope', header: 'Scope', question: 'Which part should I update?', options: [{ label: 'Composer', description: 'Keep typing without interruption.' }, { label: 'Whole app', description: 'Review the other input surfaces too.' }] },
  { id: 'tests', header: 'Tests', question: 'Which checks should I run?', multiSelect: true, options: [{ label: 'Unit tests' }, { label: 'Interaction tests' }] },
] };
const fixture: any = { answers: [], decisions: [] };
(window as any).inputFocusFixture = fixture;
function Fixture() {
  const [draft, setDraft] = useState('Keep my draft here');
  const [pending, setPending] = useState<'question' | 'approval' | null>(null);
  const [compact, setCompact] = useState(false);
  const [callId, setCallId] = useState(request.callId);
  fixture.show = (kind: 'question' | 'approval' | null, small = false, id = request.callId) => { setCompact(small); setCallId(id); setPending(kind); };
  return <><style>{'.input-focus-grid{grid-template-columns:1fr}@media(min-width:700px){.input-focus-grid{grid-template-columns:1fr 1fr}}'}</style><main className="input-focus-grid" style={{ display: 'grid', gap: 24, padding: 24, overflow: 'auto', height: '100vh', background: 'var(--paper)', color: 'var(--ink)' }}>
    <section className="panel p-4" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1 className="text-base font-medium">Agent 1: writing a prompt</h1>
      <p className="text-sm text-ink-soft">A request from another agent must leave your typing focus and selection alone.</p>
      <label className="text-xs">Search<input id="search" className="input mt-1 w-full" defaultValue="Find an agent" /></label>
      <label className="text-xs">Notes<textarea id="notes" className="input mt-1 w-full" defaultValue="My notes" /></label>
      <div className="composer-editor-wrap mt-auto rounded-xl border border-line p-3">
        <MarkdownEditor value={draft} onChange={setDraft} onKeyDown={() => {}} className="min-h-24 outline-hidden" placeholder="Message agent 1" disabled={false} aria-expanded={false} />
      </div>
    </section>
    <section className="panel p-4" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h2 className="text-base font-medium">Agent 2: waiting for input</h2>
      <p className="text-sm text-ink-soft">Questions remain available when you choose to answer them.</p>
      {pending === 'question' && <QuestionCard key={callId} request={{ ...request, callId }} compact={compact} onAnswer={(answers) => { fixture.answers.push(answers); }} onSkip={() => fixture.answers.push([])} />}
      {pending === 'approval' && <ApprovalBar approval={{ call: { id: callId, name: 'bash', input: { command: 'npm test' } }, reason: 'Run the test suite', severity: 'medium' }} onDecide={async (ok) => { fixture.decisions.push(ok); }} />}
    </section>
    <output id="focus-diagnostic" style={{ position: 'fixed', bottom: 4, left: 24, padding: '0 8px', fontSize: 12, background: 'var(--paper)', color: 'var(--ink-soft)' }} />
  </main></>;
}
fixture.diagnose = () => {
  const active = document.activeElement as HTMLElement;
  const label = active.matches('[contenteditable]') ? 'Agent 1 composer' : active.getAttribute('aria-label') || active.id || active.tagName.toLowerCase();
  const output = document.getElementById('focus-diagnostic');
  if (output) output.textContent = `Fixture diagnostic: keyboard target = ${label}`;
};
createRoot(document.getElementById('root')!).render(<Fixture />);
