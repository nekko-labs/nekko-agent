import React, { useId, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Player } from '@remotion/player';
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Modal } from './primitives/Modal.js';
import { CloseIcon, FileIcon, PlusIcon } from '../icons.js';
import { PeekNekkoArt, greetingGaze } from './GreetingNekko.js';
import { GREETING_QUESTIONS } from './CleanStartGreeting.js';
import { NekkoAvatar } from './Mascot.js';
import { GRADE_COLOR } from '../promptAnalysis.js';

/*
 * The "Send your first prompt" intro: three short looping demos drawn with
 * Remotion, each with its explanation underneath, built the way ZonesIntro is.
 * The demos are a simplified new-chat screen, not screenshots, and paint with
 * the app's own colour variables so they match the theme. The labels are the
 * app's own (the greeting, the placeholder, Suggestions, the attachment pill);
 * anything not being taught, like the reply's text, is drawn as faint lines.
 *
 * ChatPane opens it once, over someone's first ever new chat
 * (firstPromptIntroGate.ts decides), lazy loaded the way DictationButton loads
 * VoiceIntro; closing it any way marks it seen.
 */

/** Every colour, curve and spring the demos use. */
const theme = {
  colors: {
    win: 'var(--win, var(--surface))',
    surface: 'var(--surface)',
    surface2: 'var(--surface-2)',
    line: 'var(--line)',
    ink: 'var(--ink)',
    soft: 'var(--ink-soft)',
    faint: 'var(--ink-faint)',
    accent: 'var(--accent)',
    accent2: 'var(--accent-2, var(--accent))',
    accentSoft: 'var(--accent-soft)',
    danger: 'var(--danger)',
    shadow: 'color-mix(in srgb, var(--shadow-ink, var(--ink)) 18%, transparent)',
    /** White in both themes (the app's white-on-colour text): the near-white window in light, the ink in dark. */
    onColour: 'light-dark(var(--win), var(--ink))',
    /** The new-chat page: --paper under the Nekko themes' quiet wash (.clean-start::before). */
    page: 'var(--nekko-wash, linear-gradient(transparent, transparent)), var(--paper)',
  },
  ease: {
    out: Easing.bezier(0.16, 1, 0.3, 1),
    inOut: Easing.bezier(0.83, 0, 0.17, 1),
    in: Easing.bezier(0.7, 0, 0.84, 0),
  },
  spring: {
    snappy: { damping: 14, stiffness: 160, mass: 0.6 },
    smooth: { damping: 20, stiffness: 90, mass: 1 },
    bouncy: { damping: 9, stiffness: 120, mass: 0.8 },
  },
  font: 'var(--font-sans, system-ui, sans-serif)',
} as const;

const W = 640;
const H = 400;
const FPS = 30;
export const FIRST_PROMPT_FPS = FPS;
export const FIRST_PROMPT_SIZE = { width: W, height: H } as const;

type Ease = (t: number) => number;
type SpringConfig = { damping: number; stiffness: number; mass: number };
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
/** Seconds to frames. */
const useAt = () => { const { fps } = useVideoConfig(); return (s: number) => Math.round(s * fps); };
const tween = (frame: number, range: [number, number], to: [number, number], easing: Ease = theme.ease.inOut) => interpolate(frame, range, to, { ...clamp, easing });
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const pop = (frame: number, at: number, fps: number, config: SpringConfig = theme.spring.snappy) => spring({ frame: frame - at, fps, config });
const tap = (frame: number, at: number, fps: number) => pop(frame, at, fps) - pop(frame, at + Math.round(fps * 0.15), fps);
/** 0..1..0 over a quick blink starting at frame `at`. */
const blink = (frame: number, at: number) => { const t = frame - at; return t < 0 || t > 6 ? 0 : Math.sin((t / 6) * Math.PI); };
/** A hop: up and back down, 0..1..0 over `len` frames. */
const hop = (frame: number, at: number, len: number) => { const t = (frame - at) / len; return t < 0 || t > 1 ? 0 : Math.sin(t * Math.PI); };

/** A pointer path through timed stops, eased between each. */
function along(frame: number, stops: Array<[number, number, number]>): { x: number; y: number } {
  if (frame <= stops[0][0]) return { x: stops[0][1], y: stops[0][2] };
  for (let i = 1; i < stops.length; i++) {
    const [t0, x0, y0] = stops[i - 1];
    const [t1, x1, y1] = stops[i];
    if (frame <= t1) { const t = tween(frame, [t0, t1], [0, 1]); return { x: mix(x0, x1, t), y: mix(y0, y1, t) }; }
  }
  const last = stops[stops.length - 1];
  return { x: last[1], y: last[2] };
}

let measureCtx: CanvasRenderingContext2D | null = null;
/** Text width in the theme's --font-sans, for the pieces that move by their width. */
function textWidth(text: string, size: number) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * size * 0.52;
  const family = getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim() || 'system-ui, sans-serif';
  measureCtx.font = `${size}px ${family}`;
  return measureCtx.measureText(text).width;
}

