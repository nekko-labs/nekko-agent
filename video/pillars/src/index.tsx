// Five short demos, one per Nekko Agent pillar (local first, speed, privacy,
// orchestration, everywhere), for the nekkolabs.com flagship card and
// nekkoagent.com. Each is 8 s, 1280x720, and loops: it fades in from and out
// to the plain background. Colours are the app's own tokens
// (apps/desktop/src/renderer/styles.css, :root and [data-theme='dark']), and
// the layouts follow docs/design-system.md (quiet surfaces: space and type,
// not boxes). They are illustrations, not screen recordings; the speed demo
// replays the measured times from docs/benchmarks (2026-10-30, M5 Max).
import React from 'react';
import { AbsoluteFill, Composition, Easing, interpolate, registerRoot, useCurrentFrame } from 'remotion';
import { Check, Cat, Dot, FPS, FRAMES, In, MONO, SANS, THEMES, Th, clamp, fontCss, p, typed, useT } from './kit';
import { Anywhere } from './anywhere';

const W = 1280, H = 720;

/** Loop envelope + theme + fonts. */
function Stage({ theme, children }: { theme: 'dark' | 'light'; children: React.ReactNode }) {
  const f = useCurrentFrame();
  const t = THEMES[theme];
  const o = Math.min(p(f, 0, 10), 1 - p(f, FRAMES - 12, FRAMES - 1));
  return (
    <Th.Provider value={t}>
      <AbsoluteFill style={{ background: t.paper, color: t.ink, fontFamily: SANS, overflow: 'hidden' }}>
        <style>{fontCss}</style>
        <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>
      </AbsoluteFill>
    </Th.Provider>
  );
}

/** A small label above a region, sentence case, ink-soft (design-system group label). */
function Label({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  const t = useT();
  return <div style={{ fontSize: 22, fontWeight: 500, color: t.soft, ...style }}>{children}</div>;
}

/** The app window: one surface, a title row, no inner boxes. */
function AppWindow({ x, y, w, h, title, children }: { x: number; y: number; w: number; h: number; title: string; children: React.ReactNode }) {
  const t = useT();
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, background: t.win, borderRadius: 16, border: `1px solid ${t.line}`, boxShadow: t.shadow, overflow: 'hidden' }}>
      <div style={{ height: 52, display: 'flex', alignItems: 'center', gap: 12, padding: '0 20px', borderBottom: `1px solid ${t.line}` }}>
        <Cat size={24} />
        <span style={{ fontSize: 20, fontWeight: 600 }}>{title}</span>
      </div>
      <div style={{ position: 'absolute', inset: '52px 0 0 0' }}>{children}</div>
    </div>
  );
}

/** The composer: text area plus the model and mode row, as in the app. */
function Composer({ text, model, placeholder = 'Message Nekko Agent…', caret }: { text: string; model: string; placeholder?: string; caret?: boolean }) {
  const t = useT();
  return (
    <div style={{ border: `1px solid ${t.line}`, borderRadius: 14, background: t.surface, padding: '16px 18px 12px' }}>
      <div style={{ fontSize: 22, minHeight: 30, color: text ? t.ink : t.faint }}>
        {text || placeholder}{caret && <span style={{ borderLeft: `2px solid ${t.accent}`, marginLeft: 2 }} />}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 14, fontSize: 18, color: t.soft }}>
        <span style={{ fontSize: 22 }}>+</span>
        <span style={{ color: t.ink, fontWeight: 500 }}>{model} ▾</span>
        <span>Works on its own ▾</span>
      </div>
    </div>
  );
}

