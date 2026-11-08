import React from 'react';
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { PeekNekkoArt, greetingGaze } from '../../src/renderer/components/GreetingNekko.js';

/*
 * The iPhone's "Send your first prompt" demos: the same three steps as the
 * desktop's FirstPromptIntro, drawn on the iPhone's own new-chat screen
 * (NewChatView: the peeking Nekko, "What should we work on?", the glass box
 * with +, the mic and Start, and its model, effort, folder and permission
 * chips). A finger taps where the desktop has a pointer. The words live in
 * the app (FirstPromptIntroView.swift), not in the video. Rendered to MP4 by
 * scripts/render-first-prompt-intro.mjs, painted with the colour variables the
 * entry sets from the iPhone's palette (Theme.swift).
 */

export const PHONE_FPS = 30;
export const PHONE_SIZE = { width: 360, height: 400 } as const;
export const PHONE_STEPS = [
  { id: 'start', seconds: 5.5 },
  { id: 'add', seconds: 6 },
  { id: 'send', seconds: 6 },
] as const;

const c = {
  paper: 'var(--paper)', surface: 'var(--surface)', surface2: 'var(--surface-2)', line: 'var(--line)',
  ink: 'var(--ink)', soft: 'var(--ink-soft)', faint: 'var(--ink-faint)', accent: 'var(--accent)', onAccent: 'var(--on-accent)',
  shadow: 'color-mix(in srgb, var(--ink) 16%, transparent)',
};
const font = '-apple-system, "SF Pro Text", system-ui, sans-serif';
const out = Easing.bezier(0.16, 1, 0.3, 1);
const inOut = Easing.bezier(0.83, 0, 0.17, 1);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const tween = (f: number, r: [number, number], to: [number, number], easing = inOut) => interpolate(f, r, to, { ...clamp, easing });
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const useAt = () => { const { fps } = useVideoConfig(); return (s: number) => Math.round(s * fps); };
const pop = (f: number, at: number, fps: number) => spring({ frame: f - at, fps, config: { damping: 14, stiffness: 160, mass: 0.6 } });
const tap = (f: number, at: number, fps: number) => pop(f, at, fps) - pop(f, at + Math.round(fps * 0.15), fps);
const blink = (f: number, at: number) => { const t = f - at; return t < 0 || t > 6 ? 0 : Math.sin((t / 6) * Math.PI); };
const hop = (f: number, at: number, len: number) => { const t = (f - at) / len; return t < 0 || t > 1 ? 0 : Math.sin(t * Math.PI); };

/** A path through timed stops, eased between each. */
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

/* ---------- Layout (NewChatView, scaled to the 360 pt frame) ---------- */

const BOX = { x: 14, w: 332, pad: 12, field: 34, row: 44, chips: 32 };
const boxH = (photo: number) => BOX.pad + BOX.field + photo * 58 + BOX.row + 8 + BOX.chips * 2 + 6 + BOX.pad;
/** Nekko at 2.5 pt per art pixel, paws on the box's top edge (row 25), as GreetingNekko sits. */
const U = 2.5;
const NEKKO = { w: 32 * U, h: 30 * U };
const nekkoY = (top: number) => top - 25 * U;
const NEKKO_X = BOX.x + 10;
const faceOf = (top: number) => ({ x: NEKKO_X + 16 * U, y: nekkoY(top) + 15 * U });
const gaze = (face: { x: number; y: number }, x: number, y: number) => greetingGaze((x - face.x) * 80 / NEKKO.w, (y - face.y) * 80 / NEKKO.w);
const PLACEHOLDER = 'What should your computer do?';
const PROMPT = 'Summarize the sales notes';
const FOLDER = 'Sales';

function Scene({ children }: { children: React.ReactNode }) {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const leave = tween(f, [durationInFrames - 10, durationInFrames - 1], [0, 1], Easing.bezier(0.7, 0, 0.84, 0));
  const enter = tween(f, [0, 8], [0, 1], out);
  return (
    <AbsoluteFill style={{ fontFamily: font, background: `linear-gradient(color-mix(in srgb, ${c.accent} var(--wash-top), ${c.paper}), color-mix(in srgb, ${c.accent} 4%, ${c.paper}))`, overflow: 'hidden' }}>
      <style>{`.ph-nekko { width: ${NEKKO.w}px; height: ${NEKKO.h}px; display: block; overflow: visible; }`}</style>
      <AbsoluteFill style={{ opacity: Math.min(enter, 1 - leave), transform: `translateY(${leave * -10}px)` }}>{children}</AbsoluteFill>
    </AbsoluteFill>
  );
}

