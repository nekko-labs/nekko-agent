// Shared frame for the concept animations. Everything visual comes from the pillar
// demos: kit.tsx is imported as is, and Stage / Label / AppWindow / Composer are
// copies of the unexported pieces in video/pillars/src/index.tsx (same values).
// The only additions are the "Concept" tag, the on-screen headline and the
// "Illustrative" footer that the overnight brief asks for.
import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Cat, Check, Dot, In, MONO, SANS, THEMES, Th, clamp, fontCss, p, typed, useT, ease } from '../../../../video/pillars/src/kit';

export { Cat, Check, Dot, In, MONO, SANS, THEMES, Th, clamp, p, typed, useT, ease };
export const W = 1280, H = 720;
export const INFO = { dark: '#6BB8D4', light: '#1F6680' };
export const useInfo = () => (useT() === THEMES.light ? INFO.light : INFO.dark);
export const useIsLight = () => useT() === THEMES.light;

/** Pillar Stage with a variable length: fades in from and out to paper, so it loops. */
export function Stage({ theme, frames, children }: { theme: 'dark' | 'light'; frames: number; children: React.ReactNode }) {
  const f = useCurrentFrame();
  const t = THEMES[theme];
  const o = Math.min(p(f, 0, 10), 1 - p(f, frames - 12, frames - 1));
  return (
    <Th.Provider value={t}>
      <AbsoluteFill style={{ background: t.paper, color: t.ink, fontFamily: SANS, overflow: 'hidden' }}>
        <style>{fontCss}</style>
        <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>
        <ConceptTag />
      </AbsoluteFill>
    </Th.Provider>
  );
}

/** Small "Concept" tag, top right. Stays on screen for the whole loop. */
function ConceptTag() {
  const t = useT();
  return <div style={{ position: 'absolute', right: 40, top: 36, fontFamily: MONO, fontSize: 15, color: t.faint, border: `1px solid ${t.line}`, borderRadius: 8, padding: '4px 10px' }}>Concept</div>;
}

/** The headline, 30/600 like the Fleet pillar's "Your fleet". */
export function Headline({ children, at = 2 }: { children: React.ReactNode; at?: number }) {
  return <In at={at} style={{ position: 'absolute', left: 60, top: 34 }}><div style={{ fontSize: 30, fontWeight: 600 }}>{children}</div></In>;
}

/** Footer meta, like the Speed pillar's source line. */
const MACHINE = 'Qwen3-32B on MacBook Pro M5 Max, 64 GB';
export function Footer({ left, right = 'Illustrative numbers', machine = true }: { left?: React.ReactNode; right?: React.ReactNode; machine?: boolean }) {
  const t = useT();
  if (machine) right = right ? `${MACHINE} · illustrative` : `Local model: ${MACHINE}`;
  return (
    <div style={{ position: 'absolute', left: 60, right: 60, bottom: 22, display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 15, color: t.faint }}>
      <span>{left}</span><span>{right}</span>
    </div>
  );
}

export function Label({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  const t = useT();
  return <div style={{ fontSize: 22, fontWeight: 500, color: t.soft, ...style }}>{children}</div>;
}

export function AppWindow({ x, y, w, h, title, children }: { x: number; y: number; w: number; h: number; title: string; children?: React.ReactNode }) {
  const t = useT();
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, background: t.win, borderRadius: 16, border: `1px solid ${t.line}`, boxShadow: t.shadow, overflow: 'hidden' }}>
      <div style={{ height: 52, display: 'flex', alignItems: 'center', gap: 12, padding: '0 20px', borderBottom: `1px solid ${t.line}` }}>
        <Cat size={24} />
        <span style={{ fontSize: 20, fontWeight: 600 }}>{title}</span>
      </div>
      <div style={{ position: 'absolute', inset: '52px 0 0 0' }}>{children}</div>
    </div>
  );
}

