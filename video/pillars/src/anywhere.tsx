// 05 Everywhere: a MacBook running the desktop app, an iPhone in front of it
// running the iOS app. The agent on the computer asks to run a command; the
// phone gets the push, Allow is tapped there, and both screens show the run
// pass. Wording follows the real UI: the desktop ApprovalBar ("Approval
// required", Deny / Approve) and the iOS ChatView card ("Approve this tool?",
// Deny / Allow).
import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { Cat, Check, Dot, MONO, SANS, p, useT, type Theme } from './kit';

const ASK = 52; // the agent asks
const PUSH = 66; // the phone buzzes
const CARD = 82; // the card is on the phone
const TAP = 124; // Allow tapped
const PASS = 178; // tests pass

type Stage = 'work' | 'ask' | 'running' | 'passed';
const stageAt = (f: number): Stage => (f < ASK ? 'work' : f < TAP + 6 ? 'ask' : f < PASS ? 'running' : 'passed');

function Spinner({ color, size = 12 }: { color: string; size?: number }) {
  const f = useCurrentFrame();
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" style={{ transform: `rotate(${f * 18}deg)`, flexShrink: 0 }}>
      <circle cx="6" cy="6" r="4.5" fill="none" stroke={color} strokeOpacity="0.25" strokeWidth="1.6" />
      <path d="M6 1.5a4.5 4.5 0 0 1 4.5 4.5" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

// ── The MacBook ──────────────────────────────────────────────────────────────
const MB = { x: 70, y: 34, w: 930, h: 590 };

function MacBook({ children }: { children: React.ReactNode }) {
  const t = useT();
  const dark = t.paper.startsWith('#0');
  const metal = dark
    ? { lid: '#2a2b2f', deck: 'linear-gradient(#3b3c41 0%, #2a2b2f 45%, #1b1c1f 100%)', edge: '#4a4b50', lip: '#141517' }
    : { lid: '#c9cbd0', deck: 'linear-gradient(#e9eaee 0%, #cfd1d6 50%, #a9acb2 100%)', edge: '#f4f5f7', lip: '#8e9197' };
  const bezel = 14;
  return (
    <div style={{ position: 'absolute', left: MB.x, top: MB.y, width: MB.w, height: MB.h + 34 }}>
      {/* lid */}
      <div style={{ position: 'absolute', left: 0, top: 0, width: MB.w, height: MB.h, borderRadius: '22px 22px 8px 8px', background: '#0a0a0c', boxShadow: `0 0 0 1.5px ${metal.lid}, ${t.shadow}` }}>
        <div style={{ position: 'absolute', left: bezel, top: bezel, right: bezel, bottom: bezel + 6, borderRadius: 8, overflow: 'hidden', background: t.paper }}>
          {children}
        </div>
        {/* notch */}
        <div style={{ position: 'absolute', left: MB.w / 2 - 70, top: 0, width: 140, height: bezel + 12, background: '#0a0a0c', borderRadius: '0 0 10px 10px' }}>
          <div style={{ position: 'absolute', left: 64, top: 8, width: 8, height: 8, borderRadius: 4, background: '#1d2430' }} />
        </div>
      </div>
      {/* hinge and deck */}
      <div style={{ position: 'absolute', left: 6, top: MB.h, width: MB.w - 12, height: 7, background: dark ? '#111214' : '#7d8086', borderRadius: '0 0 3px 3px' }} />
      <div style={{ position: 'absolute', left: -52, top: MB.h + 6, width: MB.w + 104, height: 18, background: metal.deck, borderRadius: '2px 2px 14px 14px', boxShadow: `inset 0 1px 0 ${metal.edge}, 0 16px 30px rgba(0,0,0,${dark ? 0.55 : 0.18})` }}>
        <div style={{ position: 'absolute', left: (MB.w + 104) / 2 - 70, top: 0, width: 140, height: 6, background: metal.lip, borderRadius: '0 0 8px 8px', opacity: 0.6 }} />
      </div>
    </div>
  );
}

function MenuBar() {
  const t = useT();
  return (
    <div style={{ height: 24, display: 'flex', alignItems: 'center', gap: 16, padding: '0 14px', fontSize: 12.5, color: t.ink, background: `${t.surface2}cc`, borderBottom: `1px solid ${t.line}` }}>
      <span style={{ fontWeight: 700 }}>Nekko Agent</span>
      {['File', 'Edit', 'View', 'Window', 'Help'].map((m) => <span key={m}>{m}</span>)}
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 14, alignItems: 'center' }}>
        <Cat size={14} /><span>Mon 9:41</span>
      </span>
    </div>
  );
}

