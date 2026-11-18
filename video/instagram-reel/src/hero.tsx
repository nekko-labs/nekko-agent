// The website hero, remade for Instagram (9:16, 34 s): the two parts of
// apps/website/media/hero-v2.mp4 as one vertical film.
//   1. video/hero-intro: "Meet Nekko." and the feature list, "Built in Rust.",
//      "It's fast. Like, really fast.", and "Faster where it counts."
//   2. The Nekko vs Ollama speed replay (#1722): the whole-file rename,
//      2.5 s against 13.9 s, fast-forwarded after 5 s, then the end card.
// Same words, features and published medians as the hero; the ground is the
// website's pixel wave and Nekko wears his fixed colours. Content stays between
// y 200 and 1640, clear of Instagram's own top and bottom overlays.
import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from 'remotion';
import { AppMark, C, Check, Grad, MONO, PAGE_BG, PixelWave, Peek, SANS, clamp, ease, fontCss, p } from './reel';

export const HERO_FRAMES = 1020; // 34 s
const FPS = 30;

// Shipped features, as in video/hero-intro (checked against README + crates/ on 2026-11-07).
const FEATURES = [
  'Built-in model server', 'Works with Ollama, LM Studio and vLLM', 'ChatGPT, Claude and OpenRouter',
  'Automations on a schedule', 'Voice dictation, on your computer', 'Spend and savings tracking',
  'Skills library and marketplace', 'Memory in plain markdown', 'GitHub, Slack, Gmail and more',
  'Sandbox and Docker isolation', 'Plugs into Claude Code and Cursor', 'Self-hosted web and Docker',
];

// Published medians (README + docs/benchmarks.md), as in video/hero-intro.
const SPEED = [
  { label: 'Chat replies', detail: 'decode, M5 Max', base: 'llama.cpp', x: 6.7, value: '6.7×' },
  { label: 'Plain decode', detail: '154 vs 115 tok/s, RTX 5090', base: 'Ollama', x: 154 / 115, value: '1.3×' },
  { label: '4 requests at once', detail: '256 vs 113 tok/s, RTX 5090', base: 'Ollama', x: 256 / 113, value: '2.3×' },
  { label: 'Back to a paused chat', detail: '0.79 s vs 1.29 s, RTX 5090', base: 'Ollama', x: 1290 / 790, value: '1.6×' },
  { label: 'Code edits, NVIDIA', detail: '534 vs 106 tok/s, RTX 5090', base: 'Ollama', x: 534 / 106, value: '5×' },
  { label: 'Code edits, Mac', detail: '2.5 s vs 13.9 s, M5 Max', base: 'Ollama', x: 13.9 / 2.5, value: '5.6×' },
];

// The file both servers return (as in video/pillars, the speed demo).
const CODE = [
  "import { db } from './db';", '',
  'export async function fetchUser(id: string) {', '  const row = await db.users.find(id);',
  "  if (!row) throw new Error('not found');", '  return { id: row.id, name: row.name };', '}', '',
  'export async function listUsers() {', '  const rows = await db.users.all();',
  '  return Promise.all(rows.map((r) =>', '    fetchUser(r.id)));', '}', '',
  'export async function renameUser(id, name) {', '  await db.users.update(id, { name });',
  '  return fetchUser(id);', '}',
];

const T = {
  meet: [0, 160], rust: [162, 206], fast: [208, 262], bars: [258, 420],
  replay: [420, 900], end: [900, HERO_FRAMES],
} as const;
const RACE = 446; // the replay's clock starts here

/** Word reveal from the hero: fade, un-blur and rise. */
function Reveal({ f, at, out, children }: { f: number; at: number; out?: number; children: React.ReactNode }) {
  const v = p(f, at, at + 12) * (out === undefined ? 1 : 1 - p(f, out, out + 8));
  return <span style={{ display: 'inline-block', opacity: v, filter: `blur(${(1 - p(f, at, at + 12)) * 14}px)`, transform: `translateY(${(1 - p(f, at, at + 12)) * 18}px)` }}>{children}</span>;
}
const Big = ({ top, size, children, style }: { top: number; size: number; children: React.ReactNode; style?: React.CSSProperties }) => (
  <div style={{ position: 'absolute', left: 40, right: 40, top, textAlign: 'center', fontFamily: SANS, fontSize: size, fontWeight: 800, letterSpacing: '-0.035em', lineHeight: 1.04, color: C.ink, ...style }}>{children}</div>
);
const card: React.CSSProperties = { position: 'absolute', background: C.panel, border: `2px solid ${C.line}`, borderRadius: 36, boxShadow: '0 40px 90px rgba(0,0,0,.55)', overflow: 'hidden', boxSizing: 'border-box' };