/** GreetingNekko's PeekNekkoArt over the box's top edge, rising from behind it. Never rotated. */
function Nekko({ top, lift = 0, look, squint = 0, laugh = false, paws = 1 }: { top: number; lift?: number; look: { x: number; y: number }; squint?: number; laugh?: boolean; paws?: number }) {
  const clip = 25 * U + paws * 3 * U;
  return <>
    <style>{`.ph-nekko [data-nekko-look] { transform-box: fill-box; transform-origin: center; transform: translate(${look.x}px, ${look.y}px) scaleY(${1 - squint * 0.82}); }
.ph-nekko .peek-paws-slot { opacity: ${paws}; }`}</style>
    <div style={{ position: 'absolute', left: NEKKO_X - 20, top: nekkoY(top) - 30, width: NEKKO.w + 40, height: 30 + clip, overflow: 'hidden', zIndex: 4 }}>
      <div style={{ position: 'absolute', left: 20, top: 30, transform: `translateY(${lift}px)` }}>
        <PeekNekkoArt className="ph-nekko" look={look} laugh={laugh} paws={paws > 0.5} />
      </div>
    </div>
  </>;
}

/** NewChatView's heading beside Nekko: "What should we work on?". */
function Greeting({ top, show = 1 }: { top: number; show?: number }) {
  return <div style={{ position: 'absolute', left: NEKKO_X + NEKKO.w + 10, top: top - 52, height: 40, display: 'flex', alignItems: 'center', fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em', color: c.ink, opacity: show }}>What should we work on?</div>;
}

const glyph = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
const Plus = () => <svg width="16" height="16" viewBox="0 0 24 24" {...glyph} strokeWidth={2.4}><path d="M12 4v16M4 12h16" /></svg>;
const Mic = () => <svg width="20" height="20" viewBox="0 0 24 24" {...glyph}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3" /></svg>;
const Up = () => <svg width="16" height="16" viewBox="0 0 24 24" {...glyph} strokeWidth={2.6}><path d="M12 20V5M5 11l7-7 7 7" /></svg>;
const Chip = () => <svg width="14" height="14" viewBox="0 0 24 24" {...glyph}><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></svg>;
const Folder = () => <svg width="15" height="15" viewBox="0 0 24 24" {...glyph}><path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /></svg>;
const Shield = () => <svg width="14" height="14" viewBox="0 0 24 24" {...glyph}><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M8.5 12l2.5 2.5 4.5-5" /></svg>;
const Photo = () => <svg width="16" height="16" viewBox="0 0 24 24" {...glyph}><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M21 16l-5-5-8 8" /></svg>;

/** One of the box's option chips (NewChatView `chip`): a capsule on the surface. */
function Pill({ icon, label, lit = 0, plain = false }: { icon: React.ReactNode; label: string; lit?: number; plain?: boolean }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: BOX.chips - 4, padding: plain ? '0 4px' : '0 11px', borderRadius: 999, boxSizing: 'border-box',
    background: plain ? 'transparent' : c.surface, border: plain ? 'none' : `1px solid color-mix(in srgb, ${c.accent} ${Math.round(lit * 60)}%, ${c.line})`, color: c.ink, fontSize: 13, whiteSpace: 'nowrap',
    boxShadow: lit > 0.01 ? `0 4px 12px color-mix(in srgb, ${c.accent} ${Math.round(lit * 30)}%, transparent)` : 'none' }}>
    <span style={{ display: 'grid', color: c.soft }}>{icon}</span>{label}
  </span>;
}

/** A sample photo thumbnail (ComposerPhotos): a little landscape in the accent. */
function Thumb({ size, show = 1 }: { size: number; show?: number }) {
  return <div style={{ width: size, height: size, borderRadius: 10, overflow: 'hidden', position: 'relative', opacity: show, transform: `scale(${mix(0.6, 1, show)})`, transformOrigin: 'left center',
    background: `linear-gradient(color-mix(in srgb, ${c.accent} 22%, ${c.surface}), color-mix(in srgb, ${c.accent} 45%, ${c.surface}))`, border: `1px solid ${c.line}` }}>
    <div style={{ position: 'absolute', left: '62%', top: '20%', width: size * 0.18, height: size * 0.18, borderRadius: 99, background: c.surface }} />
    <svg viewBox="0 0 10 10" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}><path d="M0 10V7l3-3 3 3 1.5-1.5L10 8v2z" fill={c.accent} opacity="0.75" /></svg>
  </div>;
}

