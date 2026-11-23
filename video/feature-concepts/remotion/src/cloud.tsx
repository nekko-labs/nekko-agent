// D (two local models), E1/E2 (Nekko Cloud), F (Fleet pooling).
import React from 'react';
import { Img, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { AppWindow, Bar, Bubble, Cat, Check, Composer, Dot, Footer, Headline, In, Label, Lock, MONO, Status, Travel, clamp, fmt, p, typed, useInfo, useT } from './ckit';

// ─── D Two models, one pipeline ─────────────────────────────────────────────
/** Copy of the Photo pillar's Resolving: grain and blur fall away step by step. */
function Resolving({ src, size, from, steps, dur }: { src: string; size: number; from: number; steps: number; dur: number }) {
  const t = useT();
  const f = useCurrentFrame();
  const step = Math.min(steps, Math.max(0, Math.floor(((f - from) / dur) * steps) + 1));
  const left = 1 - step / steps;
  const settle = p(f, from + (dur * (step - 1)) / steps, from + (dur * (step - 1)) / steps + 6);
  const noise = f < from ? 1 : Math.max(0, left + (1 / steps) * (1 - settle));
  return (
    <div style={{ position: 'relative', width: size, height: size, borderRadius: 12, overflow: 'hidden', background: t.surface2 }}>
      <Img src={staticFile(src)} style={{ width: size, height: size, display: 'block', filter: `blur(${noise * 22}px) saturate(${1 - noise * 0.6})`, transform: `scale(${1 + noise * 0.08})` }} />
      <svg width={size} height={size} style={{ position: 'absolute', inset: 0, opacity: noise * 0.9, mixBlendMode: 'overlay' }}>
        <filter id={`grain-d`}><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed={step} /></filter>
        <rect width="100%" height="100%" filter="url(#grain-d)" />
      </svg>
    </div>
  );
}
const D_ASK = 'Write my post intro, and make a cover picture';
const D_BRIEF = 'A cosy desk at night, a warm lamp, a black cat asleep by the keyboard';
export function D() {
  const t = useT();
  const f = useCurrentFrame();
  const info = useInfo();
  const HAND = 96, GEN = 140, BACK = 206;
  return (
    <>
      <Headline>Two models. One pipeline.</Headline>
      <In at={4}>
        <AppWindow x={60} y={96} w={580} h={560} title="Blog post">
          {f >= 50 && (
            <div style={{ position: 'absolute', left: 24, right: 24, top: 22, opacity: p(f, 50, 58) }}>
              <Bubble>{D_ASK}</Bubble>
              <div style={{ fontSize: 16, color: t.faint, marginTop: 16 }}>Qwen3-32B · parent · on this computer</div>
              <div style={{ fontSize: 19, lineHeight: '28px', marginTop: 6 }}>{typed(f, 60, 92, 'Intro drafted. Asking the image model for the cover…')}</div>
              {f >= HAND - 4 && f < BACK + 16 && (
                <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, fontSize: 17, color: t.soft, opacity: p(f, HAND - 4, HAND + 4) }}>
                  <Dot color={info} pulse={(Math.sin(f / 5) + 1) / 2} /> Image sub-agent working
                </div>
              )}
              {f >= BACK + 16 && (
                <div style={{ marginTop: 12, opacity: p(f, BACK + 16, BACK + 26) }}>
                  <div style={{ width: 200, height: 200, borderRadius: 12, overflow: 'hidden' }}><Img src={staticFile('photo/desk-night.png')} style={{ width: 200, height: 200 }} /></div>
                  <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', fontSize: 17, color: t.soft }}><Check size={16} color={t.ok} /> cover.png added to the post</div>
                </div>
              )}
            </div>
          )}
          <div style={{ position: 'absolute', left: 20, right: 20, bottom: 20 }}>
            <Composer text={f > 10 && f < 50 ? typed(f, 10, 44, D_ASK) : ''} model="Qwen3-32B · On this computer" caret={f > 10 && f < 50} />
          </div>
        </AppWindow>
      </In>
      {/* the hand-off: the brief travels out, the picture travels back */}
      <Travel x1={640} y1={250} x2={700} y2={250} a={HAND} b={HAND + 14} color={t.accent} />
      <Travel x1={700} y1={470} x2={640} y2={470} a={BACK} b={BACK + 14} color={info} />
      <In at={HAND} style={{ position: 'absolute', left: 700, top: 96 }}><Label>Image sub-agent</Label></In>
      <In at={HAND + 4}>
        <div style={{ position: 'absolute', left: 700, top: 140, width: 520 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontSize: 24, fontWeight: 600, color: info }}>FLUX.2 klein 4B</span>
            <span style={{ fontSize: 17, color: t.faint }}>on this computer</span>
          </div>
          <div style={{ marginTop: 14, fontSize: 16, color: t.faint }}>Brief from the parent</div>
          <div style={{ marginTop: 4, fontSize: 19, lineHeight: '28px', color: t.soft }}>“{typed(f, HAND + 8, HAND + 40, D_BRIEF)}”</div>
          <div style={{ marginTop: 16, display: 'flex', gap: 18, alignItems: 'flex-start' }}>
            <Resolving src="photo/desk-night.png" size={260} from={GEN} steps={4} dur={52} />
            <div style={{ fontFamily: MONO, fontSize: 15, color: t.faint, lineHeight: '26px' }}>
              {f < GEN ? 'loading model' : f < GEN + 52 ? `step ${Math.min(4, Math.floor((f - GEN) / 13) + 1)}/4` : <span style={{ color: t.ink }}>1024 × 1024<br />returned to parent</span>}
            </div>
          </div>
        </div>
      </In>
      <Footer left="Picture: real FLUX.2 klein 4B output (Photo pillar asset)" right="" />
    </>
  );
}

