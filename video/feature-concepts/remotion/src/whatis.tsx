/**
 * "What is Nekko Agent?" — 30 s launch-style film on a 120 BPM grid (one beat = 15 frames).
 * Desktop → cursor clicks Nekko in the Dock → the app's real splash (res-up, then zoom through the cat)
 * → inside is the website's wave matrix, not the app → questions arrive as chat bubbles,
 * each answered by a quick stylised graphic → "Keep me company?" (the joke beat) → a flood of
 * questions collapses into the logo.
 */
import React, { useLayoutEffect, useRef } from 'react';
import { AbsoluteFill, Easing, interpolate, random, useCurrentFrame } from 'remotion';
import { Cat, MONO, SANS, THEMES, Th, clamp } from './ckit';
import { fontCss } from '../../../../video/pillars/src/kit';
import { CHUNKY_CELLS, CHUNKY_SIZE, FINE_PATH, MID_PATH } from '../../../../apps/desktop/src/renderer/splashCells';

export const WHATIS_FRAMES = 900;
const B = 15; // one beat at 120 BPM
const W = 1280, H = 720;
const INK = '#f4f2fa', SOFT = '#a3a1b0', PLUM = '#c084b5', ROSE = '#854f6c', DEEP = '#190019', PAPER = '#0b0c14', OK = '#4cc38a';
// Copied from apps/desktop/src/renderer/components/BrandMark.tsx (BRAND_HEAD).
const BRAND_HEAD = 'M4.059,10.357C4.034,10.285 4.015,10.212 4.003,10.138L3.007,4.165L2.649,2.016L9.117,5.897C11.039,5.29 12.961,5.29 14.883,5.897L21.351,2.016L20.005,10.088C19.987,10.199 19.959,10.308 19.921,10.415L19.921,10.416C18.733,13.756 15.551,16.006 12,16.006C8.428,16.006 5.23,13.729 4.059,10.357L4.059,10.357ZM5.009,10.027C6.04,12.996 8.856,15 12,15C15.126,15 17.927,13.019 18.973,10.079C18.991,10.028 19.004,9.976 19.013,9.923L20,4L15,7C13,6.267 11,6.267 9,7L4,4L4.995,9.972C4.999,9.991 5.003,10.009 5.009,10.027Z';
const INNER = BRAND_HEAD.slice(BRAND_HEAD.indexOf('ZM') + 1);

const out = Easing.bezier(0.2, 0.8, 0.2, 1);
const k = (f: number, a: number, b: number, from = 0, to = 1, e = out) => interpolate(f, [a, b], [from, to], { ...clamp, easing: e });
const lin = (f: number, a: number, b: number, from = 0, to = 1) => interpolate(f, [a, b], [from, to], clamp);
/** Pop: 0 → overshoot → 1 over ~half a beat. */
const pop = (f: number, a: number) => interpolate(f, [a, a + 5, a + 9], [0, 1.08, 1], { ...clamp, easing: Easing.out(Easing.quad) });

// ─── the website's wave matrix (apps/website/site.js, #pixelwave), dark look ───
function Wave({ f, dim = 1 }: { f: number; dim?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    const CELL = 9, t = (f / 30) * 0.72;
    ctx.clearRect(0, 0, W, H);
    for (let y = 0; y < H; y += CELL) for (let x = 0; x < W; x += CELL) {
      const w = Math.sin(x / 110 - t * 1.4 + Math.sin(y / 150 + t * 0.5) * 1.6);
      const a = Math.max(0, w) ** 3 * 0.34;
      if (a < 0.025) continue;
      const s = a > 0.18 ? 3 : 2, q = x / W;
      ctx.fillStyle = `rgba(${Math.round(192 - 59 * q)},${Math.round(132 - 53 * q)},${Math.round(181 - 73 * q)},${(a * 1.1 * dim).toFixed(3)})`;
      ctx.fillRect(Math.round(x + (CELL - s) / 2), Math.round(y + (CELL - s) / 2), s, s);
    }
  }, [f, dim]);
  return <canvas ref={ref} width={W} height={H} style={{ position: 'absolute', inset: 0 }} />;
}