function SideGroup({ name, count, open, children }: { name: string; count?: number; open?: boolean; children?: React.ReactNode }) {
  const t = useT();
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: t.accent, fontWeight: 500 }}>
        <span style={{ fontSize: 9, color: t.faint, transform: open ? 'rotate(90deg)' : 'none' }}>▶</span>{name}
        {count !== undefined && <span style={{ fontSize: 10, color: t.faint, background: t.surface2, borderRadius: 8, padding: '0 6px' }}>{count}</span>}
      </div>
      {children ?? <div style={{ fontSize: 11, color: t.faint, marginLeft: 15, marginTop: 4 }}>No active agents</div>}
    </div>
  );
}

function DesktopApp({ stage }: { stage: Stage }) {
  const t = useT();
  const f = useCurrentFrame();
  const working = stage === 'running';
  return (
    <div style={{ position: 'absolute', inset: 0, fontFamily: SANS, color: t.ink, background: t.paper, display: 'flex', flexDirection: 'column' }}>
      <MenuBar />
      {/* title row */}
      <div style={{ height: 40, display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', borderBottom: `1px solid ${t.line}` }}>
        {['#ff5f57', '#febc2e', '#28c840'].map((c) => <span key={c} style={{ width: 11, height: 11, borderRadius: 6, background: c }} />)}
        <span style={{ marginLeft: 10 }}><Cat size={18} /></span>
        <span style={{ fontSize: 17, fontWeight: 600 }}>Agents</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: t.soft }}>Monitors <span style={{ color: t.faint }}>1 of 6</span></span>
      </div>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* sidebar */}
        <div style={{ width: 196, padding: '6px 16px', borderRight: `1px solid ${t.line}` }}>
          <SideGroup name="Exploring" open />
          <SideGroup name="Building" open count={1}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginLeft: 15, marginTop: 6, fontSize: 12, padding: '4px 6px', borderRadius: 6, background: t.accentSoft }}>
              {stage === 'passed' ? <Check size={11} color={t.ok} /> : stage === 'ask' ? <Dot color={t.warn} /> : <Spinner color={t.accent} size={11} />}
              <span style={{ whiteSpace: 'nowrap' }}>Fix the flaky cart test</span>
            </div>
          </SideGroup>
          <SideGroup name="Verifying" open />
          <SideGroup name="Watching" open />
          <SideGroup name="Done" count={5} />
        </div>
        {/* chat zone */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{ height: 34, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', fontSize: 12.5 }}>
            <span style={{ color: t.faint }}>1</span>
            <span style={{ fontWeight: 600 }}>Fix the flaky cart test</span>
            <span style={{ marginLeft: 'auto', color: t.soft }}>Qwen3 32B</span><span style={{ color: t.faint }}>· Studio Mac</span>
          </div>
          <div style={{ flex: 1, padding: '6px 120px 6px 28px', fontSize: 14, lineHeight: 1.55, position: 'relative' }}>
            <div style={{ position: 'absolute', left: 26, bottom: 10 }}><Cat size={36} eyes={stage === 'passed' ? 'happy' : 'open'} /></div>
            <div style={{ marginLeft: 'auto', width: 'fit-content', background: t.surface2, borderRadius: 12, padding: '8px 14px' }}>The cart test fails about one run in five. Can you fix it?</div>
            <div style={{ marginTop: 16, fontSize: 12, color: t.faint }}>Took 3 steps <span style={{ color: t.accent }}>Show steps</span></div>
            <div style={{ marginTop: 6 }}>
              Found it: <b>cart.test.ts</b> checks the total before the debounced update lands. I made the test wait for the update instead of a fixed 50 ms timeout.
            </div>
            {stage !== 'work' && stage !== 'ask' && (
              <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, fontFamily: MONO, fontSize: 12, color: t.soft, opacity: p(f, TAP + 6, TAP + 14) }}>
                {working ? <Spinner color={t.accent} /> : <Check size={13} color={t.ok} />}
                <span>npm test</span>
                <span style={{ color: t.faint, fontFamily: SANS }}>{working ? 'running…' : '42 passed · 3.1 s'}</span>
                <span style={{ fontFamily: SANS, color: t.faint, marginLeft: 8 }}>Approved on iPhone</span>
              </div>
            )}
            {stage === 'passed' && <div style={{ marginTop: 8, opacity: p(f, PASS + 4, PASS + 14) }}>All 42 tests pass, ten runs in a row. The flake is gone.</div>}
          </div>
          {/* approval bar */}
          {stage === 'ask' && (
            <div style={{ borderTop: `1px solid ${t.line}`, padding: '10px 120px 10px 18px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, opacity: p(f, ASK, ASK + 8) }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={t.ink} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V13" /><path d="M12 17h.01" /></svg>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, whiteSpace: 'nowrap' }}>
                  <b>Approval required</b>
                  <span style={{ fontSize: 10, color: '#fff', background: t.warn, borderRadius: 9, padding: '1px 7px' }}>medium</span>
                  <span style={{ fontSize: 11.5, color: t.faint }}>Runs a command</span>
                </div>
                <div style={{ fontFamily: MONO, fontSize: 12, color: t.soft, marginTop: 3 }}>bash · npm test</div>
              </div>
              <span style={{ fontSize: 12, border: `1px solid ${t.line}`, borderRadius: 7, padding: '5px 11px' }}>Deny</span>
              <span style={{ fontSize: 12, background: t.accent, color: t.paper, borderRadius: 7, padding: '5px 11px', fontWeight: 600 }}>Approve</span>
            </div>
          )}
          {/* composer */}
          <div style={{ padding: '8px 120px 14px 18px', position: 'relative' }}>
            <div style={{ border: `1px solid ${t.line}`, borderRadius: 12, background: t.surface, padding: '9px 12px' }}>
              <div style={{ fontSize: 13, color: t.faint }}>Message Nekko Agent… (/ for prompts, @ to attach files)</div>
              <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 11.5, color: t.soft }}>
                <span>+</span><span style={{ color: t.ink }}>Qwen3 32B · Studio Mac ▾</span><span>Asks when it matters ▾</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── The iPhone ───────────────────────────────────────────────────────────────