// ─── E1 Nekko Cloud sync ────────────────────────────────────────────────────
const E_ROWS = [
  { name: 'Chats', n: 214, lock: true },
  { name: 'Library', n: 1380 },
  { name: 'Artifacts', n: 57 },
  { name: 'Photos', n: 96 },
];
function Device({ x, name, detail, start, from }: { x: number; name: string; detail: string; start: number; from: boolean }) {
  const t = useT();
  const f = useCurrentFrame();
  return (
    <div style={{ position: 'absolute', left: x, top: 120, width: 360 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 26, fontWeight: 600 }}>{name}</span>
        <span style={{ fontSize: 17, color: t.faint }}>{detail}</span>
      </div>
      {E_ROWS.map((r, i) => {
        const k = from ? 1 : interpolate(f, [start + i * 18, start + i * 18 + 50], [0, 1], clamp);
        return (
          <div key={r.name} style={{ marginTop: 26 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 21 }}>
              {r.lock ? <Lock color={t.accent} size={16} /> : <Dot color={k >= 1 ? t.ok : t.line} />}
              <span>{r.name}</span>
              <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 17, color: k >= 1 ? t.ink : t.soft }}>{fmt(r.n * k)}</span>
            </div>
            {!from && <Bar v={k} style={{ marginTop: 8, marginLeft: 26 }} />}
          </div>
        );
      })}
    </div>
  );
}
export function E1() {
  const t = useT();
  const f = useCurrentFrame();
  const S = 70;
  return (
    <>
      <Headline>Your chats, everywhere. Encrypted.</Headline>
      <In at={8}><Device x={60} name="This MacBook" detail="M5 Max" start={0} from /></In>
      <In at={30}><Device x={860} name="Your iPhone" detail="signed in" start={S + 20} from={false} /></In>
      <In at={40}>
        <div style={{ position: 'absolute', left: 470, top: 240, width: 340, textAlign: 'center' }}>
          <div style={{ display: 'flex', justifyContent: 'center' }}><Lock color={t.accent} size={34} /></div>
          <div style={{ fontSize: 24, fontWeight: 600, marginTop: 12 }}>Nekko Cloud</div>
          <div style={{ fontSize: 17, color: t.soft, marginTop: 6, lineHeight: '25px' }}>Encrypted on your device.<br />We can't read it.</div>
        </div>
      </In>
      {E_ROWS.map((_, i) => (
        <React.Fragment key={i}>
          <Travel x1={430} y1={185 + i * 62} x2={560} y2={330} a={S + i * 18} b={S + i * 18 + 20} color={t.accent} size={8} />
          <Travel x1={720} y1={330} x2={850} y2={185 + i * 62} a={S + 20 + i * 18} b={S + 40 + i * 18} color={t.accent} size={8} />
        </React.Fragment>
      ))}
      {f > 190 && <div style={{ position: 'absolute', left: 860, top: 520, opacity: p(f, 190, 200) }}><Status done>Up to date</Status></div>}
      <Footer left="Chats, library, artifacts and photos" machine={false} />
    </>
  );
}

