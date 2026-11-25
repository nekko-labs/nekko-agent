import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Markdown } from '../src/renderer/components/Markdown.js';
import '../src/renderer/styles.css';

// A reply whose text the sandbox grows, to show a Mermaid fence while it streams and once it closes.
function Stream() {
  const [text, setText] = useState('');
  (window as unknown as { setReply: (t: string) => void }).setReply = setText;
  return (
    <main className="min-h-screen bg-surface p-4 text-ink">
      <div className="mx-auto max-w-3xl"><Markdown text={text} topics runnable /></div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Stream />);
