// Hero intro for nekkoagent.com: "Meet Nekko." -> feature scroll -> "Built in Rust."
// -> "It's fast. Like, really fast." It is joined in front of the existing
// nekko-vs-ollama-{dark,light}.mp4, so it ends on that video's first frame:
// a plain background (#0c0b10 dark, #fbfafd light). Colours were measured
// from frames of the hero and beta-loop videos.
import React from 'react';
import {
  AbsoluteFill, Composition, Easing, interpolate, registerRoot, staticFile, useCurrentFrame,
} from 'remotion';

export const FPS = 30;
export const DURATION = 412; // 13.7 s

type Theme = {
  bg: string; glow: string; ink: string; accent: string; muted: string;
  card: string; cardBorder: string; rule: string; check: string;
  catFill: string; catStroke: string; catMouth: string; shadow: string;
};
const THEMES: Record<'dark' | 'light', Theme> = {
  dark: {
    bg: '#0c0b10', glow: '#1a0920', ink: '#ffffff', accent: '#c083b7', muted: '#e5e3eb',
    card: '#15151d', cardBorder: 'rgba(255,255,255,0.07)', rule: 'rgba(255,255,255,0.05)', check: '#c083b7',
    catFill: '#101714', catStroke: '#f2f1e9', catMouth: '#c083b7', shadow: 'none',
  },
  light: {
    bg: '#fbfafd', glow: '#efe6ef', ink: '#000000', accent: '#5b2352', muted: '#0e0c0d',
    card: '#ffffff', cardBorder: 'rgba(0,0,0,0.04)', rule: 'rgba(0,0,0,0.06)', check: '#5b2352',
    catFill: '#ffffff', catStroke: '#0e0c0d', catMouth: '#5b2352', shadow: '0 30px 80px rgba(91,35,82,0.12)',
  },
};

// Shipped in the current build (checked against README + crates/ on 2026-11-07).
const FEATURES = [
  'Built-in model server',
  'Works with Ollama, LM Studio and vLLM',
  'ChatGPT, Claude and OpenRouter',
  'Automations on a schedule',
  'Voice dictation, on your computer',
  'Spend and savings tracking',
  'Skills library and marketplace',
  'Memory in plain markdown',
  'GitHub, Slack, Gmail and more',
  'Sandbox and Docker isolation',
  'Plugs into Claude Code and Cursor',
  'Self-hosted web and Docker',
];

const fontCss = `
@font-face{font-family:'Inter Tight';font-weight:100 900;src:url(${staticFile('fonts/inter-tight-latin-wght-normal.woff2')}) format('woff2');}
@font-face{font-family:'Handjet';font-weight:100 900;src:url(${staticFile('fonts/handjet-latin-wght-normal.woff2')}) format('woff2');}
@font-face{font-family:'Space Mono';font-weight:400;src:url(${staticFile('fonts/space-mono-latin-400-normal.woff2')}) format('woff2');}
@font-face{font-family:'Space Mono';font-weight:700;src:url(${staticFile('fonts/space-mono-latin-700-normal.woff2')}) format('woff2');}
`;

const ease = Easing.bezier(0.22, 1, 0.36, 1);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/** Word reveal used by the beta video: fade + un-blur + small rise. */
function Reveal({ start, children, out }: { start: number; children: React.ReactNode; out?: number }) {
  const f = useCurrentFrame();
  const p = interpolate(f, [start, start + 12], [0, 1], { ...clamp, easing: ease });
  const o = out === undefined ? 1 : interpolate(f, [out, out + 8], [1, 0], clamp);
  return (
    <span style={{ display: 'inline-block', opacity: p * o, filter: `blur(${(1 - p) * 14}px)`, transform: `translateY(${(1 - p) * 18}px)` }}>
      {children}
    </span>
  );
}

/** The app's PixelHead (apps/desktop/src/renderer/components/Mascot.tsx), recoloured per theme. */
function Cat({ t, size, eyes }: { t: Theme; size: number; eyes: 'open' | 'happy' }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} shapeRendering="crispEdges">
      <path d="M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z" fill={t.catFill} stroke={t.catStroke} strokeWidth="2" strokeLinejoin="miter" />
      <path fill={t.catStroke} d={eyes === 'open'
        ? 'M11 15H13V18H11Z M20 15H22V18H20Z'
        : 'M9 17H10V15H11V14H12V15H13V17H12V16H10V17Z M19 17H20V15H21V14H22V15H23V17H22V16H20V17Z'} />
      <path d="M15 20H17V21H15Z" fill={t.catMouth} />
    </svg>
  );
}