/** NewChatView's composer on frosted glass: the field, photos, + / mic / Start, then the option chips. */
function Box({ top, draft = '', caret = false, photo = 0, folder = '', folderLit = 0, plusPress = 0, startPress = 0, glow = 0, enter = 1 }: {
  top: number; draft?: string; caret?: boolean; photo?: number; folder?: string; folderLit?: number; plusPress?: number; startPress?: number; glow?: number; enter?: number;
}) {
  const f = useCurrentFrame();
  const ready = draft.length > 0;
  const on = caret && Math.floor(f / 14) % 2 === 0;
  return <div style={{ position: 'absolute', left: BOX.x, top, width: BOX.w, height: boxH(photo), boxSizing: 'border-box', padding: BOX.pad, borderRadius: 18,
    background: `color-mix(in srgb, ${c.surface} 70%, transparent)`, boxShadow: `0 18px 40px -14px color-mix(in srgb, ${c.accent} 40%, transparent), 0 2px 5px ${c.shadow}`,
    opacity: enter, transform: `translateY(${(1 - enter) * 14}px)`, zIndex: 3, overflow: 'hidden' }}>
    <div style={{ height: BOX.field, display: 'flex', alignItems: 'center', fontSize: 16, color: ready ? c.ink : c.faint, whiteSpace: 'pre' }}>
      {draft || PLACEHOLDER}
      {caret && <span style={{ display: 'inline-block', width: 2, height: 19, marginLeft: 1, background: c.accent, opacity: on ? 1 : 0 }} />}
    </div>
    <div style={{ height: photo * 58, overflow: 'hidden', display: 'flex', alignItems: 'center' }}><Thumb size={50} show={photo} /></div>
    <div style={{ height: BOX.row, display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ display: 'grid', placeItems: 'center', width: 34, height: 34, borderRadius: 99, background: c.surface, border: `1px solid ${c.line}`, color: c.ink, transform: `scale(${1 - plusPress * 0.12})` }}><Plus /></span>
      <span style={{ flex: 1 }} />
      <span style={{ display: 'grid', placeItems: 'center', width: 34, height: 34, color: c.soft }}><Mic /></span>
      <span style={{ display: 'grid', placeItems: 'center', width: 34, height: 34, borderRadius: 99, background: ready ? c.accent : c.surface2, color: ready ? c.onAccent : c.faint,
        transform: `translateY(${-glow}px) scale(${1 + glow * 0.06 - startPress * 0.12})`, boxShadow: `0 0 ${glow * 14}px ${glow * 3}px color-mix(in srgb, ${c.accent} ${Math.round(glow * 55)}%, transparent)` }}><Up /></span>
    </div>
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 6 }}><Pill icon={<Chip />} label="Automatic" /><Pill icon={<span style={{ width: 12, height: 12, borderRadius: 99, border: `2px solid ${c.accent}`, borderRightColor: c.line, display: 'block' }} />} label="Medium" /></div>
      <div style={{ display: 'flex', gap: 6 }}><Pill icon={<Folder />} label={folder || 'No folder'} lit={folderLit} /><Pill plain icon={<Shield />} label="Ask when it matters" /></div>
    </div>
  </div>;
}
/** Where the box's pieces are, for the finger. */
const plusAt = (top: number, photo = 0) => ({ x: BOX.x + BOX.pad + 17, y: top + BOX.pad + BOX.field + photo * 58 + BOX.row / 2 });
const startAt = (top: number, photo = 0) => ({ x: BOX.x + BOX.w - BOX.pad - 17, y: plusAt(top, photo).y });
const folderAt = (top: number, photo = 0) => ({ x: BOX.x + BOX.pad + 44, y: top + BOX.pad + BOX.field + photo * 58 + BOX.row + 8 + BOX.chips + 6 + BOX.chips / 2 - 2 });

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
  const top = 150;
  const face = faceOf(top);
  const field = { x: BOX.x + 120, y: top + BOX.pad + BOX.field / 2 };
  const typedN = Math.round(tween(f, [at(1.9), at(3.3)], [0, PROMPT.length], out));
  const draft = PROMPT.slice(0, typedN);
  const typing = f >= at(1.5);
  const finger = along(f, [[at(0.8), 300, 360], [at(1.3), field.x, field.y], [at(1.7), field.x, field.y], [at(2.3), 330, 380]]);
  let look = gaze(face, face.x + 100, top + 120);
  if (f >= at(0.9)) look = gaze(face, finger.x, finger.y);
  if (typing) look = gaze(face, BOX.x + BOX.pad + draft.length * 8, field.y);
  return <Scene>
    <Greeting top={top} show={pop(f, at(0.05), fps)} />
    <Box top={top} draft={draft} caret={typing} enter={pop(f, 0, fps)} />
    <Nekko top={top} lift={(1 - pop(f, at(0.15), fps)) * 22 * U + Math.sin(f / 20)} look={look} squint={blink(f, at(4.3))} laugh={f >= at(3.5) && f < at(4.1)} paws={tween(f, [at(0.5), at(0.7)], [0, 1], out)} />
    <Finger {...finger} press={tap(f, at(1.45), fps)} show={tween(f, [at(0.8), at(1.0)], [0, 1], out) * (1 - tween(f, [at(2.1), at(2.4)], [0, 1], out))} />
  </Scene>;
}

