// Agent Nekko, Instagram Reel (9:16, 20 s). A comparison piece for the
// OpenFilm trial: the same story (pick a model, ask, approve, done), but every
// panel is drawn for a phone screen instead of zoomed from a desktop recording.
// Illustrated in the app's design, not a screen recording.
//
// Design sources (same as video/meet-nekko):
// - Ground: the website's dot-matrix swell (apps/website/site.js, #pixelwave).
// - Nekko: spec/brand/colour-palette.md, his fixed dark-mode colours, and the
//   website peek (head plus two paws on a card edge), drawn on a 32-unit grid.
// - Panels and type: the website Dark look (page #0C0C11, panel #16161C, line
//   #26262F), Inter Tight with Space Mono for small labels.
import React from 'react';
import {
  AbsoluteFill, Easing, continueRender, delayRender, interpolate,
  staticFile, useCurrentFrame,
} from 'remotion';

const FPS = 30;
const FRAMES = 600; // 20 s
const W = 1080, H = 1920;

export const C = {
  page: '#0c0c11', panel: '#16161c', panel2: '#1e1e26', line: '#26262f',
  ink: '#ffffff', soft: '#a3a1b0', faint: '#87899b',
  plum: '#c99bb3', plum2: '#854f6c', rose: '#e6d0dc', ok: '#4cc38a', warn: '#e5a54b',
  nekkoFace: '#16161c', nekkoLine: '#f3e8ee', nekkoEyes: '#ffffff', nekkoMouth: '#854f6c',
};
// The website's Dark page (apps/website/styles.css), glows sized for a phone (CSS px x 2.75).
export const PAGE_BG = 'radial-gradient(60% 2475px at 12% 0%, rgba(25, 0, 25, 0.9), transparent 70%), radial-gradient(60% 2200px at 20% 100%, rgba(25, 0, 25, 0.7), transparent 70%), #0c0c11';
export const SANS = "'Inter Tight', system-ui, sans-serif";
export const MONO = "'Space Mono', ui-monospace, monospace";

export const fontCss = `
@font-face{font-family:'Inter Tight';font-weight:100 900;src:url(${staticFile('fonts/inter-tight-latin-wght-normal.woff2')}) format('woff2');}
@font-face{font-family:'Space Mono';font-weight:400;src:url(${staticFile('fonts/space-mono-latin-400-normal.woff2')}) format('woff2');}
@font-face{font-family:'Space Mono';font-weight:700;src:url(${staticFile('fonts/space-mono-latin-700-normal.woff2')}) format('woff2');}
`;
const fontHandle = typeof document !== 'undefined' ? delayRender('fonts') : null;
if (typeof document !== 'undefined') {
  Promise.all([
    new FontFace('Inter Tight', `url(${staticFile('fonts/inter-tight-latin-wght-normal.woff2')})`, { weight: '100 900' }).load(),
    new FontFace('Space Mono', `url(${staticFile('fonts/space-mono-latin-400-normal.woff2')})`, { weight: '400' }).load(),
    new FontFace('Space Mono', `url(${staticFile('fonts/space-mono-latin-700-normal.woff2')})`, { weight: '700' }).load(),
  ]).then((faces) => { faces.forEach((f) => document.fonts.add(f)); if (fontHandle !== null) continueRender(fontHandle); });
}

export const ease = Easing.bezier(0.22, 1, 0.36, 1);
export const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
export const p = (f: number, a: number, b: number) => interpolate(f, [a, b], [0, 1], { ...clamp, easing: ease });
export const typed = (f: number, a: number, b: number, s: string) => s.slice(0, Math.round(interpolate(f, [a, b], [0, s.length], clamp)));

// Scenes: [start, end] in frames. Each fades in over 14 frames and out over 12.
const SC = { intro: [0, 96], model: [90, 246], ask: [240, 426], done: [420, 516], end: [510, 600] } as const;
type Span = readonly [number, number];
const vis = (f: number, [a, b]: Span) => p(f, a, a + 14) * (1 - p(f, b - 12, b));
/** Enter at frame a (within its scene), leave with the scene. */
const enter = (f: number, a: number, span: Span) => {
  const v = p(f, a, a + 16) * (1 - p(f, span[1] - 12, span[1]));
  return { opacity: v, transform: `translateY(${(1 - p(f, a, a + 16)) * 10}px)` };
};

// ---- the website's pixel wave, full frame, two seamless passes in 20 s ----
export function PixelWave({ f, frames = FRAMES }: { f: number; frames?: number }) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  React.useLayoutEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    // Phone scale: the site draws in CSS px, about 2.75 device px on a phone.
    const K = 2.75, CELL = Math.round(9 * K), u = (f / frames) * Math.PI * 2;
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
  }, [f, frames]);
  return <canvas ref={ref} width={W} height={H} style={{ position: 'absolute', inset: 0 }} />;
}