const ROW = 92;
function FeatureCard({ t, start, end }: { t: Theme; start: number; end: number }) {
  const f = useCurrentFrame();
  const inP = interpolate(f, [start, start + 15], [0, 1], { ...clamp, easing: ease });
  const outP = interpolate(f, [end - 10, end], [1, 0], clamp);
  const scroll = interpolate(f, [start + 6, end], [0, (FEATURES.length - 5.5) * ROW], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const mask = 'linear-gradient(to bottom, transparent 0, #000 22%, #000 78%, transparent 100%)';
  return (
    <div style={{
      position: 'absolute', left: '50%', top: 360, width: 1040, height: 560, marginLeft: -520,
      background: t.card, border: `2px solid ${t.cardBorder}`, borderRadius: 28, boxShadow: t.shadow,
      overflow: 'hidden', opacity: inP * outP, transform: `translateY(${(1 - inP) * 40}px) scale(${0.97 + inP * 0.03})`,
    }}>
      <div style={{ position: 'absolute', inset: 0, WebkitMaskImage: mask, maskImage: mask }}>
        <div style={{ transform: `translateY(${70 - scroll}px)` }}>
          {FEATURES.map((s) => (
            <div key={s} style={{ height: ROW, display: 'flex', alignItems: 'center', gap: 30, padding: '0 56px', borderBottom: `2px solid ${t.rule}` }}>
              <svg width="30" height="30" viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5" fill="none" stroke={t.check} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <span style={{ fontSize: 42, fontWeight: 600, color: t.muted, letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>{s}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Published medians (README + docs/benchmarks.md). Bars are relative speed from a zero
// baseline (the other server = 1), so a 1.3x win is drawn as 1.3x, never stretched.
const SPEED: { label: string; detail: string; base: string; x: number; value: string }[] = [
  { label: 'Chat replies', detail: 'decode, M5 Max', base: 'llama.cpp', x: 6.7, value: '6.7×' },
  { label: 'Plain decode', detail: '154 vs 115 tok/s, RTX 5090', base: 'Ollama', x: 154 / 115, value: '1.3×' },
  { label: '4 requests at once', detail: '256 vs 113 tok/s, RTX 5090', base: 'Ollama', x: 256 / 113, value: '2.3×' },
  { label: 'Back to a paused chat', detail: '0.79 s vs 1.29 s, RTX 5090', base: 'Ollama', x: 1290 / 790, value: '1.6×' },
  { label: 'Code edits, NVIDIA', detail: '534 vs 106 tok/s, RTX 5090', base: 'Ollama', x: 534 / 106, value: '5×' },
  { label: 'Code edits, Mac', detail: '2.5 s vs 13.9 s, M5 Max', base: 'Ollama', x: 13.9 / 2.5, value: '5.6×' },
];
const BAR_MAX = 760; // px for 6.7x

function SpeedSection({ t, start, end }: { t: Theme; start: number; end: number }) {
  const f = useCurrentFrame();
  if (f < start - 2 || f > end + 2) return null;
  const out = interpolate(f, [end - 10, end], [1, 0], clamp);
  const cardIn = interpolate(f, [start + 6, start + 20], [0, 1], { ...clamp, easing: ease });
  return (
    <div style={{ opacity: out }}>
      <Big top={60} size={96}>
        <Reveal start={start}>Faster</Reveal>{' '}<Reveal start={start + 5}><span style={{ color: t.accent }}>where it counts.</span></Reveal>
      </Big>
      <div style={{
        position: 'absolute', left: 190, width: 1540, top: 210, padding: '18px 0', background: t.card,
        border: `2px solid ${t.cardBorder}`, borderRadius: 28, boxShadow: t.shadow,
        opacity: cardIn, transform: `translateY(${(1 - cardIn) * 40}px)`,
      }}>
        {SPEED.map((s, i) => {
          const s0 = start + 14 + i * 9;
          const rowIn = interpolate(f, [s0, s0 + 10], [0, 1], { ...clamp, easing: ease });
          const grow = interpolate(f, [s0 + 4, s0 + 26], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
          const unit = BAR_MAX / 6.7;
          return (
            <div key={s.label} style={{
              display: 'flex', alignItems: 'center', height: 112, padding: '0 48px', opacity: rowIn,
              borderBottom: i < SPEED.length - 1 ? `2px solid ${t.rule}` : 'none',
            }}>
              <div style={{ width: 470 }}>
                <div style={{ fontSize: 36, fontWeight: 700, color: t.muted, letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>{s.label}</div>
                <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 19, color: t.muted, opacity: 0.55, marginTop: 6, whiteSpace: 'nowrap' }}>{s.detail}</div>
              </div>
              <div style={{ width: 820, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{ height: 26, width: s.x * unit * grow, background: t.accent, borderRadius: 6 }} />
                  <span style={{ fontFamily: "'Space Mono', monospace", fontSize: 18, color: t.accent, opacity: grow }}>Nekko</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{ height: 26, width: unit * Math.min(1, grow * 3), background: t.muted, opacity: 0.22, borderRadius: 6 }} />
                  <span style={{ fontFamily: "'Space Mono', monospace", fontSize: 18, color: t.muted, opacity: 0.5 * rowIn }}>{s.base}</span>
                </div>
              </div>
              <div style={{ flex: 1, textAlign: 'right', fontSize: 64, fontWeight: 800, letterSpacing: '-0.03em', color: t.accent, opacity: grow }}>
                {s.value}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{
        position: 'absolute', left: 0, right: 0, top: 1000, textAlign: 'center', fontFamily: "'Space Mono', monospace",
        fontSize: 20, color: t.muted, opacity: 0.5 * cardIn,
      }}>
        Published medians · Qwen3-8B on M5 Max, Gemma 4 12B on RTX 5090 · nekkoagent.com/docs/benchmarks
      </div>
    </div>
  );
}

const Big = ({ children, top, size = 128 }: { children: React.ReactNode; top: number; size?: number }) => (
  <div style={{ position: 'absolute', left: 0, right: 0, top, textAlign: 'center', fontSize: size, fontWeight: 800, letterSpacing: '-0.035em', lineHeight: 1.05 }}>
    {children}
  </div>
);

export function HeroIntro({ theme }: { theme: 'dark' | 'light' }) {
  const t = THEMES[theme];
  const f = useCurrentFrame();
  // Beta-style purple glow fades out so the last frames are the hero's plain background.
  const glow = interpolate(f, [0, 20, 380, 408], [0, 1, 1, 0], clamp);
  // "Meet Nekko." sits centred, then moves up as the card arrives.
  const lift = interpolate(f, [44, 62], [0, 1], { ...clamp, easing: ease });
  const meetOut = interpolate(f, [150, 160], [1, 0], clamp);
  const catHop = Math.max(0, Math.sin(((f - 30) / 14) * Math.PI)) * (f > 30 && f < 44 ? 14 : 0);
  const fastShake = f >= 222 && f < 236 ? Math.sin(f * 2.4) * 3 : 0;
  return (
    <AbsoluteFill style={{ background: t.bg, color: t.ink, fontFamily: "'Inter Tight', sans-serif", overflow: 'hidden' }}>
      <style>{fontCss}</style>
      <AbsoluteFill style={{ opacity: glow, background: `radial-gradient(120% 90% at 50% 0%, ${t.glow} 0%, ${t.bg} 70%)` }} />

      {/* 1. Meet Nekko. + feature scroll (0-160) */}
      <div style={{ opacity: meetOut }}>
        <div style={{
          position: 'absolute', left: '50%', top: interpolate(lift, [0, 1], [280, 90]), marginLeft: -60,
          transform: `translateY(${-catHop}px) scale(${interpolate(lift, [0, 1], [1, 0.75])})`, transformOrigin: 'center top',
          opacity: interpolate(f, [2, 14], [0, 1], clamp),
        }}>
          <Cat t={t} size={120} eyes={f > 30 && f < 60 ? 'happy' : 'open'} />
        </div>
        <Big top={interpolate(lift, [0, 1], [440, 186])} size={interpolate(lift, [0, 1], [150, 104])}>
          <Reveal start={10}>Meet</Reveal>{' '}<Reveal start={16}><span style={{ color: t.accent }}>Nekko.</span></Reveal>
        </Big>
        <FeatureCard t={t} start={52} end={160} />
      </div>

      {/* 2. Built in Rust. (162-206) */}
      <Big top={420} size={150}>
        <Reveal start={162} out={200}>Built in</Reveal>{' '}
        <Reveal start={168} out={200}><span style={{ color: t.accent }}>Rust.</span></Reveal>
      </Big>

      {/* 3. It's fast. Like, really fast. (208-262) */}
      <div style={{ transform: `translateX(${fastShake}px)` }}>
        <Big top={360} size={150}>
          <Reveal start={208} out={254}>It&rsquo;s fast.</Reveal>
        </Big>
        <Big top={540} size={150}>
          <Reveal start={222} out={254}>Like, <span style={{ color: t.accent }}>really fast.</span></Reveal>
        </Big>
      </div>
      <SpeedSection t={t} start={258} end={408} />
      {/* 408-412: plain background, identical to the hero's first frame. */}
    </AbsoluteFill>
  );
}

export function Root() {
  return (
    <>
      {(['dark', 'light'] as const).map((theme) => (
        <Composition key={theme} id={`HeroIntro-${theme}`} component={HeroIntro} defaultProps={{ theme }}
          durationInFrames={DURATION} fps={FPS} width={1920} height={1080} />
      ))}
    </>
  );
}

registerRoot(Root);
