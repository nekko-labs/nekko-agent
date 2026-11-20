// "Playing GTA VI on console?", a vertical post (9:16, 1080x1920, 30 fps, 11 s).
//   0.0-2.5  Hook: the question and "Your PC's doing nothing.", Nekko cheering
//            under a pixel "VI" (plain white blocks, nothing of the game's logo).
//   2.5-6.5  "Put your PC to work." and the task card; three tasks tick from 3.0 s.
//   6.5-8.0  "Free. Local. No subscription." and "So you can focus on the mission."
//   8.0-11   Nekko with a controller, the wordmark and nekkoagent.com, held.
// Rules from the brief: no frame without content, no text under 4% of the
// frame height (77 px), no em dashes on screen.
//
// Brand dark palette (spec/brand/colour-palette.md, docs/design-system.md):
// page #0B0C14 with #854F6C glows, the dot wave (#C084B5 to #854F6C), panels
// #14151F / #1D1F2C, lines #252735, Inter Tight and Space Mono, and Nekko in
// his fixed dark-mode colours. The controller is a generic pixel pad.
import React from 'react';
import {
  AbsoluteFill, Easing, continueRender, delayRender, interpolate,
  staticFile, useCurrentFrame,
} from 'remotion';

const FRAMES = 330; // 11 s at 30 fps
const W = 1080, H = 1920;

const C = {
  page: '#0b0c14', panel: '#14151f', panel2: '#1d1f2c', line: '#252735',
  ink: '#ffffff', soft: '#a3a4b6', faint: '#87899b',
  plum: '#c99bb3', plum2: '#854f6c', rose: '#e6d0dc', ok: '#4ec98a', main: '#190019',
  nekkoFace: '#16161c', nekkoLine: '#f3e8ee', nekkoEyes: '#ffffff', nekkoMouth: '#854f6c',
};
// The dark page with secondary (#854F6C) glows, as in docs/brand/nekko-banner.html, scaled to 1080x1920.
const PAGE_BG = 'radial-gradient(70% 1400px at 8% 0%, rgba(133, 79, 108, 0.26), transparent 70%), radial-gradient(55% 1200px at 85% 50%, rgba(133, 79, 108, 0.16), transparent 70%), radial-gradient(70% 1100px at 20% 100%, rgba(133, 79, 108, 0.18), transparent 70%), #0b0c14';
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

