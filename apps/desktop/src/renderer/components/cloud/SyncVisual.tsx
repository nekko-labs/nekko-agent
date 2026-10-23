import { useEffect, useMemo, useState } from 'react';
import type { SyncPhase } from '@nekko-agent/shared';

/**
 * The sync picture: this device on the left, the encrypted vault in the
 * middle, the account's other devices on the right. While a sync runs, sealed
 * packets travel along the arcs and the vault reads out ciphertext; at rest
 * the picture is still (it costs nothing when nothing is happening, and
 * reduced motion keeps it still always).
 */
export function SyncVisual({ phase, others, direction }: { phase: SyncPhase; others: number; direction?: 'up' | 'down' | 'both' }) {
  const reduced = usePrefersReducedMotion();
  const moving = phase === 'syncing' && !reduced;
  const dim = phase === 'signed-out' || phase === 'off' || phase === 'needs-plan' || phase === 'paused';
  const tone = phase === 'error' ? 'error' : phase === 'idle' ? 'ok' : phase === 'awaiting-approval' || phase === 'needs-join' ? 'wait' : 'neutral';
  const right = useMemo(() => {
    const n = Math.max(1, Math.min(3, others || 1));
    return Array.from({ length: n }, (_, i) => 70 + (i - (n - 1) / 2) * 38);
  }, [others]);
  const kinds = ['phone', 'desktop', 'laptop'] as const;
  const up = 'M 66 70 C 100 30, 124 30, 146 66';
  const downs = right.map((y) => `M 174 70 C 206 ${y < 70 ? 30 : y > 70 ? 110 : 70}, 226 ${y}, 254 ${y}`);
  return (
    <div className={`sync-visual tone-${tone}${dim ? ' is-dim' : ''}${moving ? ' is-moving' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 320 140" role="presentation">
        <defs>
          <linearGradient id="sv-prism" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--accent)" />
            <stop offset="40%" stopColor="var(--accent-2)" />
            <stop offset="60%" stopColor="#46e0bd" />
            <stop offset="80%" stopColor="#ffbe5c" />
            <stop offset="100%" stopColor="#ff7eb6" />
          </linearGradient>
          <radialGradient id="sv-glow">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
        </defs>
        <path className="sv-arc" d={up} />
        {downs.map((d, i) => <path key={i} className="sv-arc" d={d} />)}
        <circle cx="160" cy="70" r="46" fill="url(#sv-glow)" className="sv-glow" />
        {moving && <circle cx="160" cy="70" r="30" className="sv-ripple" />}
        <Device x={52} y={70} kind="laptop" self />
        {right.map((y, i) => <Device key={i} x={268} y={y} kind={kinds[i % 3]} faded={!others} />)}
        <g className="sv-vault">
          <path d="M160 40 L184 52 L184 78 C184 92 173 101 160 106 C147 101 136 92 136 78 L136 52 Z" fill="var(--surface)" stroke="url(#sv-prism)" strokeWidth="2" />
          <rect x="151" y="70" width="18" height="14" rx="3" className="sv-lock-body" />
          <path d="M154 70 v-5 a6 6 0 0 1 12 0 v5" fill="none" className="sv-lock-shackle" strokeWidth="2.4" strokeLinecap="round" />
          {tone === 'ok' && <circle cx="178" cy="98" r="7" className="sv-ok" />}
          {tone === 'ok' && <path d="M174.8 98 l2.2 2.2 l4.2 -4.4" className="sv-ok-tick" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />}
        </g>
        {moving && (
          <>
            {direction !== 'down' && [0, 0.55, 1.1].map((delay) => <Packet key={`u${delay}`} path={up} delay={delay} />)}
            {direction !== 'up' && downs.flatMap((d, i) => [0.3, 0.95].map((delay) => <Packet key={`d${i}${delay}`} path={d} delay={delay + i * 0.2} />))}
          </>
        )}
      </svg>
      {moving && <Cipher />}
    </div>
  );
}

function Packet({ path, delay }: { path: string; delay: number }) {
  return (
    // Hidden until its motion starts, or it would wait at the picture's origin.
    <g className="sv-packet" visibility="hidden">
      <set attributeName="visibility" to="visible" begin={`${delay}s`} />
      <rect x="-6" y="-4.5" width="12" height="9" rx="2.5" fill="url(#sv-prism)" />
      <rect x="-2.2" y="-1.2" width="4.4" height="3.4" rx="0.8" fill="var(--surface)" opacity="0.9" />
      <animateMotion dur="1.6s" begin={`${delay}s`} repeatCount="indefinite" path={path} keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines="0.45 0 0.25 1" />
    </g>
  );
}

function Device({ x, y, kind, self = false, faded = false }: { x: number; y: number; kind: 'laptop' | 'desktop' | 'phone'; self?: boolean; faded?: boolean }) {
  return (
    <g className={`sv-device${self ? ' is-self' : ''}${faded ? ' is-faded' : ''}`} transform={`translate(${x} ${y})`}>
      <circle r="17" className="sv-device-bg" />
      {kind === 'phone' && <rect x="-5.5" y="-9" width="11" height="18" rx="2.5" className="sv-glyph" />}
      {kind === 'desktop' && <><rect x="-9" y="-8" width="18" height="12" rx="2" className="sv-glyph" /><path d="M-4 8 h8 M0 4 v4" className="sv-glyph" /></>}
      {kind === 'laptop' && <><rect x="-8" y="-7" width="16" height="11" rx="1.6" className="sv-glyph" /><path d="M-11 7 h22" className="sv-glyph" /></>}
    </g>
  );
}

/** A short line of ciphertext under the vault: what the server actually sees. */
function Cipher() {
  const [text, setText] = useState(() => randomHex());
  useEffect(() => {
    const t = setInterval(() => setText(randomHex()), 140);
    return () => clearInterval(t);
  }, []);
  return <div className="sync-visual-cipher">{text}</div>;
}

function randomHex() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
}

function usePrefersReducedMotion() {
  const query = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const [reduced, setReduced] = useState(() => !!query?.matches);
  useEffect(() => {
    if (!query) return;
    const on = () => setReduced(query.matches);
    query.addEventListener('change', on);
    return () => query.removeEventListener('change', on);
  }, [query]);
  return reduced;
}
