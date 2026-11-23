// C1 to C5: game assets from one chat. The generated assets carry their own
// colours (a game's palette, not the app's); everything around them is app tokens.
import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { AppWindow, Bar, Bubble, Check, Composer, Dot, Footer, Headline, In, Label, MONO, Status, Travel, clamp, p, typed, useInfo, useT } from './ckit';

// ─── pixel fox ──────────────────────────────────────────────────────────────
export const FOX_BODY = [
  '..........k...k.',
  '..........oo.oo.',
  '..........ooooo.',
  'ww........okoko.',
  'owo.......oooooo',
  '.ooo......oowwwk',
  '..ooooooooooww..',
  '...ooooooooooo..',
  '...ooowwwwwooo..',
];
export const LEGS = {
  idle: ['....k.k...k.k...', '....k.k...k.k...'],
  r0: ['...k......k.k...', '..k.......k..k..'],
  r1: ['....k.....k.k...', '....k.....k.k...'],
  r2: ['.....k.k...k....', '.....k.k....k...'],
  r3: ['....k.k....k....', '...k...k...k....'],
  r4: ['...k..k...k.....', '..k...k...k.....'],
  r5: ['....k.k...k.k...', '....k.k...k.k...'],
};
export const FOX_COL: Record<string, string> = { o: '#e2803c', w: '#f4ece0', k: '#2b211c' };
export type FoxFrame = { legs: keyof typeof LEGS; dy: number };
export const IDLE: FoxFrame[] = [{ legs: 'idle', dy: 0 }, { legs: 'idle', dy: 0 }, { legs: 'idle', dy: 1 }, { legs: 'idle', dy: 1 }];
export const RUN: FoxFrame[] = [{ legs: 'r0', dy: 0 }, { legs: 'r1', dy: 1 }, { legs: 'r2', dy: 0 }, { legs: 'r3', dy: 0 }, { legs: 'r4', dy: 1 }, { legs: 'r5', dy: 0 }];
export function Fox({ frame, px }: { frame: FoxFrame; px: number }) {
  const rows = [...FOX_BODY, ...LEGS[frame.legs]];
  return (
    <svg width={16 * px} height={13 * px} viewBox="0 0 16 13" shapeRendering="crispEdges">
      {rows.flatMap((r, y) => r.split('').map((c, x) => (c === '.' ? null : <rect key={`${x}-${y}`} x={x} y={y + (y < FOX_BODY.length ? frame.dy : 0) - 1 + 1} width={1} height={1} fill={FOX_COL[c]} />)))}
    </svg>
  );
}

function Chat({ prompt, reply, w = 520, h = 560 }: { prompt: string; reply: string; w?: number; h?: number }) {
  const t = useT();
  const f = useCurrentFrame();
  return (
    <AppWindow x={60} y={96} w={w} h={h} title="Game assets">
      {f >= 54 && (
        <div style={{ position: 'absolute', left: 24, right: 24, top: 24, opacity: p(f, 54, 62) }}>
          <Bubble>{prompt}</Bubble>
          <div style={{ fontSize: 16, color: t.faint, marginTop: 20 }}>Nekko Agent · local sub-agents</div>
          <div style={{ fontSize: 20, lineHeight: '30px', marginTop: 8 }}>{typed(f, 64, 120, reply)}</div>
        </div>
      )}
      <div style={{ position: 'absolute', left: 20, right: 20, bottom: 20 }}>
        <Composer text={f > 12 && f < 54 ? typed(f, 12, 48, prompt) : ''} model="Qwen3-32B · Local" caret={f > 12 && f < 54} />
      </div>
    </AppWindow>
  );
}

