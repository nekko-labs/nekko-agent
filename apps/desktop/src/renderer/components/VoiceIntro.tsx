import React, { useId } from 'react';
import { Player } from '@remotion/player';
import { AbsoluteFill, Easing, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Modal } from './primitives/Modal.js';
import { CloseIcon } from '../icons.js';
import { useStore } from '../store.js';

/*
 * The first-open video for always-on dictation, drawn with Remotion: a
 * simplified composer and phone, not screenshots, painted with the app's own
 * colour variables so it matches the light or dark theme (the fallbacks are
 * the dark theme, for a render outside the app).
 *
 * Storyboard, about 38 s at 30 fps, captions on screen, no voiceover:
 *   1. Tap the mic once (6 s): the pointer taps the composer's mic; it turns
 *      red and the listening strip rises with its level meter.
 *   2. Talk (7 s): words type into the draft as they are heard.
 *   3. Commands (10 s): "Nekko, erase that", "send it", "new chat", each with
 *      the toast the app shows.
 *   4. iPhone (8 s): a phone listening, then locked; the mic goes off. The
 *      caption adds the Lock Screen card's mic (Face ID, then one message).
 *   5. Privacy (7 s): the promise, word for word, and a hold to the end.
 */

export const PRIVACY_PROMISE = 'Speech is turned into text on your own computer or phone. We never store, hear, or train on your voice, and your chats stay yours.';

/** Every colour, curve and spring the video uses. */
const theme = {
  colors: {
    bg: 'var(--surface-2, #20202a)',
    win: 'var(--win, #17171e)',
    line: 'var(--line, #26262f)',
    ink: 'var(--ink, #eceaf3)',
    soft: 'var(--ink-soft, #a3a1b0)',
    faint: 'var(--ink-faint, #6b6b78)',
    accent: 'var(--accent, #8b7dff)',
    glow: 'var(--accent-soft, rgba(139, 125, 255, 0.18))',
    hot: 'var(--danger, #e0574a)',
    hotSoft: 'var(--danger-soft, rgba(224, 87, 74, 0.18))',
    shadow: 'rgba(0, 0, 0, 0.22)',
    night: '#0b0b10',
    bezel: 'color-mix(in srgb, var(--ink-faint, #6b6b78) 45%, var(--line, #26262f))',
  },
  ease: {
    out: Easing.bezier(0.16, 1, 0.3, 1),
    inOut: Easing.bezier(0.83, 0, 0.17, 1),
    in: Easing.bezier(0.7, 0, 0.84, 0),
  },
  spring: {
    snappy: { damping: 14, stiffness: 160, mass: 0.6 },
    smooth: { damping: 20, stiffness: 90, mass: 1 },
  },
  font: 'var(--font-sans, system-ui, sans-serif)',
} as const;

const W = 1280;
const H = 720;
const FPS = 30;
export const VOICE_INTRO_FPS = FPS;
export const VOICE_INTRO_SIZE = { width: W, height: H } as const;

type Ease = (t: number) => number;
type SpringConfig = { damping: number; stiffness: number; mass: number };
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
/** Seconds to frames. */
const useAt = () => { const { fps } = useVideoConfig(); return (s: number) => Math.round(s * fps); };
const tween = (frame: number, range: [number, number], to: [number, number], easing: Ease = theme.ease.inOut) => interpolate(frame, range, to, { ...clamp, easing });
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const pop = (frame: number, at: number, fps: number, config: SpringConfig = theme.spring.snappy) => spring({ frame: frame - at, fps, config });
/** A short press: in, then out. */
const tap = (frame: number, at: number, fps: number) => pop(frame, at, fps) - pop(frame, at + Math.round(fps * 0.15), fps);

/* ---------- Layers every scene sits on ---------- */

function Backdrop() {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: theme.colors.bg, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', width: 900, height: 900, borderRadius: '50%', left: -300 + Math.sin(frame / 60) * 40, top: -480, filter: 'blur(60px)', background: `radial-gradient(circle, ${theme.colors.glow}, transparent 65%)` }} />
      <div style={{ position: 'absolute', width: 760, height: 760, borderRadius: '50%', right: -300 - Math.cos(frame / 75) * 36, bottom: -440, filter: 'blur(70px)', background: `radial-gradient(circle, ${theme.colors.glow}, transparent 65%)`, opacity: 0.75 }} />
    </AbsoluteFill>
  );
}

