// B1 to B3: a small local model writing clean SVG. Left: the Photo pillar's chat
// window; right: the result on a plain canvas, drawn path by path (stroke-dash).
import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { AppWindow, Bubble, Check, Composer, Footer, Headline, In, Label, MONO, clamp, p, typed, useInfo, useT } from './ckit';

const MODEL = 'Qwen3-32B · On this computer';

/** Draws a path in over [a, b] (stroke), then fills it over the next 10 frames. */
function DrawPath({ d, a, b, stroke, fill, width = 4, fillAt }: { d: string; a: number; b: number; stroke: string; fill?: string; width?: number; fillAt?: number }) {
  const f = useCurrentFrame();
  const k = p(f, a, b);
  const fk = fill ? p(f, fillAt ?? b, (fillAt ?? b) + 10) : 0;
  if (f < a) return null;
  return <path d={d} pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - k} stroke={stroke} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" fill={fill ?? 'none'} fillOpacity={fk} />;
}

function ChatSide({ prompt, reply, promptAt = 14, title = 'New chat' }: { prompt: string; reply: string; promptAt?: number; title?: string }) {
  const t = useT();
  const f = useCurrentFrame();
  const sent = promptAt + 40;
  return (
    <AppWindow x={60} y={96} w={560} h={560} title={title}>
      {f >= sent && (
        <div style={{ position: 'absolute', left: 24, right: 24, top: 24, opacity: p(f, sent, sent + 8) }}>
          <Bubble>{prompt}</Bubble>
          <div style={{ fontSize: 16, color: t.faint, marginTop: 20 }}>Qwen3-32B · on this computer · offline</div>
          <div style={{ fontSize: 20, lineHeight: '30px', marginTop: 8 }}>{typed(f, sent + 10, sent + 60, reply)}</div>
        </div>
      )}
      <div style={{ position: 'absolute', left: 20, right: 20, bottom: 20 }}>
        <Composer text={f > promptAt && f < sent ? typed(f, promptAt, sent - 6, prompt) : ''} model={MODEL} caret={f > promptAt && f < sent} />
      </div>
    </AppWindow>
  );
}