// ─── 01 Local first ─────────────────────────────────────────────────────────
function Local() {
  const t = useT();
  const f = useCurrentFrame();
  const open = p(f, 18, 28) * (1 - p(f, 72, 80));
  const hover = f >= 40 && f < 60;
  const chosen = f >= 60;
  const model = chosen ? 'Qwen3 8B · On this computer' : 'Opus 5.5 · Claude subscription';
  const rows: { name: string; detail: string; right?: string; local: boolean }[] = [
    { name: 'Qwen3 8B', detail: 'Built-in engine', right: 'Loaded', local: true },
    { name: 'Qwen3 4B', detail: 'Built-in engine', local: true },
    { name: 'Opus 5.5', detail: 'Claude subscription', local: false },
    { name: 'GPT-6-Sol', detail: 'ChatGPT subscription', local: false },
  ];
  const term = [
    { at: 108, end: 136, prompt: '$', text: 'claude mcp add nekko-agent -- nekko-agent mcp' },
    { at: 146, end: 168, prompt: '>', text: 'review auth.ts with a local model' },
  ];
  const tool = [
    { at: 178, text: 'nekko-agent_model_load', meta: 'qwen3-4b' },
    { at: 190, text: 'nekko-agent_chat', meta: 'local · qwen3-4b' },
  ];
  return (
    <>
      <In at={4} style={{ position: 'absolute', left: 60, top: 52 }}><Label>In the app</Label></In>
      <In at={4}>
        <AppWindow x={60} y={96} w={600} h={572} title="New chat">
          <div style={{ position: 'absolute', left: 24, bottom: 150 }}><Cat size={52} eyes={chosen ? 'happy' : 'open'} /></div>
          {f >= 112 && (
            <div style={{ position: 'absolute', left: 24, right: 24, top: 28, opacity: p(f, 112, 120) }}>
              <div style={{ marginLeft: 'auto', width: 'fit-content', background: t.surface2, borderRadius: 14, padding: '10px 16px', fontSize: 21 }}>Summarise this folder</div>
              <div style={{ fontSize: 16, color: t.faint, marginTop: 22 }}>Qwen3 8B · on this computer · offline</div>
              <div style={{ fontSize: 21, lineHeight: '32px', marginTop: 8 }}>{typed(f, 126, 200, 'Twelve files: an Express API, its tests, and a README. The auth middleware is the only part without tests.')}</div>
            </div>
          )}
          <div style={{ position: 'absolute', left: 20, right: 20, bottom: 20 }}>
            <Composer text={f > 84 && f < 112 ? typed(f, 84, 104, 'Summarise this folder') : ''} model={model} caret={f > 84 && f < 112} />
          </div>
          {/* Model picker: one floating surface, groups by heading and gap */}
          <div style={{ position: 'absolute', left: 20, bottom: 150, width: 440, background: t.surface, borderRadius: 14, boxShadow: t.shadow, border: `1px solid ${t.line}`, padding: '16px 8px', opacity: open, transform: `translateY(${(1 - open) * 10}px)` }}>
            <div style={{ fontSize: 17, fontWeight: 500, color: t.soft, padding: '0 14px 6px' }}>On this computer</div>
            {rows.slice(0, 2).map((r, i) => (
              <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', borderRadius: 9, background: i === 0 && (hover || chosen) ? (chosen ? t.accentSoft : `${t.ink}10`) : 'transparent' }}>
                <span style={{ fontSize: 20, fontWeight: 500, color: i === 0 && chosen ? t.accent : t.ink }}>{r.name}</span>
                <span style={{ fontSize: 16, color: t.faint }}>{r.detail}</span>
                {r.right && <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, fontSize: 16, color: t.soft }}><Dot color={t.ok} />{r.right}</span>}
                {i === 0 && chosen && <Check color={t.accent} />}
              </div>
            ))}
            <div style={{ fontSize: 17, fontWeight: 500, color: t.soft, padding: '20px 14px 6px' }}>Cloud</div>
            {rows.slice(2).map((r) => (
              <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px' }}>
                <span style={{ fontSize: 20, fontWeight: 500 }}>{r.name}</span>
                <span style={{ fontSize: 16, color: t.faint }}>{r.detail}</span>
              </div>
            ))}
          </div>
        </AppWindow>
      </In>

      <In at={96} style={{ position: 'absolute', left: 710, top: 52 }}><Label>From Claude Code, over MCP</Label></In>
      <In at={96}>
        <div style={{ position: 'absolute', left: 710, top: 96, width: 510, height: 572, background: t.codeBg, borderRadius: 16, border: `1px solid ${t.line}`, padding: '28px 26px', boxSizing: 'border-box', fontFamily: MONO, fontSize: 16.5, lineHeight: '28px' }}>
          {term.map((l, i) => f >= l.at && (
            <React.Fragment key={l.text}>
              <div style={{ marginBottom: 10, whiteSpace: 'pre' }}>
                <span style={{ color: t.accent }}>{l.prompt} </span>
                <span>{typed(f, l.at, l.end, l.text)}</span>
              </div>
              {i === 0 && f >= 140 && <div style={{ color: t.faint, marginBottom: 22, opacity: p(f, 140, 146) }}>nekko-agent connected</div>}
            </React.Fragment>
          ))}
          {tool.map((l) => f >= l.at && (
            <div key={l.text} style={{ display: 'flex', gap: 12, alignItems: 'center', opacity: p(f, l.at, l.at + 8) }}>
              <Dot color={t.accent} pulse={f < l.at + 12 ? 1 : 0} />
              <span>{l.text}</span><span style={{ color: t.faint }}>{l.meta}</span>
            </div>
          ))}
          {f >= 206 && (
            <div style={{ marginTop: 22, display: 'flex', gap: 12, alignItems: 'flex-start', fontFamily: SANS, fontSize: 21, lineHeight: '30px', opacity: p(f, 206, 216) }}>
              <span style={{ marginTop: 6 }}><Check color={t.ok} /></span>
              <span>Review from your local model.<br /><span style={{ color: t.soft }}>Nothing left this computer.</span></span>
            </div>
          )}
        </div>
      </In>
    </>
  );
}