const PH = { x: 912, y: 176, w: 252, h: 520 };

function IPhone({ children, t }: { children: React.ReactNode; t: Theme }) {
  const f = useCurrentFrame();
  const enter = p(f, 12, 34);
  const bob = Math.sin(f / 22) * 2;
  return (
    <div style={{ position: 'absolute', left: PH.x + (1 - enter) * 120, top: PH.y + bob, width: PH.w, height: PH.h, opacity: enter, transform: `rotate(${(1 - enter) * 4}deg)` }}>
      {/* side buttons */}
      <div style={{ position: 'absolute', left: -3, top: 108, width: 3, height: 26, borderRadius: 2, background: '#2b2c30' }} />
      <div style={{ position: 'absolute', left: -3, top: 150, width: 3, height: 46, borderRadius: 2, background: '#2b2c30' }} />
      <div style={{ position: 'absolute', right: -3, top: 150, width: 3, height: 70, borderRadius: 2, background: '#2b2c30' }} />
      <div style={{ position: 'absolute', inset: 0, borderRadius: 46, background: '#0a0a0c', boxShadow: `0 0 0 1.5px #3a3b40, 0 40px 80px rgba(0,0,0,0.45), 0 12px 24px rgba(0,0,0,0.25)` }}>
        <div style={{ position: 'absolute', inset: 9, borderRadius: 38, overflow: 'hidden', background: t.paper }}>
          {children}
          {/* Dynamic Island */}
          <div style={{ position: 'absolute', left: '50%', top: 10, width: 74, height: 22, marginLeft: -37, borderRadius: 14, background: '#000' }} />
          {/* home indicator */}
          <div style={{ position: 'absolute', left: '50%', bottom: 7, width: 96, height: 4, marginLeft: -48, borderRadius: 3, background: t.ink, opacity: 0.85 }} />
        </div>
      </div>
    </div>
  );
}

