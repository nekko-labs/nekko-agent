// "Your GPU is unemployed", a square post for X (1:1, 20 s).
// GTA VI launched on PS5 and Xbox only, so a player's PC sits idle while they
// play. Nekko Agent puts that GPU to work on a local model: no tokens, no bill.
//
// Illustrated in the brand dark palette (spec/brand/colour-palette.md,
// docs/design-system.md): page #0B0C14 with #854F6C glows, the dot wave
// (#C084B5 to #854F6C), panels #14151F / #1D1F2C, lines #252735, Inter Tight
// with Space Mono labels, and Nekko in his fixed dark-mode colours. One card
// carries the story and changes shape between beats, with Nekko riding it.
// No Rockstar artwork, logo, type or colours: the game is only named in text.
import React from 'react';
import {
  AbsoluteFill, Easing, continueRender, delayRender, interpolate,
  staticFile, useCurrentFrame,
} from 'remotion';

const FRAMES = 600; // 20 s at 30 fps
const W = 1080, H = 1080;

const C = {
  page: '#0b0c14', panel: '#14151f', panel2: '#1d1f2c', line: '#252735',
  ink: '#ffffff', soft: '#a3a4b6', faint: '#87899b',
  plum: '#c99bb3', plum2: '#854f6c', rose: '#e6d0dc', ok: '#4ec98a', main: '#190019',
  nekkoFace: '#16161c', nekkoLine: '#f3e8ee', nekkoEyes: '#ffffff', nekkoMouth: '#854f6c',
};
// The dark page with secondary (#854F6C) glows, as in docs/brand/nekko-banner.html, scaled to 1080 px.
const PAGE_BG = 'radial-gradient(55% 880px at 8% 0%, rgba(133, 79, 108, 0.26), transparent 70%), radial-gradient(45% 880px at 80% 50%, rgba(133, 79, 108, 0.16), transparent 70%), radial-gradient(60% 710px at 20% 100%, rgba(133, 79, 108, 0.18), transparent 70%), #0b0c14';
const SANS = "'Inter Tight', system-ui, sans-serif";
const MONO = "'Space Mono', ui-monospace, monospace";

const fontHandle = typeof document !== 'undefined' ? delayRender('fonts') : null;
if (typeof document !== 'undefined') {
  Promise.all([
    new FontFace('Inter Tight', `url(${staticFile('fonts/inter-tight-latin-wght-normal.woff2')})`, { weight: '100 900' }).load(),
    new FontFace('Space Mono', `url(${staticFile('fonts/space-mono-latin-400-normal.woff2')})`, { weight: '400' }).load(),
    new FontFace('Space Mono', `url(${staticFile('fonts/space-mono-latin-700-normal.woff2')})`, { weight: '700' }).load(),
  ]).then((faces) => { faces.forEach((f) => document.fonts.add(f)); if (fontHandle !== null) continueRender(fontHandle); });
}

const ease = Easing.bezier(0.22, 1, 0.36, 1);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const p = (f: number, a: number, b: number) => interpolate(f, [a, b], [0, 1], { ...clamp, easing: ease });
const typed = (f: number, a: number, b: number, s: string) => s.slice(0, Math.round(interpolate(f, [a, b], [0, s.length], clamp)));

// ---- the website's pixel wave ----
function PixelWave({ f }: { f: number }) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  React.useLayoutEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    const K = 1.5, CELL = Math.round(9 * K), u = (f / FRAMES) * Math.PI * 2;
    ctx.clearRect(0, 0, W, H);
    for (let y = 0; y < H; y += CELL) {
      for (let x = 0; x < W; x += CELL) {
        const w = Math.sin(x / (110 * K) - u * 2 + Math.sin(y / (150 * K) + u) * 1.6);
        const a = Math.max(0, w) ** 3 * 0.34;
        if (a < 0.025) continue;
        const sz = Math.round((a > 0.18 ? 3 : 2) * K);
        const k = x / W;
        ctx.fillStyle = `rgba(${Math.round(192 - 59 * k)},${Math.round(132 - 53 * k)},${Math.round(181 - 73 * k)},${(a * 1.1).toFixed(3)})`;
        ctx.fillRect(Math.round(x + (CELL - sz) / 2), Math.round(y + (CELL - sz) / 2), sz, sz);
      }
    }
  }, [f]);
  return <canvas ref={ref} width={W} height={H} style={{ position: 'absolute', inset: 0 }} />;
}