// ─── 02 Speed ───────────────────────────────────────────────────────────────
const CODE = [
  "import { db } from './db';",
  '',
  'export async function fetchUser(id: string) {',
  '  const row = await db.users.find(id);',
  "  if (!row) throw new Error('not found');",
  '  return { id: row.id, name: row.name };',
  '}',
  '',
  'export async function listUsers() {',
  '  const rows = await db.users.all();',
  '  return Promise.all(rows.map((r) =>',
  '    fetchUser(r.id)));',
  '}',
  '',
  'export async function renameUser(id, name) {',
  '  await db.users.update(id, { name });',
  '  return fetchUser(id);',
  '}',
];
const START = 18;
/** Ollama's clock: real time to 5 s, then fast-forward to 13.9 s. */
function ollamaSeconds(f: number) {
  const real = (f - START) / FPS;
  if (real <= 5) return Math.max(0, real);
  return interpolate(f, [START + 150, START + 192], [5, 13.9], { ...clamp, easing: Easing.inOut(Easing.cubic) });
}
function Lane({ x, name, sub, seconds, total, highlight, badge }: { x: number; name: string; sub: string; seconds: number; total: number; highlight: boolean; badge?: React.ReactNode }) {
  const t = useT();
  const f = useCurrentFrame();
  const done = seconds >= total - 1e-6;
  const lines = Math.floor((seconds / total) * CODE.length);
  return (
    <div style={{ position: 'absolute', left: x, top: 60, width: 540 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <span style={{ fontSize: 30, fontWeight: 600 }}>{name}</span>
        <span style={{ fontSize: 19, color: t.faint }}>{sub}</span>
      </div>
      <div style={{ fontFamily: MONO, fontSize: 64, fontWeight: 600, marginTop: 14, color: done && highlight ? t.accent : t.ink, letterSpacing: '-0.02em' }}>
        {seconds.toFixed(1)} s{badge}
      </div>
      <div style={{ height: 4, borderRadius: 2, background: t.surface2, marginTop: 12 }}>
        <div style={{ height: 4, borderRadius: 2, width: `${(seconds / total) * 100}%`, background: highlight ? t.accent : t.faint }} />
      </div>
      <div style={{ marginTop: 22, fontFamily: MONO, fontVariantLigatures: 'none', fontSize: 15, lineHeight: '21px', color: t.soft, height: 384 }}>
        {CODE.slice(0, lines).map((l, i) => <div key={i} style={{ whiteSpace: 'pre', color: l.includes('fetchUser') ? t.ink : t.soft }}>{l || ' '}</div>)}
        {!done && f > START && <span style={{ display: 'inline-block', width: 9, height: 18, background: highlight ? t.accent : t.faint }} />}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 21, color: done ? t.ink : t.faint, height: 30 }}>
        {done ? <><Check color={highlight ? t.accent : t.soft} /> Whole file returned</> : 'Writing…'}
      </div>
    </div>
  );
}
function Speed() {
  const t = useT();
  const f = useCurrentFrame();
  const nekko = Math.min(Math.max(0, (f - START) / FPS), 2.5);
  const ollama = Math.min(ollamaSeconds(f), 13.9);
  const ff = f > START + 150 && f < START + 194;
  return (
    <>
      <In at={2}><Lane x={60} name="Nekko Agent" sub="speculative decoding on" seconds={nekko} total={2.5} highlight
        badge={f >= START + 196 && <span style={{ fontFamily: SANS, fontSize: 30, fontWeight: 600, color: t.accent, marginLeft: 24, opacity: p(f, START + 196, START + 206) }}>5.6× sooner</span>} /></In>
      <In at={2}><Lane x={680} name="Ollama" sub="0.40.11" seconds={ollama} total={13.9} highlight={false} /></In>
      <div style={{ position: 'absolute', left: 660, top: 60, bottom: 60, width: 1, background: t.line }} />
      {ff && <div style={{ position: 'absolute', right: 60, top: 70, fontFamily: MONO, fontSize: 18, color: t.warn }}>▶▶ fast-forward</div>}
      <div style={{ position: 'absolute', left: 60, right: 60, bottom: 22, display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 15, color: t.faint }}>
        <span>Rename a function, return the whole 156-line file</span>
        <span>M5 Max · Qwen3-8B · 2026-10-30 · nekkoagent.com/docs/benchmarks</span>
      </div>
    </>
  );
}