export function Composer({ text, model, placeholder = 'Message Nekko Agent…', caret }: { text: string; model: string; placeholder?: string; caret?: boolean }) {
  const t = useT();
  return (
    <div style={{ border: `1px solid ${t.line}`, borderRadius: 14, background: t.surface, padding: '16px 18px 12px' }}>
      <div style={{ fontSize: 22, minHeight: 30, color: text ? t.ink : t.faint }}>
        {text || placeholder}{caret && <span style={{ borderLeft: `2px solid ${t.accent}`, marginLeft: 2 }} />}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 14, fontSize: 18, color: t.soft }}>
        <span style={{ fontSize: 22 }}>+</span>
        <span style={{ color: t.ink, fontWeight: 500 }}>{model} ▾</span>
        <span>Works on its own ▾</span>
      </div>
    </div>
  );
}

/** User bubble, as in the Local and Photo pillars. */
export function Bubble({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  const t = useT();
  return <div style={{ marginLeft: 'auto', width: 'fit-content', maxWidth: 470, background: t.surface2, borderRadius: 14, padding: '10px 16px', fontSize: 20, lineHeight: '28px', ...style }}>{children}</div>;
}

/** 4px meter, as in Speed and Fleet. */
export function Bar({ v, color, style }: { v: number; color?: string; style?: React.CSSProperties }) {
  const t = useT();
  return (
    <div style={{ height: 4, borderRadius: 2, background: t.surface2, ...style }}>
      <div style={{ height: 4, borderRadius: 2, width: `${Math.max(0, Math.min(1, v)) * 100}%`, background: color ?? t.accent }} />
    </div>
  );
}

/** Skeleton reply lines that fill with progress (Fleet lanes). */
export function Skeleton({ prog, widths = [0.92, 0.78, 0.6] }: { prog: number; widths?: number[] }) {
  const t = useT();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {widths.map((wdt, j) => (
        <div key={j} style={{ height: 10, borderRadius: 5, background: t.surface2, width: `${wdt * 100}%`, overflow: 'hidden' }}>
          <div style={{ height: 10, background: `${t.soft}55`, width: `${interpolate(prog, [j / widths.length, (j + 1) / widths.length], [0, 100], clamp)}%` }} />
        </div>
      ))}
    </div>
  );
}

/** The Privacy pillar's padlock. */
export function Lock({ color, size = 20 }: { color: string; size?: number }) {
  return <svg width={size} height={size * 1.1} viewBox="0 0 20 22" fill="none"><rect x="2" y="9" width="16" height="12" rx="3" stroke={color} strokeWidth="2" /><path d="M6 9V6a4 4 0 0 1 8 0v3" stroke={color} strokeWidth="2" /></svg>;
}

/** A placeholder chip, as the Privacy pillar draws [PII_EMAIL_1]. */
export function Chip({ children }: { children: React.ReactNode }) {
  const t = useT();
  return <span style={{ fontFamily: MONO, fontSize: '0.84em', color: t.accent, background: t.accentSoft, padding: '2px 8px', borderRadius: 6 }}>{children}</span>;
}

/** Done / Working line from the Fleet lanes. */
export function Status({ done, children = 'Done', working = 'Working…' }: { done: boolean; children?: React.ReactNode; working?: React.ReactNode }) {
  const t = useT();
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 18, color: done ? t.ink : t.faint }}>{done ? <><Check size={16} color={t.ok} /> {children}</> : working}</div>;
}

/** A dot travelling a straight line between two points while a <= f <= b. */
export function Travel({ x1, y1, x2, y2, a, b, color, size = 10 }: { x1: number; y1: number; x2: number; y2: number; a: number; b: number; color: string; size?: number }) {
  const f = useCurrentFrame();
  if (f < a || f > b) return null;
  const k = p(f, a, b);
  return <div style={{ position: 'absolute', left: x1 + (x2 - x1) * k - size / 2, top: y1 + (y2 - y1) * k - size / 2, width: size, height: size, borderRadius: size / 2, background: color, boxShadow: `0 0 10px ${color}` }} />;
}

/** A thin connector line (hairline or dashed). */
export function Wire({ x1, y1, x2, y2, color, dashed, opacity = 1 }: { x1: number; y1: number; x2: number; y2: number; color: string; dashed?: boolean; opacity?: number }) {
  return (
    <svg style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', opacity }} width={1} height={1}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={1.5} strokeDasharray={dashed ? '5 6' : undefined} />
    </svg>
  );
}

export const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
