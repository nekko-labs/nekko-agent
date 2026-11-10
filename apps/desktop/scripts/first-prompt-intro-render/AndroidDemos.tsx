import React from 'react';
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

/*
 * Android's "Send your first prompt" demos (#2234): the iPhone's three steps
 * (PhoneDemos.tsx), drawn on Android's own screens in Android's order. New chat
 * there is a form (folder chips, then "Start on Mac"), and the first prompt is
 * written in the chat that opens: its composer with the formatting bar, + (Dictate,
 * Image from files, Take photo), the round Send, and the model and permission row
 * under it (Composer.kt). Neither screen has a peeking Nekko, so none is drawn here.
 * A fingertip taps. The words live in the app (FirstPromptIntro.kt), not in the
 * video. Rendered to MP4 by scripts/render-first-prompt-intro.mjs --android.
 */

export const ANDROID_FPS = 30;
export const ANDROID_SIZE = { width: 360, height: 400 } as const;
export const ANDROID_STEPS = [
  { id: 'start', seconds: 5.5 },
  { id: 'add', seconds: 7 },
  { id: 'send', seconds: 6 },
] as const;

const c = {
  paper: 'var(--paper)', surface: 'var(--surface)', surface2: 'var(--surface-2)', line: 'var(--line)',
  ink: 'var(--ink)', soft: 'var(--ink-soft)', faint: 'var(--ink-faint)', accent: 'var(--accent)', onAccent: 'var(--on-accent)',
  shadow: 'color-mix(in srgb, var(--ink) 16%, transparent)',
};
const font = 'Roboto, "Google Sans", system-ui, sans-serif';
const out = Easing.bezier(0.16, 1, 0.3, 1);
const inOut = Easing.bezier(0.83, 0, 0.17, 1);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const tween = (f: number, r: [number, number], to: [number, number], easing = inOut) => interpolate(f, r, to, { ...clamp, easing });
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const useAt = () => { const { fps } = useVideoConfig(); return (s: number) => Math.round(s * fps); };
const pop = (f: number, at: number, fps: number) => spring({ frame: f - at, fps, config: { damping: 14, stiffness: 160, mass: 0.6 } });
const tap = (f: number, at: number, fps: number) => pop(f, at, fps) - pop(f, at + Math.round(fps * 0.15), fps);

function along(f: number, stops: Array<[number, number, number]>) {
  if (f <= stops[0][0]) return { x: stops[0][1], y: stops[0][2] };
  for (let i = 1; i < stops.length; i++) {
    const [t0, x0, y0] = stops[i - 1];
    const [t1, x1, y1] = stops[i];
    if (f <= t1) { const t = tween(f, [t0, t1], [0, 1]); return { x: mix(x0, x1, t), y: mix(y0, y1, t) }; }
  }
  const l = stops[stops.length - 1];
  return { x: l[1], y: l[2] };
}

const PROMPT = 'Summarize the sales notes';
const COMPUTER = 'Mac';

function Scene({ children }: { children: React.ReactNode }) {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const leave = tween(f, [durationInFrames - 10, durationInFrames - 1], [0, 1], Easing.bezier(0.7, 0, 0.84, 0));
  const enter = tween(f, [0, 8], [0, 1], out);
  return (
    <AbsoluteFill style={{ fontFamily: font, background: c.paper, overflow: 'hidden' }}>
      <AbsoluteFill style={{ opacity: Math.min(enter, 1 - leave), transform: `translateY(${leave * -10}px)` }}>{children}</AbsoluteFill>
    </AbsoluteFill>
  );
}

const glyph = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
const Back = () => <svg width="20" height="20" viewBox="0 0 24 24" {...glyph} strokeWidth={2.2}><path d="M20 12H5M11 5l-7 7 7 7" /></svg>;
const Plus = () => <svg width="20" height="20" viewBox="0 0 24 24" {...glyph} strokeWidth={2}><path d="M12 5v14M5 12h14" /></svg>;
const SendIcon = () => <svg width="18" height="18" viewBox="0 0 24 24"><path d="M3 20.5V14l9-2-9-2V3.5L22 12z" fill="currentColor" /></svg>;
const Mic = () => <svg width="16" height="16" viewBox="0 0 24 24" {...glyph}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3" /></svg>;
const Image = () => <svg width="16" height="16" viewBox="0 0 24 24" {...glyph}><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M21 16l-5-5-8 8" /></svg>;
const Camera = () => <svg width="16" height="16" viewBox="0 0 24 24" {...glyph}><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>;
const Folder = () => <svg width="15" height="15" viewBox="0 0 24 24" {...glyph}><path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /></svg>;
const Laptop = () => <svg width="18" height="18" viewBox="0 0 24 24" {...glyph}><rect x="4" y="5" width="16" height="11" rx="1" /><path d="M2 19h20" /></svg>;
const Shield = () => <svg width="13" height="13" viewBox="0 0 24 24" {...glyph}><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /></svg>;

