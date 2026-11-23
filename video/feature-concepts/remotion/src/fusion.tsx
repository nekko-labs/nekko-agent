// A1, A2 (Fusion side by side), G (Privacy Shield screening), H (model routing).
// Layout of A1/A2 is the Speed pillar's two lanes (x 60 and 680, hairline at 660).
import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { Bar, Check, Chip, Dot, Footer, Headline, In, Label, Lock, MONO, Skeleton, Status, Travel, clamp, fmt, p, typed, useInfo, useT } from './ckit';

// ─── A1 Same task. Less sent. ───────────────────────────────────────────────
const A1_STEPS = [
  { name: 'Read 40 tickets', tokens: 22000, local: true },
  { name: 'Group by topic', tokens: 9000, local: true },
  { name: 'Pick the 6 hard ones', tokens: 5300, local: true },
  { name: 'Draft the hard replies', tokens: 11900, local: false },
];
const A1_START = 40, A1_STEP = 44;
function A1Lane({ x, name, sub, fusion }: { x: number; name: string; sub: string; fusion: boolean }) {
  const t = useT();
  const f = useCurrentFrame();
  let sent = 0, kept = 0;
  A1_STEPS.forEach((s, i) => {
    const k = interpolate(f, [A1_START + i * A1_STEP, A1_START + (i + 1) * A1_STEP - 6], [0, 1], clamp);
    if (fusion && s.local) kept += s.tokens * k; else sent += s.tokens * k;
  });
  const cost = sent * 0.000015;
  const done = f >= A1_START + A1_STEPS.length * A1_STEP;
  return (
    <div style={{ position: 'absolute', left: x, top: 100, width: 540 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <span style={{ fontSize: 28, fontWeight: 600 }}>{name}</span>
        <span style={{ fontSize: 18, color: t.faint }}>{sub}</span>
      </div>
      <div style={{ fontSize: 18, color: t.soft, marginTop: 18 }}>Tokens sent to the API</div>
      <div style={{ fontFamily: MONO, fontSize: 56, fontWeight: 600, marginTop: 4, letterSpacing: '-0.02em', color: done && fusion ? t.accent : t.ink }}>{fmt(sent)}</div>
      <div style={{ display: 'flex', gap: 28, fontFamily: MONO, fontSize: 18, color: t.soft, marginTop: 6 }}>
        <span>${cost.toFixed(2)}</span>
        {fusion && <span style={{ color: t.accent }}>{fmt(kept)} handled locally</span>}
      </div>
      <div style={{ marginTop: 26, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {A1_STEPS.map((s, i) => {
          const a = A1_START + i * A1_STEP;
          const k = interpolate(f, [a, a + A1_STEP - 6], [0, 1], clamp);
          const local = fusion && s.local;
          return (
            <div key={s.name} style={{ opacity: f >= a - 10 ? 1 : 0.35 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 20 }}>
                {k >= 1 ? <Check size={16} color={t.ok} /> : <Dot color={k > 0 ? (local ? t.accent : t.soft) : t.line} pulse={k > 0 && k < 1 ? (Math.sin(f / 4) + 1) / 2 : 0} />}
                <span>{s.name}</span>
                <span style={{ marginLeft: 'auto', fontSize: 16, color: local ? t.accent : t.faint }}>{local ? 'Qwen3-32B · this computer' : 'Claude · API'}</span>
              </div>
              <Bar v={k} color={local ? t.accent : t.faint} style={{ marginTop: 8, marginLeft: 26 }} />
            </div>
          );
        })}
      </div>
      {done && <div style={{ marginTop: 22, opacity: p(f, A1_START + A1_STEPS.length * A1_STEP, A1_START + A1_STEPS.length * A1_STEP + 10) }}><Status done>Same 40 replies drafted</Status></div>}
    </div>
  );
}
export function A1() {
  const t = useT();
  return (
    <>
      <Headline>Same task. Less sent.</Headline>
      <In at={8}><A1Lane x={60} name="Claude alone" sub="every step over the API" fusion={false} /></In>
      <In at={14}><A1Lane x={680} name="Claude + Nekko Agent" sub="Fusion" fusion /></In>
      <div style={{ position: 'absolute', left: 660, top: 100, bottom: 70, width: 1, background: t.line }} />
      <Footer left="Task: sort 40 support tickets and draft replies" />
    </>
  );
}

// ─── A2 Same task. Less leaves your machine. ────────────────────────────────
const A2_LINES: { text: string; kind: 'secret' | 'pii' | 'need' | 'plain' }[] = [
  { text: "import { stripe } from './pay';", kind: 'plain' },
  { text: "const KEY = 'sk_live_51Hc…9xQ';", kind: 'secret' },
  { text: '', kind: 'plain' },
  { text: '// customers: ana@lumen.io, raj@ofix.co', kind: 'pii' },
  { text: 'export async function refund(o) {', kind: 'need' },
  { text: '  const c = await charge(o.id);', kind: 'need' },
  { text: '  if (c.amount = 0) return;', kind: 'need' },
  { text: '  return stripe.refund(c.id);', kind: 'need' },
  { text: '}', kind: 'need' },
  { text: '', kind: 'plain' },
  { text: 'export function audit(log) {', kind: 'plain' },
  { text: '  return log.filter(Boolean);', kind: 'plain' },
  { text: '}', kind: 'plain' },
];
function A2Lane({ x, name, sub, fusion }: { x: number; name: string; sub: string; fusion: boolean }) {
  const t = useT();
  const f = useCurrentFrame();
  const scan = interpolate(f, [40, 130], [0, A2_LINES.length], clamp);
  const sentLines = A2_LINES.filter((l) => (fusion ? l.kind === 'need' : true)).length;
  const sentNow = A2_LINES.filter((l, i) => i < scan && (fusion ? l.kind === 'need' : true)).length;
  return (
    <div style={{ position: 'absolute', left: x, top: 100, width: 540 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <span style={{ fontSize: 28, fontWeight: 600 }}>{name}</span>
        <span style={{ fontSize: 18, color: t.faint }}>{sub}</span>
      </div>
      <div style={{ fontSize: 18, color: t.soft, marginTop: 14 }}>billing.ts · "why do refunds never run?"</div>
      <div style={{ marginTop: 14, background: t.codeBg, border: `1px solid ${t.line}`, borderRadius: 14, padding: '14px 0', fontFamily: MONO, fontVariantLigatures: 'none', fontSize: 15.5, lineHeight: '24px' }}>
        {A2_LINES.map((l, i) => {
          const reached = i < scan;
          const sent = reached && (fusion ? l.kind === 'need' : true);
          const keptPrivate = reached && fusion && (l.kind === 'secret' || l.kind === 'pii');
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', whiteSpace: 'pre', padding: '0 16px', borderLeft: `3px solid ${sent ? (fusion ? t.accent : t.faint) : 'transparent'}`, color: sent ? t.ink : t.soft, opacity: reached && fusion && !sent ? 0.55 : 1 }}>
              <span style={{ flex: 1 }}>{l.text || ' '}</span>
              {keptPrivate && <Lock color={t.accent} size={13} />}
              {!fusion && reached && (l.kind === 'secret' || l.kind === 'pii') && <span style={{ fontFamily: MONO, fontSize: 13, color: t.warn }}>sent</span>}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginTop: 18 }}>
        <span style={{ fontFamily: MONO, fontSize: 40, fontWeight: 600, color: fusion && f > 130 ? t.accent : t.ink }}>{sentNow}</span>
        <span style={{ fontSize: 19, color: t.soft }}>of {A2_LINES.length} lines left this computer</span>
      </div>
      <div style={{ marginTop: 8, fontSize: 18, color: fusion ? t.ink : t.faint, opacity: p(f, 136, 148), display: 'flex', alignItems: 'center', gap: 8 }}>
        {fusion ? <><Lock color={t.accent} size={15} /> API key and customer emails stayed here</> : 'Including the API key and customer emails'}
      </div>
    </div>
  );
}
export function A2() {
  const t = useT();
  const f = useCurrentFrame();
  return (
    <>
      <Headline>Same task. Less leaves your machine.</Headline>
      <In at={8}><A2Lane x={60} name="Claude alone" sub="sends the whole file" fusion={false} /></In>
      <In at={14}><A2Lane x={680} name="Claude + Nekko Agent" sub="local model picks what's needed" fusion /></In>
      <div style={{ position: 'absolute', left: 660, top: 100, bottom: 70, width: 1, background: t.line }} />
      {f > 160 && (
        <div style={{ position: 'absolute', left: 680, top: 652, display: 'flex', gap: 10, alignItems: 'center', fontSize: 19, opacity: p(f, 160, 172) }}>
          <Check color={t.ok} /> Same answer: <span style={{ fontFamily: MONO, fontSize: 17 }}>`=` should be `===`</span>
        </div>
      )}
      <Footer left={null} />
    </>
  );
}

// ─── G Privacy Shield screening ─────────────────────────────────────────────
const G_ITEMS = [
  { real: 'Dana Whitfield', ph: '[NAME_1]' },
  { real: 'dana@harbourlaw.co', ph: '[EMAIL_1]' },
  { real: 'sk-proj-7Hq2…', ph: '[KEY_1]' },
];
function GLine({ masked, restored, mark }: { masked: number; restored?: boolean; mark: number }) {
  const t = useT();
  const v = (i: number) => {
    const it = G_ITEMS[i];
    if (masked >= 1) return <Chip>{it.ph}</Chip>;
    return <span style={{ boxShadow: `inset 0 -${3 * mark}px 0 ${restored ? t.ok : t.accent}`, borderRadius: 2 }}>{it.real}</span>;
  };
  return <>Write to {v(0)} at {v(1)}: the deploy failed because key {v(2)} expired. Suggest next steps.</>;
}
export function G() {
  const t = useT();
  const f = useCurrentFrame();
  const info = useInfo();
  return (
    <>
      <Headline>Use any model. Keep your data.</Headline>
      <In at={8} style={{ position: 'absolute', left: 60, top: 104 }}><Label>1 · You write</Label></In>
      <In at={10}>
        <div style={{ position: 'absolute', left: 60, top: 144, width: 520, border: `1px solid ${t.line}`, borderRadius: 14, background: t.surface, padding: '16px 18px', fontSize: 21, lineHeight: '34px' }}>
          <GLine masked={0} mark={p(f, 52, 64)} />
        </div>
      </In>
      <In at={50}>
        <div style={{ position: 'absolute', left: 60, top: 334, display: 'flex', alignItems: 'center', gap: 10, fontSize: 19, color: t.soft }}>
          <Dot color={t.accent} pulse={f > 50 && f < 70 ? 1 : 0} /> <span style={{ color: t.ink, fontWeight: 600 }}>Shield</span> found 3 private values, on this computer
        </div>
        <div style={{ position: 'absolute', left: 60, top: 370, fontSize: 18, color: t.faint, width: 520 }}>Everything else goes through as you wrote it.</div>
      </In>

      <In at={84} style={{ position: 'absolute', left: 700, top: 104 }}><Label>2 · Claude reads</Label></In>
      <In at={88}>
        <div style={{ position: 'absolute', left: 700, top: 144, width: 520, fontSize: 21, lineHeight: '38px' }}><GLine masked={1} mark={0} /></div>
      </In>
      <Travel x1={580} y1={210} x2={700} y2={210} a={70} b={88} color={t.accent} />

      <div style={{ position: 'absolute', left: 60, right: 60, top: 420, height: 1, background: t.line, opacity: p(f, 140, 150) }} />
      <In at={140} style={{ position: 'absolute', left: 700, top: 444 }}><Label>3 · Claude answers</Label></In>
      <In at={146}>
        <div style={{ position: 'absolute', left: 700, top: 484, width: 520, fontSize: 20, lineHeight: '34px', color: t.soft }}>
          Hi <Chip>[NAME_1]</Chip>, rotate <Chip>[KEY_1]</Chip> in the dashboard, then redeploy.
        </div>
      </In>
      <Travel x1={700} y1={530} x2={580} y2={530} a={178} b={196} color={info} />
      <In at={190} style={{ position: 'absolute', left: 60, top: 444 }}><Label>4 · You see</Label></In>
      <In at={196}>
        <div style={{ position: 'absolute', left: 60, top: 484, width: 520, fontSize: 20, lineHeight: '34px' }}>
          Hi <span style={{ boxShadow: `inset 0 -3px 0 ${t.ok}` }}>Dana Whitfield</span>, rotate <span style={{ boxShadow: `inset 0 -3px 0 ${t.ok}` }}>sk-proj-7Hq2…</span> in the dashboard, then redeploy.
        </div>
        <div style={{ position: 'absolute', left: 60, top: 596, display: 'flex', alignItems: 'center', gap: 10, fontSize: 19, color: t.soft }}>
          <Check color={t.ok} /> Real values put back here. The model never saw them.
        </div>
      </In>
      <Footer left="Nekko Cloud router · screening, not blocking" right="" machine={false} />
    </>
  );
}

// ─── H Model routing ────────────────────────────────────────────────────────
const H_PARTS = [
  { text: 'Rename the props in 14 files', hard: false },
  { text: 'Design the new caching layer', hard: true },
  { text: 'Fix the lint errors', hard: false },
  { text: 'Find the race condition in sync', hard: true },
  { text: 'Update the changelog', hard: false },
];
export function H() {
  const t = useT();
  const f = useCurrentFrame();
  const info = useInfo();
  const ask = 'Ship the sync refactor';
  return (
    <>
      <Headline>Easy parts here. Hard parts there.</Headline>
      <In at={8}>
        <div style={{ position: 'absolute', left: 60, top: 104, width: 400 }}>
          <Label>One request</Label>
          <div style={{ marginTop: 12, border: `1px solid ${t.line}`, borderRadius: 14, background: t.surface, padding: '14px 18px', fontSize: 22 }}>
            {typed(f, 14, 40, ask)}{f < 44 && <span style={{ borderLeft: `2px solid ${t.accent}`, marginLeft: 2 }} />}
          </div>
          <div style={{ marginTop: 26, fontSize: 18, color: t.soft, opacity: p(f, 46, 54) }}>Split by the fusion router</div>
          {H_PARTS.map((s, i) => (
            <In key={s.text} at={52 + i * 6}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', fontSize: 19 }}>
                <Dot color={f > 96 ? (s.hard ? info : t.accent) : t.line} />
                <span>{s.text}</span>
              </div>
            </In>
          ))}
        </div>
      </In>
      <div style={{ position: 'absolute', left: 500, top: 100, bottom: 70, width: 1, background: t.line }} />
      {[false, true].map((hard, li) => {
        const parts = H_PARTS.filter((s) => s.hard === hard);
        const y = 104 + li * 270;
        const c = hard ? info : t.accent;
        return (
          <In key={li} at={92 + li * 8}>
            <div style={{ position: 'absolute', left: 540, top: y, width: 680 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                <span style={{ fontSize: 26, fontWeight: 600, color: c }}>{hard ? 'Opus 5.5' : 'Qwen3-32B'}</span>
                <span style={{ fontSize: 18, color: t.faint }}>{hard ? 'frontier · Claude subscription' : 'local · this computer · free'}</span>
              </div>
              {parts.map((s, j) => {
                const a = 110 + j * 22 + li * 16;
                const prog = interpolate(f, [a, a + (hard ? 110 : 50)], [0, 1], clamp);
                return (
                  <div key={s.text} style={{ marginTop: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', fontSize: 20 }}>
                      <span>{s.text}</span>
                      <span style={{ marginLeft: 'auto' }}><Status done={prog >= 1} /></span>
                    </div>
                    <Bar v={prog} color={c} style={{ marginTop: 8 }} />
                  </div>
                );
              })}
            </div>
          </In>
        );
      })}
      {f > 246 && (
        <div style={{ position: 'absolute', left: 60, top: 560, width: 400, display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 20, lineHeight: '30px', opacity: p(f, 246, 256) }}>
          <span style={{ marginTop: 5 }}><Check color={t.ok} /></span>
          <span>One answer back in your chat.<br /><span style={{ color: t.soft }}>3 of 5 parts never left this computer.</span></span>
        </div>
      )}
      <Footer left="Fusion router" right="" />
    </>
  );
}