const NOISE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='220' height='220' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E")`;

/** Grain and vignette, the top layers. The grain stays still so the player is not repainting noise every frame. */
function Finish() {
  return <>
    <AbsoluteFill style={{ pointerEvents: 'none', backgroundImage: NOISE, backgroundSize: '220px', opacity: 0.035 }} />
    <AbsoluteFill style={{ pointerEvents: 'none', background: 'radial-gradient(ellipse at center, transparent 58%, rgba(0, 0, 0, 0.16) 100%)' }} />
  </>;
}

/** A scene's entrance and a faster exit; the last scene holds instead. */
function Scene({ children, exit = true }: { children: React.ReactNode; exit?: boolean }) {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();
  const enter = pop(frame, 0, fps, theme.spring.smooth);
  const out = exit ? tween(frame, [durationInFrames - 10, durationInFrames - 1], [0, 1], theme.ease.in) : 0;
  return (
    <AbsoluteFill style={{ fontFamily: theme.font, opacity: Math.min(enter, 1 - out), transform: `translateY(${(1 - enter) * 16 - out * 14}px) scale(${mix(0.98, 1, enter)})` }}>
      {children}
    </AbsoluteFill>
  );
}

/** Words rising in one after another. */
function Words({ text, at, style }: { text: string; at: number; style: React.CSSProperties }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', columnGap: '0.28em', ...style }}>
    {text.split(' ').map((word, i) => {
      const t = pop(frame, at + i * 3, fps, theme.spring.smooth);
      return <span key={i} style={{ display: 'inline-block', opacity: t, transform: `translateY(${(1 - t) * 18}px) scale(${mix(0.96, 1, t)})` }}>{word}</span>;
    })}
  </div>;
}

/** The caption block under each scene. */
function Caption({ scene }: { scene: VoiceIntroScene }) {
  const at = useAt();
  return <div style={{ position: 'absolute', left: 80, right: 80, top: 560, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
    <Words text={scene.caption} at={at(0.25)} style={{ fontSize: 44, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.1, color: theme.colors.ink }} />
    {scene.sub && <Words text={scene.sub} at={at(0.7)} style={{ fontSize: 23, fontWeight: 450, lineHeight: 1.3, color: theme.colors.soft }} />}
  </div>;
}

/* ---------- Pieces ---------- */

function MicGlyph({ size, color }: { size: number; color: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" aria-hidden>
    <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
  </svg>;
}

/** The composer's mic: grey when off, red with a breathing ring when on (0..1). */
function Mic({ on, press = 0, size = 64 }: { on: number; press?: number; size?: number }) {
  const frame = useCurrentFrame();
  const ring = on * (0.5 + Math.sin(frame / 9) * 0.5);
  return <div style={{ position: 'relative', width: size, height: size, flexShrink: 0, transform: `scale(${1 - press * 0.1})` }}>
    <div style={{ position: 'absolute', inset: -10 - ring * 6, borderRadius: '50%', background: theme.colors.hotSoft, opacity: on * (0.4 + ring * 0.6) }} />
    <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', display: 'grid', placeItems: 'center', background: on > 0.5 ? theme.colors.hotSoft : 'transparent', border: `1.5px solid ${on > 0.5 ? theme.colors.hot : theme.colors.line}` }}>
      <MicGlyph size={size * 0.48} color={on > 0.5 ? theme.colors.hot : theme.colors.soft} />
    </div>
  </div>;
}

const COMPOSER = { x: 200, y: 340, w: 880, h: 120 };

/** The chat composer: a title chip, the draft and the mic. */
function Composer({ draft, on, press = 0, chat = 'Fix login bug', caret = true }: { draft: string; on: number; press?: number; chat?: string; caret?: boolean }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = pop(frame, 2, fps, theme.spring.smooth);
  const float = Math.sin(frame / 40) * 2;
  const blink = caret && Math.floor(frame / 16) % 2 === 0;
  return <div style={{ position: 'absolute', left: COMPOSER.x, top: COMPOSER.y, width: COMPOSER.w, opacity: enter, transform: `translateY(${(1 - enter) * 24 + float}px) scale(${mix(0.96, 1, enter)})` }}>
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 10, padding: '6px 12px', borderRadius: 999, background: theme.colors.win, border: `1px solid ${theme.colors.line}`, fontSize: 17, fontWeight: 600, color: theme.colors.soft }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: theme.colors.accent }} />{chat}
    </div>
    <div style={{ height: COMPOSER.h, borderRadius: 22, background: theme.colors.win, border: `1px solid ${theme.colors.line}`, boxShadow: `0 18px 40px ${theme.colors.shadow}`, display: 'flex', alignItems: 'center', gap: 20, padding: '0 22px 0 30px' }}>
      <div style={{ flex: 1, minWidth: 0, fontSize: 26, lineHeight: 1.35, color: draft ? theme.colors.ink : theme.colors.faint }}>
        {draft || 'Message Nekko'}
        <span style={{ display: 'inline-block', width: 2, height: 28, marginLeft: 3, verticalAlign: 'text-bottom', background: theme.colors.accent, opacity: blink ? 1 : 0 }} />
      </div>
      <Mic on={on} press={press} />
    </div>
  </div>;
}