/* ---------- 2. Add photos and a folder ---------- */

export function AddDemo() {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const at = useAt();
  const top = 116;
  const face = faceOf(top);
  const photo = tween(f, [at(2.1), at(2.45)], [0, 1], out);
  const plus = plusAt(top);
  // The + menu (NewChatView: Photos, Paste image), rising from the button.
  const menu = tween(f, [at(1.0), at(1.25)], [0, 1], out) * (1 - tween(f, [at(1.85), at(2.05)], [0, 1], out));
  const photosRow = { x: plus.x + 60, y: plus.y + 48 };
  const folder = folderAt(top, photo);
  // The folder picker as a small sheet of the computer's folders; Sales is picked.
  const sheet = tween(f, [at(3.3), at(3.55)], [0, 1], out) * (1 - tween(f, [at(4.2), at(4.4)], [0, 1], out));
  const salesRow = { x: 120, y: 266 };
  const picked = f >= at(4.25);
  const finger = along(f, [[at(0.5), 300, 380], [at(0.9), plus.x, plus.y], [at(1.15), plus.x, plus.y], [at(1.5), photosRow.x, photosRow.y], [at(1.85), photosRow.x, photosRow.y],
    [at(2.9), folder.x, folder.y], [at(3.25), folder.x, folder.y], [at(3.75), salesRow.x, salesRow.y], [at(4.2), salesRow.x, salesRow.y], [at(4.8), 330, 390]]);
  let look = gaze(face, finger.x, finger.y);
  if (f >= at(2.1) && f < at(2.7)) look = gaze(face, BOX.x + 40, top + 70);
  if (picked) look = gaze(face, folder.x, folder.y);
  return <Scene>
    <Greeting top={top} />
    <Box top={top} draft={PROMPT} photo={photo} plusPress={tap(f, at(1.0), fps)} folder={picked ? FOLDER : ''} folderLit={tween(f, [at(4.25), at(4.5)], [0, 1], out) * (1 - tween(f, [at(5.0), at(5.4)], [0, 1]))} />
    {menu > 0.01 && <div style={{ position: 'absolute', left: plus.x - 14, top: plus.y + 26, width: 170, borderRadius: 14, background: c.surface, boxShadow: `0 10px 28px ${c.shadow}`, border: `1px solid ${c.line}`,
      opacity: menu, transform: `scale(${mix(0.85, 1, menu)})`, transformOrigin: 'left top', zIndex: 8, overflow: 'hidden', fontSize: 15, color: c.ink }}>
      {[['Photos', <Photo key="p" />], ['Paste image', <Plus key="v" />]].map(([label, icon], i) => <div key={String(label)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 44, padding: '0 14px',
        borderTop: i ? `1px solid ${c.line}` : 'none', background: i === 0 && f >= at(1.6) && f < at(1.95) ? c.surface2 : 'transparent', color: i ? c.faint : c.ink }}>{label}<span style={{ display: 'grid', color: c.soft }}>{icon}</span></div>)}
    </div>}
    {sheet > 0.01 && <div style={{ position: 'absolute', left: 30, right: 30, top: 200, borderRadius: 16, background: c.surface, boxShadow: `0 14px 34px ${c.shadow}`, border: `1px solid ${c.line}`,
      opacity: sheet, transform: `translateY(${(1 - sheet) * 30}px)`, zIndex: 8, overflow: 'hidden', fontSize: 15, color: c.ink }}>
      {['No folder', 'Sales', 'Website'].map((name, i) => <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 10, height: 44, padding: '0 14px', borderTop: i ? `1px solid ${c.line}` : 'none',
        background: name === FOLDER && f >= at(4.0) ? c.surface2 : 'transparent' }}><span style={{ display: 'grid', color: c.soft }}><Folder /></span>{name}</div>)}
    </div>}
    <Nekko top={top} lift={Math.sin(f / 20) - hop(f, at(2.5), at(0.35)) * 6 - hop(f, at(4.5), at(0.35)) * 6} look={look} squint={blink(f, at(5.2))} laugh={(f >= at(2.45) && f < at(2.9)) || (f >= at(4.45) && f < at(4.9))} />
    <Finger {...finger} press={Math.max(tap(f, at(1.0), fps), tap(f, at(1.75), fps), tap(f, at(3.1), fps), tap(f, at(4.05), fps))} show={tween(f, [at(0.5), at(0.7)], [0, 1], out) * (1 - tween(f, [at(4.6), at(4.9)], [0, 1], out))} />
  </Scene>;
}

