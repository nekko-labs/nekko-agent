import React, { memo } from 'react';
import { createRoot } from 'react-dom/client';
import { ASK_CANCELLED, ASK_UNATTENDED } from '@nekko-agent/shared';
import { toTranscriptRows } from '__SOURCE__/components/agent-console/transcript.ts';
import { MessageBubble } from '__SOURCE__/components/agent-console/MessageBubble.tsx';
import { ActivityGroup } from '__SOURCE__/components/agent-console/ActivityGroup.tsx';
import { CompactionSummary } from '__SOURCE__/components/agent-console/CompactionSummary.tsx';
import { TurnStatsLine } from '__SOURCE__/components/agent-console/TurnStatsLine.tsx';
// No PR rows exist in this fixture. Keep the exact production row-view branches intact.
const PrCard = () => null;
__ROW_VIEW__
const w = window as any;
w.nekko = {};
const call = { id: 'ask-1', name: 'ask_user', input: { questions: [
  { id: 'theme', question: 'Which theme should the gallery use?', options: [{ id: 'dark', label: 'Dark' }, { id: 'light', label: 'Light' }] },
  { id: 'details', question: 'What should stay visible?', options: ['Answer only', 'Answer and assistant reply'], multiSelect: true },
] } };
const body = 'Q: Which theme should the gallery use?\nA: Dark\n\nQ: What should stay visible?\nA: The answer and the next assistant reply, including notes.';
const output = 'The user answered:\n\n' + body + '\n\nWork to these answers. Do not ask again about anything settled here.';
const message = (id: string, role: string, content: string, extra = {}) => ({ id, role, content, createdAt: 1791892800000, ...extra });
const initial = message('user-1', 'user', 'Please prepare the gallery.');
const ask = message('assistant-ask', 'assistant', '', { toolCalls: [call] });
const follow = message('assistant-follow', 'assistant', 'I will use the dark theme and keep your answer visible before this reply.');
const result = (text: string, isError = false) => message('tool-answer', 'tool', text, { toolResult: { toolCallId: call.id, output: text, isError } });
const cases = {
  answered: [initial, ask, result(output), follow],
  skipped: [initial, ask, result(ASK_CANCELLED), follow],
  unattended: [initial, ask, result(ASK_UNATTENDED), follow],
  error: [initial, ask, result('Question failed', true), follow],
  pending: [initial, ask],
};
const rowsByCase = Object.fromEntries(Object.entries(cases).map(([name, messages]) => [name, toTranscriptRows(messages as any, () => [], () => [])]));
const calls: any[] = [];
const log = (...args: any[]) => calls.push(args);
function App() {
  return <main style={{ maxWidth: 920, margin: '0 auto', padding: '24px 20px', color: 'var(--ink)' }}>
    <h1 style={{ fontSize: 20, marginBottom: 18 }}>Question / answer transcript</h1>
    {Object.entries(rowsByCase).map(([name, rows]) => <section id={name} key={name} style={{ borderTop: '1px solid var(--line)', paddingTop: 12, marginBottom: 18 }}>
      <h2 style={{ fontSize: 13, color: 'var(--ink-faint)', marginBottom: 10 }}>{name}</h2>
      {rows.map(row => <div key={row.key} data-row-key={row.key} data-display-only={row.kind === 'msg' && !!row.displayOnly} style={{ marginBottom: 12 }}>
        <TranscriptRowView row={row} streaming={false} readOnly={false} prByUrl={new Map()} sessionId="fixture" onEditResend={log} onCopyToComposer={log} onSplit={log} onImageClick={log} onImageContextMenu={log} />
      </div>)}
    </section>)}
  </main>;
}
w.fixture = { rowsByCase, cases, body, calls, check: () => {
  const projected = rowsByCase.answered.filter((r: any) => r.kind === 'msg' && r.message.id.endsWith('_ask_reply'));
  const content = (name: string) => document.getElementById(name)!.innerText;
  const synthetic = [...document.querySelectorAll('[data-display-only="true"]')];
  const forbidden = /Edit & resend|Rewind the chat|Split|Reuse|composer/i;
  const beforeKeys = toTranscriptRows(cases.answered.slice(0, 3) as any, () => [], () => []).map(r => r.key);
  return {
    qaVisible: content('answered').includes('Q: Which theme should the gallery use?') && content('answered').includes('A: Dark') && content('answered').includes('A: The answer and the next assistant reply, including notes.'),
    assistantVisible: content('answered').includes(follow.content),
    noWrapper: !document.body.innerText.includes('The user answered:') && !document.body.innerText.includes('Work to these answers.'),
    skippedVisible: content('skipped').includes('(skipped / not answered)'),
    unattendedVisible: content('unattended').includes('(not answered: unattended time limit)'),
    errorHasNoReply: !rowsByCase.error.some((r: any) => r.kind === 'msg' && r.message.id.endsWith('_ask_reply')),
    pendingHasNoReply: !rowsByCase.pending.some((r: any) => r.kind === 'msg' && r.message.id.endsWith('_ask_reply')),
    ordered: rowsByCase.answered.map(r => r.key).join('|') === 'm_user-1|act_assistant-ask_1|m_tool-answer_ask_reply|m_assistant-follow',
    stableKeys: beforeKeys.every((k, i) => k === rowsByCase.answered[i].key),
    displayOnly: projected.length === 1 && projected[0].displayOnly === true && !cases.answered.some(m => m.id === projected[0].message.id),
    noSyntheticEditOrReuse: synthetic.length === 3 && synthetic.every(el => [...el.querySelectorAll('button')].every(b => !forbidden.test((b.title || '') + b.textContent))),
    persistedControlsRemain: !!document.querySelector('#answered [data-row-key="m_user-1"] button[title="Edit & resend"]'),
    unchangedHistory: cases.answered[2].content === output && cases.answered.length === 4,
  };
} };
createRoot(document.getElementById('root')!).render(<App />);
