// Five short demos, one per Nekko Agent pillar (local first, speed, privacy,
// orchestration, everywhere), for the nekkolabs.com flagship card and
// nekkoagent.com. Each is 8 s, 1280x720, and loops: it fades in from and out
// to the plain background. Colours are the app's own tokens
// (apps/desktop/src/renderer/styles.css, :root and [data-theme='dark']), and
// the layouts follow docs/design-system.md (quiet surfaces: space and type,
// not boxes). They are illustrations, not screen recordings; the speed demo
// replays the measured times from docs/benchmarks (2026-10-30, M5 Max).
import React, { createContext, useContext } from 'react';
import {
  AbsoluteFill, Composition, Easing, interpolate, registerRoot, staticFile, useCurrentFrame,
} from 'remotion';

export const FPS = 30;
export const FRAMES = 240; // 8 s
const W = 1280, H = 720;

type Theme = {
  paper: string; win: string; surface: string; surface2: string; ink: string; soft: string;
  faint: string; line: string; accent: string; accentSoft: string; ok: string; warn: string;
  shadow: string; codeBg: string;
};
const THEMES: Record<'dark' | 'light', Theme> = {
  dark: {
    paper: '#0c0c11', win: '#17171e', surface: '#16161c', surface2: '#20202a', ink: '#eceaf3',
    soft: '#a3a1b0', faint: '#898894', line: '#26262f', accent: '#c084b5',
    accentSoft: 'rgba(192,132,181,0.18)', ok: '#4cc38a', warn: '#e5a54b',
    shadow: '0 24px 60px rgba(0,0,0,0.55)', codeBg: '#111116',
  },
  light: {
    paper: '#fbfbfd', win: '#fcfcfe', surface: '#ffffff', surface2: '#f2f2f7', ink: '#17171d',
    soft: '#52525e', faint: '#6c6c77', line: '#e8e8ef', accent: '#5a2352',
    accentSoft: 'rgba(90,35,82,0.11)', ok: '#1f8a55', warn: '#a8650c',
    shadow: '0 24px 60px rgba(40,20,50,0.14)', codeBg: '#f6f6fa',
  },
};
const Th = createContext<Theme>(THEMES.dark);
const useT = () => useContext(Th);

const fontCss = `
@font-face{font-family:'Inter Tight';font-weight:100 900;src:url(${staticFile('fonts/inter-tight-latin-wght-normal.woff2')}) format('woff2');}
@font-face{font-family:'JetBrains Mono';font-weight:100 900;src:url(${staticFile('fonts/jetbrains-mono-latin-wght-normal.woff2')}) format('woff2');}
`;
const SANS = "'Inter Tight', system-ui, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, monospace";

const ease = Easing.bezier(0.22, 1, 0.36, 1);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
/** 0 -> 1 between frames a and b, eased. */
const p = (f: number, a: number, b: number) => interpolate(f, [a, b], [0, 1], { ...clamp, easing: ease });
/** Typewriter: the first n characters of text between frames a and b. */
const typed = (f: number, a: number, b: number, text: string) =>
  text.slice(0, Math.round(interpolate(f, [a, b], [0, text.length], clamp)));

/** Enter: fade, un-blur and a small rise. */
function In({ at, children, style, dur = 12 }: { at: number; children: React.ReactNode; style?: React.CSSProperties; dur?: number }) {
  const f = useCurrentFrame();
  const v = p(f, at, at + dur);
  return <div style={{ ...style, opacity: v * ((style?.opacity as number) ?? 1), filter: `blur(${(1 - v) * 8}px)`, transform: `translateY(${(1 - v) * 14}px)` }}>{children}</div>;
}

/** The app's PixelHead (apps/desktop/src/renderer/components/Mascot.tsx). */
function Cat({ size, eyes = 'open' }: { size: number; eyes?: 'open' | 'happy' }) {
  const t = useT();
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} shapeRendering="crispEdges">
      <path d="M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z" fill={t.paper} stroke={t.ink} strokeWidth="2" strokeLinejoin="miter" />
      <path fill={t.ink} d={eyes === 'open'
        ? 'M11 15H13V18H11Z M20 15H22V18H20Z'
        : 'M9 17H10V15H11V14H12V15H13V17H12V16H10V17Z M19 17H20V15H21V14H22V15H23V17H22V16H20V17Z'} />
      <path d="M15 20H17V21H15Z" fill={t.accent} />
    </svg>
  );
}

function Dot({ color, pulse = 0 }: { color: string; pulse?: number }) {
  return <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 5, background: color, boxShadow: pulse ? `0 0 0 ${4 * pulse}px ${color}33` : 'none', flexShrink: 0 }} />;
}

