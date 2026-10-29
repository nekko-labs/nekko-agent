import React from 'react';
import { NekkoAvatar } from './Mascot.js';
import type { AgentStatus } from './WorkspaceCard.js';

/**
 * The iPhone Live Activity's status badge (apps/ios/App/Shared/LiveStatusGlyph.swift):
 * the same tints and the same shapes, drawn dark on the tint.
 */
const BADGE: Record<AgentStatus, { tint: string; label: string; glyph: React.ReactNode }> = {
  working: { tint: '#4dc28a', label: 'Working', glyph: <path d="M12 2.5c2.6 2 3.8 5 3.8 8.6V16H8.2v-4.9c0-3.6 1.2-6.6 3.8-8.6zM8.2 12.5 5.8 15v2.2l2.4-1.2M15.8 12.5l2.4 2.5v2.2l-2.4-1.2M10.6 18.2 12 21.5l1.4-3.3" /> },
  input: { tint: '#ff9e0a', label: 'Needs you', glyph: <path d="M7.3 8a4.7 4.7 0 0 1 9.4 0c0 3.3-4.7 3.3-4.7 5.3M12 19.5h.01" /> },
  error: { tint: '#ff453a', label: 'Stopped with an error', glyph: <path d="M6 6l12 12M18 6 6 18" /> },
  done: { tint: '#30d159', label: 'Done', glyph: <path d="M4.7 12.7 10 18l9.3-12" /> },
  idle: { tint: '#0a85ff', label: 'Watching', glyph: <path d="M2.7 10.7H12l-9.3 10H12M14.7 3.3h6.6l-6.6 7.4h6.6" /> },
};

/**
 * A wall window's status: the Nekko pixel cat with the iPhone's status badge
 * on its lower right. Done makes the cat happy and watching puts it to sleep;
 * it never animates on the wall.
 */
export function WallMascot({ status, label }: { status: AgentStatus | undefined; label?: string }) {
  const badge = BADGE[status ?? 'done'];
  const mood = status === 'done' || status === undefined ? ' pixel-happy' : status === 'idle' ? ' pixel-sleeping' : '';
  return (
    <span className={`wall-mascot${mood}`} role="img" aria-label={label ?? badge.label} title={label ?? badge.label} data-wall-mascot={status ?? 'done'}>
      <NekkoAvatar size={20} stationary />
      <span className="wall-mascot-badge" style={{ background: badge.tint }} aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">{badge.glyph}</svg>
      </span>
    </span>
  );
}

/** An agent window's keyboard number, beside Nekko: Ctrl+1…9 selects it. */
export function WallNumber({ n }: { n?: number }) {
  if (n == null) return null;
  return <span className="wall-number" title={`Agent window ${n}${n <= 9 ? `: Ctrl+${n} selects it` : ''}`} aria-label={`Window ${n}`}>{n}</span>;
}
