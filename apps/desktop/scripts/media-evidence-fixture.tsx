// Real creation/intro components, synthetic data, no host or provider connection.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CreateMenuRows, type CreateKind } from '../src/renderer/components/CreateMenu';
import { MediaAgentWelcome } from '../src/renderer/components/MediaAgentIntro';
import '@fontsource-variable/inter-tight';
import '../src/renderer/styles.css';
function Fixture() {
  const [kind, setKind] = useState<CreateKind | null>(null);
  Object.assign(window, { mediaFixture: { reset: () => setKind(null), choose: setKind } });
  return <main style={{ minHeight: '100dvh', background: 'var(--paper)', color: 'var(--ink)', padding: 24 }}>
    <header style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 40 }}><strong>Nekko</strong><span>Agent types</span></header>
    <div style={{ maxWidth: 340, margin: 'auto', border: '1px solid var(--line)', borderRadius: 18, padding: 8 }}><CreateMenuRows onCreate={setKind} /></div>
    {(kind === 'image' || (kind as string) === 'video') && <MediaAgentWelcome key={kind} kind={kind as 'image' | 'video'} />}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
