// "Playing GTA VI?", a square post for X (1:1, 18 s). Three slow beats, one
// idea each: the question, the offer (your PC works through tasks on local AI)
// and Nekko Agent, with Nekko holding a controller.
//
// Brand dark palette (spec/brand/colour-palette.md, docs/design-system.md):
// page #0B0C14 with #854F6C glows, the dot wave (#C084B5 to #854F6C), panels
// #14151F / #1D1F2C, lines #252735, Inter Tight with Space Mono labels, and
// Nekko in his fixed dark-mode colours. The controller is a generic pixel pad
// in panel colours, not any console maker's. No Rockstar artwork, logo, type or
// colours: the game is only named in text.
import React from 'react';
import {
  AbsoluteFill, Easing, continueRender, delayRender, interpolate,
  staticFile, useCurrentFrame,
} from 'remotion';

const FRAMES = 540; // 18 s at 30 fps
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

// ---- Nekko with a controller ----
// His head and paws as on the website peek (32-unit grid), holding a generic
// pixel pad. Only his outline, eyes and mouth colours are used for him.
const HEAD = 'M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z';
const EYES = {
  open: 'M11 15H13V18H11Z M20 15H22V18H20Z',
  closed: 'M10 17H14V18H10Z M19 17H23V18H19Z',
  happy: 'M9 17H10V15H11V14H12V15H13V17H12V16H10V17Z M19 17H20V15H21V14H22V15H23V17H22V16H20V17Z',
  focus: 'M11 16H13V18H11Z M20 16H22V18H20Z',
} as const;
// Pad, held the right way up: shoulder buttons on top, grips at the bottom in
// his paws, d-pad left, two buttons right.
const PAD = 'M5 23H27V24H28V32H27V33H22V30H10V33H5V32H4V24H5Z';
const DPAD = 'M8 26H9V25H10V26H11V27H10V28H9V27H8Z';
function GamerNekko({ f, size }: { f: number; size: number }) {
  const t = f % 60;
  const eyes: keyof typeof EYES = t > 55 ? 'closed' : 'focus';
  const lean = Math.round(Math.sin(f / 9) * 1.4) * 0.5;  // leaning into a turn, whole pixels only
  const pressA = Math.floor(f / 7) % 3 === 0, pressB = Math.floor(f / 11) % 2 === 0;
  return (
    <svg width={size} height={size * 34 / 32} viewBox="0 0 32 34" shapeRendering="crispEdges" style={{ overflow: 'visible' }}>
      <g transform={`translate(${lean} 0)`}>
        <path d={HEAD} fill={C.nekkoFace} stroke={C.nekkoLine} strokeWidth={1} />
        <path d={EYES[eyes]} fill={C.nekkoEyes} />
        <path d="M15 20H17V21H15Z" fill={C.nekkoMouth} />
      </g>
      <g transform={`translate(${-lean} 0)`}>
        <rect x={6} y={21.6} width={4} height={1.6} fill={C.panel2} stroke={C.nekkoLine} strokeWidth={0.8} />
        <rect x={22} y={21.6} width={4} height={1.6} fill={C.panel2} stroke={C.nekkoLine} strokeWidth={0.8} />
        <path d={PAD} fill={C.panel2} stroke={C.nekkoLine} strokeWidth={1} />
        <path d={DPAD} fill={C.faint} />
        <rect x={21.4} y={26.4} width={1.6} height={1.6} fill={pressA ? C.rose : C.plum2} />
        <rect x={23.8} y={25} width={1.6} height={1.6} fill={pressB ? C.rose : C.plum2} />
        <rect x={14} y={26} width={1.4} height={0.8} fill={C.faint} />
        <rect x={16.6} y={26} width={1.4} height={0.8} fill={C.faint} />
        {/* paws round the grips */}
        <rect x={3} y={29 + (pressA ? 0.4 : 0)} width={5} height={4} fill={C.nekkoFace} stroke={C.nekkoLine} strokeWidth={1} />
        <rect x={24} y={29 + (pressB ? 0.4 : 0)} width={5} height={4} fill={C.nekkoFace} stroke={C.nekkoLine} strokeWidth={1} />
      </g>
    </svg>
  );
}