// ---- Nekko peeking over a panel edge (the website peek) ----
const HEAD = 'M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z';
export const EYES = {
  open: 'M11 15H13V18H11Z M20 15H22V18H20Z',
  closed: 'M10 17H14V18H10Z M19 17H23V18H19Z',
  happy: 'M9 17H10V15H11V14H12V15H13V17H12V16H10V17Z M19 17H20V15H21V14H22V15H23V17H22V16H20V17Z',
} as const;
const PAW_L = { fill: 'M7 23H12V28H7Z', line: 'M6 22H13V27H12V23H7V27H6Z' };
const PAW_R = { fill: 'M20 23H25V28H20Z', line: 'M19 22H26V27H25V23H20V27H19Z' };
const spark = (x: number, y: number) => `M${x} ${y - 1}H${x + 1}V${y}H${x}Z M${x - 1} ${y}H${x}V${y + 1}H${x - 1}Z M${x + 1} ${y}H${x + 2}V${y + 1}H${x + 1}Z M${x} ${y + 1}H${x + 1}V${y + 2}H${x}Z`;
const SPARKS = [spark(-3, 2), spark(34, 9), spark(1, 14), spark(29, -1), spark(17, -5)].join(' ');

export function Peek({ f, x, edge, s = 10, eyes, hop = 0, sparkle = false }: { f: number; x: number; edge: number; s?: number; eyes: keyof typeof EYES; hop?: number; sparkle?: boolean }) {
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

/** Blink now and then, happy when told. */
const eyesAt = (f: number, happy: boolean): keyof typeof EYES =>
  happy ? 'happy' : (f % 75 > 70 ? 'closed' : 'open');

export function Panel({ x = 60, y, w = 960, children, style }: { x?: number; y: number; w?: number; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: w, background: C.panel, border: `2px solid ${C.line}`, borderRadius: 36, boxSizing: 'border-box', boxShadow: '0 40px 90px rgba(0,0,0,.55)', ...style }}>
      {children}
    </div>
  );
}