/** The strip above the mic: level meter and the last thing heard. */
function Strip({ show, text, loud = 1 }: { show: number; text: string; loud?: number }) {
  const frame = useCurrentFrame();
  const bars = Array.from({ length: 9 }, (_, i) => 0.25 + Math.abs(Math.sin(frame / 4 + i * 1.3) * Math.cos(frame / 11 + i)) * 0.75 * loud);
  return <div style={{ position: 'absolute', right: W - COMPOSER.x - COMPOSER.w, top: COMPOSER.y - 30, width: 560, padding: '14px 18px', borderRadius: 16, background: theme.colors.win, border: `1px solid ${theme.colors.line}`, boxShadow: `0 12px 30px ${theme.colors.shadow}`, display: 'flex', alignItems: 'center', gap: 14, opacity: show, transform: `translateY(${(1 - show) * 14 - 60}px) scale(${mix(0.95, 1, show)})`, transformOrigin: 'bottom right' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 3, height: 26 }}>
      {bars.map((b, i) => <span key={i} style={{ width: 4, height: 26 * b, borderRadius: 2, background: theme.colors.hot }} />)}
    </div>
    <span style={{ fontSize: 18, color: theme.colors.soft, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>
  </div>;
}

function Cursor({ x, y, press = 0, show = 1 }: { x: number; y: number; press?: number; show?: number }) {
  return <svg width="30" height="36" viewBox="0 0 18 22" style={{ position: 'absolute', left: x - 3, top: y - 3, opacity: show, transform: `scale(${1 - press * 0.16})`, transformOrigin: '3px 3px', filter: `drop-shadow(0 3px 4px ${theme.colors.shadow})` }}>
    <path d="M2 2 L2 17 L6 13 L9 20 L12 19 L9 12 L15 12 Z" fill={theme.colors.win} stroke={theme.colors.ink} strokeWidth="1.4" strokeLinejoin="round" />
  </svg>;
}

/** The app's toast, top right. */
function Toast({ text, show }: { text: string; show: number }) {
  return <div style={{ position: 'absolute', right: 60, top: 48, display: 'flex', alignItems: 'center', gap: 10, padding: '12px 20px', borderRadius: 14, background: theme.colors.win, border: `1px solid ${theme.colors.line}`, boxShadow: `0 12px 30px ${theme.colors.shadow}`, fontSize: 20, fontWeight: 600, color: theme.colors.ink, opacity: show, transform: `translateY(${(1 - show) * -18}px) scale(${mix(0.92, 1, show)})` }}>
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke={theme.colors.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 8.5l3.2 3L13 4.5" /></svg>
    {text}
  </div>;
}

/** What was said, as a speech bubble above the composer. */
function Said({ text, show }: { text: string; show: number }) {
  return <div style={{ position: 'absolute', left: 0, right: 0, top: 170, display: 'flex', justifyContent: 'center', opacity: show, transform: `translateY(${(1 - show) * 20}px) scale(${mix(0.94, 1, show)})` }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 28px', borderRadius: 999, background: theme.colors.win, border: `1.5px solid ${theme.colors.hot}`, fontSize: 32, fontWeight: 650, color: theme.colors.ink, boxShadow: `0 14px 34px ${theme.colors.shadow}` }}>
      <MicGlyph size={28} color={theme.colors.hot} />{`“${text}”`}
    </div>
  </div>;
}

/* ---------- 1. Tap the mic once ---------- */

function TapScene({ scene }: { scene: VoiceIntroScene }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const at = useAt();
  const mic = { x: COMPOSER.x + COMPOSER.w - 22 - 32, y: COMPOSER.y + 38 + COMPOSER.h / 2 };
  const glide = tween(frame, [at(0.6), at(1.4)], [0, 1]);
  const leave = tween(frame, [at(2.0), at(2.8)], [0, 1]);
  const cursor = { x: mix(mix(980, mic.x, glide), mic.x + 70, leave), y: mix(mix(660, mic.y, glide), mic.y + 90, leave) };
  const on = tween(frame, [at(1.55), at(1.75)], [0, 1], theme.ease.out);
  return <Scene>
    <Composer draft="" on={on} press={tap(frame, at(1.45), fps)} />
    <Strip show={pop(frame, at(1.9), fps)} text="Listening locally. Say ‘Nekko…’ for commands." loud={0.5} />
    <Cursor {...cursor} press={tap(frame, at(1.45), fps)} show={tween(frame, [at(0.4), at(0.7)], [0, 1], theme.ease.out) * (1 - tween(frame, [at(2.6), at(3.0)], [0, 1], theme.ease.out))} />
    <Caption scene={scene} />
  </Scene>;
}

/* ---------- 2. Talk, and words appear ---------- */

const FIRST = 'Fix the login bug on the settings page.';
const SECOND = 'Then add a test for it.';
const DICTATED = `${FIRST} ${SECOND}`;

function TalkScene({ scene }: { scene: VoiceIntroScene }) {
  const frame = useCurrentFrame();
  const at = useAt();
  const words = DICTATED.split(' ');
  const shown = Math.floor(tween(frame, [at(0.7), at(4.6)], [0, words.length], theme.ease.out));
  const draft = words.slice(0, shown).join(' ');
  const heard = shown > 8 ? SECOND : FIRST;
  return <Scene>
    <Composer draft={draft} on={1} />
    <Strip show={1} text={shown ? `Heard: ${heard}` : 'Listening locally.'} loud={shown < words.length ? 1 : 0.35} />
    <Caption scene={scene} />
  </Scene>;
}

/* ---------- 3. Say "Nekko" ---------- */

const BEATS = [
  { said: 'Nekko, erase that', toast: 'Erased', at: 0.5 },
  { said: 'Nekko, send it', toast: 'Sent', at: 3.5 },
  { said: 'Nekko, new chat', toast: 'New chat', at: 6.5 },
];

function CommandScene({ scene }: { scene: VoiceIntroScene }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const at = useAt();
  // Each phrase lands, then its effect and toast a beat later; both clear before the next.
  const phase = (b: (typeof BEATS)[number]) => ({
    said: pop(frame, at(b.at), fps) * (1 - tween(frame, [at(b.at + 2.4), at(b.at + 2.7)], [0, 1], theme.ease.in)),
    toast: pop(frame, at(b.at + 1.0), fps) * (1 - tween(frame, [at(b.at + 2.5), at(b.at + 2.8)], [0, 1], theme.ease.in)),
    done: frame >= at(b.at + 1.0),
  });
  const [erase, send, fresh] = BEATS.map(phase);
  const draft = send.done ? '' : erase.done ? FIRST : DICTATED;
  return <Scene>
    <Composer draft={draft} on={1} chat={fresh.done ? 'New chat' : 'Fix login bug'} />
    {BEATS.map((b, i) => <React.Fragment key={b.said}>
      <Said text={b.said} show={[erase, send, fresh][i].said} />
      <Toast text={b.toast} show={[erase, send, fresh][i].toast} />
    </React.Fragment>)}
    <Caption scene={scene} />
  </Scene>;
}

/* ---------- 4. iPhone ---------- */

function LockGlyph({ size, color }: { size: number; color: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" aria-hidden>
    <rect x="5" y="11" width="14" height="10" rx="2.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>;
}

function PhoneScene({ scene }: { scene: VoiceIntroScene }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const at = useAt();
  const enter = pop(frame, 2, fps, theme.spring.smooth);
  const locked = tween(frame, [at(2.4), at(2.75)], [0, 1], theme.ease.out);
  const press = tap(frame, at(2.25), fps);
  const float = Math.sin(frame / 38) * 3;
  const phone = { w: 236, h: 470 };
  return <Scene>
    <div style={{ position: 'absolute', left: (W - phone.w) / 2, top: 60, width: phone.w, height: phone.h, opacity: enter, transform: `translateY(${(1 - enter) * 30 + float}px) scale(${mix(0.94, 1, enter)})` }}>
      {/* The side button the lock press lands on. */}
      <div style={{ position: 'absolute', right: -5, top: 110, width: 5, height: 56, borderRadius: 3, background: theme.colors.bezel, transform: `translateX(${-press * 3}px)` }} />
      <div style={{ position: 'absolute', inset: 0, borderRadius: 40, padding: 9, background: theme.colors.bezel, boxShadow: `0 24px 50px ${theme.colors.shadow}` }}>
        <div style={{ position: 'relative', width: '100%', height: '100%', borderRadius: 32, overflow: 'hidden', background: theme.colors.win }}>
          <div style={{ position: 'absolute', left: '50%', top: 10, width: 74, height: 22, marginLeft: -37, borderRadius: 11, background: theme.colors.night }} />
          <div style={{ position: 'absolute', left: 16, right: 16, top: 70, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[0.86, 0.62, 0.74].map((l, i) => <div key={i} style={{ height: 9, width: `${l * 100}%`, borderRadius: 5, background: theme.colors.line }} />)}
          </div>
          <div style={{ position: 'absolute', left: 12, right: 12, bottom: 18, height: 58, borderRadius: 18, border: `1px solid ${theme.colors.line}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 8px 0 14px' }}>
            <span style={{ fontSize: 14, color: theme.colors.soft }}>{locked < 0.5 ? 'Listening…' : 'Message'}</span>
            <Mic on={1 - locked} size={42} />
          </div>
          {/* The Lock Screen. */}
          <div style={{ position: 'absolute', inset: 0, background: theme.colors.night, opacity: locked, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 70, gap: 8 }}>
            <div style={{ transform: `translateY(${(1 - locked) * -10}px)` }}><LockGlyph size={26} color="#eceaf3" /></div>
            <div style={{ fontSize: 58, fontWeight: 600, letterSpacing: '-0.02em', color: '#eceaf3', transform: `translateY(${(1 - locked) * 12}px)` }}>9:41</div>
          </div>
        </div>
      </div>
    </div>
    <Caption scene={scene} />
  </Scene>;
}

/* ---------- 5. Privacy ---------- */

function ShieldGlyph({ size, color }: { size: number; color: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 2.5l7.5 3v6c0 4.6-3.2 8.4-7.5 10-4.3-1.6-7.5-5.4-7.5-10v-6z" /><path d="M8.5 12l2.4 2.4L15.6 9.7" />
  </svg>;
}

function PrivacyScene({ scene }: { scene: VoiceIntroScene }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const at = useAt();
  const card = pop(frame, 2, fps, theme.spring.smooth);
  const icon = pop(frame, at(0.3), fps);
  const breathe = Math.sin(frame / 30) * 0.012;
  return <Scene exit={false}>
    <div style={{ position: 'absolute', left: 150, right: 150, top: 160, padding: '56px 70px 60px', borderRadius: 32, background: theme.colors.win, border: `1px solid ${theme.colors.line}`, boxShadow: `0 30px 70px ${theme.colors.shadow}`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 30, opacity: card, transform: `translateY(${(1 - card) * 28}px) scale(${mix(0.96, 1, card) + breathe})` }}>
      <div style={{ width: 92, height: 92, borderRadius: 28, display: 'grid', placeItems: 'center', background: theme.colors.glow, opacity: icon, transform: `scale(${mix(0.6, 1, icon)}) rotate(${(1 - icon) * -12}deg)` }}>
        <ShieldGlyph size={52} color={theme.colors.accent} />
      </div>
      <Words text={scene.caption} at={at(0.7)} style={{ fontSize: 40, fontWeight: 650, letterSpacing: '-0.015em', lineHeight: 1.3, textAlign: 'center', color: theme.colors.ink }} />
    </div>
  </Scene>;
}

export interface VoiceIntroScene { caption: string; sub?: string; seconds: number; Scene: (props: { scene: VoiceIntroScene }) => React.ReactElement }

export const VOICE_INTRO_SCENES: VoiceIntroScene[] = [
  { caption: 'Tap the mic once. It stays on.', sub: 'One mic for the whole app. It keeps listening as you switch chats.', seconds: 6, Scene: TapScene },
  { caption: 'Talk, and your words appear.', sub: 'They go into the chat you’re looking at. Nothing is sent until you say so.', seconds: 7, Scene: TalkScene },
  { caption: 'Say “Nekko” to give a command.', sub: 'Erase that, send it, new chat, ship it, how’s it going. Without “Nekko”, it’s just text.', seconds: 10, Scene: CommandScene },
  { caption: 'On iPhone, it stops when you lock.', sub: 'Tap the mic again when you’re back. On the Lock Screen, the card’s mic asks for Face ID, then sends what you say to its chat.', seconds: 8, Scene: PhoneScene },
  { caption: PRIVACY_PROMISE, seconds: 7, Scene: PrivacyScene },
];

const starts = VOICE_INTRO_SCENES.map((_, i) => VOICE_INTRO_SCENES.slice(0, i).reduce((sum, s) => sum + Math.round(s.seconds * FPS), 0));
export const VOICE_INTRO_FRAMES = VOICE_INTRO_SCENES.reduce((sum, s) => sum + Math.round(s.seconds * FPS), 0);

/** The whole video: 1280 by 720 at 30 fps. Rendered to MP4 for iOS from this same component. */
export function VoiceIntroVideo() {
  return <AbsoluteFill>
    <Backdrop />
    {VOICE_INTRO_SCENES.map((scene, i) => (
      <Sequence key={i} from={starts[i]} durationInFrames={Math.round(scene.seconds * FPS)}>
        <scene.Scene scene={scene} />
      </Sequence>
    ))}
    <Finish />
  </AbsoluteFill>;
}

/** Remembers the video was seen. If saving fails it simply shows again next time. */
async function rememberSeen(): Promise<void> {
  try {
    const next = await window.nekko.updateSettings({ voice: { ...useStore.getState().settings?.voice, introSeen: true } });
    useStore.setState({ settings: next });
  } catch { /* shown again next time */ }
}

/**
 * The first-open video. Closing it any way marks it seen. With `onTurnOn`
 * (the first tap on the mic) it ends in Turn on / Not now; replayed from
 * settings it ends in Done.
 */
export function VoiceIntro({ onClose, onTurnOn }: { onClose: () => void; onTurnOn?: () => void }) {
  const titleId = useId();
  const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const close = (turnOn = false) => { void rememberSeen(); onClose(); if (turnOn) onTurnOn?.(); };
  return (
    <Modal title="Always-on dictation" labelledBy={titleId} onClose={() => close()} overlayClassName="p-4" className="card w-full max-w-[720px] p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id={titleId} className="text-base font-semibold">Always-on dictation</h2>
        <button type="button" className="rounded-sm p-1 text-ink-faint hover:text-ink" onClick={() => close()} aria-label="Close"><CloseIcon className="h-4 w-4" /></button>
      </div>
      <div className="mt-3 overflow-hidden rounded-xl border border-line bg-surface-2" data-voice-intro>
        <Player
          component={VoiceIntroVideo}
          durationInFrames={VOICE_INTRO_FRAMES}
          fps={FPS}
          compositionWidth={W}
          compositionHeight={H}
          style={{ width: '100%', aspectRatio: `${W} / ${H}` }}
          autoPlay={!reduced}
          // Reduced motion opens, still, on the privacy card.
          initialFrame={reduced ? starts[starts.length - 1] + FPS * 3 : 0}
          controls
        />
      </div>
      {/* The captions, for screen readers: the video itself has no text alternative. */}
      <ol className="sr-only">{VOICE_INTRO_SCENES.map(s => <li key={s.caption}>{s.caption}{s.sub ? ` ${s.sub}` : ''}</li>)}</ol>
      <div className="mt-4 flex justify-end gap-2">
        {onTurnOn
          ? <><button type="button" className="btn btn-ghost" onClick={() => close()}>Not now</button><button type="button" className="btn btn-primary" onClick={() => close(true)}>Turn on</button></>
          : <button type="button" className="btn btn-primary" onClick={() => close()}>Done</button>}
      </div>
    </Modal>
  );
}

export default VoiceIntro;