// ─── 03 Privacy ─────────────────────────────────────────────────────────────
const PII = [
  { text: 'jane.doe@acme.com', ph: '[PII_EMAIL_1]' },
  { text: '4111 1111 1111 1111', ph: '[PII_CARD_1]' },
];
function Privacy() {
  const t = useT();
  const f = useCurrentFrame();
  const message = `Tell ${PII[0].text} that card ${PII[1].text} was declined.`;
  const shown = typed(f, 12, 66, message);
  const shield = f >= 80;
  const mark = p(f, 84, 96);
  // Render the typed message with the private values marked once Shield is on.
  const parts: React.ReactNode[] = [];
  let rest = shown;
  for (const v of PII) {
    const i = rest.indexOf(v.text);
    if (i < 0) break;
    parts.push(rest.slice(0, i));
    parts.push(<span key={v.text} style={{ background: `rgba(0,0,0,0)`, boxShadow: `inset 0 -${3 * mark}px 0 ${t.accent}`, borderRadius: 2 }}>{v.text}</span>);
    rest = rest.slice(i + v.text.length);
  }
  parts.push(rest);
  const cipher = Array.from({ length: 6 }, (_, i) => ((Math.sin((f + i * 7) * 12.9898) * 43758.5453) % 1 + 1) % 1)
    .map((n) => Math.floor(n * 0xffff).toString(16).padStart(4, '0')).join(' ');
  return (
    <>
      <In at={2} style={{ position: 'absolute', left: 60, top: 52 }}><Label>Your computer</Label></In>
      <In at={2}>
        <div style={{ position: 'absolute', left: 60, top: 96, width: 600 }}>
          <div style={{ border: `1px solid ${t.line}`, borderRadius: 14, background: t.surface, padding: '18px 20px', fontSize: 25, lineHeight: '38px', minHeight: 130, boxSizing: 'border-box' }}>
            {parts}{f < 70 && <span style={{ borderLeft: `2px solid ${t.accent}`, marginLeft: 2 }} />}
          </div>
          <div style={{ display: 'flex', gap: 26, alignItems: 'center', marginTop: 16, fontSize: 20, color: t.soft }}>
            <span>Offline</span><span>Incognito</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: shield ? t.ink : t.soft, fontWeight: shield ? 600 : 400, padding: '4px 12px', borderRadius: 8, background: shield ? `${t.ink}10` : 'transparent' }}>
              <Dot color={shield ? t.accent : t.line} pulse={f >= 80 && f < 96 ? 1 : 0} /> Shield {shield && <span style={{ fontFamily: MONO, color: t.accent }}>2</span>}
            </span>
          </div>
        </div>
      </In>

      <In at={104} style={{ position: 'absolute', left: 720, top: 52 }}><Label>What the cloud model reads</Label></In>
      <In at={108}>
        <div style={{ position: 'absolute', left: 720, top: 112, width: 500, fontSize: 25, lineHeight: '42px' }}>
          Tell <span style={{ fontFamily: MONO, fontSize: 21, color: t.accent, background: t.accentSoft, padding: '2px 8px', borderRadius: 6 }}>{PII[0].ph}</span> that card <span style={{ fontFamily: MONO, fontSize: 21, color: t.accent, background: t.accentSoft, padding: '2px 8px', borderRadius: 6 }}>{PII[1].ph}</span> was declined.
          <div style={{ fontSize: 19, lineHeight: '28px', color: t.soft, marginTop: 18 }}>Real values are put back on your computer, before anything runs or is shown.</div>
        </div>
      </In>

      <div style={{ position: 'absolute', left: 60, right: 60, top: 410, height: 1, background: t.line, opacity: p(f, 140, 152) }} />
      <In at={150} style={{ position: 'absolute', left: 60, top: 450 }}><Label>Phone to computer</Label></In>
      <In at={156}>
        <div style={{ position: 'absolute', left: 60, top: 500, right: 60, display: 'flex', alignItems: 'center', gap: 28, fontSize: 24 }}>
          <span style={{ fontWeight: 600 }}>Your phone</span>
          <span style={{ flex: 1, textAlign: 'center', fontFamily: MONO, fontSize: 19, color: t.faint, borderTop: `1px dashed ${t.line}`, paddingTop: 12 }}>relay sees: {cipher}</span>
          <span style={{ fontWeight: 600 }}>Your computer</span>
        </div>
        <div style={{ position: 'absolute', left: 60, top: 580, display: 'flex', alignItems: 'center', gap: 12, fontSize: 22, color: t.soft }}>
          <svg width="20" height="22" viewBox="0 0 20 22" fill="none"><rect x="2" y="9" width="16" height="12" rx="3" stroke={t.accent} strokeWidth="2" /><path d="M6 9V6a4 4 0 0 1 8 0v3" stroke={t.accent} strokeWidth="2" /></svg>
          End-to-end encrypted. The relay can't read prompts, replies or files. Neither can we.
        </div>
      </In>
    </>
  );
}