/* ---------- Layers every demo sits on ---------- */

/**
 * The page every demo sits on: the new-chat screen's own background, --paper
 * under the theme's --nekko-wash (the quiet wash the Nekko themes use in place
 * of the prism). It is still, as the app's is.
 */
function Backdrop() {
  return <AbsoluteFill style={{ background: theme.colors.page, overflow: 'hidden' }} />;
}

/**
 * Scoped to the demos: icon sizing, NekkoAvatar held on its open eyes (the
 * app's .pixel-nekko hop and blink would otherwise run), and the reply's
 * avatar recoloured like the main Nekko (the app's avatar is always the dark head).
 */
function DemoStyles() {
  return <style>{`.fpi-root .fpi-icon > svg { width: 100%; height: 100%; }
.fpi-root .pixel-nekko, .fpi-root .pixel-nekko * { animation: none !important; }
.fpi-root .pixel-nekko .pixel-eyes-open { opacity: 1; }
.fpi-root .pixel-nekko .pixel-eyes-happy, .fpi-root .pixel-nekko .pixel-eyes-closed { opacity: 0; }
.fpi-root .fpi-reply-avatar [data-part='pixel-head'] > path:first-child { fill: ${theme.colors.surface}; stroke: ${theme.colors.ink}; }
.fpi-root .fpi-reply-avatar [data-part='pixel-eyes'], .fpi-root .fpi-reply-avatar .pixel-mouth { fill: ${theme.colors.ink}; }`}</style>;
}

/** Whole-scene entrance and a faster exit, so the loop restarts cleanly. */
function Scene({ children }: { children: React.ReactNode }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const out = tween(frame, [durationInFrames - 10, durationInFrames - 1], [0, 1], theme.ease.in);
  // A short fade in too: steps 2 and 3 open on a composer already filled in.
  const enter = tween(frame, [0, 8], [0, 1], theme.ease.out);
  return (
    <AbsoluteFill className="fpi-root" style={{ fontFamily: theme.font, opacity: Math.min(enter, 1 - out), transform: `translateY(${out * -12}px)` }}>
      <Backdrop />
      <DemoStyles />
      {children}
    </AbsoluteFill>
  );
}

/* ---------- Pieces (each mirrors its source in the app) ---------- */

/** The composer's size in the app (ChatPane .composer, clean start), narrowed to the demo. */
const COMPOSER = { x: 24, w: 592, editor: 52, bar: 48, strip: 45 };
/** PeekNekkoArt at 3 px per art pixel (a whole number; the app draws 2.5). */
const U = 3;
const NEKKO = { w: 32 * U, h: 30 * U };
/** Art row 25 sits on the composer's top edge, so the paws straddle it (.greeting-nekko, .chat-mascot). */
const nekkoY = (top: number) => top - 25 * U;
const faceOf = (x: number, top: number) => ({ x: x + 16 * U, y: nekkoY(top) + 15 * U });
/** CleanStartGreeting: a 64 px Nekko slot, 16 px gap and the 300 px heading, centred; .greeting-nekko sits 18 px left of the slot. */
const GREET_LEFT = COMPOSER.x + COMPOSER.w / 2 - (64 + 16 + 300) / 2;
const HEAD_X = GREET_LEFT + 80;
const GREET_NEKKO_X = GREET_LEFT - 18 + 40 - NEKKO.w / 2;
/** ChatMascot's spot once the chat has started: 4 px in from the composer's left. */
const CHAT_NEKKO_X = COMPOSER.x + 4 + 40 - NEKKO.w / 2;
const TEXT_X = COMPOSER.x + 16;
const PLACEHOLDER = 'Message Nekko Agent…  (/ for prompts, @ to attach files)';
const PROMPT = 'Summarize this PDF';
const FILE = 'Q3 report.pdf';
const STARTERS = ['Explain this folder', PROMPT, 'Write a script that…'];

type Pose = { x: number; top: number; lift?: number; shift?: number; look: { x: number; y: number }; squint?: number; laugh?: boolean; paws?: number; pawsHold?: number };

/**
 * GreetingNekko's PeekNekkoArt over the composer edge; she rises from behind it
 * while her paws are down. She is never rotated (that breaks her pixel grid):
 * to lean toward something she shifts sideways by `shift` px and looks at it.
 */