// ---- Nekko peeking over a panel edge (the website peek) ----
const HEAD = 'M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z';
const EYES = {
  open: 'M11 15H13V18H11Z M20 15H22V18H20Z',
  closed: 'M10 17H14V18H10Z M19 17H23V18H19Z',
  happy: 'M9 17H10V15H11V14H12V15H13V17H12V16H10V17Z M19 17H20V15H21V14H22V15H23V17H22V16H20V17Z',
} as const;
const PAW_L = { fill: 'M7 23H12V28H7Z', line: 'M6 22H13V27H12V23H7V27H6Z' };
const PAW_R = { fill: 'M20 23H25V28H20Z', line: 'M19 22H26V27H25V23H20V27H19Z' };
const spark = (x: number, y: number) => `M${x} ${y - 1}H${x + 1}V${y}H${x}Z M${x - 1} ${y}H${x}V${y + 1}H${x - 1}Z M${x + 1} ${y}H${x + 2}V${y + 1}H${x + 1}Z M${x} ${y + 1}H${x + 1}V${y + 2}H${x}Z`;
const SPARKS = [spark(-3, 2), spark(34, 9), spark(1, 14), spark(29, -1), spark(17, -5)].join(' ');

function Peek({ f, x, edge, s = 6, eyes, hop = 0, sparkle = false }: { f: number; x: number; edge: number; s?: number; eyes: keyof typeof EYES; hop?: number; sparkle?: boolean }) {
  return (
    <svg width={32 * s} height={30 * s} viewBox="0 0 32 30" shapeRendering="crispEdges"
      style={{ position: 'absolute', left: x, top: edge - 25 * s, overflow: 'visible' }}>
      <defs><clipPath id={`above-${x}-${edge}`}><rect x={-20} y={-40} width={72} height={65} /></clipPath></defs>
      <g transform={`translate(0 ${hop})`}>
        {sparkle && <path d={SPARKS} fill={Math.floor(f / 6) % 2 ? C.rose : C.plum2} />}
        <g clipPath={`url(#above-${x}-${edge})`}>
          <path d={HEAD} fill={C.nekkoFace} stroke={C.nekkoLine} strokeWidth={2} />
          <path d={EYES[eyes]} fill={C.nekkoEyes} />
          <path d="M15 20H17V21H15Z" fill={C.nekkoMouth} />
        </g>
        {[PAW_L, PAW_R].map((pw, i) => <g key={i}><path d={pw.fill} fill={C.nekkoFace} /><path d={pw.line} fill={C.nekkoLine} /></g>)}
      </g>
    </svg>
  );
}
const eyesAt = (f: number, happy: boolean): keyof typeof EYES => happy ? 'happy' : (f % 75 > 70 ? 'closed' : 'open');

