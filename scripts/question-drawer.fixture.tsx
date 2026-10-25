import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VirtualTranscript } from '__SOURCE__/components/agent-console/VirtualTranscript';
import { QuestionCard } from '__SOURCE__/components/QuestionCard';
const request = { callId: 'fixture', askedAt: 0, questions: [
  { id: 'context', header: 'Issue context', question: 'What should I include in the tracking issue?', options: [
    { label: 'Feature summary only', description: 'Describe the change without quoting the conversation.' },
    { label: 'Include request', description: 'Include the original request and relevant reference screenshots.' },
    { label: 'Remember for this project', description: 'Save this choice for future changes in this project.' },
  ] },
  { id: 'theme', header: 'Theme', question: 'Which themes should I verify?', multiSelect: true, options: [{ label: 'Light' }, { label: 'Dark' }] },
] };
const rows = Array.from({ length: 10 }, (_, i) => ({ key: `row-${i}`, text: i % 2 ? 'I found the shared question card. I will keep the keyboard controls and move the question into the conversation.' : 'Please make the question feel like part of the conversation, with one shared scroll area.' }));
function Fixture() {
  const [pending, setPending] = useState(!location.search.includes('motion'));
  const [answer, setAnswer] = useState('');
  const card = pending ? <QuestionCard request={request} onAnswer={a => { setAnswer(JSON.stringify(a)); setPending(false); }} onSkip={() => { setAnswer('skipped'); setPending(false); }} tone="attention" /> : <p data-answer>{answer}</p>;
  Object.assign(window, { fixture: { open: () => setPending(true) } });
  return <main style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--paper)', color: 'var(--ink)' }}>
    <header style={{ padding: 16, borderBottom: '1px solid var(--line)' }}>Conversation question drawer <small>(synthetic fixture)</small></header>
    {__BASELINE__ && pending && <div className="agent-question-pin shrink-0" data-agent-question><p className="agent-question-pin-label">Asked you a question</p><div className="agent-question-pin-body">{card}</div></div>}
    <VirtualTranscript rows={rows} renderRow={r => <p style={{ padding: 14, background: 'var(--surface)', borderRadius: 10 }}>{r.text}</p>} estimate={() => 100} cacheKey="fixture" className="w-full px-4 space-y-5" footer={<><p style={{ paddingTop: 16 }}>Waiting for your answer</p>{!__BASELINE__ && <div className="conversation-question" data-agent-question>{card}</div>}</>} />
    <footer style={{ padding: 16, borderTop: '1px solid var(--line)' }}>Message composer</footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
