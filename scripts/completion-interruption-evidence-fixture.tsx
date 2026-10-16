import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageBubble } from '../apps/desktop/src/renderer/components/agent-console/MessageBubble';
import * as interruptionHelpers from '../apps/desktop/src/renderer/components/agent-console/interruption';
import { CloseIcon } from '../apps/desktop/src/renderer/icons';
import { useStore } from '../apps/desktop/src/renderer/store';
import '../apps/desktop/src/renderer/styles.css';
const { PERSISTED_INTERRUPTION, shouldShowPersistedInterruption, describeInterruption } = interruptionHelpers;
// RECONCILE_IMPORT
const stale: any[] = [
  { id: 'user', role: 'user', content: 'Check the synthetic fixture and summarize the result.', createdAt: 1 },
  { id: 'tool', role: 'assistant', content: '', toolCalls: [{ id: 'call', name: 'read_file', input: { path: 'fixture.txt' } }], createdAt: 2 },
];
const final: any = { id: 'final', role: 'assistant', content: 'The synthetic fixture has been checked. All requested verification steps are complete.', createdAt: 3, turnStats: { providerId: 'fixture', modelId: 'fixture-model', inputTokens: 120, outputTokens: 30, wallMs: 1500, calls: 1, stop: 'complete' } };
const complete = [...stale, final];
const interrupted = [...stale, { ...final, content: 'The synthetic fixture check was cut off before completion.', interrupted: true, turnStats: { ...final.turnStats, stop: 'interrupted' } }];
Object.assign(window, { nekko: new Proxy({}, { get: (_, key: string) => key.startsWith('on') ? () => () => {} : () => Promise.resolve(null) }) });
useStore.setState({ sessions: [], settings: { workspaces: [], providers: [], agent: {}, ui: {} } } as any);
function Fixture() {
  const [session, setSession] = useState<any>({ messages: complete });
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [dismissedInterruption, setDismissedInterruption] = useState<string | null>(null);
  const streaming = false, held = false, question = false, finalizingReply = { current: false };
  const lastMsgId = session.messages.at(-1)?.id;
  const canContinueReply = true, ctx = null, ctxUsed = 0;
  const resumeRun = () => {};
  // ACTUAL_EFFECT
  useEffect(() => {
    Object.assign(window, { evidence: {
      setScenario(name: string) {
        setDismissedInterruption(null);
        setErrorNotice(name === 'stopped' ? 'Stopped' : name === 'provider' ? 'Provider disconnected' : null);
        setSession({ messages: name === 'interrupted' ? interrupted : name === 'stale' ? stale : complete });
      },
      reconcile() { setSession({ messages: complete }); },
      state: { errorNotice, lastMsgId },
      helperChecks: {
        complete: shouldShowPersistedInterruption(complete, false, false),
        interrupted: shouldShowPersistedInterruption(interrupted, false, false),
        stale: shouldShowPersistedInterruption(stale, false, false),
        held: shouldShowPersistedInterruption(stale, false, true),
        streaming: shouldShowPersistedInterruption(stale, true, false),
      },
    } });
  });
  return <main className="bg-paper text-ink" style={{ minHeight: '100vh', padding: 20 }}>
    <section style={{ maxWidth: 880, margin: '0 auto' }}>
      <header className="mb-5 border-b border-border pb-3 text-sm font-semibold">Completion and interruption verification</header>
      <div className="space-y-5" data-transcript>
        {session.messages.map((message: any) => <MessageBubble key={message.id} message={message} chronological />)}
      </div>
      <div className="mt-5" data-notice>
        {/* ACTUAL_NOTICE */}
      </div>
    </section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