function Panel({ x = 80, y, w = 920, children, style }: { x?: number; y: number; w?: number; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: w, background: C.panel, border: `2px solid ${C.line}`, borderRadius: 28, boxSizing: 'border-box', boxShadow: '0 30px 70px rgba(0,0,0,.55)', ...style }}>
      {children}
    </div>
  );
}
const Grad = ({ children }: { children: React.ReactNode }) => (
  <span style={{ background: `linear-gradient(110deg, ${C.plum2} 0%, ${C.rose} 100%)`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>{children}</span>
);
const Check = ({ size = 32, color = C.ok }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3 3 7-7" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const Dot = ({ color, size = 14 }: { color: string; size?: number }) => <span style={{ width: size, height: size, borderRadius: size, background: color, display: 'inline-block', flexShrink: 0 }} />;

// ─── 6 End card ────────────────────────────────────────────────────────────
function AppMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512">
      <defs><linearGradient id="tile" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#190019" /><stop offset="1" stopColor="#3A1438" /></linearGradient></defs>
      <rect width="512" height="512" rx="114" fill="url(#tile)" stroke="#854f6c" strokeWidth="10" />
      <g transform="translate(13.46 73.87) scale(20.2117)" fill="#FFFFFF" fillRule="evenodd">
        <path d="M4.059,10.357C4.034,10.285 4.015,10.212 4.003,10.138L3.007,4.165L2.649,2.016L9.117,5.897C11.039,5.29 12.961,5.29 14.883,5.897L21.351,2.016L20.005,10.088C19.987,10.199 19.959,10.308 19.921,10.415L19.921,10.416C18.733,13.756 15.551,16.006 12,16.006C8.428,16.006 5.23,13.729 4.059,10.357L4.059,10.357ZM5.009,10.027C6.04,12.996 8.856,15 12,15C15.126,15 17.927,13.019 18.973,10.079C18.991,10.028 19.004,9.976 19.013,9.923L20,4L15,7C13,6.267 11,6.267 9,7L4,4L4.995,9.972C4.999,9.991 5.003,10.009 5.009,10.027Z" />
      </g>
    </svg>
  );
}

// ─── Timeline ──────────────────────────────────────────────────────────────
// One card stays on screen from 2.4 s to the end and changes shape between
// beats (PC → agent → phone → end card); Nekko rides its top edge. Headlines
// rise into a mask and leave upward, so nothing simply blinks in or out.
//
//   0.0  GTA VI is out.            headline only
//   2.4  card rises: the idle PC   Nekko asleep on it
//   6.1  GPU is unemployed         same card, the model loads in place
//   9.9  card slides right → agent panel, the TV panel slides in from the left
//  14.0  card becomes the phone,   the TV panel leaves
//  17.5  phone becomes the end card
const CARD_KEYS = [72, 102, 296, 322, 420, 448, 526, 554];
const CARD = {
  x: [80, 80, 80, 444, 444, 600, 600, 80],
  y: [1320, 600, 600, 360, 360, 200, 200, 560],
  w: [920, 920, 920, 556, 556, 380, 380, 920],
  h: [220, 220, 220, 600, 600, 760, 760, 300],
  r: [28, 28, 28, 28, 28, 60, 60, 28],
  b: [2, 2, 2, 2, 2, 6, 6, 2],
  nekko: [0.78, 0.78, 0.78, 0.5, 0.5, 0.5, 0.5, 0.5],
};
const track = (f: number, vals: number[]) => interpolate(f, CARD_KEYS, vals, { ...clamp, easing: Easing.bezier(0.65, 0, 0.35, 1) });
/** Fade a layer in over [a, a+d] and out over [b, b+d]. */
const win = (f: number, a: number, b: number, d = 12) => p(f, a, a + d) * (1 - p(f, b, b + d));

// ─── Masked text: each line rises into place, then leaves upward ───────────
// Lines settle in one after another (a short drift, a fade and a blur that
// clears); on the way out the whole headline dissolves together, no wipe.
function Rise({ f, at, out = 1e9, i = 0, children, style }: { f: number; at: number; out?: number; i?: number; children: React.ReactNode; style?: React.CSSProperties }) {
  const inP = p(f, at + i * 3, at + i * 3 + 22);
  const outP = interpolate(f, [out, out + 12], [0, 1], { ...clamp, easing: Easing.bezier(0.4, 0, 1, 1) });
  return (
    <div style={{ ...style, opacity: inP * (1 - outP), filter: `blur(${(1 - inP) * 8 + outP * 10}px)`, transform: `translateY(${(1 - inP) * 18}px)` }}>{children}</div>
  );
}
function Headline({ f, at, out = 1e9, kicker, lines, left = 96, top = 120, size = 92, width = 900, align = 'left', sub }: {
  f: number; at: number; out?: number; kicker: string; lines: React.ReactNode[]; left?: number; top?: number; size?: number; width?: number; align?: 'left' | 'center'; sub?: string;
}) {
  if (f < at || f > out + 14) return null;
  return (
    <div style={{ position: 'absolute', left, top, width, textAlign: align }}>
      <Rise f={f} at={at} out={out} style={{ fontFamily: MONO, fontSize: 24, letterSpacing: 2, color: C.plum, textTransform: 'uppercase' }}>{kicker}</Rise>
      <div style={{ marginTop: 16, fontFamily: SANS, fontWeight: 800, fontSize: size, lineHeight: 1.02, letterSpacing: size * -0.038, color: C.ink }}>
        {lines.map((l, i) => <Rise key={i} f={f} at={at + 4} out={out} i={i + 1}>{l}</Rise>)}
      </div>
      {sub && <Rise f={f} at={at + 12} out={out} i={lines.length + 1} style={{ fontFamily: SANS, fontSize: 30, lineHeight: 1.35, color: C.soft, marginTop: 26 }}>{sub}</Rise>}
    </div>
  );
}

// GPU meter
function GpuMeter({ value, label }: { value: number; label: string }) {
  const on = value > 5;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
        <span style={{ fontFamily: MONO, fontSize: 24, color: C.soft }}>GPU</span>
        <span style={{ fontFamily: SANS, fontWeight: 800, fontSize: 88, letterSpacing: -3, color: on ? C.ink : C.faint, fontVariantNumeric: 'tabular-nums' }}>{Math.round(value)}%</span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, fontFamily: SANS, fontSize: 28, color: C.soft }}>
          <Dot color={on ? C.ok : C.faint} />{label}
        </span>
      </div>
      <div style={{ height: 14, borderRadius: 7, background: C.line, marginTop: 18, overflow: 'hidden' }}>
        <div style={{ width: `${value}%`, height: '100%', borderRadius: 7, background: `linear-gradient(90deg, ${C.plum2}, ${C.rose})` }} />
      </div>
    </div>
  );
}