const Grad = ({ children }: { children: React.ReactNode }) => (
  <span style={{ background: `linear-gradient(110deg, ${C.plum2} 0%, ${C.rose} 100%)`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>{children}</span>
);

// ---- Nekko ----
const HEAD = 'M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z';
const EYES = {
  open: 'M11 15H13V18H11Z M20 15H22V18H20Z',
  closed: 'M10 17H14V18H10Z M19 17H23V18H19Z',
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

// "VI" in plain white pixel blocks, the same grid as Nekko (7x8 V, 2x8 I).
const VI_BLOCKS: [number, number, number][] = [ // [x, y, width]
  [0, 0, 2], [5, 0, 2], [0, 1, 2], [5, 1, 2], [0, 2, 2], [5, 2, 2], [0, 3, 2], [5, 3, 2],
  [1, 4, 2], [4, 4, 2], [1, 5, 2], [4, 5, 2], [2, 6, 3], [3, 7, 1],
  ...Array.from({ length: 8 }, (_, y) => [9, y, 2] as [number, number, number]),
];
function CheerNekko({ f }: { f: number }) {
  const S = 13;                                           // px per unit
  const beat = Math.sin(f / 6);
  const bounce = Math.abs(beat) * -16;
  const paw = (side: number) => Math.max(0, Math.sin(f / 6 + (side > 0 ? Math.PI : 0))) * -22;
  return (
    <div style={{ position: 'relative', width: 32 * S + 160, height: 640, transform: `translateY(${bounce}px)` }}>
      <svg width={11 * S * 1.6} height={8 * S * 1.6} viewBox="0 0 11 8" shapeRendering="crispEdges"
        style={{ position: 'absolute', left: (32 * S + 160 - 11 * S * 1.6) / 2, top: 0, transform: `rotate(${beat * 3}deg)` }}>
        {VI_BLOCKS.map(([x, y, w], i) => <rect key={i} x={x} y={y} width={w} height={1} fill={C.ink} />)}
      </svg>
      {/* both paws up, cheering */}
      {[-1, 1].map((side) => (
        <div key={side} style={{ position: 'absolute', top: 250 + paw(side), left: side < 0 ? 30 : 32 * S + 160 - 30 - 6 * S, width: 6 * S, height: 6 * S, background: C.nekkoFace, border: `${S}px solid ${C.nekkoLine}`, boxSizing: 'border-box' }} />
      ))}
      <svg width={32 * S} height={22 * S} viewBox="0 5 32 22" shapeRendering="crispEdges" style={{ position: 'absolute', left: 80, top: 230 }}>
        <path d={HEAD} fill={C.nekkoFace} stroke={C.nekkoLine} strokeWidth={1} />
        <path d={f % 60 > 55 ? EYES.closed : EYES.open} fill={C.nekkoEyes} />
        <path d="M14 20H18V21H14Z M15 21H17V22H15Z" fill={C.nekkoMouth} />
      </svg>
    </div>
  );
}

const Check = ({ size = 72 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3 3 7-7" stroke={C.ok} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const Dot = ({ color, size = 22 }: { color: string; size?: number }) => <span style={{ width: size, height: size, borderRadius: size, background: color, display: 'inline-block', flexShrink: 0 }} />;

// Opacity for a scene: fade in over [a, a+d], out over [b, b+d]. d = 6 is the
// 0.2 s crossfade; scenes overlap so no frame is ever empty.
const win = (f: number, a: number, b: number, d = 6) =>
  (a <= 0 ? 1 : interpolate(f, [a, a + d], [0, 1], clamp)) * interpolate(f, [b, b + d], [1, 0], clamp);
/** A quick settle for text arriving inside a scene. */
const arrive = (f: number, at: number) => ({ opacity: p(f, at, at + 8), transform: `translateY(${(1 - p(f, at, at + 10)) * 24}px)` });

const TXT = 78;                          // the floor: 4% of 1920
const HEAD_SIZE = 104;
const CENTER: React.CSSProperties = { position: 'absolute', left: 60, right: 60, textAlign: 'center' };

// Placeholders until the final tasks are confirmed.
const TASKS = ['Sort 50 support emails', "Summarise this week's meeting notes", 'Draft the launch post'];
const TASK_AT = [90, 108, 126];          // 3.0 s, 3.6 s, 4.2 s; all ticked by 4.6 s

function WorkCard({ f }: { f: number }) {
  return (
    <div style={{ width: 918, margin: '0 auto', background: C.panel, border: `3px solid ${C.line}`, borderRadius: 40, boxShadow: '0 40px 90px rgba(0,0,0,.5)', padding: '44px 52px 30px', boxSizing: 'border-box', textAlign: 'left' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 22, fontFamily: SANS, fontSize: TXT, fontWeight: 700, color: C.ink, letterSpacing: -1.5 }}>
        Your PC
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16, fontWeight: 500, color: C.soft }}><Dot color={C.ok} />Working</span>
      </div>
      <div style={{ marginTop: 14 }}>
        {TASKS.map((t, i) => {
          const done = p(f, TASK_AT[i], TASK_AT[i] + 8);
          return (
            <div key={t} style={{ display: 'flex', alignItems: 'flex-start', gap: 26, padding: '18px 0', fontFamily: SANS, fontSize: TXT, lineHeight: 1.08, letterSpacing: -1.5, color: done > 0.5 ? C.ink : C.soft }}>
              <span style={{ position: 'relative', width: 72, height: 84, flexShrink: 0, display: 'grid', placeItems: 'center' }}>
                <span style={{ position: 'absolute', opacity: 1 - done }}><Dot color={C.plum} /></span>
                <span style={{ position: 'absolute', opacity: done, transform: `scale(${0.6 + done * 0.4})` }}><Check /></span>
              </span>{t}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function GtaIdleGpu() {
  const f = useCurrentFrame();
  const s1 = win(f, 0, 72), s2 = win(f, 72, 237), s3 = win(f, 237, 1e9);
  return (
    <AbsoluteFill style={{ background: PAGE_BG, overflow: 'hidden', fontFamily: SANS }}>
      <PixelWave f={f} />

      {/* 1 Hook, 0.0 to 2.5 s: everything on screen from the first frame */}
      {s1 > 0 && (
        <AbsoluteFill style={{ opacity: s1 }}>
          <div style={{ ...CENTER, top: 230, fontFamily: SANS, fontWeight: 800, fontSize: HEAD_SIZE, lineHeight: 1.04, letterSpacing: -4 }}>
            <div style={{ color: C.ink }}>Playing GTA VI on console?</div>
            <div style={{ marginTop: 36 }}><Grad>Your PC's doing nothing.</Grad></div>
          </div>
          <div style={{ position: 'absolute', left: 0, right: 0, top: 1000, display: 'flex', justifyContent: 'center' }}><CheerNekko f={f} /></div>
        </AbsoluteFill>
      )}

      {/* 2 and 3, 2.5 to 8.0 s: headline and card arrive together, the value line follows below */}
      {s2 > 0 && (
        <AbsoluteFill style={{ opacity: s2 }}>
          <div style={{ ...CENTER, top: 150, fontFamily: SANS, fontWeight: 800, fontSize: HEAD_SIZE, lineHeight: 1.04, letterSpacing: -4, color: C.ink }}>Put your PC to work.</div>
          <div style={{ position: 'absolute', left: 0, right: 0, top: 420 }}><WorkCard f={f} /></div>
          <div style={{ ...CENTER, top: 1290, fontFamily: SANS, fontWeight: 800, fontSize: HEAD_SIZE, lineHeight: 1.04, letterSpacing: -4, ...arrive(f, 195) }}>
            <Grad>Free. Local. No subscription.</Grad>
          </div>
          <div style={{ ...CENTER, top: 1560, fontFamily: SANS, fontWeight: 700, fontSize: 88, lineHeight: 1.06, letterSpacing: -3, color: C.ink, ...arrive(f, 213) }}>
            So you can focus on the mission.
          </div>
        </AbsoluteFill>
      )}

      {/* 4 End card, 8.0 to 11 s */}
      {s3 > 0 && (
        <AbsoluteFill style={{ opacity: s3 }}>
          <div style={{ ...CENTER, top: 200, display: 'flex', justifyContent: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 20, background: C.panel, border: `3px solid ${C.line}`, borderRadius: 999, padding: '18px 44px', fontFamily: SANS, fontSize: TXT, fontWeight: 650, letterSpacing: -1.5, color: C.ink }}><Check size={70} />3 tasks done</div>
          </div>
          <div style={{ position: 'absolute', left: 0, right: 0, top: 440, display: 'flex', justifyContent: 'center' }}><GamerNekko f={f} size={560} /></div>
          <div style={{ ...CENTER, top: 1180, ...arrive(f, 249) }}>
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 28 }}>
              <AppMark size={124} />
              <span style={{ fontFamily: SANS, fontWeight: 800, fontSize: HEAD_SIZE, letterSpacing: -4, color: C.ink }}>Nekko Agent</span>
            </div>
            <div style={{ fontFamily: SANS, fontWeight: 600, fontSize: TXT, letterSpacing: -1.5, color: C.soft, marginTop: 56 }}>Free local AI</div>
            <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 80, color: C.ink, marginTop: 18 }}>nekkoagent.com</div>
          </div>
        </AbsoluteFill>
      )}
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

