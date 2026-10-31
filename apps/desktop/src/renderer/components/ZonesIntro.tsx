import React, { useId, useState } from 'react';
import { Player } from '@remotion/player';
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Modal } from './primitives/Modal.js';
import { CloseIcon } from '../icons.js';

/*
 * The first-visit intro to zones on the Agent board: three short looping
 * demos drawn with Remotion, each with its explanation underneath. The demos
 * are a simplified board, not screenshots, and paint with the app's own
 * colour variables so they match the light or dark theme.
 */

/** Every colour, curve and spring the demos use. */
const theme = {
  colors: {
    bg: 'var(--surface-2)',
    glow: 'var(--accent-soft)',
    win: 'var(--win)',
    line: 'var(--line)',
    ink: 'var(--ink)',
    soft: 'var(--ink-soft)',
    faint: 'var(--ink-faint)',
    accent: 'var(--accent)',
    accentSoft: 'var(--accent-soft)',
    shadow: 'rgba(0, 0, 0, 0.18)',
  },
  ease: {
    out: Easing.bezier(0.16, 1, 0.3, 1),
    inOut: Easing.bezier(0.83, 0, 0.17, 1),
    in: Easing.bezier(0.7, 0, 0.84, 0),
  },
  spring: {
    snappy: { damping: 14, stiffness: 160, mass: 0.6 },
    smooth: { damping: 20, stiffness: 90, mass: 1 },
  },
  font: 'var(--font-sans, system-ui, sans-serif)',
} as const;

const W = 640;
const H = 400;
const FPS = 30;
const GAP = 10;
/** The board inside each demo. */
const BOARD = { x: 24, y: 24, w: 592, h: 352 };

type Ease = (t: number) => number;
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
/** Seconds to frames. */
const useAt = () => { const { fps } = useVideoConfig(); return (s: number) => Math.round(s * fps); };
const tween = (frame: number, range: [number, number], to: [number, number], easing: Ease = theme.ease.inOut) => interpolate(frame, range, to, { ...clamp, easing });
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const pop = (frame: number, at: number, fps: number, config: { damping: number; stiffness: number; mass: number } = theme.spring.snappy) => spring({ frame: frame - at, fps, config });

/** The soft drifting glow every demo sits on. */
function Backdrop() {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: theme.colors.bg, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', width: 520, height: 520, borderRadius: '50%', left: -160 + Math.sin(frame / 55) * 30, top: -240, filter: 'blur(40px)', background: `radial-gradient(circle, ${theme.colors.glow}, transparent 65%)` }} />
      <div style={{ position: 'absolute', width: 420, height: 420, borderRadius: '50%', right: -160 - Math.cos(frame / 70) * 24, bottom: -220, filter: 'blur(50px)', background: `radial-gradient(circle, ${theme.colors.glow}, transparent 65%)`, opacity: 0.7 }} />
    </AbsoluteFill>
  );
}

/** Whole-scene entrance and a faster exit, so the loop restarts cleanly. */
function Scene({ children }: { children: React.ReactNode }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const out = tween(frame, [durationInFrames - 10, durationInFrames - 1], [0, 1], theme.ease.in);
  return (
    <AbsoluteFill style={{ fontFamily: theme.font, opacity: 1 - out, transform: `translateY(${out * -12}px)` }}>
      <Backdrop />
      {children}
    </AbsoluteFill>
  );
}

interface Box { x: number; y: number; w: number; h: number }

/** Faint text lines standing in for a transcript. */
function Lines({ seed, width }: { seed: number; width: number }) {
  const lens = [0.86, 0.62, 0.78, 0.48, 0.7].map((l, i) => ((l + seed * 0.13 * (i + 1)) % 0.5) + 0.4);
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 7, padding: '10px 12px' }}>
    {lens.map((l, i) => <div key={i} style={{ height: 6, width: Math.max(0, (width - 24) * l), borderRadius: 3, background: theme.colors.line }} />)}
  </div>;
}