/** The top app bar: back arrow and the title, left on New chat, centred in a chat (ChatScreen). */
function TopBar({ title, center = false }: { title: string; center?: boolean }) {
  return <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 52, display: 'flex', alignItems: 'center', padding: '0 14px', gap: 18, color: c.ink }}>
    <span style={{ display: 'grid' }}><Back /></span>
    <span style={{ fontSize: center ? 17 : 21, fontWeight: center ? 600 : 400, flex: center ? 1 : undefined, textAlign: center ? 'center' : 'left', marginRight: center ? 38 : 0 }}>{title}</span>
  </div>;
}

/** A sample photo thumbnail: a little landscape in the accent. */
function Thumb({ size, show = 1 }: { size: number; show?: number }) {
  return <div style={{ width: size, height: size, borderRadius: 8, overflow: 'hidden', position: 'relative', opacity: show, transform: `scale(${mix(0.6, 1, show)})`, transformOrigin: 'left center',
    background: `linear-gradient(color-mix(in srgb, ${c.accent} 22%, ${c.surface}), color-mix(in srgb, ${c.accent} 45%, ${c.surface}))`, border: `1px solid ${c.line}` }}>
    <div style={{ position: 'absolute', left: '62%', top: '20%', width: size * 0.18, height: size * 0.18, borderRadius: 99, background: c.surface }} />
    <svg viewBox="0 0 10 10" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}><path d="M0 10V7l3-3 3 3 1.5-1.5L10 8v2z" fill={c.accent} opacity="0.75" /></svg>
  </div>;
}

/* ---------- The chat's composer (Composer.kt) ---------- */

const COMPOSER = { x: 12, w: 336, pad: 10, bar: 30, field: 36, row: 46, opts: 26 };
const composerH = (photo: number) => COMPOSER.pad + COMPOSER.bar + COMPOSER.field + photo * 52 + COMPOSER.row + COMPOSER.opts + COMPOSER.pad;
const composerTop = (photo = 0) => 400 - 12 - composerH(photo);
const plusAt = (photo = 0) => ({ x: COMPOSER.x + COMPOSER.pad + 22, y: composerTop(photo) + COMPOSER.pad + COMPOSER.bar + COMPOSER.field + photo * 52 + COMPOSER.row / 2 });
const sendAt = (photo = 0) => ({ x: COMPOSER.x + COMPOSER.w - COMPOSER.pad - 22, y: plusAt(photo).y });
const fieldAt = (photo = 0) => ({ x: COMPOSER.x + 130, y: composerTop(photo) + COMPOSER.pad + COMPOSER.bar + COMPOSER.field / 2 });

