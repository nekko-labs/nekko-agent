// "Your GPU is unemployed", a square post for X (1:1, 20 s).
// GTA VI launched on PS5 and Xbox only, so a player's PC sits idle while they
// play. Nekko Agent puts that GPU to work on a local model: no tokens, no bill.
//
// Illustrated in the website's Dark look, the same sources as
// video/instagram-reel (spec/brand/colour-palette.md, docs/design-system.md):
// page #0C0C11 with plum glows, the pixel-dot wave, panels #16161C / #26262F,
// Inter Tight with Space Mono labels, and Nekko in his fixed dark-mode colours.
// No Rockstar artwork, logo, type or colours: the game is only named in text.
import React from 'react';
import {
  AbsoluteFill, Easing, continueRender, delayRender, interpolate,
  staticFile, useCurrentFrame,
} from 'remotion';

const FRAMES = 600; // 20 s at 30 fps
const W = 1080, H = 1080;

const C = {
  page: '#0c0c11', panel: '#16161c', panel2: '#1e1e26', line: '#26262f',
  ink: '#ffffff', soft: '#a3a1b0', faint: '#87899b',
  plum: '#c99bb3', plum2: '#854f6c', rose: '#e6d0dc', ok: '#4cc38a', warn: '#e5a54b',
  nekkoFace: '#16161c', nekkoLine: '#f3e8ee', nekkoEyes: '#ffffff', nekkoMouth: '#854f6c',
};
// The website's Dark page, glows scaled to a 1080 px square (CSS px x 1.5).
const PAGE_BG = 'radial-gradient(60% 1350px at 12% 0%, rgba(25, 0, 25, 0.9), transparent 70%), radial-gradient(60% 1200px at 20% 100%, rgba(25, 0, 25, 0.7), transparent 70%), #0c0c11';
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

// Scenes: [start, end] in frames. Each fades in over 14 frames and out over 12.
const SC = { out: [0, 90], console: [84, 186], wake: [180, 306], play: [300, 456], phone: [450, 522], end: [516, 600] } as const;
type Span = readonly [number, number];
const vis = (f: number, [a, b]: Span) => p(f, a, a + 14) * (1 - p(f, b - 12, b));
const enter = (f: number, a: number, span: Span) => {
  const v = p(f, a, a + 16) * (1 - p(f, span[1] - 12, span[1]));
  return { opacity: v, transform: `translateY(${(1 - p(f, a, a + 16)) * 10}px)` };
};

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

function Headline({ f, span, kicker, top = 120, size = 92, children }: { f: number; span: Span; kicker: string; top?: number; size?: number; children: React.ReactNode }) {
  return (
    <div style={{ position: 'absolute', left: 96, top, width: 900 }}>
      <div style={{ fontFamily: MONO, fontSize: 24, letterSpacing: 2, color: C.plum, textTransform: 'uppercase', ...enter(f, span[0] + 4, span) }}>{kicker}</div>
      <div style={{ fontFamily: SANS, fontWeight: 800, fontSize: size, lineHeight: 1.02, letterSpacing: -3.5, color: C.ink, marginTop: 16, ...enter(f, span[0] + 10, span) }}>{children}</div>
    </div>
  );
}

