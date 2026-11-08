// Real renderer components with synthetic, local-only state. No host writes.
import './layout-evidence-fixture';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QuestionCard } from '../src/renderer/components/QuestionCard';
import { parseAskRequest, formatAskAnswers } from '@nekko-agent/shared';
const call = { id: 'ask-fixture', name: 'ask_user', input: { questions: [
  { header: 'Scope', question: 'Which part should I update?', options: [{ label: 'Composer', description: 'Keep the change focused on the message box.' }, { label: 'Whole app', description: 'Include shared CTA buttons throughout the app.' }] },
  { header: 'Checks', question: 'Which checks should I run?', multiSelect: true, options: [{ label: 'Unit tests' }, { label: 'Interaction tests' }] },
  { header: 'Theme', question: 'Which theme should I check?', options: [{ label: 'Light' }, { label: 'Dark' }] },
] } };
const parsed = parseAskRequest(call.id, call.input, 1);
if ('error' in parsed) throw Error(parsed.error);
const fixture: any = { answers: [], call, request: parsed.request };
(window as any).ctaQuestionFixture = fixture;
fixture.showQuestion = () => {
  let node = document.getElementById('question-fixture');
  if (!node) { node = document.createElement('div'); node.id = 'question-fixture'; document.body.append(node); }
  node.style.cssText = 'position:fixed;inset:0;z-index:999;background:var(--paper);color:var(--ink);padding:24px;overflow:auto';
  createRoot(node).render(<main style={{ maxWidth: 580, margin: 'auto' }}>
    <h1 className="mb-4 text-base font-medium">Before I start</h1>
    <QuestionCard request={parsed.request} onAnswer={async a => { if (fixture.failNext) { fixture.failNext = false; throw Error('Synthetic offline host'); } fixture.answers.push(a); }} onSkip={async () => { fixture.answers.push([]); }} />
    <div className="mt-6 flex flex-wrap gap-2"><button className="btn btn-primary py-1! text-xs!">Create agent</button><button className="btn btn-outline py-1! text-xs!">Cancel</button><button className="btn btn-ghost h-6 w-6 p-0" aria-label="More actions">···</button></div>
  </main>);
};
fixture.showAnswer = async (live: boolean) => {
  const f = (window as any).layoutFixture;
  await f.showRetry();
  const record = f.records[0];
  record.messages = [{ id: 'prompt', role: 'user', content: 'Update the buttons, and check the question flow.', createdAt: 1 }];
  const output = formatAskAnswers(parsed.request, [{ questionId: 'q1', labels: ['Whole app'], note: 'Keep icons the same size.' }]);
  const events = [{ type: 'tool_call', call }, { type: 'tool_result', result: { toolCallId: call.id, output } }];
  if (live) { events.forEach(e => f.emit(e)); f.emit({ type: 'text', delta: 'Thanks. I’m applying your choices now.' }); }
  else {
    record.messages.push({ id: 'ask', role: 'assistant', content: '', createdAt: 2, toolCalls: [call] }, { id: 'answered', role: 'tool', content: output, createdAt: 3, toolResult: { toolCallId: call.id, output } }, { id: 'done', role: 'assistant', content: 'Thanks. I’m applying your choices now.', createdAt: 4 });
    f.putCachedSession({ ...record });
  }
};