function Nekko({ x, top, lift = 0, shift = 0, look, squint = 0, laugh = false, paws = 1, pawsHold = 0 }: Pose) {
  const y = nekkoY(top);
  const clip = 25 * U + paws * 3 * U;
  return <>
    <style>{`.fpi-root .fpi-nekko { width: ${NEKKO.w}px; height: ${NEKKO.h}px; display: block; overflow: visible; }
.fpi-root .fpi-nekko [data-nekko-look] { transform-box: fill-box; transform-origin: center; transform: translate(${look.x}px, ${look.y}px) scaleY(${1 - squint * 0.82}); }
.fpi-root .fpi-nekko .peek-paws-slot { transform: translateY(${(1 - paws) * 5 + pawsHold / U}px); opacity: ${paws}; }`}</style>
    <div style={{ position: 'absolute', left: x - 24, top: y - 30, width: NEKKO.w + 48, height: 30 + clip, overflow: 'hidden', zIndex: 4 }}>
      <div style={{ position: 'absolute', left: 24, top: 30, width: NEKKO.w, height: NEKKO.h, transform: `translate(${Math.round(shift)}px, ${lift}px)` }}>
        <PeekNekkoArt className="fpi-nekko" look={look} laugh={laugh} paws={paws > 0.5} />
      </div>
    </div>
  </>;
}

/** Nekko's eyes on a point in the demo, the way GreetingNekko bounds her glance. */
const gaze = (face: { x: number; y: number }, x: number, y: number) => greetingGaze((x - face.x) * 80 / NEKKO.w, (y - face.y) * 80 / NEKKO.w);

/** CleanStartGreeting's heading: text-xl, 600, -0.01em, in its 300 x 60 box above the composer. */
function Greeting({ top, show = 1 }: { top: number; show?: number }) {
  if (show < 0.01) return null;
  return <div style={{ position: 'absolute', left: HEAD_X, top: top - 16 - 60, width: 300, height: 60, display: 'flex', alignItems: 'center', fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em', color: theme.colors.ink, whiteSpace: 'nowrap', opacity: show }}>{GREETING_QUESTIONS[0]}</div>;
}

/** The app's stroke icons (icons.tsx) take their size from a class; here a box sizes them. */
function Icon({ size, color, children }: { size: number; color: string; children: React.ReactNode }) {
  return <span className="fpi-icon" style={{ display: 'grid', width: size, height: size, color, flexShrink: 0 }}>{children}</span>;
}

/** ChatPane's attached-file pill: h-7 rounded-lg border-line px-2 text-xs ink-soft, FileIcon, the name, remove at 60%. */
function FilePill({ show = 1 }: { show?: number }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 28, boxSizing: 'border-box', padding: '0 8px', borderRadius: 8, border: `1px solid ${theme.colors.line}`, fontSize: 12, color: theme.colors.soft, whiteSpace: 'nowrap', opacity: show, transform: `scale(${mix(0.85, 1, show)})`, transformOrigin: 'left center' }}>
    <Icon size={14} color={theme.colors.soft}><FileIcon /></Icon>{FILE}<span style={{ marginLeft: 2, opacity: 0.6 }}>✕</span>
  </span>;
}
const pillWidth = () => 8 + 14 + 8 + textWidth(FILE, 12) + 8 + 2 + textWidth('✕', 12) + 8 + 2;

/** PromptAnalyzer's chip (variant="chip"): .composer-suggestions-chip with a GradeBadge, shown once there is text. */
function SuggestionsChip({ show }: { show: number }) {
  if (show < 0.01) return null;
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 28, padding: '0 12px 0 8px', boxSizing: 'border-box', border: `1px solid ${theme.colors.line}`, borderRadius: 999, background: theme.colors.surface2, fontSize: 12, color: theme.colors.soft, whiteSpace: 'nowrap', opacity: show, transform: `scale(${mix(0.9, 1, show)})` }}>
    <span style={{ display: 'grid', placeItems: 'center', width: 16, height: 16, borderRadius: 999, background: GRADE_COLOR.A, color: theme.colors.onColour, fontSize: 11, fontWeight: 700 }}>A</span>Suggestions
  </span>;
}

/**
 * ChatPane's composer, clean-start look (18 px radius, translucent win,
 * accent-tinted depth): the attachments strip, the editor, then the
 * composer-bar with + on the left and Suggestions, the mic and Send on the right.
 */