function Composer({ draft = '', caret = false, photo = 0, plusPress = 0, sendPress = 0, glow = 0, y = 0 }: {
  draft?: string; caret?: boolean; photo?: number; plusPress?: number; sendPress?: number; glow?: number; y?: number;
}) {
  const f = useCurrentFrame();
  const ready = draft.length > 0;
  const on = caret && Math.floor(f / 14) % 2 === 0;
  const top = composerTop(photo) + y;
  const marks = ['B', 'I', 'S', '<>', '∞', 'T', '≡', '⋮≡', '☑'];
  return <div style={{ position: 'absolute', left: COMPOSER.x, top, width: COMPOSER.w, height: composerH(photo), boxSizing: 'border-box', padding: COMPOSER.pad, borderRadius: 16,
    background: c.surface, border: `1px solid ${c.line}`, zIndex: 3, overflow: 'hidden' }}>
    <div style={{ height: COMPOSER.bar, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 6px', color: c.soft, fontSize: 13, fontWeight: 700 }}>
      {marks.map((m) => <span key={m} style={{ opacity: 0.8 }}>{m}</span>)}
    </div>
    <div style={{ height: COMPOSER.field, display: 'flex', alignItems: 'center', padding: '0 6px', fontSize: 16, color: ready ? c.ink : c.faint, whiteSpace: 'pre' }}>
      {draft || 'Message'}
      {caret && <span style={{ display: 'inline-block', width: 2, height: 19, marginLeft: 1, background: c.accent, opacity: on ? 1 : 0 }} />}
    </div>
    <div style={{ height: photo * 52, overflow: 'hidden', display: 'flex', alignItems: 'center', padding: '0 6px' }}><Thumb size={44} show={photo} /></div>
    <div style={{ height: COMPOSER.row, display: 'flex', alignItems: 'center', gap: 14 }}>
      <span style={{ display: 'grid', placeItems: 'center', width: 44, height: 44, borderRadius: 99, background: c.surface2, color: c.ink, transform: `scale(${1 - plusPress * 0.12})` }}><Plus /></span>
      <span style={{ color: c.accent, fontWeight: 700, fontSize: 16, textDecoration: 'underline' }}>A</span>
      <span style={{ flex: 1 }} />
      <span style={{ display: 'grid', placeItems: 'center', width: 44, height: 44, borderRadius: 99, background: ready ? c.accent : c.surface2, color: ready ? c.onAccent : c.faint,
        transform: `translateY(${-glow}px) scale(${1 + glow * 0.06 - sendPress * 0.12})`, boxShadow: `0 0 ${glow * 14}px ${glow * 3}px color-mix(in srgb, ${c.accent} ${Math.round(glow * 55)}%, transparent)` }}><SendIcon /></span>
    </div>
    <div style={{ height: COMPOSER.opts, display: 'flex', alignItems: 'center', gap: 16, padding: '0 6px', fontSize: 12.5, color: c.ink }}>
      <span style={{ fontWeight: 600 }}>Text model ⌃</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ display: 'grid', color: c.soft }}><Shield /></span>Ask when it matters</span>
    </div>
  </div>;
}

/** The + menu (Composer's DropdownMenu): Dictate, Image from files, Take photo. */
function PlusMenu({ show, lit = -1 }: { show: number; lit?: number }) {
  if (show < 0.01) return null;
  const p = plusAt();
  const rows: Array<[string, React.ReactNode]> = [['Dictate', <Mic key="m" />], ['Image from files', <Image key="i" />], ['Take photo', <Camera key="c" />]];
  return <div style={{ position: 'absolute', left: p.x - 20, top: p.y - 30 - rows.length * 44, width: 200, borderRadius: 6, background: c.surface, boxShadow: `0 8px 24px ${c.shadow}`,
    opacity: show, transform: `scale(${mix(0.85, 1, show)})`, transformOrigin: 'left bottom', zIndex: 8, overflow: 'hidden', fontSize: 15, color: c.ink, padding: '6px 0' }}>
    {rows.map(([label, icon], i) => <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 14, height: 44, padding: '0 14px', background: i === lit ? c.surface2 : 'transparent' }}>
      <span style={{ display: 'grid', color: c.soft }}>{icon}</span>{label}</div>)}
  </div>;
}
const menuRowAt = (i: number) => { const p = plusAt(); return { x: p.x + 60, y: p.y - 30 - 3 * 44 + 6 + i * 44 + 22 }; };

/** A chat with nothing in it yet: the bar, and the composer at the bottom. */
function EmptyChat({ children }: { children?: React.ReactNode }) {
  return <>
    <TopBar title="New chat" center />
    {children}
  </>;
}

/* ---------- New chat (NewChatScreen.kt): the folder, then Start on the computer ---------- */

