import React, { useEffect, useState } from 'react';
import { AbsoluteFill, Easing, continueRender, delayRender, interpolate, useCurrentFrame } from 'remotion';
import { NekkoHead, Peek, PeekNekko, Sparkle } from './Nekko.js';

/*
 * Shared look for the Windows install help videos, following docs/design-system.md
 * (quiet surfaces, decisions 0071 and 0075):
 * - Dusk tokens, read as CSS variables, never hex in our own chrome. The Windows and Edge
 *   mockups are third-party UI and keep their own colours, like provider logos do.
 * - Geist, sentence case, no tracked caps; sizes are the type ladder doubled for video.
 * - One quiet surface with a hairline. Plum only for intent (the focus ring on what to click).
 *   Petrol for information. Space before lines.
 * - Motion is short and decelerating, moves 8px at most, never bounces or loops.
 */
export const TOKENS: React.CSSProperties = {
  ['--paper' as string]: '#0B0C14',
  ['--surface' as string]: '#14151F',
  ['--surface-2' as string]: '#1D1F2C',
  ['--line' as string]: '#252735',
  ['--ink' as string]: '#FFFFFF',
  ['--ink-soft' as string]: '#A3A4B6',
  ['--ink-faint' as string]: '#87899B',
  ['--accent' as string]: '#C084B5',
  ['--accent-edge' as string]: '#854F6C',
  ['--plum' as string]: '#190019',
  ['--info' as string]: '#6BB8D4',
  ['--shadow-float' as string]: '0 16px 40px rgba(0,0,0,.45)',
};
export const v = (name: string) => `var(--${name})`;

export const SANS = "'Geist', system-ui, 'Segoe UI', sans-serif";
export const MONO = "'Geist Mono', ui-monospace, 'Cascadia Mono', monospace";
/** Windows and Edge mockups use the Windows system face, as the real dialogs do. */
export const WIN = "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif";

export const FPS = 30;
export const STAGE = { w: 1600, h: 900 };
/** 200ms, the design system's --dur-med. */
export const MED = 6;

const easeOut = Easing.bezier(0.16, 1, 0.3, 1);

/** 0 to 1 across [start, start + dur], decelerating and clamped. */
export function prog(frame: number, start: number, dur: number) {
  return interpolate(frame, [start, start + dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: easeOut });
}

/** Fades in at `from` over 200ms, out before `to` about 25% faster. */
export function shown(frame: number, from: number, to: number, fade = MED) {
  const out = Math.max(3, Math.round(fade * 0.75));
  return Math.min(prog(frame, from, fade), 1 - prog(frame, to - out, out));
}

const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap';

/** Loads Geist and Geist Mono before rendering. */
export function Fonts() {
  const [handle] = useState(() => delayRender('Geist'));
  useEffect(() => {
    let done = false;
    const finish = () => { if (!done) { done = true; continueRender(handle); } };
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = FONT_CSS;
    link.onload = () => {
      const faces = ['400 40px "Geist"', '500 40px "Geist"', '600 40px "Geist"', '400 20px "Geist Mono"'];
      Promise.all(faces.map((f) => document.fonts.load(f))).then(finish, finish);
    };
    link.onerror = finish;
    document.head.appendChild(link);
    const timer = setTimeout(finish, 8000);
    return () => clearTimeout(timer);
  }, [handle]);
  return null;
}

export type Layout = 'wide' | 'tall';
export const SIZE = { wide: { width: 1920, height: 1080 }, tall: { width: 1080, height: 1920 } };

export type Cap = { from: number; to: number; text: string; step?: string };

/** Screen geometry per layout: stage scale and position, Nekko's grid unit, text slots. 20px grid. */
const GEO = {
  wide: { s: 0.8, x: 320, y: 160, u: 4, label: { left: 320, top: 32 }, cap: { bottom: 80 }, capSize: 38, stepSize: 24, note: 1032, noteSize: 22 },
  tall: { s: 0.625, x: 40, y: 640, u: 4, label: { left: 40, top: 500 }, cap: { top: 1260 }, capSize: 52, stepSize: 28, note: 1780, noteSize: 26 },
};

