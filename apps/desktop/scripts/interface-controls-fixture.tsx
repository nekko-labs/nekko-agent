// Real shared controls with synthetic drafts only. No bridge, host, clipboard or network.
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FollowUpChoices } from '../src/renderer/components/FollowUpChoices';
import { MarkdownEditor, type MarkdownEditorElement } from '../src/renderer/components/agent-console/MarkdownEditor';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '../src/renderer/styles.css';

function Fixture() {
  const [value, setValue] = useState('Make the next step feel simple and connected.');
  const [position, setPosition] = useState('normal');
  const [canDelegate, setCanDelegate] = useState(true);
  const editor = useRef<MarkdownEditorElement>(null);
  Object.assign(window, { interfaceFixture: { editor, setValue, setPosition, setCanDelegate, sends: (window as any).interfaceFixture?.sends ?? [] } });
  return <main style={{ height: '100vh', background: 'var(--paper)', padding: 16, color: 'var(--ink)' }}>
    <style>{'@media(max-width:600px){[data-neighbor]{display:none}[data-agent-pane]{width:100%!important}}'}</style>
    <header className="mb-4 text-sm text-ink-soft">Nekko Agent · Isolated interface verification</header>
    <div style={{ display: 'flex', gap: 16 }}>
      <section data-agent-pane className="card p-4" style={{ width: 360, maxWidth: '100%', overflow: 'hidden' }}>
        <h2 className="mb-2 text-sm font-semibold">Refine the follow-up controls</h2>
        <p className="text-xs text-ink-soft">The changes are ready. Choose the next step.</p>
        <FollowUpChoices options={['Check the latest CI and merge the PR', 'Inspect the saved screenshots']} canDelegate={canDelegate} onSend={text => (window as any).interfaceFixture.sends.push(text)} />
        <div style={position === 'normal' ? { marginTop: 160 } : { position: 'fixed', top: position === 'top' ? 12 : 360, ...(position === 'right' ? { right: 16 } : { left: 32 }), width: 300 }}>
          <MarkdownEditor ref={editor} value={value} onChange={setValue} onKeyDown={() => {}} disabled={false} aria-expanded={false} placeholder="Message" className="min-h-24 rounded-xl border border-line bg-surface p-3 text-sm whitespace-pre-wrap outline-hidden" />
        </div>
      </section>
      <section className="card p-4 text-xs text-ink-soft" style={{ flex: 1, minWidth: 0 }} data-neighbor>
        <h2 className="mb-2 text-sm font-semibold text-ink">Another agent</h2>
        Working independently. Formatting tools can extend over this pane.
      </section>
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