/* ---------- 3. Tap Start, and Nekko gets to work ---------- */

export function SendDemo() {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const at = useAt();
  const send = at(1.2);
  const sent = f >= send;
  const top0 = 150;
  // Once sent, the chat opens: the box drops to the bottom (ChatView's composer) and the message rises.
  const drop = tween(f, [send, send + at(0.5)], [0, 1]);
  const top = mix(top0, 250, drop);
  const face = faceOf(top);
  const startBtn = startAt(top0);
  const finger = along(f, [[at(0.2), 300, 380], [at(0.9), startBtn.x, startBtn.y], [at(1.35), startBtn.x, startBtn.y], [at(1.9), 330, 395]]);
  const glow = tween(f, [at(0.5), at(0.9)], [0, 1], out) * (1 - tween(f, [at(1.3), at(1.5)], [0, 1]));
  const climb = Math.min(1, pop(f, send, fps));
  const thinking = tween(f, [at(1.9), at(2.1)], [0, 1], out) * (1 - tween(f, [at(3.0), at(3.2)], [0, 1], out));
  const reply = Math.min(1, pop(f, at(3.1), fps));
  const hops = hop(f, at(3.7), at(0.4)) * 8 + hop(f, at(4.15), at(0.4)) * 8;
  let look = gaze(face, startBtn.x, startBtn.y);
  if (sent) look = gaze(face, 300, 40);
  if (f >= at(3.2)) look = gaze(face, 120, 90);
  const msgW = 230;
  return <Scene>
    <Greeting top={top} show={1 - tween(f, [send, send + at(0.25)], [0, 1], out)} />
    {sent && <div style={{ position: 'absolute', right: 14, top: mix(top0 + BOX.pad, 26, climb), width: msgW, boxSizing: 'border-box', padding: '9px 14px', borderRadius: 18, fontSize: 15,
      background: c.accent, color: c.onAccent, opacity: Math.min(1, climb * 1.5), zIndex: 4 }}>{PROMPT}</div>}
    {reply > 0.01 && <div style={{ position: 'absolute', left: 18, top: 84, width: 300, opacity: reply, transform: `translateY(${(1 - reply) * 10}px)` }}>
      <div style={{ fontSize: 15, color: c.ink, marginBottom: 9 }}>Here’s the summary of the sales notes:</div>
      {[280, 230, 180].map((w) => <div key={w} style={{ height: 6, width: w, borderRadius: 3, background: c.line, marginBottom: 7 }} />)}
    </div>}
    <Box top={top} draft={sent ? '' : PROMPT} startPress={tap(f, at(1.15), fps)} glow={glow} />
    {thinking > 0.01 && <div style={{ position: 'absolute', left: NEKKO_X + 29 * U, top: nekkoY(top) + 6 * U, display: 'flex', gap: 5, padding: '8px 10px', borderRadius: 12, background: c.surface, border: `1px solid ${c.line}`,
      boxShadow: `0 6px 14px ${c.shadow}`, opacity: thinking, transform: `scale(${mix(0.6, 1, thinking)})`, transformOrigin: 'left bottom', zIndex: 5 }}>
      {[0, 1, 2].map(i => <span key={i} style={{ width: 7, height: 7, borderRadius: 4, background: c.soft, transform: `translateY(${-Math.max(0, Math.sin(f / 4.5 - i * 0.9)) * 3}px)` }} />)}
    </div>}
    <Nekko top={top} lift={Math.sin(f / 20) - hops} look={look} squint={Math.max(thinking, blink(f, at(5.1)))} laugh={f >= at(3.65) && f < at(4.8)} paws={1 - thinking} />
    <Finger {...finger} press={tap(f, at(1.15), fps)} show={tween(f, [at(0.2), at(0.4)], [0, 1], out) * (1 - tween(f, [at(1.6), at(1.9)], [0, 1], out))} />
  </Scene>;
}

export const PHONE_DEMOS = { start: StartDemo, add: AddDemo, send: SendDemo } as const;