/** One zone: its name bar over an agent window, or a dotted empty zone. */
function Zone({ box, name, agent, active, drop, lift = 0, enter = 1, seed = 0, swap }: {
  box: Box; name: string; agent?: string; active?: boolean; drop?: boolean; lift?: number; enter?: number; seed?: number;
  /** 0..1: the agent window being replaced by `swap.agent`. */
  swap?: { agent: string; t: number };
}) {
  const frame = useCurrentFrame();
  if (box.w < 2) return null;
  const breathe = Math.sin((frame + seed * 17) / 26) * 0.6;
  const ring = active || drop ? `2px solid ${theme.colors.accent}` : `1px solid ${theme.colors.line}`;
  const window = (title: string, style: React.CSSProperties) => (
    <div style={{ position: 'absolute', inset: 0, borderRadius: 9, background: drop ? theme.colors.accentSoft : theme.colors.win, border: ring, overflow: 'hidden', ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 22, padding: '0 9px', borderBottom: `1px solid ${theme.colors.line}`, fontSize: 10.5, fontWeight: 600, color: theme.colors.ink, whiteSpace: 'nowrap', overflow: 'hidden' }}>
        <span style={{ width: 6, height: 6, borderRadius: 3, background: theme.colors.accent, flexShrink: 0 }} />{title}
      </div>
      <Lines seed={seed + title.length} width={box.w} />
    </div>
  );
  return (
    <div style={{
      position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h,
      opacity: enter, transform: `translateY(${(1 - enter) * 18 - lift * 6 + breathe * (lift ? 1 : 0)}px) scale(${mix(0.94, 1, enter) + lift * 0.03}) rotate(${lift * -1.5}deg)`,
      filter: lift ? `drop-shadow(0 ${14 * lift}px ${18 * lift}px ${theme.colors.shadow})` : undefined,
      zIndex: lift ? 5 : 1,
    }}>
      <div style={{ height: 15, fontSize: 9.5, fontWeight: 600, letterSpacing: '0.02em', color: active ? theme.colors.accent : theme.colors.faint, padding: '0 4px' }}>{name}</div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 18, bottom: 0 }}>
        {agent
          ? <>
            {window(agent, swap ? { opacity: 1 - swap.t, transform: `translateY(${swap.t * 14}px) scale(${1 - swap.t * 0.04})` } : {})}
            {swap && window(swap.agent, { opacity: swap.t, transform: `translateY(${(1 - swap.t) * -10}px) scale(${mix(0.96, 1, swap.t)})` })}
          </>
          : <div style={{ position: 'absolute', inset: 0, borderRadius: 9, border: `${active || drop ? 2 : 1.5}px dotted ${active || drop ? theme.colors.accent : theme.colors.faint}`, background: drop ? theme.colors.accentSoft : 'transparent', display: 'grid', placeItems: 'center', fontSize: 11, color: theme.colors.faint }}>Empty zone</div>}
      </div>
    </div>
  );
}