function NewChatForm({ folder, startPress = 0, startGlow = 0 }: { folder: string; startPress?: number; startGlow?: number }) {
  const chip = (label: string, on: boolean) => <span key={label} style={{ display: 'inline-flex', alignItems: 'center', height: 34, padding: '0 14px', borderRadius: 8, fontSize: 14,
    background: on ? c.accent : 'transparent', color: on ? c.onAccent : c.ink, border: on ? 'none' : `1px solid ${c.line}` }}>{label}</span>;
  return <>
    <TopBar title="New chat" />
    <div style={{ position: 'absolute', left: 16, top: 64, fontSize: 12.5, fontWeight: 600, letterSpacing: '0.06em', color: c.soft }}>ON {COMPUTER.toUpperCase()}</div>
    <div style={{ position: 'absolute', left: 16, top: 86, display: 'flex', gap: 8 }}>{chip('Chat', true)}{chip('Image', false)}</div>
    <div style={{ position: 'absolute', left: 16, right: 16, top: 130, height: 236, borderRadius: 16, border: `1px solid ${c.line}`, background: c.surface, padding: 14, boxSizing: 'border-box' }}>
      <div style={{ fontSize: 13, color: c.soft, marginBottom: 8 }}>Model · from {COMPUTER}</div>
      <div style={{ height: 40, borderRadius: 10, background: c.surface2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 12px', fontSize: 15, color: c.ink }}>Text model<span style={{ color: c.accent }}>✓</span></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: c.soft, margin: '14px 0 8px' }}><span style={{ display: 'grid', color: c.accent }}><Folder /></span>Folder</div>
      <div style={{ display: 'flex', gap: 8 }}>{chip('None', folder === '')}{chip('Sales', folder === 'Sales')}{chip('Website', false)}</div>
      <div style={{ marginTop: 18, height: 46, borderRadius: 99, background: c.accent, color: c.onAccent, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, fontSize: 15, fontWeight: 600,
        transform: `scale(${1 + startGlow * 0.03 - startPress * 0.05})`, boxShadow: `0 0 ${startGlow * 14}px ${startGlow * 3}px color-mix(in srgb, ${c.accent} ${Math.round(startGlow * 50)}%, transparent)` }}><Laptop />Start on {COMPUTER}</div>
    </div>
  </>;
}
const SALES = { x: 16 + 14 + 76 + 8 + 30, y: 130 + 14 + 21 + 40 + 14 + 8 + 21 + 17 };
const START = { x: 180, y: SALES.y + 17 + 18 + 23 };

/** A fingertip: a soft disc that darkens and spreads a ring when it presses. */
function Finger({ x, y, press = 0, show = 1 }: { x: number; y: number; press?: number; show?: number }) {
  if (show < 0.01) return null;
  return <>
    <div style={{ position: 'absolute', left: x - 18, top: y - 18, width: 36, height: 36, borderRadius: 99, background: `color-mix(in srgb, ${c.ink} ${Math.round(16 + press * 14)}%, transparent)`,
      border: `2px solid color-mix(in srgb, ${c.surface} 85%, transparent)`, boxShadow: `0 4px 10px ${c.shadow}`, opacity: show, transform: `scale(${1 - press * 0.12})`, zIndex: 20 }} />
    {press > 0.01 && <div style={{ position: 'absolute', left: x - 26, top: y - 26, width: 52, height: 52, borderRadius: 99, border: `2px solid ${c.accent}`, opacity: press * 0.6 * show, transform: `scale(${mix(0.7, 1.15, press)})`, zIndex: 19 }} />}
  </>;
}

/* ---------- 1. Start with a question ---------- */

export function StartDemo() {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const at = useAt();
  const field = fieldAt();
  const typedN = Math.round(tween(f, [at(1.9), at(3.3)], [0, PROMPT.length], out));
  const draft = PROMPT.slice(0, typedN);
  const typing = f >= at(1.5);
  const finger = along(f, [[at(0.8), 300, 150], [at(1.3), field.x, field.y], [at(1.7), field.x, field.y], [at(2.3), 320, 160]]);
  return <Scene>
    <EmptyChat>
      <Composer draft={draft} caret={typing} y={(1 - pop(f, 0, fps)) * 14} />
    </EmptyChat>
    <Finger {...finger} press={tap(f, at(1.45), fps)} show={tween(f, [at(0.8), at(1.0)], [0, 1], out) * (1 - tween(f, [at(2.1), at(2.4)], [0, 1], out))} />
  </Scene>;
}

/* ---------- 2. Add photos and a folder ---------- */

export function AddDemo() {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const at = useAt();
  // New chat: Sales is picked, then Start on Mac; the chat opens over it.
  const picked = f >= at(1.15);
  const open = tween(f, [at(2.35), at(2.75)], [0, 1]);
  // In the chat: + opens its menu, Image from files, and the photo lands in the box.
  const menu = tween(f, [at(3.65), at(3.9)], [0, 1], out) * (1 - tween(f, [at(4.55), at(4.75)], [0, 1], out));
  const photo = tween(f, [at(4.8), at(5.15)], [0, 1], out);
  const plus = plusAt();
  const row = menuRowAt(1);
  const finger = along(f, [[at(0.4), 300, 380], [at(0.85), SALES.x, SALES.y], [at(1.15), SALES.x, SALES.y], [at(1.6), START.x, START.y], [at(2.1), START.x, START.y], [at(2.5), 320, 200],
    [at(3.1), 320, 200], [at(3.45), plus.x, plus.y], [at(3.75), plus.x, plus.y], [at(4.15), row.x, row.y], [at(4.5), row.x, row.y], [at(5.0), 320, 200]]);
  return <Scene>
    <div style={{ position: 'absolute', inset: 0, opacity: 1 - open }}>
      <NewChatForm folder={picked ? 'Sales' : ''} startPress={tap(f, at(1.95), fps)} startGlow={tween(f, [at(1.5), at(1.9)], [0, 1], out) * (1 - tween(f, [at(2.0), at(2.3)], [0, 1]))} />
    </div>
    <div style={{ position: 'absolute', inset: 0, background: c.paper, opacity: open, transform: `translateX(${(1 - open) * 40}px)` }}>
      <EmptyChat>
        <Composer draft={PROMPT} photo={photo} plusPress={tap(f, at(3.6), fps)} />
        <PlusMenu show={menu} lit={f >= at(4.3) ? 1 : -1} />
      </EmptyChat>
    </div>
    <Finger {...finger} press={Math.max(tap(f, at(1.0), fps), tap(f, at(1.95), fps), tap(f, at(3.6), fps), tap(f, at(4.35), fps))}
      show={tween(f, [at(0.4), at(0.6)], [0, 1], out) * (1 - tween(f, [at(2.3), at(2.5)], [0, 1], out) + tween(f, [at(3.0), at(3.2)], [0, 1], out)) * (1 - tween(f, [at(4.9), at(5.2)], [0, 1], out))} />
  </Scene>;
}

/* ---------- 3. Tap Send, and Nekko gets to work ---------- */

export function SendDemo() {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const at = useAt();
  const send = at(1.2);
  const sent = f >= send;
  const btn = sendAt();
  const finger = along(f, [[at(0.2), 300, 200], [at(0.9), btn.x, btn.y], [at(1.35), btn.x, btn.y], [at(1.9), 320, 190]]);
  const glow = tween(f, [at(0.5), at(0.9)], [0, 1], out) * (1 - tween(f, [at(1.3), at(1.5)], [0, 1]));
  const climb = Math.min(1, pop(f, send, fps));
  const thinking = tween(f, [at(1.9), at(2.1)], [0, 1], out) * (1 - tween(f, [at(3.0), at(3.2)], [0, 1], out));
  const reply = Math.min(1, pop(f, at(3.1), fps));
  const field = fieldAt();
  return <Scene>
    <EmptyChat>
      {sent && <div style={{ position: 'absolute', right: 14, top: mix(field.y - 16, 64, climb), maxWidth: 240, boxSizing: 'border-box', padding: '9px 14px', borderRadius: 18, fontSize: 15,
        background: c.accent, color: c.onAccent, opacity: Math.min(1, climb * 1.5), zIndex: 4 }}>{PROMPT}</div>}
      {thinking > 0.01 && <div style={{ position: 'absolute', left: 18, top: 116, display: 'flex', gap: 5, opacity: thinking }}>
        {[0, 1, 2].map(i => <span key={i} style={{ width: 7, height: 7, borderRadius: 4, background: c.soft, transform: `translateY(${-Math.max(0, Math.sin(f / 4.5 - i * 0.9)) * 3}px)` }} />)}
      </div>}
      {reply > 0.01 && <div style={{ position: 'absolute', left: 18, top: 112, width: 310, opacity: reply, transform: `translateY(${(1 - reply) * 10}px)` }}>
        <div style={{ fontSize: 15, color: c.ink, marginBottom: 9 }}>Here’s the summary of the sales notes:</div>
        {[290, 240, 190].map((w) => <div key={w} style={{ height: 6, width: w, borderRadius: 3, background: c.line, marginBottom: 7 }} />)}
      </div>}
      <Composer draft={sent ? '' : PROMPT} sendPress={tap(f, at(1.15), fps)} glow={glow} />
    </EmptyChat>
    <Finger {...finger} press={tap(f, at(1.15), fps)} show={tween(f, [at(0.2), at(0.4)], [0, 1], out) * (1 - tween(f, [at(1.6), at(1.9)], [0, 1], out))} />
  </Scene>;
}

export const ANDROID_DEMOS = { start: StartDemo, add: AddDemo, send: SendDemo } as const;
