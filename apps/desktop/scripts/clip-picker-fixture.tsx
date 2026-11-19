// Synthetic only: a paid cloud clip's choice card, as the composer shows it (#2973).
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QuestionCard } from '../src/renderer/components/QuestionCard';
import '../src/renderer/styles.css';
const opt = (label: string, description: string) => ({ label, description });
const request: any = {
  callId: 'c_veo-clip', askedAt: Date.now(),
  questions: [
    { id: 'q1', header: 'Length', question: 'How long should the clip be?', options: [opt('4 seconds', '$0.80 (suggested)'), opt('6 seconds', '$1.20'), opt('8 seconds', '$1.60')] },
    { id: 'q2', header: 'Audio', question: 'Should the clip have sound?', options: [opt('No audio', '$0.80 (suggested)'), opt('With audio', '$1.60')] },
    { id: 'q3', header: 'Resolution', question: 'At which resolution?', options: [opt('720p', '$0.80 (suggested)'), opt('1080p', '$0.80')] },
  ],
  clip: { model: 'Veo 3.1', via: 'OpenRouter', sendsPicture: false, prices: Object.fromEntries(
    ['4', '6', '8'].flatMap(s => ['No audio', 'With audio'].flatMap(a => ['720p', '1080p'].map(r =>
      [`${s} seconds|${a}|${r}`, Number(s) * (a === 'With audio' ? 0.4 : 0.2)])))) },
};
(window as any).nekko = new Proxy({}, { get: (_t, k: string) => (k.startsWith('on') ? () => () => {} : async () => null) });
(window as any).clipFixture = true;
createRoot(document.getElementById('root')!).render(<div style={{ padding: 24, maxWidth: 620 }}>
  <QuestionCard request={request} onAnswer={() => {}} onSkip={() => {}} />
</div>);