/** The pointer, pressed in at `press` (0..1). */
function Cursor({ x, y, press = 0, show = 1 }: { x: number; y: number; press?: number; show?: number }) {
  return (
    <svg width="18" height="22" viewBox="0 0 18 22" style={{ position: 'absolute', left: x - 2, top: y - 2, opacity: show, transform: `scale(${1 - press * 0.16})`, transformOrigin: '2px 2px', zIndex: 20, filter: `drop-shadow(0 2px 3px ${theme.colors.shadow})` }}>
      <path d="M2 2 L2 17 L6 13 L9 20 L12 19 L9 12 L15 12 Z" fill={theme.colors.win} stroke={theme.colors.ink} strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

/** A thin plus in the rail beside the board. */
function RailPlus({ x, y, hot = 0, show = 1 }: { x: number; y: number; hot?: number; show?: number }) {
  return (
    <div style={{ position: 'absolute', left: x - 8, top: y - 8, width: 16, height: 16, borderRadius: 5, display: 'grid', placeItems: 'center', opacity: show * mix(0.5, 1, hot), background: hot ? theme.colors.accentSoft : 'transparent', color: hot ? theme.colors.accent : theme.colors.faint, transform: `scale(${1 + hot * 0.25})` }}>
      <svg width="10" height="10" viewBox="0 0 10 10"><path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
    </div>
  );
}

/** A pointer path through timed stops, eased between each. */
function along(frame: number, stops: Array<[number, number, number]>): { x: number; y: number } {
  if (frame <= stops[0][0]) return { x: stops[0][1], y: stops[0][2] };
  for (let i = 1; i < stops.length; i++) {
    const [t0, x0, y0] = stops[i - 1];
    const [t1, x1, y1] = stops[i];
    if (frame <= t1) { const t = tween(frame, [t0, t1], [0, 1]); return { x: mix(x0, x1, t), y: mix(y0, y1, t) }; }
  }
  const last = stops[stops.length - 1];
  return { x: last[1], y: last[2] };
}

/** Columns across the board for `n` zones (n may be fractional mid-animation), by weight. */
function columns(weights: number[], area = BOARD): Box[] {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const gaps = GAP * Math.max(0, weights.filter((w) => w > 0.001).length - 1);
  let x = area.x;
  return weights.map((w) => {
    const width = ((area.w - gaps) * w) / total;
    const box = { x, y: area.y, w: width, h: area.h };
    x += width + (w > 0.001 ? GAP : 0);
    return box;
  });
}

/* ---------- 1. Two zones, then a third ---------- */

function TwoZonesDemo() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const at = useAt();
  const grow = tween(frame, [at(2.7), at(3.2)], [0, 1]);
  const [a, b, c] = columns([1, 1, grow]);
  const press = pop(frame, at(2.55), fps) - pop(frame, at(2.7), fps);
  const hot = tween(frame, [at(1.9), at(2.1)], [0, 1], theme.ease.out) * (1 - tween(frame, [at(3.1), at(3.3)], [0, 1], theme.ease.out));
  const ghost = hot * (1 - grow);
  const final = columns([1, 1, 1])[2];
  const cursor = along(frame, [[at(1), 560, 380], [at(2), BOARD.x + BOARD.w + 8, 200], [at(3.4), BOARD.x + BOARD.w + 8, 200], [at(4.2), 470, 330]]);
  return (
    <Scene>
      <Zone box={a} name="Zone 1" agent="Research pricing" active enter={pop(frame, at(0.1), fps, theme.spring.smooth)} seed={1} />
      <Zone box={b} name="Zone 2" agent="Fix login bug" enter={pop(frame, at(0.25), fps, theme.spring.smooth)} seed={2} />
      {grow > 0 && <Zone box={c} name="Zone 3" enter={pop(frame, at(2.75), fps)} />}
      {ghost > 0.01 && <div style={{ position: 'absolute', left: final.x, top: final.y + 18, width: final.w, height: final.h - 18, borderRadius: 9, border: `2px dotted ${theme.colors.accent}`, background: theme.colors.accentSoft, opacity: ghost * 0.9, transform: `scale(${mix(0.97, 1, ghost)})` }} />}
      <RailPlus x={BOARD.x + BOARD.w + 8} y={200} hot={hot} show={tween(frame, [at(0.5), at(0.8)], [0, 1], theme.ease.out)} />
      <RailPlus x={320} y={BOARD.y + BOARD.h + 10} show={tween(frame, [at(0.6), at(0.9)], [0, 1], theme.ease.out)} />
      <Cursor {...cursor} press={press} show={tween(frame, [at(0.9), at(1.2)], [0, 1], theme.ease.out)} />
    </Scene>
  );
}

/* ---------- 2. Move a zone, then close one ---------- */

function MoveZonesDemo() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const at = useAt();
  const lift = pop(frame, at(1.2), fps) * (1 - pop(frame, at(2.5), fps, theme.spring.smooth));
  const travel = tween(frame, [at(1.3), at(2.4)], [0, 1]);
  const fold = tween(frame, [at(4.05), at(4.45)], [0, 1]);
  // Zone 1 travels from the first slot to the last; 2 and 3 slide left under it.
  const slots = columns([1, 1, 1 - fold]);
  const two = columns([1, 1 - fold]);
  const pos = (from: number, to: number) => ({ x: mix(slots[from].x, slots[to].x, travel), w: slots[from].w });
  const z1 = fold > 0 ? { ...two[1] } : { ...pos(0, 2), y: BOARD.y, h: BOARD.h };
  const z2 = fold > 0 ? { ...two[0] } : { ...pos(1, 0), y: BOARD.y, h: BOARD.h };
  const z3 = { ...pos(2, 1), y: BOARD.y, h: BOARD.h, w: slots[1].w * (1 - fold) };
  const grab = { x: 60, y: 30 };
  const cursor = along(frame, [[at(0.6), 300, 300], [at(1.1), grab.x, grab.y], [at(1.3), grab.x, grab.y], [at(2.4), slots[2].x + 36, grab.y], [at(2.9), slots[2].x + 36, grab.y], [at(3.3), z3.x + 40, grab.y], [at(3.75), z3.x + 40, grab.y], [at(3.95), z3.x + 70, grab.y + 34], [at(4.6), 330, 320]]);
  const held = { x: cursor.x - grab.x + BOARD.x, w: slots[0].w };
  const menu = pop(frame, at(3.45), fps) * (1 - tween(frame, [at(4.0), at(4.15)], [0, 1], theme.ease.in));
  const press = (t: number) => pop(frame, at(t), fps) - pop(frame, at(t + 0.15), fps);
  return (
    <Scene>
      <Zone box={z2} name="Zone 2" agent="Fix login bug" enter={pop(frame, at(0.15), fps, theme.spring.smooth)} seed={2} />
      <Zone box={z3} name="Zone 3" enter={pop(frame, at(0.25), fps, theme.spring.smooth) * (1 - fold)} />
      {lift > 0.02 && travel < 1 && <div style={{ position: 'absolute', left: mix(slots[0].x, slots[2].x, travel), top: BOARD.y + 18, width: slots[0].w, height: BOARD.h - 18, borderRadius: 9, border: `2px dotted ${theme.colors.accent}`, background: theme.colors.accentSoft, opacity: lift }} />}
      <Zone box={lift > 0.02 ? { x: held.x, y: BOARD.y, w: held.w, h: BOARD.h } : z1} name="Zone 1" agent="Research pricing" lift={lift} enter={pop(frame, at(0.05), fps, theme.spring.smooth)} seed={1} />
      {menu > 0.01 && <div style={{ position: 'absolute', left: z3.x + 40, top: grab.y + 14, width: 128, padding: 5, borderRadius: 9, background: theme.colors.win, border: `1px solid ${theme.colors.line}`, boxShadow: `0 10px 24px ${theme.colors.shadow}`, opacity: menu, transform: `translateY(${(1 - menu) * -6}px) scale(${mix(0.94, 1, menu)})`, transformOrigin: 'top left', zIndex: 10 }}>
        <div style={{ padding: '6px 8px', borderRadius: 6, fontSize: 11, color: theme.colors.ink, background: frame > at(3.9) ? theme.colors.accentSoft : 'transparent' }}>Close zone</div>
      </div>}
      <Cursor {...cursor} press={Math.max(press(1.15), press(3.45), press(4.0))} show={tween(frame, [at(0.5), at(0.8)], [0, 1], theme.ease.out)} />
    </Scene>
  );
}