// GPU meter: the one number this video is about.
function GpuMeter({ f, value, label }: { f: number; value: number; label: string }) {
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

// ─── 1 GTA VI is out ───────────────────────────────────────────────────────
function Out({ f }: { f: number }) {
  const span = SC.out;
  return (
    <AbsoluteFill style={{ opacity: vis(f, span), justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}>
      <div style={{ fontFamily: MONO, fontSize: 26, letterSpacing: 3, color: C.plum, textTransform: 'uppercase', ...enter(f, 6, span) }}>Launch week</div>
      <div style={{ fontFamily: SANS, fontWeight: 800, fontSize: 150, lineHeight: 1, letterSpacing: -6, color: C.ink, marginTop: 24, ...enter(f, 14, span) }}>GTA VI<br /><Grad>is out.</Grad></div>
    </AbsoluteFill>
  );
}

// ─── 2 It's on your console; the PC is idle ────────────────────────────────
function Console({ f }: { f: number }) {
  const span = SC.console, s = span[0];
  const edge = 600;
  return (
    <AbsoluteFill style={{ opacity: vis(f, span) }}>
      <Headline f={f} span={span} kicker="PS5 and Xbox only">It's on your console.<br /><span style={{ color: C.faint }}>Not your PC.</span></Headline>
      <Panel y={edge} style={{ padding: '48px 52px 44px', ...enter(f, s + 22, span) }}>
        <div style={{ fontFamily: SANS, fontSize: 32, fontWeight: 650, color: C.soft, marginBottom: 26 }}>Your gaming PC</div>
        <GpuMeter f={f} value={0} label="Idle" />
      </Panel>
      <Peek f={f} x={720} edge={edge} eyes="closed" />
    </AbsoluteFill>
  );
}

// ─── 3 Your GPU is unemployed → Nekko puts it to work ──────────────────────
function Wake({ f }: { f: number }) {
  const span = SC.wake, s = span[0];
  const edge = 520;
  const load = interpolate(f, [s + 50, s + 86], [0, 92], { ...clamp, easing: ease }) + (f > s + 86 ? Math.sin(f / 5) * 2 : 0);
  const loaded = f >= s + 86;
  return (
    <AbsoluteFill style={{ opacity: vis(f, span) }}>
      <Headline f={f} span={span} kicker="Meanwhile">Your GPU is<br /><Grad>unemployed.</Grad></Headline>
      <Panel y={edge} style={{ padding: '48px 52px 44px', ...enter(f, s + 18, span) }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 26 }}>
          <span style={{ fontFamily: SANS, fontSize: 32, fontWeight: 650, color: C.ink }}>{f >= s + 40 ? 'Qwen3 8B' : 'Your gaming PC'}</span>
          {f >= s + 40 && <span style={{ fontFamily: MONO, fontSize: 22, color: C.faint, opacity: p(f, s + 40, s + 50) }}>Built-in engine · on this PC</span>}
        </div>
        <GpuMeter f={f} value={Math.max(0, load)} label={loaded ? 'Working' : f >= s + 50 ? 'Loading' : 'Idle'} />
      </Panel>
      <div style={{ position: 'absolute', left: 96, top: 900, display: 'flex', gap: 14, fontFamily: SANS, fontSize: 28, color: C.soft, ...enter(f, s + 92, span) }}>
        {['No tokens', 'No subscription', 'Stays on your PC'].map((t) => (
          <span key={t} style={{ padding: '10px 22px', borderRadius: 999, border: `2px solid ${C.line}` }}>{t}</span>
        ))}
      </div>
      <Peek f={f} x={720} edge={edge} eyes={f < s + 40 ? 'closed' : eyesAt(f, loaded)} />
    </AbsoluteFill>
  );
}

// ─── 4 You play, it works ──────────────────────────────────────────────────
const STEPS = ['Read 14 files in /site', 'Fixed 3 broken links', 'Wrote the changelog', 'Ran the tests: 48 passed'];
function Play({ f }: { f: number }) {
  const span = SC.play, s = span[0];
  const mins = 12 + Math.floor((f - s) / 4); // game clock runs fast
  const clock = `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
  const edge = 360;
  return (
    <AbsoluteFill style={{ opacity: vis(f, span) }}>
      <Headline f={f} span={span} kicker="Tonight" size={76} top={90}>You play. <Grad>It works.</Grad></Headline>
      {/* left: the console session, drawn as plain text, no game art */}
      <Panel x={80} y={edge} w={340} style={{ padding: '40px 36px', height: 600, display: 'flex', flexDirection: 'column', ...enter(f, s + 14, span) }}>
        <div style={{ fontFamily: MONO, fontSize: 22, color: C.faint }}>On the TV</div>
        <div style={{ fontFamily: SANS, fontWeight: 750, fontSize: 46, lineHeight: 1.1, color: C.ink, marginTop: 14 }}>GTA VI</div>
        <div style={{ fontFamily: SANS, fontSize: 28, color: C.soft, marginTop: 8 }}>Story mode</div>
        <div style={{ marginTop: 'auto' }}>
          <div style={{ fontFamily: MONO, fontSize: 22, color: C.faint }}>Playing for</div>
          <div style={{ fontFamily: SANS, fontWeight: 800, fontSize: 84, letterSpacing: -3, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{clock}</div>
        </div>
      </Panel>
      {/* right: Nekko Agent on the PC */}
      <Panel x={444} y={edge} w={556} style={{ padding: '40px 40px', height: 600, ...enter(f, s + 20, span) }}>
        <div style={{ fontFamily: MONO, fontSize: 22, color: C.faint }}>On the PC · Qwen3 8B</div>
        <div style={{ marginLeft: 'auto', marginTop: 20, width: 'fit-content', background: C.panel2, borderRadius: 20, padding: '14px 22px', fontFamily: SANS, fontSize: 28, color: C.ink }}>
          {typed(f, s + 26, s + 50, 'Tidy the site and ship the changelog')}
        </div>
        <div style={{ marginTop: 26 }}>
          {STEPS.map((t, i) => {
            const at = s + 58 + i * 20;
            const done = f >= at + 14;
            return f >= at ? (
              <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 14, fontFamily: SANS, fontSize: 28, color: done ? C.ink : C.soft, padding: '11px 0', opacity: p(f, at, at + 8) }}>
                {done ? <Check size={30} /> : <Dot color={C.plum} />}{t}
              </div>
            ) : null;
          })}
        </div>
      </Panel>
      <Peek f={f} x={622} edge={edge} eyes={eyesAt(f, f >= s + 140)} />
    </AbsoluteFill>
  );
}

// ─── 5 Phone ping between missions ─────────────────────────────────────────
function Phone({ f }: { f: number }) {
  const span = SC.phone, s = span[0];
  const pressed = f >= s + 38 && f < s + 44;
  const approved = f >= s + 42;
  const edge = 470;
  const hop = approved && f < s + 63 ? [-1, -2, -1][Math.floor((f - s - 42) / 7)] ?? 0 : 0;
  return (
    <AbsoluteFill style={{ opacity: vis(f, span) }}>
      <Headline f={f} span={span} kicker="Between missions" size={76} top={110}>Check in. <Grad>Back to it.</Grad></Headline>
      <Panel x={200} y={edge} w={680} style={{ padding: '36px 40px', ...enter(f, s + 8, span) }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontFamily: SANS, fontSize: 30, fontWeight: 650, color: approved ? C.ok : C.ink }}>
          {approved ? <Check size={30} /> : <Dot color={C.plum} />}{approved ? 'Shipped' : 'Ready for review'}
        </div>
        <div style={{ fontFamily: SANS, fontSize: 28, color: C.soft, marginTop: 10 }}>4 steps · 48 tests passed · $0.00</div>
        <div style={{ display: 'flex', gap: 16, marginTop: 26, fontFamily: SANS, fontSize: 30, fontWeight: 650 }}>
          <span style={{ flex: 1, textAlign: 'center', padding: '16px 0', borderRadius: 16, border: `2px solid ${C.line}`, color: C.soft, opacity: approved ? 0.4 : 1 }}>Later</span>
          <span style={{ flex: 1, textAlign: 'center', padding: '16px 0', borderRadius: 16, background: approved ? C.ok : C.plum, color: '#120a12', transform: `scale(${pressed ? 0.95 : 1})` }}>{approved ? 'Done' : 'Approve'}</span>
        </div>
      </Panel>
      <Peek f={f} x={440} edge={edge} eyes={approved ? 'happy' : 'open'} hop={hop} sparkle={approved && f < s + 70} />
    </AbsoluteFill>
  );
}

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
function End({ f }: { f: number }) {
  const span = [SC.end[0], FRAMES + 20] as const;
  const edge = 560;
  return (
    <AbsoluteFill style={{ opacity: p(f, SC.end[0], SC.end[0] + 14) }}>
      <Headline f={f} span={span} kicker="Local AI" size={88} top={130}>$0 per token.<br /><Grad>Play while it works.</Grad></Headline>
      <Panel y={edge} style={{ padding: '56px 52px 50px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 26 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, ...enter(f, span[0] + 8, span) }}>
          <AppMark size={84} />
          <span style={{ fontFamily: SANS, fontWeight: 800, fontSize: 68, letterSpacing: -2.5, color: C.ink }}>Nekko Agent</span>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 36, color: C.ink, ...enter(f, span[0] + 22, span) }}>nekkoagent.com</div>
      </Panel>
      <Peek f={f} x={444} edge={edge} eyes={eyesAt(f, true)} />
    </AbsoluteFill>
  );
}

export function GtaIdleGpu() {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: PAGE_BG, overflow: 'hidden', fontFamily: SANS }}>
      <PixelWave f={f} />
      {f < SC.out[1] && <Out f={f} />}
      {f >= SC.console[0] && f < SC.console[1] && <Console f={f} />}
      {f >= SC.wake[0] && f < SC.wake[1] && <Wake f={f} />}
      {f >= SC.play[0] && f < SC.play[1] && <Play f={f} />}
      {f >= SC.phone[0] && f < SC.phone[1] && <Phone f={f} />}
      {f >= SC.end[0] && <End f={f} />}
    </AbsoluteFill>
  );
}

export const GTA_FRAMES = FRAMES;
