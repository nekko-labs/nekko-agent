// Shared pieces for the pillar demos: the app's theme tokens, fonts, timing
// helpers and the small marks (pixel cat, status dot, check).
import React, { createContext, useContext } from 'react';
import { Easing, interpolate, staticFile, useCurrentFrame } from 'remotion';

export const FPS = 30;
export const FRAMES = 240; // 8 s

export type Theme = {
  paper: string; win: string; surface: string; surface2: string; ink: string; soft: string;
  faint: string; line: string; accent: string; accentSoft: string; ok: string; warn: string;
  shadow: string; codeBg: string;
};
export const THEMES: Record<'dark' | 'light', Theme> = {
  dark: {
    paper: '#0c0c11', win: '#17171e', surface: '#16161c', surface2: '#20202a', ink: '#eceaf3',
    soft: '#a3a1b0', faint: '#898894', line: '#26262f', accent: '#c084b5',
    accentSoft: 'rgba(192,132,181,0.18)', ok: '#4cc38a', warn: '#e5a54b',
    shadow: '0 24px 60px rgba(0,0,0,0.55)', codeBg: '#111116',
  },
  light: {
    paper: '#fbfbfd', win: '#fcfcfe', surface: '#ffffff', surface2: '#f2f2f7', ink: '#17171d',
    soft: '#52525e', faint: '#6c6c77', line: '#e8e8ef', accent: '#5a2352',
    accentSoft: 'rgba(90,35,82,0.11)', ok: '#1f8a55', warn: '#a8650c',
    shadow: '0 24px 60px rgba(40,20,50,0.14)', codeBg: '#f6f6fa',
  },
};
export const Th = createContext<Theme>(THEMES.dark);
export const useT = () => useContext(Th);

export const fontCss = `
@font-face{font-family:'Inter Tight';font-weight:100 900;src:url(${staticFile('fonts/inter-tight-latin-wght-normal.woff2')}) format('woff2');}
@font-face{font-family:'JetBrains Mono';font-weight:100 900;src:url(${staticFile('fonts/jetbrains-mono-latin-wght-normal.woff2')}) format('woff2');}
`;
export const SANS = "'Inter Tight', system-ui, sans-serif";
export const MONO = "'JetBrains Mono', ui-monospace, monospace";

export const ease = Easing.bezier(0.22, 1, 0.36, 1);
export const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
/** 0 -> 1 between frames a and b, eased. */
export const p = (f: number, a: number, b: number) => interpolate(f, [a, b], [0, 1], { ...clamp, easing: ease });
/** Typewriter: the first n characters of text between frames a and b. */
export const typed = (f: number, a: number, b: number, text: string) =>
  text.slice(0, Math.round(interpolate(f, [a, b], [0, text.length], clamp)));

/** Enter: fade, un-blur and a small rise. */
export function In({ at, children, style, dur = 12 }: { at: number; children: React.ReactNode; style?: React.CSSProperties; dur?: number }) {
  const f = useCurrentFrame();
  const v = p(f, at, at + dur);
  return <div style={{ ...style, opacity: v * ((style?.opacity as number) ?? 1), filter: `blur(${(1 - v) * 8}px)`, transform: `translateY(${(1 - v) * 14}px)` }}>{children}</div>;
}

/** The app's PixelHead (apps/desktop/src/renderer/components/Mascot.tsx). */
export function Cat({ size, eyes = 'open' }: { size: number; eyes?: 'open' | 'happy' }) {
  const t = useT();
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} shapeRendering="crispEdges">
      <path d="M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z" fill={t.paper} stroke={t.ink} strokeWidth="2" strokeLinejoin="miter" />
      <path fill={t.ink} d={eyes === 'open'
        ? 'M11 15H13V18H11Z M20 15H22V18H20Z'
        : 'M9 17H10V15H11V14H12V15H13V17H12V16H10V17Z M19 17H20V15H21V14H22V15H23V17H22V16H20V17Z'} />
      <path d="M15 20H17V21H15Z" fill={t.accent} />
    </svg>
  );
}

export function Dot({ color, pulse = 0 }: { color: string; pulse?: number }) {
  return <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 5, background: color, boxShadow: pulse ? `0 0 0 ${4 * pulse}px ${color}33` : 'none', flexShrink: 0 }} />;
}

export function Check({ size = 18, color }: { size?: number; color: string }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3 3 7-7" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

