import React from 'react';
import { createRoot } from 'react-dom/client';
import { MessageBubble } from '../src/renderer/components/agent-console/MessageBubble.js';
import '../src/renderer/styles.css';
import type { ChatMessage } from '@nekko-agent/shared';

// A chat synced from another computer (#3298): one picture here, one still on its way, one an older sync left out.
const canvas = document.createElement('canvas');
canvas.width = canvas.height = 208;
const g = canvas.getContext('2d')!;
const grad = g.createLinearGradient(0, 0, 208, 208);
grad.addColorStop(0, '#5b6cff'); grad.addColorStop(1, '#ff7ab6');
g.fillStyle = grad; g.fillRect(0, 0, 208, 208);
g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect(24, 40, 160, 18); g.fillRect(24, 72, 110, 18); g.fillRect(24, 140, 160, 44);
const here = canvas.toDataURL('image/png');

const user = {
  id: 'u1', role: 'user', createdAt: 1793757600000, content: 'Why is the checkout button cut off on these?',
  images: [here, `nekko-blob:${'a'.repeat(64)}.png`, '[picture not synced]'],
} as ChatMessage;
const reply = { id: 'a1', role: 'assistant', createdAt: 1793757660000, content: 'The button sits in a fixed-height row, so the label wraps under it at narrow widths.' } as ChatMessage;

createRoot(document.getElementById('root')!).render(
  <main className="min-h-screen bg-surface p-4 text-ink">
    <div className="mx-auto max-w-3xl space-y-4">
      <MessageBubble message={user} />
      <MessageBubble message={reply} />
    </div>
  </main>,
);