// ─── C1 Sprites ─────────────────────────────────────────────────────────────
export function C1() {
  const t = useT();
  const f = useCurrentFrame();
  const START = 100;
  const all = [...IDLE.map((x) => ({ ...x, set: 'idle' })), ...RUN.map((x) => ({ ...x, set: 'run' }))];
  const tick = Math.floor(f / 3);
  const mode = f < 190 ? 'idle' : 'run';
  const seq = mode === 'idle' ? IDLE : RUN;
  const cur = seq[tick % seq.length];
  const curIdx = mode === 'idle' ? tick % 4 : 4 + (tick % 6);
  return (
    <>
      <Headline>Your game's assets. One chat.</Headline>
      <In at={4}><Chat prompt="A fox character, idle and run cycle" reply="Done: 10 frames, 16 × 13 px, on one sheet. fox.png is in your assets folder." /></In>
      <In at={START - 8} style={{ position: 'absolute', left: 640, top: 96 }}><Label>fox.png</Label></In>
      <div style={{ position: 'absolute', left: 640, top: 140, display: 'flex', gap: 6, flexWrap: 'wrap', width: 590 }}>
        {all.map((fr, i) => (
          <In key={i} at={START + i * 5} dur={8}>
            <div style={{ width: 52, height: 52, borderRadius: 8, background: f > 150 && i === curIdx ? t.accentSoft : t.surface, border: `1px solid ${f > 150 && i === curIdx ? t.accent : t.line}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Fox frame={fr} px={3} />
            </div>
          </In>
        ))}
      </div>
      <In at={START + 6} style={{ position: 'absolute', left: 640, top: 208, fontFamily: MONO, fontSize: 14, color: t.faint, display: 'flex', gap: 158 }}><span>idle · 4</span><span>run · 6</span></In>
      <In at={150}>
        <div style={{ position: 'absolute', left: 640, top: 260, width: 580, height: 300, borderRadius: 14, background: t.codeBg, border: `1px solid ${t.line}`, overflow: 'hidden' }}>
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 60, height: 2, background: t.line }} />
          <div style={{ position: 'absolute', left: 210, bottom: 62 }}><Fox frame={cur} px={10} /></div>
          {mode === 'run' && [0, 1, 2, 3].map((k) => (
            <div key={k} style={{ position: 'absolute', bottom: 40, height: 4, width: 30, borderRadius: 2, background: t.surface2, left: ((k * 160 - (f - 190) * 9) % 640 + 640) % 640 - 30 }} />
          ))}
          <div style={{ position: 'absolute', left: 20, top: 16, fontFamily: MONO, fontSize: 15, color: t.soft }}>preview · {mode} · 10 fps</div>
        </div>
      </In>
      <Footer left="Sprite sub-agent · pixel model on this computer" right="" />
    </>
  );
}

// ─── C2 2D asset set ────────────────────────────────────────────────────────
function rnd(i: number) { return ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1; }
export function Tile({ base, speck, seed, size = 64 }: { base: string; speck: string; seed: number; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" shapeRendering="crispEdges">
      <rect width="8" height="8" fill={base} />
      {Array.from({ length: 9 }, (_, i) => <rect key={i} x={Math.floor(rnd(seed + i) * 8)} y={Math.floor(rnd(seed + i + 50) * 8)} width="1" height="1" fill={speck} />)}
    </svg>
  );
}
export const TILES = [
  { name: 'grass', base: '#4f8a3c', speck: '#6fae4f' },
  { name: 'dirt', base: '#7a5236', speck: '#5e3d27' },
  { name: 'water', base: '#2f6f9a', speck: '#5b9bc4' },
  { name: 'stone', base: '#6c6a72', speck: '#8b8992' },
];
export const ITEM_SVG: Record<string, React.ReactNode> = {
  coin: <><circle cx="12" cy="12" r="8" fill="#e5b83a" /><circle cx="12" cy="12" r="5" fill="none" stroke="#b98a1e" strokeWidth="1.5" /></>,
  key: <><circle cx="8" cy="12" r="4" fill="none" stroke="#e5b83a" strokeWidth="2.5" /><path d="M12 12 H21 M18 12 V16 M21 12 V15" stroke="#e5b83a" strokeWidth="2.5" /></>,
  potion: <><path d="M10 3 H14 V8 L18 15 Q19 20 12 20 Q5 20 6 15 L10 8 Z" fill="#9b4bc0" /><path d="M10 3 H14" stroke="#e8e0f0" strokeWidth="2" /></>,
  heart: <path d="M12 20 L4 12 Q2 8 6 6 Q10 5 12 9 Q14 5 18 6 Q22 8 20 12 Z" fill="#d9434e" />,
};
export function C2() {
  const t = useT();
  const f = useCurrentFrame();
  const groups = [
    { label: 'Tiles', at: 100 },
    { label: 'Items', at: 130 },
    { label: 'UI', at: 160 },
  ];
  const sceneAt = 196;
  return (
    <>
      <Headline>Your game's assets. One chat.</Headline>
      <In at={4}><Chat prompt="Tiles, items and UI for a meadow scene" reply="One palette, three sets: 4 tiles, 4 items, a button and a health bar." /></In>
      <div style={{ position: 'absolute', left: 640, top: 96, width: 580 }}>
        <In at={groups[0].at - 6}><Label>Tiles</Label></In>
        <div style={{ display: 'flex', gap: 14, marginTop: 10 }}>
          {TILES.map((tl, i) => <In key={tl.name} at={groups[0].at + i * 5}><div style={{ textAlign: 'center' }}><div style={{ borderRadius: 6, overflow: 'hidden', height: 64 }}><Tile base={tl.base} speck={tl.speck} seed={i * 7} /></div><div style={{ fontFamily: MONO, fontSize: 13, color: t.faint, marginTop: 6 }}>{tl.name}</div></div></In>)}
        </div>
        <In at={groups[1].at - 6}><Label style={{ marginTop: 20 }}>Items</Label></In>
        <div style={{ display: 'flex', gap: 14, marginTop: 10 }}>
          {Object.entries(ITEM_SVG).map(([n, s], i) => (
            <In key={n} at={groups[1].at + i * 5}><div style={{ textAlign: 'center' }}><div style={{ width: 64, height: 64, borderRadius: 8, background: t.surface, border: `1px solid ${t.line}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width={40} height={40} viewBox="0 0 24 24">{s}</svg></div><div style={{ fontFamily: MONO, fontSize: 13, color: t.faint, marginTop: 6 }}>{n}</div></div></In>
          ))}
        </div>
        <In at={groups[2].at - 6}><Label style={{ marginTop: 20 }}>UI</Label></In>
        <div style={{ display: 'flex', gap: 24, alignItems: 'center', marginTop: 10 }}>
          <In at={groups[2].at}><div style={{ padding: '8px 22px', background: '#e5b83a', color: '#3a2a0a', fontFamily: MONO, fontWeight: 700, fontSize: 18, borderRadius: 4, boxShadow: '0 4px 0 #b98a1e' }}>PLAY</div></In>
          <In at={groups[2].at + 6}><div style={{ display: 'flex', gap: 4 }}>{[0, 1, 2, 3, 4].map((i) => <div key={i} style={{ width: 22, height: 14, background: i < 3 ? '#d9434e' : '#4a2a2e', borderRadius: 2 }} />)}</div></In>
        </div>
      </div>
      {f >= sceneAt && (
        <div style={{ position: 'absolute', left: 640, top: 520, width: 580, height: 128, borderRadius: 12, overflow: 'hidden', border: `1px solid ${t.line}`, opacity: p(f, sceneAt, sceneAt + 12), background: '#9fd0e8' }}>
          <div style={{ position: 'absolute', left: 0, bottom: 0, display: 'flex' }}>
            {Array.from({ length: 10 }, (_, i) => <div key={i}><Tile {...TILES[i === 4 || i === 5 ? 2 : 0]} seed={i} size={58} /><Tile {...TILES[i === 4 || i === 5 ? 2 : 1]} seed={i + 30} size={58} /></div>)}
          </div>
          <svg style={{ position: 'absolute', left: 140, top: 18 }} width={28} height={28} viewBox="0 0 24 24">{ITEM_SVG.coin}</svg>
          <svg style={{ position: 'absolute', left: 420, top: 26 }} width={28} height={28} viewBox="0 0 24 24">{ITEM_SVG.potion}</svg>
          <div style={{ position: 'absolute', right: 12, top: 10, display: 'flex', gap: 3 }}>{[0, 1, 2, 3, 4].map((i) => <div key={i} style={{ width: 12, height: 8, background: i < 3 ? '#d9434e' : '#4a2a2e' }} />)}</div>
          <div style={{ position: 'absolute', left: 40, bottom: 58 }}><Fox frame={{ legs: 'idle', dy: 0 }} px={3} /></div>
        </div>
      )}
      <Footer left="Asset sub-agent · on this computer" right="" />
    </>
  );
}

// ─── C3 3D asset ────────────────────────────────────────────────────────────
export type V = [number, number, number];
export const CHEST_V: V[] = [
  [-1, 0, -0.6], [1, 0, -0.6], [1, 0, 0.6], [-1, 0, 0.6], // 0-3 base bottom
  [-1, 1, -0.6], [1, 1, -0.6], [1, 1, 0.6], [-1, 1, 0.6], // 4-7 base top
  [-1, 1.5, -0.25], [1, 1.5, -0.25], [1, 1.5, 0.25], [-1, 1.5, 0.25], // 8-11 lid top
  [-0.18, 0.55, 0.62], [0.18, 0.55, 0.62], [0.18, 0.95, 0.62], [-0.18, 0.95, 0.62], // 12-15 lock
];
export const CHEST_F: { v: number[]; c: string }[] = [
  { v: [3, 2, 6, 7], c: '#8a5a3b' }, { v: [1, 0, 4, 5], c: '#8a5a3b' }, { v: [2, 1, 5, 6], c: '#7a4e33' }, { v: [0, 3, 7, 4], c: '#7a4e33' },
  { v: [7, 6, 10, 11], c: '#9a6644' }, { v: [5, 4, 8, 9], c: '#9a6644' }, { v: [6, 5, 9, 10], c: '#87583a' }, { v: [4, 7, 11, 8], c: '#87583a' },
  { v: [11, 10, 9, 8], c: '#a8724c' }, { v: [12, 13, 14, 15], c: '#d8a942' },
];
export function C3() {
  const t = useT();
  const f = useCurrentFrame();
  const th = f * 0.028 + 0.6;
  const tilt = 0.42;
  const proj = ([x, y, z]: V) => {
    const x1 = x * Math.cos(th) + z * Math.sin(th);
    const z1 = -x * Math.sin(th) + z * Math.cos(th);
    const y2 = (y - 0.75) * Math.cos(tilt) - z1 * Math.sin(tilt);
    const z2 = (y - 0.75) * Math.sin(tilt) + z1 * Math.cos(tilt);
    return { x: 300 + x1 * 140, y: 230 - y2 * 140, z: z2 };
  };
  const pts = CHEST_V.map(proj);
  const solid = p(f, 140, 170);
  const wire = p(f, 96, 136);
  const faces = CHEST_F.map((fc) => {
    const ps = fc.v.map((i) => pts[i]);
    const ax = ps[1].x - ps[0].x, ay = ps[1].y - ps[0].y, bx = ps[2].x - ps[0].x, by = ps[2].y - ps[0].y;
    const facing = ax * by - ay * bx; // screen-space winding: > 0 faces away
    return { ...fc, ps, depth: ps.reduce((s, q) => s + q.z, 0) / ps.length, facing };
  }).sort((a, b) => a.depth - b.depth);
  return (
    <>
      <Headline>Your game's assets. One chat.</Headline>
      <In at={4}><Chat prompt="A low-poly treasure chest" reply="Here's chest.glb: 10 faces, flat colours, ready for your engine." /></In>
      <In at={90} style={{ position: 'absolute', left: 640, top: 96 }}><Label>chest.glb</Label></In>
      <In at={90}>
        <div style={{ position: 'absolute', left: 640, top: 140, width: 580, height: 440, borderRadius: 14, background: t.codeBg, border: `1px solid ${t.line}` }}>
          <svg width={580} height={440} viewBox="0 20 600 440">
            <ellipse cx="300" cy="352" rx="170" ry="26" fill={t.surface2} opacity={solid} />
            {faces.map((fc, i) => (
              <polygon key={i} points={fc.ps.map((q) => `${q.x},${q.y}`).join(' ')} fill={fc.c} fillOpacity={solid} stroke={solid > 0.5 ? '#3b2617' : t.accent} strokeOpacity={solid > 0.5 ? 0.7 : wire} strokeWidth={solid > 0.5 ? 1.5 : 1.2} strokeLinejoin="round" />
            ))}
          </svg>
          <div style={{ position: 'absolute', left: 20, top: 16, fontFamily: MONO, fontSize: 15, color: t.soft }}>{solid > 0 ? 'shaded · turntable' : wire > 0 ? 'building mesh…' : ''}</div>
        </div>
      </In>
      {f > 176 && <div style={{ position: 'absolute', left: 640, top: 600, display: 'flex', gap: 24, fontFamily: MONO, fontSize: 16, color: t.faint, opacity: p(f, 176, 186) }}><span>10 faces</span><span>3 materials</span><span>48 KB</span></div>}
      <Footer left="3D sub-agent · on this computer" />
    </>
  );
}

// ─── C4 Audio ───────────────────────────────────────────────────────────────
export const SFX = [
  { name: 'jump', dur: '0.32 s', env: (x: number) => Math.sin(x * Math.PI) ** 0.6 * (0.9 - x * 0.4), wob: 0.25 },
  { name: 'coin', dur: '0.41 s', env: (x: number) => (x < 0.35 ? Math.exp(-x * 9) : 0.85 * Math.exp(-(x - 0.35) * 5)), wob: 0.15 },
  { name: 'hit', dur: '0.18 s', env: (x: number) => Math.exp(-x * 5.5), wob: 0.7 },
];
export function C4() {
  const t = useT();
  const f = useCurrentFrame();
  const N = 72;
  return (
    <>
      <Headline>Your game's assets. One chat.</Headline>
      <In at={4}><Chat prompt="Jump, coin and hit sounds, 8-bit style" reply="Three sounds, 44.1 kHz WAV, matched loudness. They're in sfx/." /></In>
      {SFX.map((s, i) => {
        const a = 100 + i * 26;
        const draw = interpolate(f, [a, a + 30], [0, N], clamp);
        const play = interpolate(f, [190 + i * 22, 190 + i * 22 + 18], [0, 1], clamp);
        const playing = play > 0 && play < 1;
        return (
          <In key={s.name} at={a - 6}>
            <div style={{ position: 'absolute', left: 640, top: 110 + i * 172, width: 580 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                <span style={{ fontSize: 22, fontWeight: 500 }}>{s.name}.wav</span>
                <span style={{ fontFamily: MONO, fontSize: 16, color: t.faint }}>{s.dur}</span>
                <span style={{ marginLeft: 'auto', fontSize: 17, color: playing ? t.accent : t.faint }}>{playing ? '▶ playing' : play >= 1 ? '' : ''}</span>
              </div>
              <div style={{ position: 'relative', marginTop: 12, height: 96, display: 'flex', alignItems: 'center', gap: 3 }}>
                {Array.from({ length: N }, (_, k) => {
                  const x = k / N;
                  const amp = s.env(x) * (0.55 + 0.45 * Math.abs(Math.sin(k * (1.7 + s.wob * 3) + i)));
                  const on = k < draw;
                  return <div key={k} style={{ width: 5, borderRadius: 2, height: on ? Math.max(3, amp * 92) : 3, background: x < play ? t.accent : on ? t.soft : t.surface2 }} />;
                })}
                {playing && <div style={{ position: 'absolute', top: -4, bottom: -4, left: `${play * 100}%`, width: 2, background: t.accent }} />}
              </div>
            </div>
          </In>
        );
      })}
      <Footer left="Audio sub-agent · on this computer" right="" />
    </>
  );
}

// ─── C5 Full pipeline ───────────────────────────────────────────────────────
const SUBS = [
  { name: 'Sprites', model: 'pixel model', files: ['fox.png', 'owl.png'] },
  { name: 'Tiles', model: 'pixel model', files: ['forest-tiles.png'] },
  { name: '3D', model: 'mesh model', files: ['log.glb', 'stump.glb'] },
  { name: 'Audio', model: 'sound model', files: ['birds.wav', 'step.wav'] },
];
export function C5() {
  const t = useT();
  const f = useCurrentFrame();
  const info = useInfo();
  const MAIN = { x: 290, y: 380 };
  const subY = (i: number) => 170 + i * 120;
  const SUBX = 520, FOLDX = 940;
  const fan = 78;
  const done = (i: number) => fan + 30 + 70 + i * 14;
  const files = SUBS.flatMap((s, i) => s.files.map((n) => ({ n, at: done(i) + 16 })));
  return (
    <>
      <Headline>Your game's assets. One chat.</Headline>
      <In at={6}>
        <div style={{ position: 'absolute', left: 60, top: 110, width: 380 }}>
          <Bubble style={{ marginLeft: 0 }}>{typed(f, 10, 44, 'Make me assets for a forest level')}</Bubble>
        </div>
      </In>
      <In at={50}>
        <div style={{ position: 'absolute', left: 60, top: MAIN.y - 40, width: 300 }}>
          <div style={{ fontSize: 16, color: t.faint }}>Main agent</div>
          <div style={{ fontSize: 24, fontWeight: 600, marginTop: 4 }}>Qwen3-32B</div>
          <div style={{ fontSize: 17, color: t.soft, marginTop: 4 }}>{f < fan ? 'Planning…' : f < done(3) + 16 ? 'Waiting on 4 sub-agents' : 'Collected 7 files'}</div>
        </div>
      </In>
      {SUBS.map((s, i) => {
        const y = subY(i);
        const prog = interpolate(f, [fan + 30 + i * 6, done(i)], [0, 1], clamp);
        return (
          <React.Fragment key={s.name}>
            <svg style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }} width={1} height={1}>
              <path d={`M${MAIN.x} ${MAIN.y} C ${MAIN.x + 120} ${MAIN.y}, ${SUBX - 120} ${y}, ${SUBX - 16} ${y}`} stroke={t.line} strokeWidth={1.5} fill="none" opacity={p(f, fan, fan + 12)} />
              <path d={`M${SUBX + 300} ${y} C ${SUBX + 360} ${y}, ${FOLDX - 80} 380, ${FOLDX - 16} 380`} stroke={t.line} strokeWidth={1.5} fill="none" opacity={p(f, done(i), done(i) + 10)} />
            </svg>
            <Travel x1={MAIN.x} y1={MAIN.y} x2={SUBX - 16} y2={y} a={fan + i * 5} b={fan + 24 + i * 5} color={t.accent} />
            <Travel x1={SUBX + 300} y1={y} x2={FOLDX - 16} y2={380} a={done(i)} b={done(i) + 18} color={info} />
            <In at={fan + 20 + i * 5}>
              <div style={{ position: 'absolute', left: SUBX, top: y - 34, width: 280 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <span style={{ fontSize: 22, fontWeight: 600 }}>{s.name}</span>
                  <span style={{ fontSize: 16, color: t.faint }}>{s.model} · local</span>
                </div>
                <Bar v={prog} style={{ marginTop: 10 }} />
                <div style={{ marginTop: 8 }}><Status done={prog >= 1} /></div>
              </div>
            </In>
          </React.Fragment>
        );
      })}
      <In at={fan + 40}>
        <div style={{ position: 'absolute', left: FOLDX, top: 300, width: 280 }}>
          <div style={{ fontSize: 22, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 10 }}>
            <svg width="22" height="18" viewBox="0 0 22 18" fill="none"><path d="M1 3 Q1 1 3 1 H8 L10 3 H19 Q21 3 21 5 V15 Q21 17 19 17 H3 Q1 17 1 15 Z" stroke={t.soft} strokeWidth="1.6" /></svg>
            forest-level/
          </div>
          <div style={{ marginTop: 10, fontFamily: MONO, fontSize: 16, lineHeight: '28px' }}>
            {files.map((x) => f >= x.at && <div key={x.n} style={{ opacity: p(f, x.at, x.at + 8), display: 'flex', alignItems: 'center', gap: 10 }}><Dot color={t.ok} />{x.n}</div>)}
          </div>
        </div>
      </In>
      {f > done(3) + 30 && <div style={{ position: 'absolute', left: 60, top: 600, display: 'flex', gap: 10, alignItems: 'center', fontSize: 20, opacity: p(f, done(3) + 30, done(3) + 40) }}><Check color={t.ok} /> One folder, back in your chat.</div>}
      <Footer left="Main agent + 4 local sub-agents" right="" />
    </>
  );
}