// ─── Card faces ────────────────────────────────────────────────────────────
const FACE: React.CSSProperties = { position: 'absolute', inset: 0, boxSizing: 'border-box' };

function PcFace({ f }: { f: number }) {
  const load = interpolate(f, [222, 262], [0, 92], { ...clamp, easing: ease }) + (f > 262 ? Math.sin(f / 5) * 2 : 0);
  const model = p(f, 206, 222);
  return (
    <div style={{ ...FACE, padding: '46px 52px', opacity: win(f, 0, 300) }}>
      <div style={{ position: 'relative', height: 40, marginBottom: 22 }}>
        <span style={{ position: 'absolute', fontFamily: SANS, fontSize: 32, fontWeight: 650, color: C.soft, opacity: 1 - model, transform: `translateY(${-model * 12}px)` }}>Your gaming PC</span>
        <span style={{ position: 'absolute', display: 'flex', alignItems: 'baseline', gap: 16, opacity: model, transform: `translateY(${(1 - model) * 12}px)` }}>
          <span style={{ fontFamily: SANS, fontSize: 32, fontWeight: 650, color: C.ink }}>Qwen3 8B</span>
          <span style={{ fontFamily: MONO, fontSize: 22, color: C.faint }}>Built-in engine · on this PC</span>
        </span>
      </div>
      <GpuMeter value={Math.max(0, load)} label={f >= 262 ? 'Working' : f >= 222 ? 'Loading' : 'Idle'} />
    </div>
  );
}