function Composer({ bottom, strip = 0, pill = 0, draft = '', hint = 1, caret = false, press = 0, glow = 0, suggestions = 0, enter = 1 }: {
  bottom: number; strip?: number; pill?: number; draft?: string; hint?: number; caret?: boolean; press?: number; glow?: number; suggestions?: number; enter?: number;
}) {
  const frame = useCurrentFrame();
  const top = bottom - COMPOSER.editor - COMPOSER.bar - strip * COMPOSER.strip;
  const on = caret && Math.floor(frame / 14) % 2 === 0;
  const ready = draft.length > 0;
  return <div style={{ position: 'absolute', left: COMPOSER.x, top, width: COMPOSER.w, height: bottom - top, boxSizing: 'border-box', borderRadius: 18, background: `color-mix(in srgb, ${theme.colors.win} 82%, transparent)`,
    boxShadow: `0 18px 50px -22px color-mix(in srgb, ${theme.colors.accent} 45%, transparent), 0 2px 4px ${theme.colors.shadow}`, display: 'flex', flexDirection: 'column', overflow: 'hidden', opacity: enter, transform: `translateY(${(1 - enter) * 16}px)`, zIndex: 3 }}>
    <div style={{ height: strip * COMPOSER.strip, flexShrink: 0, borderBottom: strip > 0.02 ? `1px solid ${theme.colors.line}` : 'none', display: 'flex', alignItems: 'center', padding: '0 12px', boxSizing: 'border-box', overflow: 'hidden' }}>
      <FilePill show={pill} />
    </div>
    <div style={{ height: COMPOSER.editor, boxSizing: 'border-box', padding: '8px 16px', fontSize: 14, lineHeight: '20px', color: ready ? theme.colors.ink : theme.colors.faint, whiteSpace: 'pre' }}>
      {draft || <span style={{ opacity: hint }}>{PLACEHOLDER}</span>}
      {caret && <span style={{ display: 'inline-block', width: 1.5, height: 18, marginLeft: 1, verticalAlign: 'text-bottom', background: theme.colors.ink, opacity: on ? 1 : 0 }} />}
    </div>
    <div style={{ height: COMPOSER.bar, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px 8px' }}>
      <span style={{ display: 'grid', placeItems: 'center', width: 32, height: 32, borderRadius: 8 }}><Icon size={16} color={theme.colors.faint}><PlusIcon /></Icon></span>
      <span style={{ flex: 1 }} />
      <SuggestionsChip show={suggestions} />
      <span style={{ display: 'grid', placeItems: 'center', width: 36, height: 36, borderRadius: 12 }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={theme.colors.soft} strokeWidth="1.7" aria-hidden><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></svg>
      </span>
      {/* .send-avatar: transparent, rounded-xl 36 px, NekkoAvatar 24, disabled:opacity-40. The glow is the demo's cue. */}
      <span style={{ display: 'grid', placeItems: 'center', width: 36, height: 36, borderRadius: 12, opacity: ready ? 1 : 0.4, lineHeight: 0,
        transform: `translateY(${-glow}px) scale(${1 + glow * 0.06 - press * 0.1})`,
        boxShadow: `0 0 ${glow * 14}px ${glow * 3}px color-mix(in srgb, ${theme.colors.accent} ${Math.round(glow * 55)}%, transparent)` }}>
        <NekkoAvatar size={24} stationary />
      </span>
    </div>
  </div>;
}
const composerTop = (bottom: number, strip = 0) => bottom - COMPOSER.editor - COMPOSER.bar - strip * COMPOSER.strip;

/** The pointer, pressed in at `press` (0..1). */
function Cursor({ x, y, press = 0, show = 1 }: { x: number; y: number; press?: number; show?: number }) {
  return (
    <svg width="18" height="22" viewBox="0 0 18 22" style={{ position: 'absolute', left: x - 2, top: y - 2, opacity: show, transform: `scale(${1 - press * 0.16})`, transformOrigin: '2px 2px', zIndex: 20, filter: `drop-shadow(0 2px 3px ${theme.colors.shadow})` }}>
      <path d="M2 2 L2 17 L6 13 L9 20 L12 19 L9 12 L15 12 Z" fill={theme.colors.win} stroke={theme.colors.ink} strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

/** Faint text lines standing in for a reply. */
function Lines({ widths }: { widths: number[] }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
    {widths.map((w, i) => <div key={i} style={{ height: 6, width: w, borderRadius: 3, background: theme.colors.line }} />)}
  </div>;
}

/* ---------- 1. Start with a question ---------- */

/** Starter chips are planned (issue #614), drawn with .composer-suggestions-chip; the picked one takes its .is-open look. */
const STARTER = { y: 0, gap: 8, h: 28, size: 12, pad: 12 };
const starterW = (label: string) => textWidth(label, STARTER.size) + STARTER.pad * 2 + 2;
const starterX = (i: number) => HEAD_X + STARTERS.slice(0, i).reduce((x, l) => x + starterW(l) + STARTER.gap, 0);

function StartDemo() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const at = useAt();
  const bottom = 318;
  const top = composerTop(bottom);
  const chipY = bottom + 14;
  const face = faceOf(GREET_NEKKO_X, top);
  const pick = 1;
  const chip = { x: starterX(pick) + starterW(PROMPT) / 2, y: chipY + STARTER.h / 2 };
  const rise = pop(frame, at(0.15), fps, theme.spring.bouncy);
  const paws = tween(frame, [at(0.5), at(0.7)], [0, 1], theme.ease.out);
  const looking = tween(frame, [at(1.0), at(1.3)], [0, 1], theme.ease.out) * (1 - tween(frame, [at(2.5), at(2.8)], [0, 1]));
  const lit = Math.max(looking, frame >= at(1.0) && frame < at(2.6) ? 1 : 0);
  const gone = tween(frame, [at(2.45), at(2.75)], [0, 1], theme.ease.in);
  // The chip's words first lift clear of the chip (so the two labels never overlap), then travel up into the composer.
  const liftOff = tween(frame, [at(2.4), at(2.65)], [0, 1], theme.ease.out);
  const fly = tween(frame, [at(2.65), at(3.1)], [0, 1]);
  const typed = Math.round(tween(frame, [at(3.05), at(3.85)], [0, PROMPT.length], theme.ease.out));
  const draft = PROMPT.slice(0, typed);
  const typing = frame >= at(3.05);
  const cursor = along(frame, [[at(1.2), 600, 380], [at(2.15), chip.x, chip.y], [at(2.7), chip.x, chip.y], [at(3.6), chip.x + 80, chip.y + 40]]);
  let look = gaze(face, face.x + 120, bottom + 30);
  if (looking > 0.2) look = gaze(face, chip.x, chip.y);
  if (typing) look = gaze(face, TEXT_X + textWidth(draft, 14), top + 18);
  return (
    <Scene>
      <Greeting top={top} show={pop(frame, at(0.05), fps, theme.spring.smooth)} />
      {STARTERS.map((label, i) => {
        const t = pop(frame, at(0.7) + i * 3, fps);
        const on = i === pick ? lit : 0;
        return <div key={label} style={{ position: 'absolute', left: starterX(i), top: chipY, height: STARTER.h, boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', padding: `0 ${STARTER.pad}px`, borderRadius: 999, whiteSpace: 'nowrap',
          background: theme.colors.surface2, border: `1px solid ${on > 0.5 ? `color-mix(in srgb, ${theme.colors.accent} 55%, ${theme.colors.line})` : theme.colors.line}`, fontSize: STARTER.size, color: on > 0.5 ? theme.colors.ink : theme.colors.soft,
          boxShadow: on > 0.5 ? `0 6px 16px color-mix(in srgb, ${theme.colors.accent} 30%, transparent)` : 'none',
          opacity: t * (1 - gone), transform: `translate(${(1 - t) * 14}px, ${-on * 4 - gone * 8}px) scale(${mix(0.94, 1, t) * (1 - (i === pick ? tap(frame, at(2.3), fps) * 0.06 : 0))})` }}>{label}</div>;
      })}
      <Composer bottom={bottom} draft={draft} hint={1 - tween(frame, [at(2.65), at(2.9)], [0, 1], theme.ease.out)} caret={typing} suggestions={tween(frame, [at(3.3), at(3.6)], [0, 1], theme.ease.out)} enter={pop(frame, 0, fps, theme.spring.smooth)} />
      <Nekko x={GREET_NEKKO_X} top={top} lift={(1 - rise) * 22 * U + Math.sin(frame / 20)} shift={looking * 2 * U} look={look} squint={blink(frame, at(4.4))} laugh={frame >= at(3.8) && frame < at(4.3)} paws={paws} />
      {liftOff > 0 && fly < 1 && <div style={{ position: 'absolute', left: mix(starterX(pick) + STARTER.pad, TEXT_X, fly), top: mix(chipY + 6 - liftOff * (STARTER.h + 8), top + 8, fly), fontSize: mix(12, 14, fly), color: theme.colors.accent, whiteSpace: 'nowrap', opacity: liftOff, zIndex: 6 }}>{PROMPT}</div>}
      <Cursor {...cursor} press={tap(frame, at(2.3), fps)} show={tween(frame, [at(1.1), at(1.4)], [0, 1], theme.ease.out)} />
    </Scene>
  );
}

/* ---------- 2. Add your files ---------- */

/** The dragged file: a page with the theme's danger-red label. */
function PdfIcon({ size }: { size: number }) {
  return <svg width={size} height={size * 1.25} viewBox="0 0 24 30" aria-hidden>
    <path d="M3 1h12l6 6v20a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2z" fill={theme.colors.win} stroke={theme.colors.soft} strokeWidth="1.3" />
    <path d="M15 1v6h6" fill="none" stroke={theme.colors.soft} strokeWidth="1.3" />
    <rect x="0" y="15" width="17" height="9" rx="2" fill={theme.colors.danger} />
    <text x="8.5" y="22" textAnchor="middle" fontSize="6.5" fontWeight="800" fill={theme.colors.onColour} fontFamily="system-ui, sans-serif">PDF</text>
  </svg>;
}

function FilesDemo() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const at = useAt();
  const bottom = 340;
  const strip = tween(frame, [at(2.6), at(2.95)], [0, 1], theme.ease.out);
  const top = composerTop(bottom, strip);
  const face = faceOf(GREET_NEKKO_X, top);
  // The card comes in from the right edge in the pointer's hand, goes down onto the composer, and shrinks into the strip.
  const grip = { x: 30, y: 26 };
  const card = along(frame, [[at(0.7), W + 40, 120], [at(1.4), 380, 110], [at(1.6), 380, 110], [at(2.5), 330, composerTop(bottom) + 10]]);
  const shrink = tween(frame, [at(2.6), at(2.9)], [0, 1]);
  const pillAt = { x: COMPOSER.x + 12, y: composerTop(bottom, 1) + 8 };
  const cardX = mix(card.x, pillAt.x, shrink);
  const cardY = mix(card.y, pillAt.y, shrink);
  const cardShow = (frame >= at(0.7) ? 1 : 0) * (1 - tween(frame, [at(2.8), at(2.95)], [0, 1], theme.ease.in));
  const held = frame < at(2.6) ? 1 : 1 - shrink;
  const cursor = frame < at(2.6) ? { x: card.x + grip.x, y: card.y + grip.y } : along(frame, [[at(2.6), 330 + grip.x, composerTop(bottom) + 10 + grip.y], [at(3.6), 470, 250]]);
  let look = gaze(face, face.x + 120, bottom + 30);
  if (frame >= at(0.8)) look = gaze(face, Math.min(cardX + 80, W), cardY + 20);
  if (frame >= at(2.95)) look = gaze(face, pillAt.x + 60, pillAt.y + 14);
  const landed = hop(frame, at(3.05), at(0.35)) * 6;
  return (
    <Scene>
      <Greeting top={top} />
      <Composer bottom={bottom} strip={strip} pill={tween(frame, [at(2.8), at(3.0)], [0, 1], theme.ease.out)} draft={PROMPT} suggestions={1} />
      {cardShow > 0.01 && <div style={{ position: 'absolute', left: cardX, top: cardY, display: 'flex', alignItems: 'center', gap: 12, padding: '10px 18px 10px 12px', borderRadius: 14, background: theme.colors.win, border: `1px solid ${theme.colors.line}`,
        boxShadow: `0 ${10 * held}px ${22 * held}px ${theme.colors.shadow}`, fontSize: 16, fontWeight: 600, color: theme.colors.ink, whiteSpace: 'nowrap', opacity: cardShow, transform: `scale(${mix(1, 0.55, shrink)}) rotate(${held * -2}deg)`, transformOrigin: 'left top', zIndex: 3 }}>
        <PdfIcon size={28} />{FILE}
      </div>}
      <Nekko x={GREET_NEKKO_X} top={top} lift={Math.sin(frame / 20) - landed} shift={tween(frame, [at(0.8), at(1.2)], [0, 1], theme.ease.out) * (1 - tween(frame, [at(2.5), at(2.9)], [0, 1])) * mix(2 * U, -U, tween(frame, [at(1.6), at(2.5)], [0, 1]))} look={look} squint={blink(frame, at(4.2))} laugh={frame >= at(3.0) && frame < at(3.7)} />
      <Cursor {...cursor} show={tween(frame, [at(0.6), at(0.9)], [0, 1], theme.ease.out) * (1 - tween(frame, [at(3.5), at(3.8)], [0, 1], theme.ease.out))} />
    </Scene>
  );
}

/* ---------- 3. Send, and Nekko gets to work ---------- */

/**
 * One pixel-confetti burst, in the theme's accents, out to both sides of her
 * head and falling over about a second. It fades out above `floor` (the
 * composer's top edge), so none lands on the composer or its placeholder.
 */
function Confetti({ at, face, floor }: { at: number; face: { x: number; y: number }; floor: number }) {
  const frame = useCurrentFrame();
  const t = frame - at;
  if (t < 0 || t > 40) return null;
  const colours = [theme.colors.accent, theme.colors.accent2, theme.colors.faint];
  const rand = (i: number, k: number) => { const v = Math.sin(i * 12.9898 + k * 78.233 + at * 3.1) * 43758.5453; return v - Math.floor(v); };
  return <>{Array.from({ length: 18 }, (_, i) => {
    const side = i % 2 ? 1 : -1;
    const x = face.x + side * (13 * U + rand(i, 3) * 18) + side * (1 + rand(i, 1) * 3) * t;
    const y = face.y - (4 + rand(i, 4) * 6) * U + (-1.5 - rand(i, 2) * 3.5) * t + 0.22 * t * t;
    const nearFloor = tween(y, [floor - 30, floor - 10], [1, 0], theme.ease.out);
    if (nearFloor <= 0) return null;
    return <span key={i} style={{ position: 'absolute', left: x, top: y, width: 6, height: 6, background: colours[i % colours.length], opacity: nearFloor * (1 - tween(t, [12 + rand(i, 5) * 8, 36], [0, 1], theme.ease.in)), transform: `rotate(${t * (i % 2 ? 9 : -9)}deg)`, zIndex: 5 }} />;
  })}</>;
}

function SendDemo() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const at = useAt();
  const bottom = 376;
  const send = at(1.2);
  const strip = 1 - tween(frame, [send, send + at(0.3)], [0, 1]);
  const top = composerTop(bottom, strip);
  const dock = tween(frame, [at(1.3), at(2.0)], [0, 1]);
  const nx = mix(GREET_NEKKO_X, CHAT_NEKKO_X, dock);
  const face = faceOf(nx, top);
  const sendAt = { x: COMPOSER.x + COMPOSER.w - 8 - 18, y: bottom - 8 - 18 };
  const cursor = along(frame, [[at(0.2), 520, 250], [at(1.0), sendAt.x, sendAt.y], [at(1.4), sendAt.x, sendAt.y], [at(2.0), sendAt.x + 30, sendAt.y + 60]]);
  const glow = tween(frame, [at(0.5), at(0.9)], [0, 1], theme.ease.out) * (1 - tween(frame, [at(1.35), at(1.6)], [0, 1], theme.ease.in));
  const press = tap(frame, send, fps);
  // The message and its file slide right along their composer rows, then rise into the chat, passing neither Nekko nor the heading.
  const slide = tween(frame, [send, at(1.6)], [0, 1]);
  const climb = Math.min(1, pop(frame, at(1.6), fps, theme.spring.smooth));
  const replyIn = pop(frame, at(3.1), fps, theme.spring.smooth);
  const right = COMPOSER.x + COMPOSER.w - 8;
  const msgW = textWidth(PROMPT, 14) + 32;
  const pillW = pillWidth();
  const replyH = 20 + 8 + 6 + 7 + 6;
  const stackBottom = nekkoY(composerTop(bottom)) + 5 * U - 22;
  const replyTop = stackBottom - replyH;
  const block = 28 + 6 + 36;
  const blockTop = mix(stackBottom - block, replyTop - 14 - block, replyIn);
  const thinking = tween(frame, [at(1.9), at(2.1)], [0, 1], theme.ease.out) * (1 - tween(frame, [at(3.0), at(3.2)], [0, 1], theme.ease.out));
  const cheer = frame >= at(3.7) && frame < at(4.9);
  const hops = hop(frame, at(3.75), at(0.4)) * 10 + hop(frame, at(4.2), at(0.4)) * 10;
  const lift = Math.sin(frame / 20) + thinking * Math.sin((frame - at(1.9)) / 6) * 2 - hops;
  let look = gaze(face, sendAt.x, sendAt.y);
  if (frame >= send) look = gaze(face, right - 60, 60);
  if (frame >= at(3.2)) look = gaze(face, COMPOSER.x + 200, replyTop);
  if (frame >= at(4.9)) look = gaze(face, face.x + 60, bottom + 40);
  const greeting = 1 - tween(frame, [send, send + at(0.3)], [0, 1], theme.ease.out);
  return (
    <Scene>
      <Greeting top={top} show={greeting} />
      <Composer bottom={bottom} strip={strip} pill={frame < send ? 1 : 0} draft={frame < send ? PROMPT : ''} hint={frame < send ? 1 : tween(frame, [at(1.8), at(2.1)], [0, 1], theme.ease.out)} suggestions={frame < send ? 1 : 0} press={press} glow={glow} />
      {frame >= send && <>
        <div style={{ position: 'absolute', left: mix(COMPOSER.x + 12, right - pillW, slide), top: mix(composerTop(bottom, 1) + 8, blockTop, climb), zIndex: 4 }}><FilePill /></div>
        <div style={{ position: 'absolute', left: mix(TEXT_X - 16, right - msgW, slide), top: mix(composerTop(bottom, 1) + COMPOSER.strip, blockTop + 34, climb), width: msgW, height: 36, boxSizing: 'border-box', padding: '8px 16px', borderRadius: 16, fontSize: 14, lineHeight: '20px', whiteSpace: 'nowrap',
          background: `color-mix(in srgb, ${theme.colors.surface2} ${Math.round(climb * 100)}%, transparent)`, color: theme.colors.ink, zIndex: 4 }}>{PROMPT}</div>
      </>}
      {replyIn > 0.01 && <div style={{ position: 'absolute', left: COMPOSER.x + 8, top: replyTop, display: 'flex', gap: 10, opacity: Math.min(1, replyIn), transform: `translateY(${(1 - replyIn) * 12}px)` }}>
        <div className="fpi-reply-avatar" style={{ lineHeight: 0, flexShrink: 0 }}><NekkoAvatar size={22} stationary /></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 14, lineHeight: '20px', color: theme.colors.ink }}>Here’s what’s in Q3 report.pdf:</div>
          <Lines widths={[360, 250]} />
        </div>
      </div>}
      {thinking > 0.01 && <div style={{ position: 'absolute', left: nx + 29 * U, top: nekkoY(top) + 5 * U + lift, display: 'flex', gap: 5, padding: '8px 10px', borderRadius: 12, background: theme.colors.win, border: `1px solid ${theme.colors.line}`, boxShadow: `0 6px 14px ${theme.colors.shadow}`, opacity: thinking, transform: `scale(${mix(0.6, 1, thinking)})`, transformOrigin: 'left bottom', zIndex: 5 }}>
        {[0, 1, 2].map(i => <span key={i} style={{ width: 7, height: 7, borderRadius: 4, background: theme.colors.soft, transform: `translateY(${-Math.max(0, Math.sin(frame / 4.5 - i * 0.9)) * 3}px)` }} />)}
      </div>}
      <Nekko x={nx} top={top} lift={lift} look={look} squint={Math.max(thinking, blink(frame, at(5.1)))} laugh={cheer} paws={1 - thinking} pawsHold={hops * 0.85} />
      <Confetti at={at(3.8)} face={face} floor={top} />
      <Confetti at={at(4.25)} face={face} floor={top} />
      <Cursor {...cursor} press={press} show={tween(frame, [at(0.1), at(0.4)], [0, 1], theme.ease.out) * (1 - tween(frame, [at(1.7), at(2.0)], [0, 1], theme.ease.out))} />
    </Scene>
  );
}