// ─── 04 Orchestration ───────────────────────────────────────────────────────
const MACHINES = [
  { name: 'This MacBook', detail: 'M5 Max', lane: -1 },
  { name: 'Studio PC', detail: 'RTX 5090', lane: 0 },
  { name: 'Mac mini', detail: 'M4 Pro', lane: 1 },
];
const LANES = [
  { zone: 'Zone 1', model: 'Qwen3 32B', where: 'Studio PC', start: 70, ask: 'Refactor the billing module' },
  { zone: 'Zone 2', model: 'Qwen3 14B', where: 'Mac mini', start: 86, ask: 'Write tests for checkout' },
  { zone: 'Zone 3', model: 'Opus 5.5', where: 'Claude subscription', start: 102, ask: 'Review the migration plan' },
];
function Fleet() {
  const t = useT();
  const f = useCurrentFrame();
  const busy = (lane: number) => lane >= 0 && f >= LANES[lane].start + 10 && f < 222;
  return (
    <>
      <In at={2} style={{ position: 'absolute', left: 60, top: 52 }}><div style={{ fontSize: 30, fontWeight: 600 }}>Your fleet</div></In>
      <div style={{ position: 'absolute', left: 60, top: 112, width: 380 }}>
        <In at={8}><div style={{ fontSize: 18, fontWeight: 500, color: t.soft, marginBottom: 6 }}>Computers</div></In>
        {MACHINES.map((m, i) => {
          const load = m.lane >= 0 ? interpolate(f, [LANES[m.lane].start + 10, LANES[m.lane].start + 40, 214, 230], [0.06, 0.86 - i * 0.12, 0.8 - i * 0.1, 0.06], clamp) : 0.12;
          return (
            <In key={m.name} at={12 + i * 8}>
              <div style={{ padding: '12px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <Dot color={t.ok} pulse={busy(m.lane) ? (Math.sin(f / 5) + 1) / 2 : 0} />
                  <span style={{ fontSize: 23, fontWeight: 500 }}>{m.name}</span>
                  <span style={{ fontSize: 18, color: t.faint }}>{m.detail}</span>
                  <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 16, color: t.soft }}>GPU {Math.round(load * 100)}%</span>
                </div>
                <div style={{ height: 4, borderRadius: 2, background: t.surface2, marginTop: 10, marginLeft: 22 }}>
                  <div style={{ height: 4, borderRadius: 2, width: `${load * 100}%`, background: t.accent }} />
                </div>
              </div>
            </In>
          );
        })}
        <In at={40}><div style={{ fontSize: 18, fontWeight: 500, color: t.soft, margin: '28px 0 6px' }}>Cloud</div></In>
        {['Claude subscription', 'ChatGPT subscription'].map((c, i) => (
          <In key={c} at={44 + i * 6}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0' }}>
              <Dot color={t.ok} pulse={c.startsWith('Claude') && f >= LANES[2].start + 10 && f < 222 ? (Math.sin(f / 5) + 1) / 2 : 0} />
              <span style={{ fontSize: 23, fontWeight: 500 }}>{c}</span>
            </div>
          </In>
        ))}
      </div>

      <div style={{ position: 'absolute', left: 480, top: 60, bottom: 60, width: 1, background: t.line }} />

      {LANES.map((l, i) => {
        const prog = interpolate(f, [l.start + 14, 212 - i * 8], [0, 1], clamp);
        const done = prog >= 1;
        return (
          <In key={l.zone} at={l.start}>
            <div style={{ position: 'absolute', left: 520, top: 60 + i * 200, width: 700 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, fontSize: 18, color: t.soft }}>
                <span>{l.zone}</span>
                <span style={{ marginLeft: 'auto', color: t.ink, fontWeight: 500 }}>{l.model}</span>
                <span style={{ color: t.faint }}>on {l.where}</span>
              </div>
              <div style={{ fontSize: 25, fontWeight: 500, marginTop: 10 }}>{l.ask}</div>
              <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[0.92, 0.78, 0.6].map((wdt, j) => (
                  <div key={j} style={{ height: 10, borderRadius: 5, background: t.surface2, width: `${wdt * 100}%`, overflow: 'hidden' }}>
                    <div style={{ height: 10, background: `${t.soft}55`, width: `${interpolate(prog, [j / 3, (j + 1) / 3], [0, 100], clamp)}%` }} />
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, fontSize: 18, color: done ? t.ink : t.faint }}>
                {done ? <><Check size={16} color={t.ok} /> Done</> : 'Working…'}
              </div>
            </div>
          </In>
        );
      })}
    </>
  );
}

const SCENES = { local: Local, speed: Speed, privacy: Privacy, fleet: Fleet, anywhere: Anywhere } as const;

registerRoot(() => (
  <>
    {(Object.keys(SCENES) as (keyof typeof SCENES)[]).flatMap((id) =>
      (['dark', 'light'] as const).map((theme) => {
        const Scene = SCENES[id];
        const C = () => <Stage theme={theme}><Scene /></Stage>;
        return <Composition key={`${id}-${theme}`} id={`Pillar-${id}-${theme}`} component={C} durationInFrames={FRAMES} fps={FPS} width={W} height={H} />;
      }),
    )}
  </>
));