/* ---------- 3. Change the agent in a zone ---------- */

const PANEL = { x: 24, y: 24, w: 156, h: 352 };
const AGENTS = ['Research pricing', 'Fix login bug', 'Draft onboarding', 'Refactor sync', 'Write release notes', 'Triage issues', 'Update docs', 'Plan Q4'];
const ROW = 32;
/** Where the panel's list starts, under its heading. */
const LIST_TOP = 28;

function SwapAgentDemo() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const at = useAt();
  const area = { x: PANEL.x + PANEL.w + 12, y: BOARD.y, w: BOARD.w - PANEL.w - 12, h: BOARD.h };
  const [z1, z2] = columns([1, 1], area);
  const scroll = tween(frame, [at(1.0), at(1.6)], [0, -ROW * 2.2]);
  const rowY = (i: number) => PANEL.y + 34 + i * ROW + scroll;
  const swap = tween(frame, [at(2.3), at(2.75)], [0, 1], theme.ease.out);
  const pick = 4; // Write release notes
  const dragged = 5; // Triage issues
  const chipLift = pop(frame, at(3.65), fps);
  const chipTravel = tween(frame, [at(3.7), at(4.5)], [0, 1]);
  const land = tween(frame, [at(4.6), at(5.0)], [0, 1], theme.ease.out);
  const landed = frame >= at(5.0);
  const rowBox = { x: PANEL.x + 6, y: rowY(dragged), w: PANEL.w - 12, h: ROW - 6 };
  const cursor = along(frame, [[at(0.6), 300, 330], [at(0.95), 100, 220], [at(1.7), 100, 220], [at(2.0), 90, rowY(pick) + 12], [at(3.3), 90, rowY(pick) + 12], [at(3.6), 90, rowY(dragged) + 12], [at(3.7), 90, rowY(dragged) + 12], [at(4.5), z1.x + z1.w / 2, z1.y + z1.h / 2], [at(5.6), z1.x + z1.w / 2 + 20, z1.y + z1.h / 2 + 60]]);
  const over = frame >= at(4.2) && frame < at(4.6);
  const chip = {
    x: mix(mix(rowBox.x, cursor.x - 40, chipTravel), z1.x, land),
    y: mix(mix(rowBox.y, cursor.y - 12, chipTravel), z1.y + 18, land),
    w: mix(rowBox.w, z1.w, land),
    h: mix(rowBox.h, z1.h - 18, land),
  };
  const press = (t: number) => pop(frame, at(t), fps) - pop(frame, at(t + 0.15), fps);
  return (
    <Scene>
      <div style={{ position: 'absolute', left: PANEL.x, top: PANEL.y, width: PANEL.w, height: PANEL.h, borderRadius: 10, background: theme.colors.win, border: `1px solid ${theme.colors.line}`, overflow: 'hidden', opacity: pop(frame, 0, fps, theme.spring.smooth) }}>
        <div style={{ position: 'absolute', left: 10, top: 9, fontSize: 10.5, fontWeight: 700, color: theme.colors.ink }}>Agents</div>
        {/* The list scrolls under the heading, never over it. */}
        <div style={{ position: 'absolute', left: 0, right: 0, top: LIST_TOP, bottom: 0, overflow: 'hidden' }}>
        {AGENTS.map((name, i) => {
          const enter = pop(frame, at(0.1) + i * 3, fps);
          const chosen = (i === pick && frame >= at(2.2)) || (i === dragged && landed);
          return <div key={name} style={{ position: 'absolute', left: 6, right: 6, top: rowY(i) - PANEL.y - LIST_TOP, height: ROW - 6, borderRadius: 7, display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', fontSize: 10.5, color: theme.colors.soft, background: chosen ? theme.colors.accentSoft : 'transparent', opacity: enter * (i === dragged && chipLift > 0.05 && !landed ? 0.35 : 1), transform: `translateX(${(1 - enter) * -10}px)` }}>
            <span style={{ width: 6, height: 6, borderRadius: 3, background: i % 3 === 0 ? theme.colors.accent : theme.colors.faint }} />{name}
          </div>;
        })}
        </div>
      </div>
      <Zone box={z1} name="Zone 1" agent={landed ? AGENTS[dragged] : 'Research pricing'} active={landed} drop={over} enter={pop(frame, at(0.2), fps, theme.spring.smooth)} seed={1} />
      <Zone box={z2} name="Zone 2" agent="Fix login bug" active={!landed} swap={swap > 0 ? { agent: AGENTS[pick], t: swap } : undefined} enter={pop(frame, at(0.3), fps, theme.spring.smooth)} seed={2} />
      {chipLift > 0.02 && !landed && <div style={{ position: 'absolute', left: chip.x, top: chip.y, width: chip.w, height: chip.h, borderRadius: mix(7, 9, land), background: theme.colors.win, border: `${land > 0 ? 2 : 1}px solid ${theme.colors.accent}`, boxShadow: `0 ${12 * chipLift}px ${26 * chipLift}px ${theme.colors.shadow}`, transform: `rotate(${(1 - land) * -1.5 * chipLift}deg)`, zIndex: 15, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: ROW - 6, padding: '0 8px', fontSize: 10.5, color: theme.colors.ink, opacity: 1 - land }}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: theme.colors.faint }} />{AGENTS[dragged]}
        </div>
      </div>}
      <Cursor {...cursor} press={Math.max(press(2.15), chipLift > 0.05 && chipTravel < 1 ? 0.6 : 0)} show={tween(frame, [at(0.5), at(0.8)], [0, 1], theme.ease.out)} />
    </Scene>
  );
}

