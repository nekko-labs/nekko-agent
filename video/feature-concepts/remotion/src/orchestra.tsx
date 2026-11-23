// C6: one paid model plans, four local sub-agents make, and we watch each one's work appear.
// Left: the request and the main agent (Opus 5.5, petrol = frontier). Right: four live sub-agent cards.
// Then the cards fold into one assembled level preview.
import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { Bubble, Check, Dot, Footer, Headline, In, MONO, Travel, clamp, p, typed, useInfo, useT } from './ckit';
import { CHEST_F, CHEST_V, Fox, IDLE, RUN, SFX, TILES, Tile, type V } from './game';

export const C6_FRAMES = 420;
const MAIN = { x: 400, y: 330 };
const GX = 480, GY = 96, CW = 360, CH = 248, GAP = 20;
const cardPos = (i: number) => ({ x: GX + (i % 2) * (CW + GAP), y: GY + Math.floor(i / 2) * (CH + GAP) });
const SUBS = [
  { name: 'Sprites', model: 'pixel model', brief: 'Fox hero, idle + run', file: 'fox.png' },
  { name: 'Tiles', model: 'pixel model', brief: '8 forest tiles', file: 'forest-tiles.png' },
  { name: '3D', model: 'mesh model', brief: 'Low-poly chest', file: 'chest.glb' },
  { name: 'Audio', model: 'sound model', brief: 'Jump, coin, hit', file: 'sfx/' },
];
const SEND = 92;                     // briefs leave the main agent
const start = (i: number) => SEND + 22 + i * 6;
const DONE = [196, 188, 214, 222];   // each sub-agent finishes
const BACK = 236;                    // all four back by here
const FOLD = 268;                    // cards fold into the level

function Chest({ cx, cy, s, th, solid, wire }: { cx: number; cy: number; s: number; th: number; solid: number; wire: number }) {
  const t = useT();
  const tilt = 0.42;
  const pts = CHEST_V.map(([x, y, z]: V) => {
    const x1 = x * Math.cos(th) + z * Math.sin(th);
    const z1 = -x * Math.sin(th) + z * Math.cos(th);
    const y2 = (y - 0.75) * Math.cos(tilt) - z1 * Math.sin(tilt);
    const z2 = (y - 0.75) * Math.sin(tilt) + z1 * Math.cos(tilt);
    return { x: cx + x1 * s, y: cy - y2 * s, z: z2 };
  });
  const faces = CHEST_F.map((fc) => {
    const ps = fc.v.map((i) => pts[i]);
    return { ...fc, ps, depth: ps.reduce((a, q) => a + q.z, 0) / ps.length };
  }).sort((a, b) => a.depth - b.depth);
  return (
    <>
      {faces.map((fc, i) => (
        <polygon key={i} points={fc.ps.map((q) => `${q.x},${q.y}`).join(' ')} fill={fc.c} fillOpacity={solid}
          stroke={solid > 0.5 ? '#3b2617' : t.accent} strokeOpacity={solid > 0.5 ? 0.7 : wire} strokeWidth={1.3} strokeLinejoin="round" />
      ))}
    </>
  );
}