// ─── 1 · desktop and Dock ──────────────────────────────────────────────────
const DOCK_N = 8, NEKKO_I = 5, ICON = 64, DOCK_Y = 628;
const iconX = (i: number) => W / 2 - (DOCK_N * (ICON + 14)) / 2 + i * (ICON + 14) + 7;
const GLYPH = ['M8 14h16v10H8z', 'M16 6a10 10 0 1 0 .01 0zM6 16h20M16 6c-4 4-4 16 0 20M16 6c4 4 4 16 0 20', 'M9 7h14v18H9zM12 12h8M12 16h8M12 20h5', 'M12 22V9l12-3v13', 'M7 9h18v14H7zM7 9l9 7 9-7', '', 'M8 8h16v16H8zM8 14h16M14 8v16', 'M10 24l6-16 6 16M12 19h8'];
function Desktop({ f }: { f: number }) {
  const hoverAt = 44, click = 60;
  const cx = interpolate(f, [6, hoverAt], [880, iconX(NEKKO_I) + ICON / 2 + 6], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const cy = interpolate(f, [6, hoverAt], [250, DOCK_Y + 30], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const press = f >= click && f < click + 4 ? 0.85 : 1;
  const bounce = f >= click + 2 ? Math.abs(Math.sin(((f - click - 2) / 14) * Math.PI)) * Math.max(0, 1 - (f - click) / 40) * 26 : 0;
  return (
    <AbsoluteFill style={{ background: 'radial-gradient(120% 90% at 30% 20%, #2a1630 0%, #120d1a 55%, #07070b 100%)' }}>
      {/* menu bar */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 28, background: 'rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 22, padding: '0 20px', fontSize: 14, color: 'rgba(255,255,255,0.75)' }}>
        <span style={{ fontWeight: 600 }}>Finder</span><span>File</span><span>Edit</span><span>View</span><span style={{ marginLeft: 'auto' }}>Fri 9:41</span>
      </div>
      {/* dock */}
      <div style={{ position: 'absolute', left: iconX(0) - 14, top: DOCK_Y - 12, width: DOCK_N * (ICON + 14) + 14, height: ICON + 24, borderRadius: 22, background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.12)' }} />
      {Array.from({ length: DOCK_N }, (_, i) => {
        const dist = Math.abs(cx - (iconX(i) + ICON / 2));
        const near = cy > DOCK_Y - 60 ? Math.max(0, 1 - dist / 160) : 0;
        const s = 1 + near * 0.45;
        const nk = i === NEKKO_I;
        return (
          <div key={i} style={{ position: 'absolute', left: iconX(i), top: DOCK_Y - (nk ? bounce : 0), width: ICON, height: ICON, transformOrigin: '50% 100%', transform: `scale(${s})`, borderRadius: 15,
            background: nk ? DEEP : `linear-gradient(160deg, hsl(${230 + i * 18} 10% ${34 - i}%), hsl(${230 + i * 18} 10% ${20 - i}%))`, border: nk ? `1px solid ${ROSE}` : '1px solid rgba(255,255,255,0.08)', display: 'grid', placeItems: 'center' }}>
            {nk ? <svg width={44} height={44} viewBox="2 0 20 18"><path d={BRAND_HEAD} fill="#fff" fillRule="evenodd" /></svg>
              : <svg width={34} height={34} viewBox="0 0 32 32"><path d={GLYPH[i]} fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth={2} strokeLinejoin="round" /></svg>}
          </div>
        );
      })}
      {f > click && <div style={{ position: 'absolute', left: iconX(NEKKO_I) + ICON / 2 - 2, top: DOCK_Y + ICON + 4, width: 4, height: 4, borderRadius: 2, background: '#fff', opacity: k(f, click, click + 6) }} />}
      {/* hover label */}
      {f >= hoverAt && f < click + 8 && <div style={{ position: 'absolute', left: iconX(NEKKO_I) + ICON / 2 - 60, top: DOCK_Y - 82, width: 120, textAlign: 'center', fontSize: 15, color: '#fff', background: 'rgba(30,30,36,0.9)', borderRadius: 8, padding: '4px 0', opacity: k(f, hoverAt, hoverAt + 4) * (1 - k(f, click + 2, click + 8)) }}>Nekko Agent</div>}
      {/* cursor */}
      <svg style={{ position: 'absolute', left: cx, top: cy, transform: `scale(${press})`, transformOrigin: '0 0', filter: 'drop-shadow(0 2px 4px rgba(0,0,0,.5))' }} width={26} height={34} viewBox="0 0 13 17">
        <path d="M1 1 L1 14 L4.2 11 L6.6 16 L8.6 15 L6.3 10.2 L10.8 10.2 Z" fill="#fff" stroke="#000" strokeWidth={0.9} strokeLinejoin="round" />
      </svg>
    </AbsoluteFill>
  );
}

// ─── 2 · the splash (apps/desktop/src/renderer/splash.ts), frame-driven ───────
const S0 = 84; // splash window opens
function Splash({ f }: { f: number }) {
  const s = f - (S0 + 8); // res-up clock
  const kk = Math.max(40, W * 0.085) / 20, ox = W / 2 - 12 * kk, oy = H / 2 - 9 * kk;
  const place = `translate(${ox} ${oy}) scale(${kk})`;
  const cxz = ox + 12 * kk, cyz = oy + 10.6 * kk;
  const reach = (Math.hypot(W, H) / (8 * kk)) * 1.6;
  const z0 = 2.5 * B, D = 1.05 * B;
  const u = (s - z0) / D;
  let zoom = 1;
  if (u > 0) zoom = u < 0.25 ? 1 - 0.07 * Easing.bezier(0.3, 0, 0.5, 1)(u / 0.25) : 0.93 * Math.pow(reach / 0.93, Math.pow(Math.min(1, (u - 0.25) / 0.75), 1.35));
  const lid = 1 - k(s, z0 + 0.05 * D, z0 + 0.4 * D, 0, 1, Easing.bezier(0.4, 0, 0.6, 1));
  const open = k(f, S0, S0 + 8); // the window grows out of the Dock icon
  const ix = iconX(NEKKO_I) + ICON / 2, iy = DOCK_Y + ICON / 2;
  const zt = `translate(${cxz} ${cyz}) scale(${zoom}) translate(${-cxz} ${-cyz})`;
  const stage = s < B ? 0 : s < 1.5 * B ? 1 : s < 2 * B ? 2 : 3;
  const pulse = [B, 1.5 * B, 2 * B].reduce((m, t0) => (s >= t0 && s < t0 + 0.22 * B ? 0.988 + 0.012 * ((s - t0) / (0.22 * B)) : m), 1);
  if (u >= 1) return null;
  return (
    <svg width={W} height={H} style={{ position: 'absolute', inset: 0, transformOrigin: `${ix}px ${iy}px`, transform: `scale(${0.05 + 0.95 * open})`, opacity: open }}>
      <defs>
        <mask id="wi-mask" maskUnits="userSpaceOnUse" x={-W} y={-H} width={3 * W} height={3 * H}>
          <rect x={-W} y={-H} width={3 * W} height={3 * H} fill="#fff" />
          <g transform={zt}><path d={INNER} fill="#000" transform={place} /></g>
        </mask>
      </defs>
      <rect x={-W} y={-H} width={3 * W} height={3 * H} fill={DEEP} mask="url(#wi-mask)" />
      <g transform={zt}>
        <g transform={place}>
          <path d={INNER} fill={DEEP} stroke={DEEP} strokeWidth={0.2} opacity={lid} />
          <g transform={`translate(12 9) scale(${pulse}) translate(-12 -9)`}>
            {stage === 0 && CHUNKY_CELLS.map(([x, y], i) => {
              const d = ((x - 2) / 19) * 0.6 * B;
              const sc = k(s, d, d + 0.3 * B);
              return <rect key={i} x={x + 0.07} y={y + 0.07} width={CHUNKY_SIZE - 0.14} height={CHUNKY_SIZE - 0.14} fill="#fff" transform={`translate(${x + CHUNKY_SIZE / 2} ${y + CHUNKY_SIZE / 2}) scale(${sc}) translate(${-(x + CHUNKY_SIZE / 2)} ${-(y + CHUNKY_SIZE / 2)})`} />;
            })}
            {stage === 1 && <path d={MID_PATH} fill="#fff" />}
            {stage === 2 && <path d={FINE_PATH} fill="#fff" />}
            {stage === 3 && <path d={BRAND_HEAD} fill="#fff" stroke="#fff" strokeWidth={0.5} strokeMiterlimit={8} fillRule="evenodd" />}
          </g>
        </g>
      </g>
    </svg>
  );
}

// ─── chat bubble ───────────────────────────────────────────────────────────
function Bubble({ f, at, children, size = 40, style }: { f: number; at: number; children: React.ReactNode; size?: number; style?: React.CSSProperties }) {
  if (f < at) return null;
  const sc = pop(f, at);
  return (
    <div style={{ position: 'absolute', transformOrigin: '100% 100%', transform: `scale(${sc})`, opacity: Math.min(1, sc * 1.5), ...style }}>
      <div style={{ background: ROSE, color: '#fff', fontSize: size, fontWeight: 500, letterSpacing: '-0.02em', padding: `${size * 0.32}px ${size * 0.6}px`, borderRadius: size * 0.9, borderBottomRightRadius: size * 0.2, whiteSpace: 'nowrap', boxShadow: '0 12px 40px rgba(0,0,0,0.45)' }}>{children}</div>
    </div>
  );
}

// ─── the answers (local frame r, 0 = bubble lands) ──────────────────────────
const Center = ({ children, y = 0 }: { children: React.ReactNode; y?: number }) => <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', transform: `translateY(${y}px)` }}>{children}</AbsoluteFill>;
const Big = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => <div style={{ fontSize: 84, fontWeight: 600, letterSpacing: '-0.04em', color: INK, lineHeight: 1, ...style }}>{children}</div>;
const Note = ({ children }: { children: React.ReactNode }) => <div style={{ fontFamily: MONO, fontSize: 16, letterSpacing: '0.12em', textTransform: 'uppercase', color: SOFT }}>{children}</div>;

function Game({ r }: { r: number }) {
  const parts = [
    { n: 'Sprites', g: <svg width="70" height="70" viewBox="0 0 7 7" shapeRendering="crispEdges">{[[1, 0], [5, 0], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [0, 2], [1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [1, 3], [2, 3], [4, 3], [5, 3], [1, 4], [2, 4], [3, 4], [4, 4], [5, 4], [2, 5], [4, 5], [1, 6], [5, 6]].map(([x, y], i) => <rect key={i} x={x} y={y} width={1} height={1} fill={i % 7 === 3 ? '#fff' : PLUM} />)}</svg> },
    { n: '3D', g: <Cube t={r} /> },
    { n: 'Tiles', g: <svg width="70" height="70" viewBox="0 0 4 4" shapeRendering="crispEdges">{Array.from({ length: 16 }, (_, i) => <rect key={i} x={i % 4} y={Math.floor(i / 4)} width={0.92} height={0.92} fill={['#4f8a3c', '#7a5236', '#2f6f9a', '#6c6a72'][(i * 7 + Math.floor(i / 4)) % 4]} />)}</svg> },
    { n: 'Sound', g: <svg width="90" height="70" viewBox="0 0 18 14">{Array.from({ length: 9 }, (_, i) => { const h = 2 + Math.abs(Math.sin(i * 1.3 + r / 3)) * 10; return <rect key={i} x={i * 2} y={7 - h / 2} width={1.2} height={h} rx={0.6} fill={PLUM} />; })}</svg> },
  ];
  return (
    <Center y={40}>
      <svg width={W} height={H} style={{ position: 'absolute', left: 0, top: -40 }}>
        {parts.map((_, i) => { const x = 250 + i * 260; const d = k(r, 8 + i * 3, 18 + i * 3); return <line key={i} x1={640} y1={300} x2={640 + (x - 640) * d} y2={300 + 130 * d} stroke={PLUM} strokeWidth={2} opacity={0.6} />; })}
      </svg>
      <div style={{ position: 'absolute', top: 210, left: 0, right: 0, display: 'flex', justifyContent: 'center' }}>
        <div style={{ transform: `scale(${pop(r, 4)})`, padding: '10px 20px', borderRadius: 999, border: `1.5px solid ${PLUM}`, color: INK, fontSize: 22, background: 'rgba(11,12,20,0.8)' }}>Main agent plans</div>
      </div>
      <div style={{ position: 'absolute', top: 360, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 60 }}>
        {parts.map((pt, i) => (
          <div key={pt.n} style={{ width: 200, height: 170, borderRadius: 20, background: 'rgba(22,22,28,0.85)', border: '1px solid #2f2f3a', display: 'grid', placeItems: 'center', transform: `scale(${pop(r, 15 + i * 7)})`, paddingTop: 10 }}>
            {pt.g}
            <div style={{ fontSize: 20, color: SOFT }}>{pt.n}</div>
          </div>
        ))}
      </div>
    </Center>
  );
}
function Cube({ t }: { t: number }) {
  const th = t * 0.09, V = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
  const P = V.map(([x, y, z]) => { const x1 = x * Math.cos(th) + z * Math.sin(th), z1 = -x * Math.sin(th) + z * Math.cos(th); const y2 = y * Math.cos(0.5) - z1 * Math.sin(0.5); return [35 + x1 * 18, 35 + y2 * 18]; });
  const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  return <svg width="70" height="70">{E.map(([a, b], i) => <line key={i} x1={P[a][0]} y1={P[a][1]} x2={P[b][0]} y2={P[b][1]} stroke={PLUM} strokeWidth={2} strokeLinecap="round" />)}</svg>;
}

function Credits({ r }: { r: number }) {
  const v = interpolate(r, [12, 44], [48.2, 9.6], { ...clamp, easing: out });
  return (
    <Center y={50}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 36, transform: `scale(${pop(r, 8)})` }}>
        <Big style={{ fontSize: 150, fontVariantNumeric: 'tabular-nums', color: r > 44 ? PLUM : INK }}>${v.toFixed(2)}</Big>
        <div style={{ fontSize: 34, color: OK, opacity: k(r, 40, 48), fontWeight: 600 }}>−80%</div>
      </div>
      <div style={{ marginTop: 26, opacity: k(r, 20, 28) }}><Note>Same task · less sent · illustrative</Note></div>
    </Center>
  );
}

const GL = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&@';
function Private({ r }: { r: number }) {
  const hit = 26, real = 'maya@ortiz.studio';
  const scr = r >= hit && r < hit + 8, masked = r >= hit + 8;
  const txt = scr ? real.split('').map((c, i) => GL[Math.floor(random(`p${i}${Math.floor(r / 2)}`) * GL.length)]).join('') : masked ? '[EMAIL_1]' : real;
  const beam = lin(r, 12, 38, -10, 110);
  return (
    <Center y={50}>
      <div style={{ position: 'relative', transform: `scale(${pop(r, 6)})`, padding: '10px 26px', borderRadius: 18, background: masked ? 'rgba(192,132,181,0.18)' : 'transparent', boxShadow: masked ? `0 0 ${60 * Math.max(0, 1 - (r - hit - 8) / 14)}px ${PLUM}` : 'none' }}>
        <Big style={{ fontFamily: masked || scr ? MONO : SANS, color: masked ? PLUM : INK, fontSize: 90 }}>{txt}</Big>
        {r > 12 && r < 40 && <div style={{ position: 'absolute', top: -60, bottom: -60, left: `${beam}%`, width: 5, background: '#ff8fd0', boxShadow: '0 0 40px 10px rgba(255,143,208,0.5)' }} />}
      </div>
      <div style={{ marginTop: 30, opacity: k(r, 36, 44) }}><Note>Masked on your Mac before any model sees it</Note></div>
    </Center>
  );
}

const MODELS = ['Claude', 'Opus 5.5', 'Qwen3-32B', 'FLUX.2', 'Your own', 'Any model'];
function Models({ r }: { r: number }) {
  const idx = Math.min(MODELS.length - 1, Math.floor(lin(r, 8, 44, 0, MODELS.length - 0.01)));
  const flip = ((r - 8) % 6) / 6;
  return (
    <Center y={50}>
      <div style={{ display: 'flex', gap: 8, transform: `scale(${pop(r, 6)})` }}>
        {MODELS[idx].padEnd(9, ' ').split('').map((c, i) => (
          <div key={i} style={{ width: 92, height: 130, borderRadius: 12, background: '#16161c', border: '1px solid #2a2a34', display: 'grid', placeItems: 'center', position: 'relative', overflow: 'hidden',
            fontFamily: MONO, fontSize: 84, color: idx === MODELS.length - 1 ? PLUM : INK, transform: r < 46 && flip < 0.3 ? `scaleY(${0.6 + flip})` : 'none' }}>
            {c}
            <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', height: 2, background: '#0b0c14' }} />
          </div>
        ))}
      </div>
    </Center>
  );
}

function Devices({ r }: { r: number }) {
  const dots = [0, 1, 2].map((i) => lin(r, 14 + i * 7, 30 + i * 7));
  return (
    <Center y={50}>
      <svg width={900} height={320} viewBox="0 0 900 320" style={{ transform: `scale(${pop(r, 6)})` }}>
        <rect x={60} y={40} width={340} height={210} rx={14} fill="#16161c" stroke={SOFT} strokeWidth={3} />
        <path d="M20 262 H440 L420 282 H40 Z" fill="#16161c" stroke={SOFT} strokeWidth={3} strokeLinejoin="round" />
        <rect x={680} y={40} width={130} height={250} rx={24} fill="#16161c" stroke={SOFT} strokeWidth={3} />
        <path d="M410 150 C 520 90, 570 90, 670 150" stroke={PLUM} strokeWidth={2} strokeDasharray="6 8" fill="none" />
        {dots.map((d, i) => d > 0 && d < 1 && <circle key={i} cx={410 + 260 * d} cy={150 - Math.sin(d * Math.PI) * 45} r={8} fill={PLUM} />)}
        <g transform="translate(540 160)" opacity={k(r, 30, 38)}><rect x={-14} y={-4} width={28} height={22} rx={4} fill={PLUM} /><path d="M-8 -4 V-11 a8 8 0 0 1 16 0 V-4" stroke={PLUM} strokeWidth={4} fill="none" /></g>
        {[0, 1, 2].map((i) => <rect key={i} x={90} y={74 + i * 46} width={(200 + i * 30) * k(r, 8 + i * 3, 18 + i * 3)} height={22} rx={11} fill="#2a2a34" />)}
        {[0, 1, 2].map((i) => <rect key={i} x={698} y={84 + i * 40} width={94 * k(r, 22 + i * 7, 30 + i * 7)} height={18} rx={9} fill="#2a2a34" />)}
      </svg>
      <div style={{ marginTop: 6, opacity: k(r, 34, 42) }}><Note>Encrypted on your device</Note></div>
    </Center>
  );
}

function Logo({ r }: { r: number }) {
  const d = k(r, 8, 40, 0, 1, Easing.inOut(Easing.cubic));
  const fillO = k(r, 38, 46);
  return (
    <Center y={50}>
      <svg width={300} height={300} viewBox="0 0 100 100" style={{ transform: `scale(${pop(r, 6)})` }}>
        <path d="M24 40 H70 V62 Q70 80 52 80 H42 Q24 80 24 62 Z" pathLength={1} fill={PLUM} fillOpacity={fillO} stroke={INK} strokeWidth={3} strokeDasharray={1} strokeDashoffset={1 - d} strokeLinejoin="round" />
        <path d="M70 46 Q84 46 84 56 Q84 66 70 64" pathLength={1} fill="none" stroke={INK} strokeWidth={3} strokeDasharray={1} strokeDashoffset={1 - d} />
        <path d="M38 20 Q34 27 38 32 M48 16 Q44 25 48 32 M58 20 Q54 27 58 32" pathLength={1} fill="none" stroke={INK} strokeWidth={3} strokeLinecap="round" strokeDasharray={1} strokeDashoffset={1 - k(r, 24, 44)} />
      </svg>
      <div style={{ marginTop: 6, fontFamily: MONO, fontSize: 20, color: SOFT, opacity: k(r, 42, 50) }}>logo.svg</div>
    </Center>
  );
}

function Offline({ r }: { r: number }) {
  const cut = k(r, 10, 16);
  const lines = ['Still here.', 'Still thinking.', 'Still yours.'];
  return (
    <Center y={50}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 80, transform: `scale(${pop(r, 6)})` }}>
        <svg width={170} height={150} viewBox="0 0 34 30">
          {[14, 9.5, 5].map((rr, i) => <path key={i} d={`M${17 - rr} ${24 - rr * 0.55} A ${rr} ${rr} 0 0 1 ${17 + rr} ${24 - rr * 0.55}`} stroke={SOFT} strokeWidth={2.6} fill="none" strokeLinecap="round" opacity={1 - cut * 0.7} />)}
          <circle cx={17} cy={24} r={2} fill={SOFT} />
          <line x1={5} y1={4} x2={5 + 24 * cut} y2={4 + 24 * cut} stroke="#ff6b7a" strokeWidth={3} strokeLinecap="round" />
        </svg>
        <div style={{ display: 'grid', gap: 14 }}>
          {lines.map((l, i) => <div key={l} style={{ fontSize: 52, fontWeight: 600, letterSpacing: '-0.03em', color: i === 2 ? PLUM : INK, opacity: k(r, 20 + i * 8, 26 + i * 8), transform: `translateX(${k(r, 20 + i * 8, 28 + i * 8, 30, 0)}px)` }}>{l}</div>)}
        </div>
      </div>
    </Center>
  );
}

function Company({ r }: { r: number }) {
  const up = k(r, 14, 30);
  const blink = (r > 44 && r < 48) || (r > 56 && r < 59);
  return (
    <Center y={30}>
      <div style={{ transform: `translateY(${(1 - up) * 300}px)`, opacity: up }}>
        <div style={{ transform: `rotate(${Math.sin(r / 8) * 2}deg)` }}>
          {blink ? <svg width={240} height={240} viewBox="0 0 32 32"><path d="M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z" fill="#16161c" stroke="#f3e8ee" strokeWidth="2" /><path d="M11 16H13V17H11Z M20 16H22V17H20Z" fill="#fff" /><path d="M15 20H17V21H15Z" fill={ROSE} /></svg>
            : <Cat size={240} eyes={r > 66 ? 'happy' : 'open'} />}
        </div>
      </div>
      <div style={{ marginTop: 20, fontSize: 30, color: SOFT, opacity: k(r, 70, 78), fontStyle: 'italic' }}>…yes.</div>
    </Center>
  );
}

// ─── timeline ──────────────────────────────────────────────────────────────
const Q0 = 210, QL = 4 * B; // first question, 4 beats each
const QS: { q: string; A: (p: { r: number }) => React.ReactElement; len?: number }[] = [
  { q: 'Build my game locally?', A: Game },
  { q: 'Save me API credits?', A: Credits },
  { q: 'Keep my data private?', A: Private },
  { q: 'Use any model I want?', A: Models },
  { q: 'Link my devices on the go?', A: Devices },
  { q: 'Make me a logo?', A: Logo },
  { q: 'Work offline?', A: Offline },
  { q: 'Keep me company?', A: Company, len: 6 * B },
];
const starts = QS.reduce<number[]>((acc, q, i) => [...acc, i === 0 ? Q0 : acc[i - 1] + (QS[i - 1].len ?? QL)], []);
const FLOOD = starts[QS.length - 1] + 6 * B; // 750
const FLOOD_Q = ['Name my cat?', 'Write my tests?', 'Plan my week?', 'Summarise this PDF?', 'Work while I sleep?', 'Fix my CSS?', 'Find that file?', 'Draft my emails?', 'Explain this error?', 'Translate this?', 'Run a whole team?', 'Read my notes?'];
const POS = [[120, 120], [760, 90], [380, 230], [880, 300], [90, 380], [560, 420], [180, 560], [820, 520], [460, 110], [620, 600], [300, 470], [980, 180]];
const END = FLOOD + 4 * B; // collapse

export function WhatIs() {
  const f = useCurrentFrame();
  const fade = Math.min(k(f, 0, 6), 1 - k(f, WHATIS_FRAMES - 12, WHATIS_FRAMES - 1));
  const qi = QS.findIndex((_, i) => f >= starts[i] && f < starts[i] + (QS[i].len ?? QL));
  const company = qi === QS.length - 1;
  return (
    <Th.Provider value={THEMES.dark}>
      <AbsoluteFill style={{ background: PAPER, fontFamily: SANS, color: INK, overflow: 'hidden' }}>
        <style>{fontCss}</style>
        <AbsoluteFill style={{ opacity: fade }}>
          {/* the world inside the cat: wave + content (visible once the splash opens) */}
          {f >= S0 && (
            <AbsoluteFill>
              <Wave f={f} dim={company ? 0.25 : 1} />
              {/* title */}
              {f < Q0 && (
                <Center>
                  <div style={{ opacity: k(f, 128, 140) * (1 - k(f, 186, 194)), transform: `scale(${k(f, 128, 150, 1.12, 1)})`, filter: `blur(${k(f, 128, 140, 10, 0)}px)` }}>
                    <Big style={{ fontSize: 120 }}>What is <span style={{ color: PLUM }}>Nekko Agent?</span></Big>
                  </div>
                  <Bubble f={f} at={188} size={52} style={{ right: 300, top: 300 }}>What can it do for me?</Bubble>
                </Center>
              )}
              {/* questions */}
              {qi >= 0 && (() => {
                const r = f - starts[qi];
                const { q, A } = QS[qi];
                const len = QS[qi].len ?? QL;
                const leave = k(r, len - 5, len);
                return (
                  <AbsoluteFill style={{ opacity: 1 - leave, transform: `translateY(${-leave * 30}px)` }}>
                    {qi > 0 && r < 6 && <div style={{ position: 'absolute', right: 120, top: 70 - r * 12, opacity: 1 - r / 6 }}><div style={{ background: ROSE, color: '#fff', fontSize: 34, padding: '10px 22px', borderRadius: 30, opacity: 0.6 }}>{QS[qi - 1].q}</div></div>}
                    <Bubble f={r} at={0} size={40} style={{ right: 120, top: 70 }}>{q}</Bubble>
                    <div style={{ position: 'absolute', left: 60, top: 82, fontFamily: MONO, fontSize: 16, color: SOFT, opacity: k(r, 4, 10) }}>{String(qi + 1).padStart(2, '0')} / {String(QS.length).padStart(2, '0')}</div>
                    <A r={r} />
                  </AbsoluteFill>
                );
              })()}
              {/* flood and collapse */}
              {f >= FLOOD && f < END + 12 && FLOOD_Q.map((q, i) => {
                const at = FLOOD + Math.floor(i / 3) * B + (i % 3) * 4;
                const col = k(f, END, END + 10, 0, 1, Easing.in(Easing.cubic));
                const [x, y] = POS[i];
                return (
                  <div key={q} style={{ position: 'absolute', left: x + (560 - x) * col, top: y + (330 - y) * col, transform: `scale(${1 - col * 0.9})`, opacity: 1 - col }}>
                    <Bubble f={f} at={at} size={28} style={{ position: 'relative' }}>{q}</Bubble>
                  </div>
                );
              })}
              {f >= END + 6 && (
                <Center>
                  <svg width={200} height={180} viewBox="2 0 20 18" style={{ transform: `scale(${pop(f, END + 6)})`, filter: `drop-shadow(0 0 ${30 * (1 - k(f, END + 10, END + 40))}px ${PLUM})` }}><path d={BRAND_HEAD} fill="#fff" fillRule="evenodd" /></svg>
                  <div style={{ marginTop: 34, opacity: k(f, END + 14, END + 24), transform: `translateY(${k(f, END + 14, END + 24, 20, 0)}px)` }}><Big style={{ fontSize: 96 }}>Nekko Agent</Big></div>
                  <div style={{ marginTop: 20, fontSize: 30, color: SOFT, opacity: k(f, END + 28, END + 38) }}>Ask it anything. It runs on your Mac.</div>
                </Center>
              )}
            </AbsoluteFill>
          )}
          {f < S0 + 8 && <AbsoluteFill style={{ opacity: f < S0 ? 1 : 1 - k(f, S0, S0 + 8) }}><Desktop f={f} /></AbsoluteFill>}
          <Splash f={f} />
        </AbsoluteFill>
        <div style={{ position: 'absolute', right: 40, top: 40, fontFamily: MONO, fontSize: 15, color: '#6c6a78', border: '1px solid #26262f', borderRadius: 8, padding: '4px 10px', background: PAPER }}>Concept</div>
      </AbsoluteFill>
    </Th.Provider>
  );
}