function Headline({ f, span, kicker, children }: { f: number; span: Span; kicker: string; children: React.ReactNode }) {
  return (
    <div style={{ position: 'absolute', left: 84, top: 230, width: 920 }}>
      <div style={{ fontFamily: MONO, fontSize: 30, letterSpacing: 2, color: C.plum, textTransform: 'uppercase', ...enter(f, span[0] + 4, span) }}>{kicker}</div>
      <div style={{ fontFamily: SANS, fontWeight: 800, fontSize: 96, lineHeight: 1.02, letterSpacing: -3.5, color: C.ink, marginTop: 18, ...enter(f, span[0] + 10, span) }}>{children}</div>
    </div>
  );
}
export const Grad = ({ children }: { children: React.ReactNode }) => (
  <span style={{ background: `linear-gradient(110deg, ${C.plum2} 0%, ${C.rose} 100%)`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>{children}</span>
);
export const Check = ({ size = 40, color = C.ok }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3 3 7-7" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
export const Dot = ({ color }: { color: string }) => <span style={{ width: 16, height: 16, borderRadius: 8, background: color, display: 'inline-block', flexShrink: 0 }} />;

// ─── 1 Intro ───────────────────────────────────────────────────────────────
function Intro({ f }: { f: number }) {
  const span = SC.intro;
  const edge = 900;
  return (
    <AbsoluteFill style={{ opacity: vis(f, span) }}>
      <Panel y={edge} style={{ padding: '70px 60px 64px', textAlign: 'center' }}>
        <div style={{ fontFamily: SANS, fontWeight: 800, fontSize: 124, letterSpacing: -5, lineHeight: 1, color: C.ink, ...enter(f, 14, span) }}>Meet <Grad>Nekko.</Grad></div>
        <div style={{ fontFamily: SANS, fontWeight: 500, fontSize: 44, lineHeight: 1.3, color: '#d6d2de', marginTop: 28, ...enter(f, 26, span) }}>An AI agent that runs on<br />your own computer.</div>
      </Panel>
      <Peek f={f} x={380} edge={edge} eyes={f < 20 ? 'closed' : eyesAt(f, f > 50)} />
    </AbsoluteFill>
  );
}

// ─── 2 Pick a model ────────────────────────────────────────────────────────
const MODELS = [
  { group: 'On this computer' },
  { name: 'Qwen3 8B', detail: 'Built-in engine', right: 'Loaded' },
  { name: 'Gemma 4 12B', detail: 'Built-in engine' },
  { group: 'Cloud' },
  { name: 'Opus 5.5', detail: 'Claude subscription' },
  { name: 'GPT-6-Sol', detail: 'ChatGPT subscription' },
];
function Model({ f }: { f: number }) {
  const span = SC.model, s = span[0];
  const hover = f >= s + 50 && f < s + 74;
  const chosen = f >= s + 74;
  const edge = 760;
  return (
    <AbsoluteFill style={{ opacity: vis(f, span) }}>
      <Headline f={f} span={span} kicker="Your models">Local or cloud.<br /><Grad>You pick.</Grad></Headline>
      <Panel y={edge} style={{ padding: '44px 28px 32px', ...enter(f, s + 16, span) }}>
        {MODELS.map((m, i) => 'group' in m ? (
          <div key={i} style={{ fontFamily: MONO, fontSize: 28, color: C.soft, padding: i ? '30px 24px 10px' : '0 24px 10px' }}>{m.group}</div>
        ) : (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '22px 24px', borderRadius: 20,
            background: i === 1 && (hover || chosen) ? (chosen ? 'rgba(192,132,181,0.16)' : 'rgba(255,255,255,0.05)') : 'transparent' }}>
            <div>
              <div style={{ fontFamily: SANS, fontSize: 46, fontWeight: 650, color: i === 1 && chosen ? C.plum : C.ink }}>{m.name}</div>
              <div style={{ fontFamily: SANS, fontSize: 32, color: C.faint, marginTop: 4 }}>{m.detail}</div>
            </div>
            {m.right && <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12, fontFamily: SANS, fontSize: 32, color: C.soft }}><Dot color={C.ok} />{m.right}</span>}
            {i === 1 && chosen && <span style={{ marginLeft: m.right ? 8 : 'auto' }}><Check size={44} color={C.plum} /></span>}
          </div>
        ))}
      </Panel>
      <div style={{ position: 'absolute', left: 84, top: 1640, display: 'flex', gap: 18, fontFamily: SANS, fontSize: 36, color: C.soft, ...enter(f, s + 84, span) }}>
        <span style={{ padding: '12px 26px', borderRadius: 999, border: `2px solid ${C.line}` }}>Offline</span>
        <span style={{ padding: '12px 26px', borderRadius: 999, border: `2px solid ${C.line}` }}>Free</span>
        <span style={{ padding: '12px 26px', borderRadius: 999, border: `2px solid ${C.line}` }}>Private</span>
      </div>
      <Peek f={f} x={680} edge={edge} s={8} eyes={eyesAt(f, chosen)} />
    </AbsoluteFill>
  );
}

// ─── 3 Ask, then approve ───────────────────────────────────────────────────
function Ask({ f }: { f: number }) {
  const span = SC.ask, s = span[0];
  const ask = 'Clean up my Downloads folder';
  const reply = 'Found 3 old installers taking up 2.1 GB.';
  const pressed = f >= s + 128 && f < s + 136;
  const approved = f >= s + 134;
  const edge = 700;
  return (
    <AbsoluteFill style={{ opacity: vis(f, span) }}>
      <Headline f={f} span={span} kicker="You stay in charge">Just ask.<br /><Grad>It checks first.</Grad></Headline>
      <Panel y={edge} style={{ padding: '56px 40px 40px', minHeight: 760, ...enter(f, s + 16, span) }}>
        {f >= s + 28 && (
          <div style={{ marginLeft: 'auto', width: 'fit-content', maxWidth: 760, background: C.panel2, borderRadius: 28, padding: '22px 32px', fontFamily: SANS, fontSize: 44, color: C.ink }}>
            {typed(f, s + 28, s + 58, ask)}{f < s + 62 && <span style={{ borderLeft: `3px solid ${C.plum}`, marginLeft: 3 }} />}
          </div>
        )}
        {f >= s + 66 && (
          <>
            <div style={{ fontFamily: MONO, fontSize: 26, color: C.faint, marginTop: 40, opacity: p(f, s + 66, s + 74) }}>Qwen3 8B · on this computer</div>
            <div style={{ fontFamily: SANS, fontSize: 44, lineHeight: 1.3, color: C.ink, marginTop: 12 }}>{typed(f, s + 70, s + 96, reply)}</div>
          </>
        )}
        {f >= s + 98 && (
          <div style={{ marginTop: 40, border: `2px solid ${approved ? C.ok : C.warn}66`, background: approved ? 'rgba(76,195,138,0.08)' : 'rgba(229,165,75,0.08)', borderRadius: 28, padding: '32px 34px', ...enter(f, s + 98, span) }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontFamily: SANS, fontSize: 34, fontWeight: 600, color: approved ? C.ok : C.warn }}>
              {approved ? <Check size={36} /> : <Dot color={C.warn} />}{approved ? 'Approved' : 'Needs your OK'}
            </div>
            <div style={{ fontFamily: MONO, fontSize: 34, color: C.ink, marginTop: 18 }}>delete 3 installers (2.1 GB)</div>
            <div style={{ display: 'flex', gap: 20, marginTop: 30, fontFamily: SANS, fontSize: 40, fontWeight: 650 }}>
              <span style={{ flex: 1, textAlign: 'center', padding: '20px 0', borderRadius: 20, border: `2px solid ${C.line}`, color: C.soft, opacity: approved ? 0.4 : 1 }}>Deny</span>
              <span style={{ flex: 1, textAlign: 'center', padding: '20px 0', borderRadius: 20, background: approved ? C.ok : C.plum, color: '#120a12', transform: `scale(${pressed ? 0.95 : 1})` }}>{approved ? 'Done' : 'Approve'}</span>
            </div>
          </div>
        )}
      </Panel>
      <Peek f={f} x={90} edge={edge} s={8} eyes={f >= s + 98 && !approved ? 'open' : eyesAt(f, approved)} />
    </AbsoluteFill>
  );
}