/** The thing each sub-agent is making, drawn live inside its card (360 x ~170). */
function Work({ i, f }: { i: number; f: number }) {
  const t = useT();
  const a = start(i) + 10, d = DONE[i];
  if (i === 0) {
    // sprite sheet fills cell by cell, then the fox runs in the preview
    const cells = Math.floor(interpolate(f, [a, d - 24], [0, 10], clamp));
    const frames = [...IDLE, ...RUN];
    const run = f >= d - 20;
    return (
      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 34px)', gap: 3 }}>
          {frames.map((fr, k) => (
            <div key={k} style={{ width: 34, height: 30, borderRadius: 4, background: t.surface2, display: 'grid', placeItems: 'center', outline: run && k === 4 + (Math.floor(f / 3) % 6) ? `1.5px solid ${t.accent}` : 'none' }}>
              {k < cells && <Fox frame={fr} px={2} />}
            </div>
          ))}
        </div>
        <div style={{ width: 120, height: 110, borderRadius: 8, background: t.surface2, position: 'relative', overflow: 'hidden' }}>
          {run && <>
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 14, height: 2, background: '#4f8a3c' }} />
            <div style={{ position: 'absolute', left: 28, bottom: 16 }}><Fox frame={RUN[Math.floor(f / 3) % 6]} px={4} /></div>
          </>}
          {!run && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontFamily: MONO, fontSize: 13, color: t.faint }}>drawing…</div>}
        </div>
      </div>
    );
  }
  if (i === 1) {
    const n = Math.floor(interpolate(f, [a, d], [0, 8], clamp));
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 62px)', gap: 6 }}>
        {Array.from({ length: 8 }, (_, k) => {
          const tl = TILES[k % 4];
          return <div key={k} style={{ width: 62, height: 62, borderRadius: 6, overflow: 'hidden', background: t.surface2, transform: `scale(${k < n ? 1 : 0.85})`, opacity: k < n ? 1 : 0.6 }}>{k < n && <Tile base={tl.base} speck={tl.speck} seed={k * 7 + 3} size={62} />}</div>;
        })}
      </div>
    );
  }
  if (i === 2) {
    const wire = p(f, a, a + 40), solid = p(f, d - 30, d);
    return (
      <svg width={330} height={160} viewBox="0 0 330 160">
        <ellipse cx="165" cy="138" rx="90" ry="12" fill={t.surface2} opacity={solid} />
        <Chest cx={165} cy={84} s={72} th={f * 0.03} solid={solid} wire={wire} />
      </svg>
    );
  }
  // audio: three waveforms draw, then play in turn
  const N = 46;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {SFX.map((s, j) => {
        const draw = interpolate(f, [a + j * 14, a + j * 14 + 30], [0, N], clamp);
        const pa = d - 6 + j * 18;
        const play = interpolate(f, [pa, pa + 16], [0, 1], clamp);
        return (
          <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 44, fontFamily: MONO, fontSize: 13, color: play > 0 && play < 1 ? t.accent : t.faint }}>{s.name}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2, height: 40 }}>
              {Array.from({ length: N }, (_, k) => {
                const x = k / N;
                const amp = s.env(x) * (0.55 + 0.45 * Math.abs(Math.sin(k * (1.7 + s.wob * 3) + j)));
                return <div key={k} style={{ width: 4, borderRadius: 2, height: k < draw ? Math.max(3, amp * 38) : 3, background: x < play ? t.accent : k < draw ? t.soft : t.surface2 }} />;
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Card({ i, f }: { i: number; f: number }) {
  const t = useT();
  const { x, y } = cardPos(i);
  const s = SUBS[i];
  const done = f >= DONE[i];
  const fold = p(f, FOLD, FOLD + 18);
  return (
    <In at={start(i)}>
      <div style={{ position: 'absolute', left: x, top: y, width: CW, height: CH, borderRadius: 14, background: t.surface, border: `1px solid ${done ? t.line : t.accent}`,
        boxShadow: done ? 'none' : `0 0 0 3px ${t.accentSoft}`, padding: '14px 16px', opacity: 1 - fold, transform: `scale(${1 - fold * 0.1})` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Dot color={done ? t.ok : t.accent} pulse={done ? 0 : 1} />
          <span style={{ fontSize: 19, fontWeight: 600 }}>{s.name}</span>
          <span style={{ fontSize: 14, color: t.faint }}>{s.model} · on your Mac</span>
        </div>
        <div style={{ fontSize: 15, color: t.soft, marginTop: 4 }}>{s.brief}</div>
        <div style={{ position: 'absolute', left: 16, right: 16, top: 70, bottom: 34, display: 'grid', placeItems: 'center' }}><Work i={i} f={f} /></div>
        <div style={{ position: 'absolute', left: 16, bottom: 12, fontFamily: MONO, fontSize: 13, color: done ? t.ok : t.faint }}>{done ? `✓ ${s.file}` : 'working…'}</div>
      </div>
    </In>
  );
}

/** The assembled level: tiles as ground, the chest on it, the fox running across. */
function Level({ f }: { f: number }) {
  const t = useT();
  const o = p(f, FOLD + 8, FOLD + 26);
  const w = 740, h = 516;
  const foxX = interpolate(f, [FOLD + 20, 360], [-80, 380], clamp);
  const stopped = f >= 360;
  return (
    <div style={{ position: 'absolute', left: GX, top: GY, width: w, height: h, borderRadius: 14, overflow: 'hidden', opacity: o, transform: `scale(${0.94 + 0.06 * o})`, border: `1px solid ${t.line}`,
      background: 'linear-gradient(#1d3b4a, #3d6b5a)' }}>
      <div style={{ position: 'absolute', left: 16, top: 12, fontFamily: MONO, fontSize: 14, color: '#e6efe9', opacity: 0.85 }}>forest-level · preview</div>
      {/* trees */}
      {[60, 210, 420, 600].map((x, k) => (
        <svg key={k} style={{ position: 'absolute', left: x, bottom: 160 }} width="90" height="170" viewBox="0 0 9 17" shapeRendering="crispEdges">
          <rect x="4" y="12" width="1" height="5" fill="#5e3d27" /><rect x="1" y="6" width="7" height="6" fill="#2f5e33" /><rect x="2" y="2" width="5" height="5" fill="#3b7340" /><rect x="3" y="0" width="3" height="2" fill="#4f8a3c" />
        </svg>
      ))}
      {/* ground of generated tiles */}
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, display: 'flex', flexWrap: 'wrap', width: w + 64 }}>
        {Array.from({ length: 24 }, (_, k) => {
          const tl = k < 12 ? TILES[0] : TILES[k % 3 === 0 ? 3 : 1];
          return <Tile key={k} base={tl.base} speck={tl.speck} seed={k * 5} size={64} />;
        })}
      </div>
      <svg style={{ position: 'absolute', left: 470, bottom: 100 }} width={200} height={140} viewBox="0 0 200 140">
        <Chest cx={100} cy={70} s={56} th={0.7} solid={1} wire={1} />
      </svg>
      <div style={{ position: 'absolute', left: foxX, bottom: 124 }}><Fox frame={stopped ? IDLE[Math.floor(f / 6) % 4] : RUN[Math.floor(f / 3) % 6]} px={6} /></div>
      {/* step sounds */}
      {Array.from({ length: 6 }, (_, k) => {
        const at = FOLD + 34 + k * 14;
        const q = interpolate(f, [at, at + 14], [0, 1], clamp);
        return q > 0 && q < 1 ? <div key={k} style={{ position: 'absolute', left: interpolate(at, [FOLD + 20, 360], [-80, 380], clamp) + 40, bottom: 120 + q * 50, fontFamily: MONO, fontSize: 18, color: '#f4ece0', opacity: 1 - q }}>♪</div> : null;
      })}
    </div>
  );
}

export function C6() {
  const t = useT();
  const f = useCurrentFrame();
  const info = useInfo();
  const back = f >= BACK;
  return (
    <>
      <Headline>One plans. Four make.</Headline>
      <In at={6}>
        <div style={{ position: 'absolute', left: 60, top: 96, width: 380 }}>
          <Bubble style={{ marginLeft: 0 }}>{typed(f, 8, 46, 'Make a forest level: a hero, tiles, a chest and sounds')}</Bubble>
        </div>
      </In>
      <In at={50}>
        <div style={{ position: 'absolute', left: 60, top: 230, width: 360, borderRadius: 14, border: `1px solid ${info}`, padding: '14px 16px', background: t.surface }}>
          <div style={{ fontSize: 14, color: t.faint }}>Main agent · cloud</div>
          <div style={{ fontSize: 24, fontWeight: 600, marginTop: 2, color: info }}>Opus 5.5</div>
          <div style={{ fontSize: 16, color: t.soft, marginTop: 4 }}>
            {f < SEND ? 'Planning the level…' : !back ? 'Sent 4 briefs. Waiting.' : f < FOLD ? 'Checked 4 results' : 'Put the level together'}
          </div>
          <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
            {SUBS.map((s, i) => (
              <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, opacity: p(f, 60 + i * 6, 68 + i * 6) }}>
                {f >= DONE[i] + 14 ? <Check size={15} color={t.ok} /> : <Dot color={f >= SEND ? t.accent : t.faint} />}
                <span style={{ color: t.ink }}>{s.name}</span><span style={{ color: t.faint }}>· {s.brief}</span>
              </div>
            ))}
          </div>
        </div>
      </In>
      {SUBS.map((_, i) => {
        const c = cardPos(i);
        const tx = c.x, ty = c.y + 28;
        return (
          <React.Fragment key={i}>
            <Travel x1={MAIN.x} y1={MAIN.y} x2={tx} y2={ty} a={SEND + i * 5} b={SEND + 22 + i * 5} color={info} />
            {f < FOLD && <Travel x1={tx} y1={ty} x2={MAIN.x} y2={MAIN.y} a={DONE[i]} b={DONE[i] + 14} color={t.accent} />}
          </React.Fragment>
        );
      })}
      {SUBS.map((_, i) => <Card key={i} i={i} f={f} />)}
      {f >= FOLD && <Level f={f} />}
      {f > FOLD + 30 && (
        <div style={{ position: 'absolute', left: 60, top: 560, width: 380, fontSize: 20, lineHeight: '30px', opacity: p(f, FOLD + 30, FOLD + 42) }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><Check color={t.ok} /> 4 files, one level.</div>
          <div style={{ color: t.soft, fontSize: 17 }}>The paid model only planned and checked. The making ran on your Mac.</div>
        </div>
      )}
      <Footer left="Opus 5.5 plans · 4 local sub-agents make" right="Illustrative" machine={false} />
    </>
  );
}