function Check({ size = 18, color }: { size?: number; color: string }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3 3 7-7" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

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

// ─── 05 Everywhere ──────────────────────────────────────────────────────────
/** A mini chat as each device shows it: the ask, then the approval state. */
function MiniChat({ scale, approve, compact }: { scale: number; approve: 'ask' | 'tapping' | 'approved' | 'passed'; compact?: boolean }) {
  const t = useT();
  const s = (n: number) => n * scale;
  const state = {
    ask: { text: 'Run npm test?', color: t.warn },
    tapping: { text: 'Run npm test?', color: t.warn },
    approved: { text: 'Approved · running', color: t.accent },
    passed: { text: 'Tests passed', color: t.ok },
  }[approve];
  return (
    <div style={{ padding: s(14), fontSize: s(15), lineHeight: 1.35 }}>
      <div style={{ marginLeft: 'auto', width: 'fit-content', maxWidth: '82%', background: t.surface2, borderRadius: s(10), padding: `${s(7)}px ${s(10)}px` }}>Fix the flaky test</div>
      {!compact && <div style={{ color: t.soft, marginTop: s(10) }}>Found it: a timer race in cart.test.ts.</div>}
      <div style={{ marginTop: s(10), display: 'flex', alignItems: 'center', gap: s(7), color: t.ink, fontWeight: 600 }}>
        <Dot color={state.color} /> {state.text}
      </div>
    </div>
  );
}
function Device({ x, y, w, h, radius, label, at, children, hinge }: { x: number; y: number; w: number; h: number; radius: number; label: string; at: number; children: React.ReactNode; hinge?: boolean }) {
  const t = useT();
  return (
    <In at={at}>
      <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, borderRadius: radius, border: `3px solid ${t.ink}22`, background: t.win, overflow: 'hidden', boxShadow: t.shadow }}>
        {children}
        {hinge && <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 2, background: `${t.ink}18` }} />}
      </div>
      <div style={{ position: 'absolute', left: x, top: y + h + 14, width: w, textAlign: 'center', fontSize: 20, color: t.soft }}>{label}</div>
    </In>
  );
}
function Anywhere() {
  const t = useT();
  const f = useCurrentFrame();
  const approve = f < 132 ? 'ask' : f < 146 ? 'tapping' : f < 182 ? 'approved' : 'passed';
  const shown = f >= 96 ? approve : null;
  const tap = p(f, 132, 146);
  return (
    <>
      {/* Desktop */}
      <Device x={60} y={70} w={600} h={400} radius={14} label="macOS · Windows · Linux" at={4}>
        <div style={{ height: 40, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', borderBottom: `1px solid ${t.line}`, fontSize: 17, fontWeight: 600 }}><Cat size={20} /> Agents</div>
        {shown ? <MiniChat scale={1.5} approve={shown} /> : <MiniChat scale={1.5} approve="ask" compact />}
        <div style={{ position: 'absolute', left: 20, bottom: 18 }}><Cat size={42} eyes={approve === 'passed' ? 'happy' : 'open'} /></div>
      </Device>
      {/* Tablet */}
      <Device x={720} y={70} w={300} h={210} radius={18} label="iPad" at={24}>
        {shown && <MiniChat scale={0.95} approve={shown} />}
      </Device>
      {/* Phone */}
      <Device x={1060} y={70} w={160} h={320} radius={26} label="iPhone · Android" at={36}>
        <div style={{ paddingTop: 22 }}>{shown && <MiniChat scale={0.82} approve={shown} compact />}</div>
        {shown && f < 182 && (
          <div style={{ position: 'absolute', left: 12, right: 12, bottom: 18, textAlign: 'center', padding: '10px 0', borderRadius: 10, background: t.accent, color: t.paper, fontSize: 16, fontWeight: 600, transform: `scale(${1 - Math.sin(tap * Math.PI) * 0.08})` }}>
            {approve === 'ask' ? 'Approve' : 'Approved'}
          </div>
        )}
        {f >= 132 && f < 156 && <div style={{ position: 'absolute', left: 80 - 30 * tap, bottom: 34 - 30 * tap + 4, width: 60 * tap, height: 60 * tap, borderRadius: '50%', border: `2px solid ${t.accent}`, opacity: 1 - tap }} />}
      </Device>
      {/* Folding phone, open: two panes */}
      <Device x={720} y={350} w={300} h={200} radius={18} label="Folding phones" at={48} hinge>
        <div style={{ display: 'flex', height: '100%' }}>
          <div style={{ width: '50%', padding: 12, fontSize: 13, color: t.soft, lineHeight: 1.6 }}>
            <div style={{ color: t.ink, fontWeight: 600 }}>Chats</div>Fix the flaky test<br />Weekly report<br />Billing refactor
          </div>
          <div style={{ width: '50%' }}>{shown && <MiniChat scale={0.72} approve={shown} compact />}</div>
        </div>
      </Device>
      <In at={70} style={{ position: 'absolute', left: 60, top: 560, width: 600 }}>
        <div style={{ fontSize: 26, fontWeight: 600 }}>{approve === 'passed' ? 'Approved from your phone.' : 'One chat, on every screen.'}</div>
        <div style={{ fontSize: 19, color: t.soft, marginTop: 8 }}>The work runs on your computer. Every device is a window into it.</div>
      </In>
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