// ─── 4 Done ────────────────────────────────────────────────────────────────
function Done({ f }: { f: number }) {
  const span = SC.done, s = span[0];
  const edge = 980;
  const hopStep = f >= s + 24 && f < s + 45 ? [-1, -2, -1][Math.floor((f - s - 24) / 7)] ?? 0 : 0;
  return (
    <AbsoluteFill style={{ opacity: vis(f, span) }}>
      <Headline f={f} span={span} kicker="Finished"><Grad>2.1 GB</Grad> freed.<br />Nothing left<br />your computer.</Headline>
      <Panel y={edge} style={{ padding: '64px 56px 56px', ...enter(f, s + 14, span) }}>
        {['Found 214 files', 'Asked before deleting', 'Removed 3 installers'].map((t, i) => (
          <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 20, fontFamily: SANS, fontSize: 44, color: C.ink, padding: '14px 0', ...enter(f, s + 18 + i * 6, span) }}>
            <Check size={44} />{t}
          </div>
        ))}
        <div style={{ fontFamily: MONO, fontSize: 28, color: C.faint, marginTop: 24, ...enter(f, s + 40, span) }}>Qwen3 8B · offline · $0.00</div>
      </Panel>
      <Peek f={f} x={600} edge={edge} s={8} eyes="happy" hop={hopStep} sparkle={f >= s + 20 && f < s + 60} />
    </AbsoluteFill>
  );
}

// ─── 5 End card ────────────────────────────────────────────────────────────
export function AppMark({ size }: { size: number }) {
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
  const span = [SC.end[0], FRAMES + 20] as const; // holds to the last frame
  const edge = 1000;
  return (
    <AbsoluteFill style={{ opacity: p(f, SC.end[0], SC.end[0] + 14) }}>
      <Panel y={edge} style={{ padding: '76px 60px 66px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 34 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, ...enter(f, span[0] + 8, span) }}>
          <AppMark size={104} />
          <span style={{ fontFamily: SANS, fontWeight: 800, fontSize: 84, letterSpacing: -3, color: C.ink }}>Nekko Agent</span>
        </div>
        <div style={{ fontFamily: SANS, fontSize: 40, fontWeight: 600, color: C.plum, border: `2px solid ${C.plum}55`, borderRadius: 999, padding: '14px 40px', ...enter(f, span[0] + 18, span) }}>Free public beta</div>
        <div style={{ fontFamily: MONO, fontSize: 44, color: C.ink, ...enter(f, span[0] + 26, span) }}>nekkoagent.com</div>
      </Panel>
      <Peek f={f} x={380} edge={edge} eyes={eyesAt(f, true)} />
    </AbsoluteFill>
  );
}

export function Reel() {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: PAGE_BG, overflow: 'hidden', fontFamily: SANS }}>
      <style>{fontCss}</style>
      <PixelWave f={f} />
      {f < SC.intro[1] && <Intro f={f} />}
      {f >= SC.model[0] && f < SC.model[1] && <Model f={f} />}
      {f >= SC.ask[0] && f < SC.ask[1] && <Ask f={f} />}
      {f >= SC.done[0] && f < SC.done[1] && <Done f={f} />}
      {f >= SC.end[0] && <End f={f} />}
    </AbsoluteFill>
  );
}

export const REEL_FRAMES = FRAMES;