const STEPS = [
  {
    title: 'Your board starts with two zones',
    body: 'Each zone holds one agent. To add a zone, use the thin plus buttons along the right and bottom edges of the board. A new zone fits the row or column you add it to; the plus at the end of an edge (or Shift-click) spans the full height or width.',
    demo: TwoZonesDemo,
    seconds: 6,
  },
  {
    title: 'Move, resize and close zones',
    body: "Drag a zone by its name bar to move it, and drag the gaps between zones to resize them. Dropped at a board edge it fits that row; hold Shift to span the whole side. Right-click a zone's name bar to close it. Closing or minimizing an agent keeps its zone, drawn dotted until you fill it.",
    demo: MoveZonesDemo,
    seconds: 6,
  },
  {
    title: 'Change the agent in a zone',
    body: 'Click a zone to make it active; it gets a heavier outline. Then scroll the agents panel and click any agent to show it in that zone, or drag an agent from the panel straight into a zone. New agents wait in the panel instead of opening on the board.',
    demo: SwapAgentDemo,
    seconds: 6.5,
  },
];

/** The first-visit intro to zones. Closing it (any way) marks it seen. */
export function ZonesIntro({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const titleId = useId();
  const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const current = STEPS[step];
  const last = step === STEPS.length - 1;
  const frames = Math.round(current.seconds * FPS);
  return (
    <Modal title="Zones" labelledBy={titleId} onClose={onClose} overlayClassName="p-4" className="card zones-intro w-full max-w-[600px] p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id={titleId} className="text-base font-semibold">Agents now live in zones</h2>
        <button className="rounded-sm p-1 text-ink-faint hover:text-ink" onClick={onClose} aria-label="Close"><CloseIcon className="h-4 w-4" /></button>
      </div>
      <div className="zones-intro-demo" aria-hidden data-zones-intro-step={step}>
        <Player
          key={step}
          component={current.demo}
          durationInFrames={frames}
          fps={FPS}
          compositionWidth={W}
          compositionHeight={H}
          style={{ width: '100%', aspectRatio: `${W} / ${H}` }}
          loop
          autoPlay={!reduced}
          // Reduced motion shows one telling frame, still.
          initialFrame={reduced ? Math.round(frames * 0.6) : 0}
          controls={false}
          clickToPlay={false}
        />
      </div>
      <h3 className="mt-4 text-sm font-semibold">{current.title}</h3>
      <p className="mt-1 text-xs leading-relaxed text-ink-soft">{current.body}</p>
      <div className="mt-4 flex items-center gap-3">
        <div className="flex gap-1.5" role="group" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
          {STEPS.map((s, i) => <button key={s.title} type="button" className="zones-intro-dot" aria-label={`Step ${i + 1}: ${s.title}`} aria-current={i === step || undefined} onClick={() => setStep(i)} />)}
        </div>
        <div className="ml-auto flex gap-2">
          {step > 0 && <button type="button" className="btn btn-ghost" onClick={() => setStep(step - 1)}>Back</button>}
          <button type="button" className="btn btn-primary" onClick={() => (last ? onClose() : setStep(step + 1))}>{last ? 'Get started' : 'Next'}</button>
        </div>
      </div>
    </Modal>
  );
}

export default ZonesIntro;