// Nekko cheering: both paws up, holding a banner that just says "VI" in our
// own type and colours (nothing of the game's logo or lettering).
function CheerNekko({ f }: { f: number }) {
  const bounce = Math.abs(Math.sin(f / 7)) * -14;           // little cheering hops
  const sway = Math.sin(f / 7) * 3;                          // banner rocks with him
  const lift = (side: number) => Math.max(0, Math.sin(f / 7 + side * Math.PI)) * -8;
  const S = 8;                                               // px per Nekko unit
  return (
    <div style={{ position: 'relative', width: 380, height: 470, transform: `translateY(${bounce}px)` }}>
      <div style={{ position: 'absolute', left: 30, top: 34, width: 320, height: 150, transform: `rotate(${sway}deg)`, transformOrigin: '50% 100%' }}>
        <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(110deg, ${C.main}, #3a1438)`, border: `6px solid ${C.plum2}`, borderRadius: 18, display: 'grid', placeItems: 'center', boxShadow: '0 24px 50px rgba(0,0,0,.5)' }}>
          <span style={{ fontFamily: SANS, fontWeight: 800, fontSize: 116, letterSpacing: -2, lineHeight: 1, color: C.ink }}>VI</span>
        </div>
        {/* paws gripping the bottom corners */}
        {[-1, 1].map((side) => (
          <div key={side} style={{ position: 'absolute', top: 118 + lift(side), left: side < 0 ? -22 : 286, width: 7 * S, height: 7 * S, background: C.nekkoFace, border: `${S}px solid ${C.nekkoLine}`, boxSizing: 'border-box' }} />
        ))}
      </div>
      <svg width={32 * S} height={22 * S} viewBox="0 5 32 22" shapeRendering="crispEdges" style={{ position: 'absolute', left: 190 - 16 * S, top: 196 }}>
        <path d={HEAD} fill={C.nekkoFace} stroke={C.nekkoLine} strokeWidth={1} />
        <path d={f % 60 > 55 ? EYES.closed : EYES.open} fill={C.nekkoEyes} />
        <path d="M14 20H18V21H14Z M15 21H17V22H15Z" fill={C.nekkoMouth} />
      </svg>
    </div>
  );
}

const Grad = ({ children }: { children: React.ReactNode }) => (
  <span style={{ background: `linear-gradient(110deg, ${C.plum2} 0%, ${C.rose} 100%)`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>{children}</span>
);

/** Settle in (short drift, fade, blur clearing), dissolve out. Slow on purpose. */
function Soft({ f, at, out = 1e9, children, style }: { f: number; at: number; out?: number; children: React.ReactNode; style?: React.CSSProperties }) {
  const inP = p(f, at, at + 28);
  const outP = interpolate(f, [out, out + 18], [0, 1], { ...clamp, easing: Easing.bezier(0.4, 0, 1, 1) });
  if (inP <= 0 || outP >= 1) return null;
  return <div style={{ ...style, opacity: inP * (1 - outP), filter: `blur(${(1 - inP) * 10 + outP * 10}px)`, transform: `translateY(${(1 - inP) * 20}px)` }}>{children}</div>;
}

const CENTER: React.CSSProperties = { position: 'absolute', left: 0, right: 0, textAlign: 'center' };

const Check = ({ size = 34 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3 3 7-7" stroke={C.ok} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const Dot = ({ color, size = 14 }: { color: string; size?: number }) => <span style={{ width: size, height: size, borderRadius: size, background: color, display: 'inline-block', flexShrink: 0 }} />;

// The PC's work while you play: one row finishes about every 1.5 s.
const TASKS = ['Answer 12 support emails', 'Fix the checkout bug', 'Draft the launch post'];
const TASK_AT = [176, 222, 268];
function WorkCard({ f }: { f: number }) {
  return (
    <div style={{ width: 760, margin: '0 auto', background: C.panel, border: `2px solid ${C.line}`, borderRadius: 28, boxShadow: '0 30px 70px rgba(0,0,0,.5)', padding: '36px 44px', boxSizing: 'border-box', textAlign: 'left' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={{ fontFamily: SANS, fontWeight: 650, fontSize: 32, color: C.ink }}>Your PC</span>
        <span style={{ fontFamily: MONO, fontSize: 22, color: C.faint }}>Qwen3 8B · local</span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, fontFamily: SANS, fontSize: 26, color: C.soft }}><Dot color={C.ok} />Working</span>
      </div>
      <div style={{ marginTop: 22 }}>
        {TASKS.map((t, i) => {
          const done = p(f, TASK_AT[i], TASK_AT[i] + 12);
          return (
            <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '14px 0', fontFamily: SANS, fontSize: 34, color: done > 0.5 ? C.ink : C.soft }}>
              <span style={{ position: 'relative', width: 34, height: 34, display: 'grid', placeItems: 'center' }}>
                <span style={{ position: 'absolute', opacity: 1 - done }}><Dot color={C.plum} /></span>
                <span style={{ position: 'absolute', opacity: done, transform: `scale(${0.6 + done * 0.4})` }}><Check /></span>
              </span>{t}
            </div>
          );
        })}
      </div>
      <div style={{ fontFamily: MONO, fontSize: 22, color: C.faint, marginTop: 14 }}>No tokens · no subscription · $0.00</div>
    </div>
  );
}

// ─── Timeline (frames at 30 fps) ───────────────────────────────────────────
//   0.0–3.7  Playing GTA VI?
//   4.0–11   Put your PC to work. The PC finishes three tasks, slowly.
//            So you can focus on the mission.
//  11.3–18   Nekko with a controller, "3 tasks done" above him, Nekko Agent
export function GtaIdleGpu() {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: PAGE_BG, overflow: 'hidden', fontFamily: SANS }}>
      <PixelWave f={f} />

      {/* 1 — the question, Nekko cheering under it */}
      <Soft f={f} at={-8} out={100} style={{ ...CENTER, top: 130 }}>
        <div style={{ fontFamily: SANS, fontWeight: 800, fontSize: 132, lineHeight: 1, letterSpacing: -5, color: C.ink }}>
          Playing<br /><Grad>GTA VI?</Grad>
        </div>
      </Soft>
      <Soft f={f} at={10} out={100} style={{ ...CENTER, top: 470, display: 'flex', justifyContent: 'center' }}>
        <CheerNekko f={f} />
      </Soft>

      {/* 2 — the PC works */}
      <Soft f={f} at={120} out={322} style={{ ...CENTER, top: 130 }}>
        <div style={{ fontFamily: SANS, fontWeight: 800, fontSize: 92, letterSpacing: -3.5, color: C.ink }}>Put your PC to work.</div>
      </Soft>
      <Soft f={f} at={140} out={322} style={{ ...CENTER, top: 300 }}><WorkCard f={f} /></Soft>
      <Soft f={f} at={290} out={322} style={{ ...CENTER, top: 790 }}>
        <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: 60, letterSpacing: -2 }}><Grad>So you can focus on the mission.</Grad></div>
      </Soft>

      {/* 3 — Nekko Agent */}
      <Soft f={f} at={340} style={{ ...CENTER, top: 150, display: 'flex', justifyContent: 'center' }}>
        <GamerNekko f={f} size={420} />
      </Soft>
      <Soft f={f} at={400} style={{ position: 'absolute', left: 780, top: 300 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: C.panel, border: `2px solid ${C.line}`, borderRadius: 999, padding: '12px 22px', fontFamily: SANS, fontSize: 26, color: C.ink }}><Check size={26} />3 tasks done</div>
      </Soft>
      <Soft f={f} at={364} style={{ ...CENTER, top: 690, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 22 }}>
        <AppMark size={88} />
        <span style={{ fontFamily: SANS, fontWeight: 800, fontSize: 84, letterSpacing: -3, color: C.ink }}>Nekko Agent</span>
      </Soft>
      <Soft f={f} at={384} style={{ ...CENTER, top: 822 }}>
        <div style={{ fontFamily: MONO, fontSize: 36, color: C.soft }}>Free local AI · nekkoagent.com</div>
      </Soft>
    </AbsoluteFill>
  );
}

export const GTA_FRAMES = FRAMES;

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