export type FrameProps = {
  layout: Layout;
  label: string;
  captions: Cap[];
  note: string;
  /** Where Nekko peeks over the screen's top edge, in stage x. */
  peek: (frame: number) => Peek | null;
  sparkle?: [number, number];
  end: { from: number; title: string; lines: { text: string; info?: boolean }[] };
  children: React.ReactNode;
};

export function Frame({ layout, label, captions, note, peek, sparkle, end, children }: FrameProps) {
  const frame = useCurrentFrame();
  const g = GEO[layout];
  const endO = prog(frame, end.from, 9);
  const p = peek(frame);
  const nx = p ? g.x + p.x * g.s : 0;
  return (
    <AbsoluteFill style={{ ...TOKENS, background: v('paper'), fontFamily: SANS, overflow: 'hidden' }}>
      <Fonts />
      <div style={{ opacity: 1 - endO }}>
        <div style={{ position: 'absolute', ...g.label, fontSize: layout === 'tall' ? 28 : 24, fontWeight: 500, color: v('ink-soft') }}>{label}</div>
        <div style={{ position: 'absolute', left: g.x, top: g.y, width: STAGE.w * g.s, height: STAGE.h * g.s, borderRadius: 16, overflow: 'hidden', boxShadow: `0 0 0 1px ${v('line')}` }}>
          <div style={{ position: 'absolute', left: 0, top: 0, width: STAGE.w, height: STAGE.h, transform: `scale(${g.s})`, transformOrigin: '0 0' }}>{children}</div>
        </div>
        {p && <PeekNekko frame={frame} x={nx} edgeY={g.y + 1} u={g.u} peek={p} seed={23} />}
        {p && sparkle && frame >= sparkle[0] && frame < sparkle[1] && <Sparkle frame={frame} x={nx + 15 * g.u} y={g.y - 34 * g.u} u={g.u} />}
        {captions.map((c, i) => {
          const o = shown(frame, c.from, c.to);
          if (o <= 0) return null;
          return (
            <div key={i} style={{ position: 'absolute', left: 60, right: 60, ...g.cap, opacity: o, transform: `translateY(${(1 - prog(frame, c.from, MED)) * 8}px)`, textAlign: 'center' }}>
              {c.step && <div style={{ fontSize: g.stepSize, fontWeight: 500, color: v('ink-soft'), marginBottom: 8 }}>{c.step}</div>}
              <div style={{ color: v('ink'), fontSize: g.capSize, fontWeight: 600, lineHeight: 1.2 }}>{c.text}</div>
            </div>
          );
        })}
        <div style={{ position: 'absolute', left: 40, right: 40, top: g.note, textAlign: 'center', color: v('ink-faint'), fontSize: g.noteSize }}>{note}</div>
      </div>
      {endO > 0 && (
        <AbsoluteFill style={{ opacity: endO, transform: `translateY(${(1 - endO) * 8}px)`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 80px', textAlign: 'center' }}>
          <NekkoHead frame={frame} size={layout === 'tall' ? 160 : 128} mood={frame >= end.from + 18 && frame < end.from + 66 ? 'happy' : 'open'} seed={5} />
          <div style={{ marginTop: 40, color: v('ink'), fontSize: layout === 'tall' ? 52 : 48, fontWeight: 600, lineHeight: 1.2, maxWidth: 1400 }}>{end.title}</div>
          {end.lines.map((l, i) => (
            <div key={i} style={{ marginTop: i === 0 ? 20 : 8, opacity: prog(frame, end.from + 8 + i * 6, MED), display: 'flex', alignItems: 'center', gap: 12, fontSize: layout === 'tall' ? 30 : 28, color: l.info ? v('info') : v('ink-soft') }}>
              {l.info && <span style={{ width: 12, height: 12, borderRadius: 99, background: v('info') }} />}
              {l.text}
            </div>
          ))}
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
}

/** A Windows arrow pointer that glides between waypoints and presses on clicks. */
export function Cursor({ path, clicks = [], from = 0, to = 1e9 }: { path: [number, number, number][]; clicks?: number[]; from?: number; to?: number }) {
  const frame = useCurrentFrame();
  if (frame < from || frame > to) return null;
  let x = path[0][1];
  let y = path[0][2];
  for (let i = 1; i < path.length; i++) {
    const [f0, x0, y0] = path[i - 1];
    const [f1, x1, y1] = path[i];
    if (frame >= f0) {
      const t = prog(frame, f0, Math.max(1, f1 - f0));
      x = x0 + (x1 - x0) * t;
      y = y0 + (y1 - y0) * t;
    }
  }
  const press = clicks.some((c) => frame >= c && frame < c + 4);
  return (
    <svg style={{ position: 'absolute', left: x - 2, top: y - 2, opacity: shown(frame, from, to), transform: `scale(${press ? 0.9 : 1})`, transformOrigin: '2px 2px', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.35))' }} width={34} height={46} viewBox="0 0 17 23">
      <path d="M1 1V18L5 14L8 21L11 20L8 13H14Z" fill="#fff" stroke="#000" strokeWidth={1.2} strokeLinejoin="round" />
    </svg>
  );
}

/** The focus ring (--ring, plum intent) around what to click. Fades in, holds still. */
export function Ring({ x, y, w, h, from, to, r = 10 }: { x: number; y: number; w: number; h: number; from: number; to: number; r?: number }) {
  const frame = useCurrentFrame();
  const o = shown(frame, from, to);
  if (o <= 0) return null;
  const sc = 0.98 + 0.02 * prog(frame, from, MED);
  return <div style={{ position: 'absolute', left: x - 7, top: y - 7, width: w + 14, height: h + 14, borderRadius: r + 7, border: `4px solid ${v('accent')}`, opacity: o, transform: `scale(${sc})`, pointerEvents: 'none' }} />;
}

/** Information as a dot and a word in Petrol, on a floating surface (the one thing that floats). */
export function Info({ x, y, text, from, to }: { x: number; y: number; text: string; from: number; to: number }) {
  const frame = useCurrentFrame();
  const o = shown(frame, from, to);
  if (o <= 0) return null;
  return (
    <div style={{ position: 'absolute', left: x, top: y + (1 - prog(frame, from, MED)) * 4, opacity: o, display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px', borderRadius: 12, background: v('surface'), boxShadow: v('shadow-float'), color: v('ink'), fontFamily: SANS, fontSize: 24, fontWeight: 500, whiteSpace: 'nowrap' }}>
      <span style={{ width: 12, height: 12, borderRadius: 99, background: v('info') }} />
      {text}
    </div>
  );
}

/** The app's pixel head as a flat logo, for the installer and app mockups. */
export function HeadLogo({ size, x, y }: { size: number; x?: number; y?: number }) {
  return (
    <svg style={x === undefined ? undefined : { position: 'absolute', left: x, top: y }} width={size} height={size} viewBox="0 0 32 32" shapeRendering="crispEdges">
      <path d="M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z" fill="var(--plum)" stroke="#fff" strokeWidth={2} />
      <path d="M11 15H13V18H11Z M20 15H22V18H20Z" fill="#fff" />
      <path d="M15 20H17V21H15Z" fill="#C99BB3" />
    </svg>
  );
}

/** A camera shot: centre (x, y) in stage px and zoom z (1 = whole screen). It glides in from frame f over `dur` frames. */
export type Shot = { f: number; x: number; y: number; z: number; dur?: number };
const SHOT_MOVE = 36; // 1.2s: slow enough to follow the eye, never a jump

/** Ease in and out (sine), so a move starts and settles gently. */
const glide = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, t)));

/**
 * Where the camera is at `frame`. Each shot is fitted inside the screen before the move starts,
 * so nothing clamps mid-move. Zoom changes at an even rate (geometric), and the centre glides.
 */
function cameraAt(frame: number, shots: Shot[], vw: number, vh: number) {
  const base = Math.min(vw / STAGE.w, vh / STAGE.h);
  const fit = (s: Shot) => {
    const sc = base * s.z;
    const hw = vw / sc / 2;
    const hh = vh / sc / 2;
    return {
      z: s.z,
      x: hw * 2 >= STAGE.w ? STAGE.w / 2 : Math.min(Math.max(s.x, hw), STAGE.w - hw),
      y: hh * 2 >= STAGE.h ? STAGE.h / 2 : Math.min(Math.max(s.y, hh), STAGE.h - hh),
    };
  };
  let cur = fit(shots[0]);
  for (const s of shots.slice(1)) {
    if (frame < s.f) break;
    const t = glide((frame - s.f) / (s.dur ?? SHOT_MOVE));
    const to = fit(s);
    cur = { x: cur.x + (to.x - cur.x) * t, y: cur.y + (to.y - cur.y) * t, z: cur.z * Math.pow(to.z / cur.z, t) };
  }
  const sc = base * cur.z;
  return { sc, tx: vw / 2 - cur.x * sc, ty: vh / 2 - cur.y * sc };
}

export type PanelProps = {
  captions: Cap[];
  shots: Shot[];
  /** Nekko over the caption strip, x in frame px (0 to 1920). */
  peek: (frame: number) => Peek | null;
  sparkle?: [number, number];
  end: FrameProps['end'];
  children: React.ReactNode;
};

/**
 * The website panel cut: shown about 720px wide, so the screen fills the frame above a
 * caption strip, text is large, and the camera zooms to what is being clicked.
 */
export function PanelFrame({ captions, shots, peek, sparkle, end, children }: PanelProps) {
  const frame = useCurrentFrame();
  const W = 1920;
  const STRIP = 220;
  const VH = 1080 - STRIP;
  const cam = cameraAt(frame, shots, W, VH);
  const endO = prog(frame, end.from, 9);
  const p = peek(frame);
  const u = 6;
  return (
    <AbsoluteFill style={{ ...TOKENS, background: v('paper'), fontFamily: SANS, overflow: 'hidden' }}>
      <Fonts />
      <div style={{ opacity: 1 - endO }}>
        <div style={{ position: 'absolute', left: 0, top: 0, width: W, height: VH, overflow: 'hidden' }}>
          <div style={{ position: 'absolute', left: 0, top: 0, width: STAGE.w, height: STAGE.h, transformOrigin: '0 0', transform: `translate(${cam.tx}px, ${cam.ty}px) scale(${cam.sc})` }}>{children}</div>
        </div>
        <div style={{ position: 'absolute', left: 0, top: VH, width: W, height: 1, background: v('line') }} />
        {p && <PeekNekko frame={frame} x={p.x} edgeY={VH + 1} u={u} peek={p} seed={23} />}
        {p && sparkle && frame >= sparkle[0] && frame < sparkle[1] && <Sparkle frame={frame} x={p.x + 15 * u} y={VH - 34 * u} u={u} />}
        {captions.map((c, i) => {
          const o = shown(frame, c.from, c.to);
          if (o <= 0) return null;
          return (
            <div key={i} style={{ position: 'absolute', left: 60, right: 60, top: VH, height: STRIP, display: 'flex', flexDirection: 'column', justifyContent: 'center', opacity: o, transform: `translateY(${(1 - prog(frame, c.from, MED)) * 8}px)`, textAlign: 'center' }}>
              {c.step && <div style={{ fontSize: 36, fontWeight: 500, color: v('ink-soft'), marginBottom: 8 }}>{c.step}</div>}
              <div style={{ color: v('ink'), fontSize: c.text.length > 56 ? 52 : 64, fontWeight: 600, lineHeight: 1.15 }}>{c.text}</div>
            </div>
          );
        })}
      </div>
      {endO > 0 && (
        <AbsoluteFill style={{ opacity: endO, transform: `translateY(${(1 - endO) * 8}px)`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 100px', textAlign: 'center' }}>
          <NekkoHead frame={frame} size={176} mood={frame >= end.from + 18 && frame < end.from + 66 ? 'happy' : 'open'} seed={5} />
          <div style={{ marginTop: 48, color: v('ink'), fontSize: 72, fontWeight: 600, lineHeight: 1.15 }}>{end.title}</div>
          {end.lines.map((l, i) => (
            <div key={i} style={{ marginTop: i === 0 ? 32 : 12, opacity: prog(frame, end.from + 8 + i * 6, MED), display: 'flex', alignItems: 'center', gap: 16, fontSize: 44, color: l.info ? v('info') : v('ink-soft') }}>
              {l.info && <span style={{ width: 18, height: 18, borderRadius: 99, background: v('info') }} />}
              {l.text}
            </div>
          ))}
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
}