const STEPS = ['Read 14 files in /site', 'Fixed 3 broken links', 'Wrote the changelog', 'Ran the tests: 48 passed'];
function AgentFace({ f }: { f: number }) {
  return (
    <div style={{ ...FACE, padding: '40px', opacity: win(f, 304, 420) }}>
      <div style={{ fontFamily: MONO, fontSize: 22, color: C.faint }}>On the PC · Qwen3 8B</div>
      <div style={{ marginLeft: 'auto', marginTop: 20, width: 'fit-content', background: C.panel2, borderRadius: 20, padding: '14px 22px', fontFamily: SANS, fontSize: 28, color: C.ink, opacity: p(f, 328, 338) }}>
        {typed(f, 330, 352, 'Tidy the site and ship the changelog')}
      </div>
      <div style={{ marginTop: 26 }}>
        {STEPS.map((t, i) => {
          const at = 358 + i * 13, done = p(f, at + 9, at + 15);
          return (
            <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 14, fontFamily: SANS, fontSize: 28, color: done > 0.5 ? C.ink : C.soft, padding: '11px 0', opacity: p(f, at, at + 12), transform: `translateY(${(1 - p(f, at, at + 14)) * 14}px)` }}>
              <span style={{ position: 'relative', width: 30, height: 30, display: 'grid', placeItems: 'center' }}>
                <span style={{ position: 'absolute', opacity: 1 - done }}><Dot color={C.plum} /></span>
                <span style={{ position: 'absolute', opacity: done, transform: `scale(${0.6 + done * 0.4})` }}><Check size={30} /></span>
              </span>{t}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PhoneFace({ f, w }: { f: number; w: number }) {
  const n = 452;
  const pressed = f >= n + 28 && f < n + 34;
  const ok = p(f, n + 32, n + 40);
  return (
    <div style={{ ...FACE, padding: '70px 22px 0', opacity: win(f, 428, 526) }}>
      <div style={{ position: 'absolute', left: w / 2 - 47, top: 16, width: 88, height: 26, borderRadius: 13, background: C.panel2 }} />
      <div style={{ fontFamily: SANS, fontWeight: 300, fontSize: 84, letterSpacing: -2, color: C.ink, textAlign: 'center' }}>11:42</div>
      <div style={{ fontFamily: SANS, fontSize: 22, color: C.soft, textAlign: 'center', marginTop: 2, marginBottom: 34 }}>Friday</div>
      <div style={{ background: C.panel, border: `2px solid ${C.line}`, borderRadius: 26, padding: '22px 22px 20px', opacity: p(f, n, n + 10), transform: `translateY(${(1 - p(f, n, n + 16)) * -24}px) scale(${0.96 + p(f, n, n + 16) * 0.04})` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <AppMark size={30} />
          <span style={{ fontFamily: SANS, fontSize: 20, fontWeight: 650, color: C.ink }}>Nekko Agent</span>
          <span style={{ marginLeft: 'auto', fontFamily: SANS, fontSize: 18, color: C.faint }}>now</span>
        </div>
        <div style={{ position: 'relative', height: 30, marginTop: 16, fontFamily: SANS, fontSize: 24, fontWeight: 650 }}>
          <span style={{ position: 'absolute', display: 'flex', alignItems: 'center', gap: 10, color: C.ink, opacity: 1 - ok }}><Dot color={C.plum} size={12} />Needs your OK</span>
          <span style={{ position: 'absolute', display: 'flex', alignItems: 'center', gap: 10, color: C.ok, opacity: ok }}><Check size={24} />Approved. Pushing.</span>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 19, color: C.soft, marginTop: 10 }}>git push origin main</div>
        <div style={{ display: 'flex', gap: 10, marginTop: 18, fontFamily: SANS, fontSize: 22, fontWeight: 650 }}>
          <span style={{ flex: 1, textAlign: 'center', padding: '12px 0', borderRadius: 14, border: `2px solid ${C.line}`, color: C.soft, opacity: 1 - ok * 0.6 }}>Deny</span>
          <span style={{ flex: 1, textAlign: 'center', padding: '12px 0', borderRadius: 14, background: C.main, border: `2px solid ${C.plum2}`, color: C.ink, transform: `scale(${pressed ? 0.94 : 1})` }}>{ok > 0.5 ? 'Done' : 'Approve'}</span>
        </div>
      </div>
    </div>
  );
}

function EndFace({ f }: { f: number }) {
  return (
    <div style={{ ...FACE, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 26, opacity: p(f, 532, 548) }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, whiteSpace: 'nowrap', transform: `translateY(${(1 - p(f, 534, 554)) * 12}px)` }}>
        <AppMark size={84} />
        <span style={{ fontFamily: SANS, fontWeight: 800, fontSize: 68, letterSpacing: -2.5, color: C.ink }}>Nekko Agent</span>
      </div>
      <div style={{ fontFamily: MONO, fontSize: 36, color: C.ink, opacity: p(f, 544, 558) }}>nekkoagent.com</div>
    </div>
  );
}

// The console session, drawn as plain text (no game art).
function TvPanel({ f }: { f: number }) {
  const x = interpolate(f, [298, 324, 414, 438], [-420, 80, 80, -420], { ...clamp, easing: Easing.bezier(0.65, 0, 0.35, 1) });
  if (x <= -420) return null;
  const mins = 12 + Math.max(0, Math.floor((f - 300) / 4));
  return (
    <div style={{ position: 'absolute', left: x, top: 360, width: 340, height: 600, background: C.panel, border: `2px solid ${C.line}`, borderRadius: 28, boxSizing: 'border-box', boxShadow: '0 30px 70px rgba(0,0,0,.55)', padding: '40px 36px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ fontFamily: MONO, fontSize: 22, color: C.faint }}>On the TV</div>
      <div style={{ fontFamily: SANS, fontWeight: 750, fontSize: 46, lineHeight: 1.1, color: C.ink, marginTop: 14 }}>GTA VI</div>
      <div style={{ fontFamily: SANS, fontSize: 28, color: C.soft, marginTop: 8 }}>Story mode</div>
      <div style={{ marginTop: 'auto' }}>
        <div style={{ fontFamily: MONO, fontSize: 22, color: C.faint }}>Playing for</div>
        <div style={{ fontFamily: SANS, fontWeight: 800, fontSize: 84, letterSpacing: -3, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{Math.floor(mins / 60)}:{String(mins % 60).padStart(2, '0')}</div>
      </div>
    </div>
  );
}

// ─── Nekko's mood along the timeline ───────────────────────────────────────
function nekkoEyes(f: number): keyof typeof EYES {
  if (f < 214) return 'closed';                 // asleep on the idle PC
  if (f < 262) return f % 40 > 36 ? 'closed' : 'open';
  if (f < 290) return 'happy';                  // the GPU has a job
  if (f >= 484 && f < 520) return 'happy';      // approved
  if (f >= 556) return 'happy';
  return eyesAt(f, false);
}
/** A small settle each time the card lands, a happy hop on approval. */
function nekkoHop(f: number) {
  for (const land of [102, 322, 448, 554]) if (f >= land && f < land + 10) return Math.sin(((f - land) / 10) * Math.PI) * -1.2;
  if (f >= 484 && f < 505) return [-1, -2, -1][Math.floor((f - 484) / 7)] ?? 0;
  return 0;
}

export function GtaIdleGpu() {
  const f = useCurrentFrame();
  const x = track(f, CARD.x), y = track(f, CARD.y), w = track(f, CARD.w), h = track(f, CARD.h);
  const buzz = f >= 452 && f < 464 ? Math.sin((f - 452) * 2.4) * 4 * (1 - (f - 452) / 12) : 0;
  return (
    <AbsoluteFill style={{ background: PAGE_BG, overflow: 'hidden', fontFamily: SANS }}>
      <PixelWave f={f} />

      <Headline f={f} at={-14} out={62} kicker="Launch week" align="center" top={360} size={150}
        lines={['GTA VI', <Grad key="g">is out.</Grad>]} />
      <Headline f={f} at={82} out={176} kicker="PS5 and Xbox only"
        lines={["It's on your console.", <span key="n" style={{ color: C.faint }}>Not your PC.</span>]} />
      <Headline f={f} at={186} out={290} kicker="Meanwhile"
        lines={['Your GPU is', <Grad key="g">unemployed.</Grad>]} />
      <Headline f={f} at={304} out={412} kicker="Tonight" top={96} size={76}
        lines={[<>You play. <Grad>It works.</Grad></>]} />
      <Headline f={f} at={426} out={520} kicker="From your phone" top={260} width={470} size={84}
        lines={['Approve', 'from the', <Grad key="g">couch.</Grad>]} sub="Risky steps wait for your OK. Tap it between missions." />
      <Headline f={f} at={538} kicker="Local AI" top={130} size={88}
        lines={['$0 per token.', <Grad key="g">Play while it works.</Grad>]} />

      {/* chips under the PC card while the model works */}
      <div style={{ position: 'absolute', left: 96, top: 870, display: 'flex', gap: 14, fontFamily: SANS, fontSize: 28, color: C.soft }}>
        {['No tokens', 'No subscription', 'Stays on your PC'].map((t, i) => (
          <span key={t} style={{ padding: '10px 22px', borderRadius: 999, border: `2px solid ${C.line}`, opacity: win(f, 266 + i * 5, 288 + i * 2, 12), transform: `translateY(${(1 - p(f, 266 + i * 5, 282 + i * 5)) * 14}px)` }}>{t}</span>
        ))}
      </div>

      <TvPanel f={f} />

      {f >= CARD_KEYS[0] && (
        <>
          <div style={{ position: 'absolute', left: x + buzz, top: y, width: w, height: h, background: C.panel,
            border: `${track(f, CARD.b)}px solid ${C.line}`, borderRadius: track(f, CARD.r), boxSizing: 'border-box', boxShadow: '0 30px 70px rgba(0,0,0,.55)', overflow: 'hidden' }}>
            <PcFace f={f} />
            <AgentFace f={f} />
            <PhoneFace f={f} w={w} />
            <EndFace f={f} />
          </div>
          <Peek f={f} x={x + buzz + w * track(f, CARD.nekko) - 96} edge={y} eyes={nekkoEyes(f)} hop={nekkoHop(f)} sparkle={f >= 484 && f < 516} />
        </>
      )}
    </AbsoluteFill>
  );
}

export const GTA_FRAMES = FRAMES;