/** Nekko's head on its own (PixelHead), in his fixed colours. */
function Head({ size, eyes }: { size: number; eyes: 'open' | 'happy' }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} shapeRendering="crispEdges">
      <path d="M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z" fill={C.nekkoFace} stroke={C.nekkoLine} strokeWidth="2" />
      <path fill={C.nekkoEyes} d={eyes === 'open' ? 'M11 15H13V18H11Z M20 15H22V18H20Z' : 'M9 17H10V15H11V14H12V15H13V17H12V16H10V17Z M19 17H20V15H21V14H22V15H23V17H22V16H20V17Z'} />
      <path d="M15 20H17V21H15Z" fill={C.nekkoMouth} />
    </svg>
  );
}

// ─── 1 Meet Nekko + features ───────────────────────────────────────────────
function Meet({ f }: { f: number }) {
  const out = 1 - p(f, 150, 160);
  const lift = p(f, 44, 64);
  const hop = f > 30 && f < 44 ? Math.sin(((f - 30) / 14) * Math.PI) * 18 : 0;
  const cardIn = p(f, 54, 70);
  const ROW = 104;
  const scroll = interpolate(f, [60, 158], [0, (FEATURES.length - 6.6) * ROW], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const mask = 'linear-gradient(to bottom, transparent 0, #000 18%, #000 82%, transparent 100%)';
  return (
    <div style={{ opacity: out }}>
      <div style={{ position: 'absolute', left: 540 - 90, top: interpolate(lift, [0, 1], [560, 200]), transform: `translateY(${-hop}px) scale(${interpolate(lift, [0, 1], [1, 0.62])})`, transformOrigin: 'center top', opacity: p(f, 2, 14) }}>
        <Head size={180} eyes={f > 30 && f < 64 ? 'happy' : 'open'} />
      </div>
      <Big top={interpolate(lift, [0, 1], [780, 330])} size={interpolate(lift, [0, 1], [168, 116])}>
        <Reveal f={f} at={10}>Meet</Reveal> <Reveal f={f} at={16}><Grad>Nekko.</Grad></Reveal>
      </Big>
      <div style={{ ...card, left: 60, top: 540, width: 960, height: 760, opacity: cardIn, transform: `translateY(${(1 - cardIn) * 40}px)` }}>
        <div style={{ position: 'absolute', inset: 0, WebkitMaskImage: mask, maskImage: mask }}>
          <div style={{ transform: `translateY(${60 - scroll}px)` }}>
            {FEATURES.map((s) => (
              <div key={s} style={{ height: ROW, display: 'flex', alignItems: 'center', gap: 26, padding: '0 50px', borderBottom: '2px solid rgba(255,255,255,0.05)' }}>
                <Check size={38} color={C.plum} />
                <span style={{ fontFamily: SANS, fontSize: 44, fontWeight: 600, color: '#ffffff', letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>{s}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── 2, 3 Built in Rust. / It's fast. ──────────────────────────────────────
function Statements({ f }: { f: number }) {
  const shake = f >= 222 && f < 236 ? Math.sin(f * 2.4) * 4 : 0;
  return (
    <>
      <Big top={700} size={176}>
        <Reveal f={f} at={T.rust[0]} out={200}>Built in</Reveal><br />
        <Reveal f={f} at={T.rust[0] + 6} out={200}><Grad>Rust.</Grad></Reveal>
      </Big>
      <div style={{ transform: `translateX(${shake}px)` }}>
        <Big top={600} size={170}><Reveal f={f} at={T.fast[0]} out={254}>It&rsquo;s fast.</Reveal></Big>
        <Big top={800} size={170}><Reveal f={f} at={T.fast[0] + 14} out={254}>Like,<br /><Grad>really fast.</Grad></Reveal></Big>
      </div>
    </>
  );
}

// ─── 4 Faster where it counts ──────────────────────────────────────────────
function Bars({ f }: { f: number }) {
  const [start, end] = T.bars;
  if (f < start - 2 || f > end + 2) return null;
  const out = 1 - p(f, end - 10, end);
  const cardIn = p(f, start + 6, start + 20);
  const unit = 600 / 6.7;
  return (
    <div style={{ opacity: out }}>
      <Big top={210} size={112}><Reveal f={f} at={start}>Faster</Reveal><br /><Reveal f={f} at={start + 5}><Grad>where it counts.</Grad></Reveal></Big>
      <div style={{ ...card, left: 60, top: 470, width: 960, padding: '6px 0', opacity: cardIn, transform: `translateY(${(1 - cardIn) * 40}px)` }}>
        {SPEED.map((s, i) => {
          const s0 = start + 14 + i * 9;
          const rowIn = p(f, s0, s0 + 10);
          const grow = interpolate(f, [s0 + 4, s0 + 26], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
          return (
            <div key={s.label} style={{ padding: '11px 44px', opacity: rowIn, borderBottom: i < SPEED.length - 1 ? '2px solid rgba(255,255,255,0.05)' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontFamily: SANS, fontSize: 36, fontWeight: 700, color: '#ffffff' }}>{s.label}</div>
                  <div style={{ fontFamily: MONO, fontSize: 20, color: C.faint, marginTop: 2 }}>{s.detail}</div>
                </div>
                <div style={{ fontFamily: SANS, fontSize: 60, fontWeight: 800, letterSpacing: '-0.03em', color: C.plum, opacity: grow }}>{s.value}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{ height: 16, width: s.x * unit * grow, background: C.plum, borderRadius: 6 }} />
                  <span style={{ fontFamily: MONO, fontSize: 18, color: C.plum, opacity: grow }}>Nekko</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{ height: 16, width: unit * Math.min(1, grow * 3), background: '#ffffff', opacity: 0.22, borderRadius: 6 }} />
                  <span style={{ fontFamily: MONO, fontSize: 18, color: C.faint }}>{s.base}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ position: 'absolute', left: 60, right: 60, top: 1590, textAlign: 'center', fontFamily: MONO, fontSize: 22, lineHeight: 1.5, color: C.faint, opacity: cardIn }}>
        Published medians · Qwen3-8B on M5 Max,<br />Gemma 4 12B on RTX 5090 · nekkoagent.com/docs/benchmarks
      </div>
    </div>
  );
}

// ─── 5 The replay: whole-file rename, Nekko vs Ollama ──────────────────────
/** Ollama's clock: real time to 5 s, then fast-forward to 13.9 s. */
function ollamaSeconds(f: number) {
  const real = (f - RACE) / FPS;
  if (real <= 5) return Math.max(0, real);
  return interpolate(f, [RACE + 150, RACE + 200], [5, 13.9], { ...clamp, easing: Easing.inOut(Easing.cubic) });
}
function Lane({ f, top, name, sub, seconds, total, mine }: { f: number; top: number; name: string; sub: string; seconds: number; total: number; mine: boolean }) {
  const done = seconds >= total - 1e-6;
  const lines = Math.floor((seconds / total) * CODE.length);
  const shown = CODE.slice(Math.max(0, lines - 7), lines);
  return (
    <div style={{ ...card, left: 60, top, width: 960, height: 450, padding: '30px 40px', borderColor: mine && done ? `${C.plum}88` : C.line }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        {mine && <AppMark size={48} />}
        <span style={{ fontFamily: SANS, fontSize: 42, fontWeight: 700, color: C.ink }}>{name}</span>
        <span style={{ fontFamily: MONO, fontSize: 22, color: C.faint }}>{sub}</span>
        <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 64, fontWeight: 700, color: mine && done ? C.plum : C.ink }}>{seconds.toFixed(1)}s</span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: C.panel2, marginTop: 18 }}>
        <div style={{ height: 6, borderRadius: 3, width: `${(seconds / total) * 100}%`, background: mine ? C.plum : C.faint }} />
      </div>
      <div style={{ marginTop: 18, fontFamily: MONO, fontSize: 22, lineHeight: '30px', color: C.soft, height: 220, overflow: 'hidden' }}>
        {shown.map((l, i) => <div key={i} style={{ whiteSpace: 'pre', color: l.includes('fetchUser') ? C.ink : C.soft }}>{l || ' '}</div>)}
        {!done && f > RACE && <span style={{ display: 'inline-block', width: 12, height: 24, background: mine ? C.plum : C.faint }} />}
      </div>
      <div style={{ position: 'absolute', left: 40, bottom: 26, display: 'flex', alignItems: 'center', gap: 12, fontFamily: SANS, fontSize: 32, color: done ? C.ink : C.faint }}>
        {done ? <><Check size={34} color={mine ? C.plum : C.soft} /> Whole file returned</> : 'Writing…'}
      </div>
    </div>
  );
}
function Replay({ f }: { f: number }) {
  const [start, end] = T.replay;
  if (f < start || f >= end) return null;
  const v = p(f, start, start + 14) * (1 - p(f, end - 12, end));
  const nekko = Math.min(Math.max(0, (f - RACE) / FPS), 2.5);
  const ollama = Math.min(ollamaSeconds(f), 13.9);
  const ff = f > RACE + 150 && f < RACE + 202;
  const won = f >= RACE + 210;
  return (
    <AbsoluteFill style={{ opacity: v }}>
      <div style={{ position: 'absolute', left: 70, top: 210, width: 940 }}>
        <div style={{ fontFamily: MONO, fontSize: 26, color: C.plum }}>SAME MAC · SAME MODEL · SAME EDIT</div>
        <div style={{ fontFamily: SANS, fontSize: 96, fontWeight: 800, letterSpacing: '-0.035em', lineHeight: 1.02, color: C.ink, marginTop: 14 }}>
          Local code edits.<br /><span style={{ opacity: p(f, RACE + 210, RACE + 226) }}><Grad>5× faster</Grad> than Ollama.</span>
        </div>
      </div>
      <Lane f={f} top={620} name="Nekko Agent" sub="spec. decoding" seconds={nekko} total={2.5} mine />
      <Lane f={f} top={1100} name="Ollama" sub="0.40.11" seconds={ollama} total={13.9} mine={false} />
      <Peek f={f} x={790} edge={620} s={6} eyes={nekko >= 2.5 ? 'happy' : (f % 75 > 70 ? 'closed' : 'open')} sparkle={f >= RACE + 75 && f < RACE + 110} />
      {ff && <div style={{ position: 'absolute', right: 80, top: 1050, fontFamily: MONO, fontSize: 26, color: C.warn }}>▶▶ fast-forward</div>}
      <div style={{ position: 'absolute', left: 60, right: 60, top: 1590, textAlign: 'center', fontFamily: MONO, fontSize: 22, lineHeight: 1.5, color: C.faint, opacity: won ? 0 : 1 }}>
        Illustrative replay of published median reply times. Not a live recording.<br />M5 Max · Qwen3-8B · whole-file rename · 30 Oct 2026
      </div>
      {won && <div style={{ position: 'absolute', left: 60, right: 60, top: 1590, textAlign: 'center', fontFamily: SANS, fontSize: 40, fontWeight: 600, color: C.ink, opacity: p(f, RACE + 214, RACE + 228) }}>2.5 s vs 13.9 s · whole file, same weights</div>}
    </AbsoluteFill>
  );
}

// ─── 6 End card ────────────────────────────────────────────────────────────
function End({ f }: { f: number }) {
  const [start] = T.end;
  if (f < start) return null;
  const v = p(f, start, start + 14) * (1 - p(f, HERO_FRAMES - 14, HERO_FRAMES - 1));
  const edge = 820;
  const rise = (at: number) => ({ opacity: p(f, start + at, start + at + 14), transform: `translateY(${(1 - p(f, start + at, start + at + 14)) * 10}px)` });
  return (
    <AbsoluteFill style={{ opacity: v }}>
      <div style={{ ...card, left: 60, top: edge, width: 960, padding: '80px 50px 64px', textAlign: 'center', overflow: 'visible' }}>
        <div style={{ fontFamily: SANS, fontSize: 80, fontWeight: 800, letterSpacing: '-0.035em', lineHeight: 1.06, color: C.ink, ...rise(4) }}>Local code edits.<br /><Grad>5× faster</Grad> than Ollama.</div>
        <div style={{ fontFamily: MONO, fontSize: 26, color: C.faint, marginTop: 26, ...rise(12) }}>2.5 s vs 13.9 s · whole-file rename benchmark</div>
        <div style={{ fontFamily: SANS, fontSize: 46, fontWeight: 600, color: '#ffffff', marginTop: 44, ...rise(20) }}>Run local models. Get real work done.</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20, marginTop: 44, ...rise(28) }}>
          <AppMark size={76} />
          <span style={{ fontFamily: MONO, fontSize: 46, color: C.ink }}>nekkoagent.com</span>
        </div>
      </div>
      <Peek f={f} x={380} edge={edge} eyes={f % 75 > 70 ? 'closed' : 'happy'} />
    </AbsoluteFill>
  );
}

export function HeroReel() {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: PAGE_BG, overflow: 'hidden', fontFamily: SANS }}>
      <style>{fontCss}</style>
      <PixelWave f={f} frames={HERO_FRAMES} />
      {f < T.meet[1] && <Meet f={f} />}
      {f >= T.rust[0] && f < T.fast[1] && <Statements f={f} />}
      <Bars f={f} />
      <Replay f={f} />
      <End f={f} />
    </AbsoluteFill>
  );
}