export const FIRST_PROMPT_STEPS = [
  {
    title: 'Start with a question',
    body: 'Type anything into the box, the way you’d ask a colleague. Not sure where to begin? Pick a starter and it’s typed in for you, ready to edit.',
    demo: StartDemo,
    seconds: 5.5,
  },
  {
    title: 'Add your files',
    body: 'Drag a file or folder onto the message box to attach it. You can also click + to choose one, or type @ and the file’s name.',
    demo: FilesDemo,
    seconds: 5.5,
  },
  {
    title: 'Send, and Nekko gets to work',
    body: 'Press Send (Nekko’s face) or Enter. Nekko reads your files, works out a plan and replies here. Before it runs a command or changes anything on your computer, it asks you first.',
    demo: SendDemo,
    seconds: 6,
  },
];

/** The "Send your first prompt" intro, in the app's Modal the way ZonesIntro is shown. */
export function FirstPromptIntro({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const titleId = useId();
  const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const current = FIRST_PROMPT_STEPS[step];
  const last = step === FIRST_PROMPT_STEPS.length - 1;
  const frames = Math.round(current.seconds * FPS);
  return (
    <Modal title="Send your first prompt" labelledBy={titleId} onClose={onClose} overlayClassName="p-4" className="card w-full max-w-[600px] p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id={titleId} className="text-base font-semibold">Send your first prompt</h2>
        <button className="rounded-sm p-1 text-ink-faint hover:text-ink" onClick={onClose} aria-label="Close"><CloseIcon className="h-4 w-4" /></button>
      </div>
      {/* ZonesIntro's demo frame (.zones-intro-demo), written out: that stylesheet loads with the board only. */}
      <div className="mt-3 overflow-hidden rounded-xl border border-line bg-surface-2" aria-hidden data-first-prompt-intro-step={step}>
        <Player
          key={step}
          component={current.demo}
          durationInFrames={frames}
          fps={FPS}
          compositionWidth={W}
          compositionHeight={H}
          style={{ width: '100%', aspectRatio: `${W} / ${H}` }}
          loop
          autoPlay={!reduced}
          // Reduced motion shows one telling frame, still.
          initialFrame={reduced ? Math.round(frames * 0.6) : 0}
          controls={false}
          clickToPlay={false}
        />
      </div>
      <h3 className="mt-4 text-sm font-semibold">{current.title}</h3>
      <p className="mt-1 text-xs leading-relaxed text-ink-soft">{current.body}</p>
      <div className="mt-4 flex items-center gap-3">
        <div className="flex gap-2" role="group" aria-label={`Step ${step + 1} of ${FIRST_PROMPT_STEPS.length}`}>
          {/* ZonesIntro's step dots (.zones-intro-dot), written out for the same reason. */}
          {FIRST_PROMPT_STEPS.map((s, i) => <button key={s.title} type="button" className="transition-[width,background-color] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
            style={{ width: i === step ? 18 : 7, height: 7, borderRadius: 4, background: i === step ? 'var(--accent)' : 'var(--line)' }}
            aria-label={`Step ${i + 1}: ${s.title}`} aria-current={i === step || undefined} onClick={() => setStep(i)} />)}
        </div>
        <div className="ml-auto flex gap-2">
          {/* It opens on its own on the first chat, so leaving it is always one click (as are ✕, Escape and the backdrop). */}
          {!last && <button type="button" className="btn btn-ghost" onClick={onClose} data-first-prompt-intro-skip>Skip</button>}
          {step > 0 && <button type="button" className="btn btn-ghost" onClick={() => setStep(step - 1)}>Back</button>}
          <button type="button" className="btn btn-primary" onClick={() => (last ? onClose() : setStep(step + 1))}>{last ? 'Get started' : 'Next'}</button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Development only: opens the intro on its own from the DevTools console, with no trigger in the app:
 *   (await import('/components/FirstPromptIntro.tsx')).previewFirstPromptIntro()
 */
export function previewFirstPromptIntro() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<FirstPromptIntro onClose={() => { root.unmount(); host.remove(); }} />);
}

export default FirstPromptIntro;