function StatusBar() {
  const t = useT();
  return (
    <div style={{ height: 44, display: 'flex', alignItems: 'center', padding: '6px 16px 0 24px', fontSize: 13, fontWeight: 600, color: t.ink }}>
      <span>9:41</span>
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center', transform: 'scale(0.86)', transformOrigin: 'right center' }}>
        <svg width="16" height="10" viewBox="0 0 16 10">{[0, 1, 2, 3].map((i) => <rect key={i} x={i * 4} y={7 - i * 2.2} width="3" height={3 + i * 2.2} rx="0.6" fill={t.ink} />)}</svg>
        <svg width="14" height="10" viewBox="0 0 14 10" fill="none" stroke={t.ink} strokeWidth="1.6" strokeLinecap="round"><path d="M1 3.5a9 9 0 0 1 12 0" /><path d="M3.3 6a5.5 5.5 0 0 1 7.4 0" /><circle cx="7" cy="8.6" r="0.9" fill={t.ink} stroke="none" /></svg>
        <svg width="24" height="11" viewBox="0 0 24 11"><rect x="0.5" y="0.5" width="20" height="10" rx="3" fill="none" stroke={t.ink} strokeOpacity="0.45" /><rect x="2" y="2" width="15" height="7" rx="1.6" fill={t.ink} /><rect x="21.5" y="3.5" width="1.8" height="4" rx="0.8" fill={t.ink} fillOpacity="0.45" /></svg>
      </span>
    </div>
  );
}