// ─── E2 Local first, Cloud when you want it ─────────────────────────────────
function Switch({ on }: { on: number }) {
  const t = useT();
  return (
    <span style={{ position: 'relative', width: 54, height: 30, borderRadius: 15, background: on > 0.5 ? t.accent : t.surface2, border: `1px solid ${t.line}`, display: 'inline-block' }}>
      <span style={{ position: 'absolute', top: 3, left: 3 + on * 24, width: 22, height: 22, borderRadius: 11, background: on > 0.5 ? t.paper : t.soft }} />
    </span>
  );
}
export function E2() {
  const t = useT();
  const f = useCurrentFrame();
  const ON = 150;
  const on = p(f, ON, ON + 8);
  return (
    <>
      <Headline>Works on its own. Cloud if you want it.</Headline>
      <In at={6}>
        <AppWindow x={60} y={96} w={560} h={560} title="New chat">
          <div style={{ position: 'absolute', left: 24, right: 24, top: 24 }}>
            {f >= 36 && <Bubble style={{ opacity: p(f, 36, 44) }}>Plan my week from these notes</Bubble>}
            {f >= 50 && (
              <div style={{ opacity: p(f, 50, 58) }}>
                <div style={{ fontSize: 16, color: t.faint, marginTop: 18 }}>Qwen3-32B · on this computer · offline</div>
                <div style={{ fontSize: 20, lineHeight: '30px', marginTop: 6 }}>{typed(f, 56, 120, 'Monday: finish the deck. Tuesday: two client calls. Wednesday is clear for deep work.')}</div>
              </div>
            )}
          </div>
          <div style={{ position: 'absolute', left: 24, bottom: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
            <Cat size={44} eyes={f > 120 ? 'happy' : 'open'} />
            <span style={{ fontSize: 18, color: t.soft }}>No account. No internet needed.</span>
          </div>
        </AppWindow>
      </In>
      <In at={100} style={{ position: 'absolute', left: 680, top: 96 }}><Label>Settings · Account</Label></In>
      <In at={104}>
        <div style={{ position: 'absolute', left: 680, top: 150, width: 540 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div>
              <div style={{ fontSize: 22, fontWeight: 500 }}>Nekko Cloud</div>
              <div style={{ fontSize: 17, color: t.faint, marginTop: 4 }}>Off. Everything stays on this computer.</div>
            </div>
            <span style={{ marginLeft: 'auto' }}><Switch on={on} /></span>
          </div>
          {f > ON + 6 && (
            <div style={{ marginTop: 28, opacity: p(f, ON + 6, ON + 16) }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 19 }}><Lock color={t.accent} size={16} /> Encrypted before it leaves</div>
              {['Chats', 'Library', 'Artifacts', 'Photos'].map((n, i) => (
                <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 19, marginTop: 16, opacity: p(f, ON + 16 + i * 8, ON + 24 + i * 8) }}>
                  <Dot color={t.ok} /> {n} <span style={{ marginLeft: 'auto', fontSize: 16, color: t.faint }}>{f > ON + 50 + i * 10 ? 'synced' : 'syncing…'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </In>
      <Footer left="Nekko Cloud is optional and paid" right="" />
    </>
  );
}

// ─── F Fleet: pooled compute ────────────────────────────────────────────────
function Laptop({ color }: { color: string }) {
  return <svg width="96" height="62" viewBox="0 0 96 62" fill="none"><rect x="14" y="4" width="68" height="44" rx="4" stroke={color} strokeWidth="2.5" /><path d="M4 54 H92 L86 58 H10 Z" stroke={color} strokeWidth="2.5" strokeLinejoin="round" /></svg>;
}
const MACS = ['MacBook Pro', 'MacBook Air', 'Mac mini'];
export function F() {
  const t = useT();
  const f = useCurrentFrame();
  const S = 70;
  const one = interpolate(f, [S, 270], [0, 0.42], clamp);
  const pool = interpolate(f, [S + 10, 230], [0, 1], clamp);
  const linked = p(f, 40, 56);
  return (
    <>
      <Headline>Three Macs. One brain.</Headline>
      <div style={{ position: 'absolute', left: 60, top: 116, width: 1160, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        {MACS.map((m, i) => (
          <In key={m} at={10 + i * 8}>
            <div style={{ width: 300, textAlign: 'center' }}>
              <Laptop color={pool > 0 && pool < 1 ? t.accent : t.soft} />
              <div style={{ fontSize: 21, fontWeight: 500, marginTop: 8 }}>{m}</div>
              <div style={{ fontFamily: MONO, fontSize: 15, color: t.faint, marginTop: 4 }}>{f > S + 10 && pool < 1 ? `working · part ${i + 1}/3` : 'idle'}</div>
            </div>
          </In>
        ))}
      </div>
      <svg style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }} width={1} height={1}>
        <line x1={270} y1={150} x2={530} y2={150} stroke={t.accent} strokeWidth={1.5} strokeDasharray="5 6" opacity={linked} />
        <line x1={750} y1={150} x2={1010} y2={150} stroke={t.accent} strokeWidth={1.5} strokeDasharray="5 6" opacity={linked} />
      </svg>
      {[0, 1, 2].map((k) => (
        <React.Fragment key={k}>
          <Travel x1={280} y1={150} x2={520} y2={150} a={S + k * 40} b={S + k * 40 + 24} color={t.accent} size={8} />
          <Travel x1={1000} y1={150} x2={760} y2={150} a={S + 20 + k * 40} b={S + 44 + k * 40} color={t.accent} size={8} />
        </React.Fragment>
      ))}
      <In at={24}><div style={{ position: 'absolute', left: 60, top: 290, fontSize: 18, color: t.soft }}>Task: <span style={{ color: t.ink }}>transcribe and index 200 hours of interviews</span></div></In>
      {[
        { label: 'One Mac', v: one, mins: Math.round(one / 0.42 * 0 + 0) },
        { label: 'Three Macs, pooled', v: pool },
      ].map((row, i) => (
        <In key={row.label} at={40 + i * 8}>
          <div style={{ position: 'absolute', left: 60, top: 350 + i * 120, width: 1160 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
              <span style={{ fontSize: 24, fontWeight: 600, color: i ? t.accent : t.ink }}>{row.label}</span>
              <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 22, color: i && row.v >= 1 ? t.accent : t.soft }}>{Math.round(row.v * 100)}%</span>
              <span style={{ fontFamily: MONO, fontSize: 18, color: t.faint, width: 170, textAlign: 'right' }}>{i ? 'about 3 h' : 'about 9 h'}</span>
            </div>
            <Bar v={row.v} color={i ? t.accent : t.faint} style={{ marginTop: 14, height: 6 }} />
          </div>
        </In>
      ))}
      {f > 236 && <div style={{ position: 'absolute', left: 60, top: 600, opacity: p(f, 236, 246) }}><Status done>Finished on three machines, one result</Status></div>}
      <Footer left="Fleet · computers you've connected" machine={false} />
    </>
  );
}