// ─── B1 Brand logo ──────────────────────────────────────────────────────────
const LOGO = [
  { d: 'M44 78 H156 V120 Q156 168 100 168 Q44 168 44 120 Z', fill: true },
  { d: 'M156 92 Q188 92 188 113 Q188 134 156 134' },
  { d: 'M64 78 L72 44 L90 62 Q100 59 110 62 L128 44 L136 78' },
  { d: 'M86 70 v0.1 M114 70 v0.1', round: true },
  { d: 'M28 182 H172' },
];
export function B1() {
  const t = useT();
  const f = useCurrentFrame();
  const START = 92;
  const done = f >= START + LOGO.length * 18 + 10;
  return (
    <>
      <Headline>Logos and icons. Made locally.</Headline>
      <In at={4}><ChatSide prompt="Minimal cat logo for a coffee shop" reply="Here it is: five paths, one colour. Saved as cafe-logo.svg." /></In>
      <In at={84} style={{ position: 'absolute', left: 680, top: 96 }}><Label>cafe-logo.svg</Label></In>
      <In at={84}>
        <div style={{ position: 'absolute', left: 680, top: 140, width: 440, height: 440, borderRadius: 14, border: `1px solid ${t.line}`, background: t.surface, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg viewBox="0 0 200 200" width={340} height={340}>
            {LOGO.map((l, i) => (
              <DrawPath key={i} d={l.d} a={START + i * 18} b={START + i * 18 + 22} stroke={t.accent} width={l.round ? 10 : 6} fill={l.fill ? t.accentSoft : undefined} fillAt={START + LOGO.length * 18} />
            ))}
          </svg>
        </div>
      </In>
      {f > 92 && (
        <div style={{ position: 'absolute', left: 680, top: 600, fontFamily: MONO, fontSize: 16, color: t.faint, opacity: p(f, 92, 100) }}>
          {done ? '5 paths · 1 colour · 0.9 KB' : `drawing path ${Math.min(LOGO.length, Math.floor((f - START) / 18) + 1)}/${LOGO.length}`}
        </div>
      )}
      {done && <div style={{ position: 'absolute', left: 940, top: 598, display: 'flex', gap: 8, alignItems: 'center', fontSize: 18, opacity: p(f, START + 100, START + 110) }}><Check size={16} color={t.ok} /> Clean vector</div>}
      <Footer left="Made on this computer, no upload" />
    </>
  );
}

// ─── B2 Icon set ────────────────────────────────────────────────────────────
const ICONS: { name: string; d: string[] }[] = [
  { name: 'Home', d: ['M4 11 L12 4 L20 11', 'M6 10 V20 H18 V10', 'M10 20 V14 H14 V20'] },
  { name: 'Search', d: ['M10.5 4 a6.5 6.5 0 1 0 0.01 0 Z', 'M15.5 15.5 L20 20'] },
  { name: 'Notes', d: ['M6 3 H15 L19 7 V21 H6 Z', 'M9 11 H16', 'M9 15 H16'] },
  { name: 'Settings', d: ['M12 8.5 a3.5 3.5 0 1 0 0.01 0 Z', 'M12 2 V5 M12 19 V22 M2 12 H5 M19 12 H22 M5 5 L7 7 M17 17 L19 19 M19 5 L17 7 M7 17 L5 19'] },
  { name: 'Share', d: ['M12 15 V3', 'M7 8 L12 3 L17 8', 'M5 12 V20 H19 V12'] },
  { name: 'Trash', d: ['M4 6 H20', 'M9 6 V3 H15 V6', 'M6 6 L7 21 H17 L18 6'] },
];
export function B2() {
  const t = useT();
  const f = useCurrentFrame();
  const START = 92;
  return (
    <>
      <Headline>One prompt. A matching set.</Headline>
      <In at={4}><ChatSide prompt="Six app icons for a notes app, one style" reply="Six icons on a 24 grid, 1.75 stroke, round caps. All in icons/." /></In>
      <In at={84} style={{ position: 'absolute', left: 680, top: 96 }}><Label>icons/</Label></In>
      <div style={{ position: 'absolute', left: 680, top: 150, width: 540, display: 'grid', gridTemplateColumns: 'repeat(3, 160px)', gap: '28px 30px' }}>
        {ICONS.map((ic, i) => {
          const a = START + i * 16;
          return (
            <In key={ic.name} at={a - 4}>
              <div style={{ width: 160, height: 160, borderRadius: 14, border: `1px solid ${t.line}`, background: t.surface, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                <svg viewBox="0 0 24 24" width={72} height={72}>
                  {ic.d.map((d, j) => <DrawPath key={j} d={d} a={a + j * 6} b={a + j * 6 + 18} stroke={t.ink} width={1.75} />)}
                </svg>
                <span style={{ fontFamily: MONO, fontSize: 14, color: t.faint }}>{ic.name.toLowerCase()}.svg</span>
              </div>
            </In>
          );
        })}
      </div>
      {f > START + 120 && <div style={{ position: 'absolute', left: 680, top: 560, display: 'flex', gap: 8, alignItems: 'center', fontSize: 19, opacity: p(f, START + 120, START + 130) }}><Check color={t.ok} /> Same grid, stroke and corners on all six</div>}
      <Footer left="Made on this computer, no upload" right="" />
    </>
  );
}

// ─── B3 Edit by chat ────────────────────────────────────────────────────────
export function B3() {
  const t = useT();
  const f = useCurrentFrame();
  const info = useInfo();
  const round = p(f, 100, 130);
  const two = p(f, 196, 220);
  const r = interpolate(round, [0, 1], [10, 70]);
  const ear = interpolate(round, [0, 1], [0, 10]);
  const ver = f < 100 ? 1 : f < 196 ? 2 : 3;
  const msgs = [
    { at: 60, text: 'Make it rounder' },
    { at: 156, text: 'Two colours only' },
  ];
  const third = two > 0.5 ? t.accent : info;
  return (
    <>
      <Headline>Change it by asking.</Headline>
      <In at={4}>
        <div style={{ position: 'absolute', left: 60, top: 96, width: 520 }}>
          <Label>badge.svg</Label>
          {msgs.map((m) => f >= m.at && (
            <div key={m.text} style={{ marginTop: 22, opacity: p(f, m.at, m.at + 8) }}>
              <Bubble style={{ marginLeft: 0 }}>{typed(f, m.at, m.at + 20, m.text)}</Bubble>
              {f > m.at + 36 && <div style={{ fontSize: 17, color: t.faint, marginTop: 10, opacity: p(f, m.at + 36, m.at + 44) }}>Qwen3-32B · updated 2 paths</div>}
            </div>
          ))}
          <div style={{ marginTop: 34, display: 'flex', gap: 10 }}>
            {[1, 2, 3].map((v) => (
              <span key={v} style={{ fontFamily: MONO, fontSize: 16, padding: '4px 12px', borderRadius: 8, background: v === ver ? t.accentSoft : 'transparent', color: v === ver ? t.accent : v < ver ? t.soft : t.line }}>v{v}</span>
            ))}
          </div>
        </div>
      </In>
      <In at={8}>
        <div style={{ position: 'absolute', left: 680, top: 96, width: 540, height: 540, borderRadius: 14, border: `1px solid ${t.line}`, background: t.surface, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg viewBox="0 0 200 200" width={380} height={380}>
            <rect x="20" y="20" width="160" height="160" rx={r} fill={t.accent} />
            <path d={`M62 ${132} L62 ${78 + ear} Q62 70 70 ${74 + ear / 2} L84 86 Q100 80 116 86 L130 ${74 + ear / 2} Q138 70 138 ${78 + ear} L138 132 Q138 ${150 + ear} 100 ${150 + ear} Q62 ${150 + ear} 62 132 Z`} fill={t.paper} />
            <circle cx="86" cy="112" r={6 + round * 2} fill={third} />
            <circle cx="114" cy="112" r={6 + round * 2} fill={third} />
            <path d="M94 128 Q100 134 106 128" stroke={interpolate(two, [0, 1], [0, 1]) > 0.5 ? t.accent : '#854F6C'} strokeWidth="4" fill="none" strokeLinecap="round" />
          </svg>
        </div>
      </In>
      <div style={{ position: 'absolute', left: 700, top: 590, display: 'flex', gap: 10 }}>
        {(two > 0.5 ? [t.accent, t.paper] : [t.accent, t.paper, info, '#854F6C']).map((c, i) => (
          <span key={i} style={{ width: 22, height: 22, borderRadius: 6, background: c, border: `1px solid ${t.line}` }} />
        ))}
      </div>
      <Footer left="Each edit rewrites the SVG on this computer" right="" />
    </>
  );
}