function PhoneApp({ stage }: { stage: Stage }) {
  const t = useT();
  const f = useCurrentFrame();
  const banner = p(f, PUSH, PUSH + 10) * (1 - p(f, CARD + 6, CARD + 16));
  const tap = interpolate(f, [TAP - 6, TAP, TAP + 8], [0, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const showCard = f >= CARD && stage === 'ask';
  return (
    <div style={{ position: 'absolute', inset: 0, fontFamily: SANS, color: t.ink }}>
      <StatusBar />
      {/* nav bar */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '4px 12px 8px', borderBottom: `1px solid ${t.line}` }}>
        <span style={{ fontSize: 22, color: t.accent, lineHeight: 1, width: 18 }}>‹</span>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Fix the flaky cart test</div>
          <div style={{ fontSize: 10, color: t.faint }}>Studio Mac · Qwen3 32B</div>
        </div>
        <span style={{ width: 18 }} />
      </div>
      <div style={{ padding: '10px 12px', fontSize: 11.5, lineHeight: 1.45 }}>
        <div style={{ marginLeft: 'auto', width: 'fit-content', maxWidth: '84%', background: t.accentSoft, borderRadius: 14, padding: '7px 10px' }}>The cart test fails about one run in five. Can you fix it?</div>
        <div style={{ marginTop: 10, color: t.ink }}>Found it: <b>cart.test.ts</b> checks the total before the debounced update lands. I made the test wait for it.</div>

        {showCard && (
          <div style={{ marginTop: 12, background: t.surface2, borderRadius: 14, padding: 11, opacity: p(f, CARD, CARD + 8), transform: `translateY(${(1 - p(f, CARD, CARD + 8)) * 8}px)` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600 }}>
              <span style={{ fontSize: 12 }}>✋</span> Approve this tool?
              <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 700, color: t.warn, background: `${t.warn}22`, borderRadius: 8, padding: '1px 6px' }}>Medium</span>
            </div>
            <div style={{ fontFamily: MONO, fontSize: 11, marginTop: 7 }}>bash: npm test</div>
            <div style={{ fontSize: 10.5, color: t.soft, marginTop: 4 }}>Runs a command on Studio Mac</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <span style={{ flex: 1, textAlign: 'center', fontSize: 12, padding: '8px 0', borderRadius: 8, background: `${t.soft}22` }}>Deny</span>
              <span style={{ position: 'relative', flex: 1, textAlign: 'center', fontSize: 12, fontWeight: 600, padding: '8px 0', borderRadius: 8, background: t.accent, color: t.paper, transform: `scale(${1 - tap * 0.06})` }}>
                Allow
                {f >= TAP - 2 && f < TAP + 16 && (
                  <span style={{ position: 'absolute', left: '50%', top: '50%', width: 60, height: 60, marginLeft: -30, marginTop: -30, borderRadius: 30, border: `2px solid ${t.paper}`, opacity: 1 - p(f, TAP, TAP + 14), transform: `scale(${0.3 + p(f, TAP - 2, TAP + 14)})` }} />
                )}
              </span>
            </div>
          </div>
        )}
        {(stage === 'running' || stage === 'passed') && (
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: t.soft, opacity: p(f, TAP + 6, TAP + 14) }}>
            {stage === 'running' ? <Spinner color={t.accent} size={11} /> : <Check size={12} color={t.ok} />}
            <span style={{ fontFamily: MONO }}>npm test</span>
            <span style={{ color: t.faint }}>{stage === 'running' ? 'running…' : '42 passed'}</span>
          </div>
        )}
        {stage === 'passed' && <div style={{ marginTop: 8, opacity: p(f, PASS + 4, PASS + 14) }}>All 42 tests pass, ten runs in a row. The flake is gone.</div>}
      </div>
      {/* composer */}
      <div style={{ position: 'absolute', left: 10, right: 10, bottom: 22, border: `1px solid ${t.line}`, borderRadius: 18, padding: '8px 12px', fontSize: 11, color: t.faint, background: t.surface }}>Message Nekko…</div>
      {/* push banner */}
      {banner > 0.01 && (
        <div style={{ position: 'absolute', left: 8, right: 8, top: 40, transform: `translateY(${(1 - banner) * -60}px)`, opacity: banner, background: t.surface2, border: `1px solid ${t.line}`, borderRadius: 16, padding: '9px 11px', boxShadow: '0 8px 24px rgba(0,0,0,0.25)', display: 'flex', gap: 9, alignItems: 'center' }}>
          <div style={{ width: 28, height: 28, borderRadius: 7, background: '#5a2352', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg viewBox="0 0 32 32" width="22" height="22" shapeRendering="crispEdges"><path d="M4 5H6V7H8V9H11V10H21V9H24V7H26V5H28V19H27V22H25V24H22V26H10V24H7V22H5V19H4Z" fill="#5a2352" stroke="#fff" strokeWidth="2" /><path fill="#fff" d="M11 15H13V18H11Z M20 15H22V18H20Z" /></svg>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', fontSize: 10.5, fontWeight: 600 }}>Nekko Agent<span style={{ marginLeft: 'auto', fontWeight: 400, color: t.faint }}>now</span></div>
            <div style={{ fontSize: 10.5, color: t.soft, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Approve this tool? npm test on Studio Mac</div>
          </div>
        </div>
      )}
    </div>
  );
}

export function Anywhere() {
  const t = useT();
  const f = useCurrentFrame();
  const stage = stageAt(f);
  const rise = p(f, 0, 22);
  return (
    <>
      <div style={{ position: 'absolute', inset: 0, opacity: rise, transform: `translateY(${(1 - rise) * 16}px) scale(${0.985 + rise * 0.015})`, transformOrigin: '50% 60%' }}>
        <MacBook><DesktopApp stage={stage} /></MacBook>
      </div>
      <IPhone t={t}><PhoneApp stage={stage} /></IPhone>
      <div style={{ position: 'absolute', left: 70, bottom: 14, fontSize: 15, color: t.faint, opacity: p(f, 30, 44) }}>
        macOS · Windows · Linux · iPhone · Android · iPad
      </div>
    </>
  );
}
