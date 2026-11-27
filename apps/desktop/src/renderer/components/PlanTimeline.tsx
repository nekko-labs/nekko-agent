import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PlanStep } from '@nekko-agent/shared';
import { EASE_OUT } from '../easing.js';

/** A step's words for the hover card: where it sits, its status, and the agent's note or check detail. */
export type StepDetail = { status: string; detail?: string };

/** Lets the sheet record where the dots are before it switches between the line and the list. */
export type PlanTimelineHandle = { capture: () => void; afterTurn: (callback: () => void) => void };

type Point = { x: number; y: number };
type Snapshot = { dots: Map<string, Point>; line?: { start: Point; angle: number; track: number; done: number } };

/** Durations: the line turns in under 300ms; the text arrives fast behind it. Exits run about a quarter faster. */
export const TIMELINE_MOTION = { turn: 280, turnBack: 190, text: 160, textStagger: 18, textDelay: 90, textShift: 16 };

export const PLAN_FOLD_EASING = 'cubic-bezier(0.35, 0, 0.25, 1)';

const center = (el: Element): Point => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The last finished step in published order, so the line fills up to it. */
export function lastFinished(steps: Pick<PlanStep, 'status'>[]): number {
  let last = -1;
  steps.forEach((s, i) => { if (s.status === 'done' || s.status === 'skipped') last = i; });
  return last;
}

/**
 * The plan as a timeline. Folded, every step is a dot on one horizontal line,
 * each showing its status; hovering or focusing a dot shows that step's detail,
 * and clicking one opens the plan at it. Open, the same line turns to run down
 * the left edge with each step's row to its right. Switching between the two
 * moves every dot to its new place, turns and stretches the line, and slides
 * the rows in from the left.
 */
export const PlanTimeline = forwardRef<PlanTimelineHandle, {
  steps: PlanStep[];
  vertical: boolean;
  /** One status mark, drawn inside the dot. */
  renderMark: (step: PlanStep) => React.ReactNode;
  /** A full row (`<li>` with its mark and title) for the open list. */
  renderRow: (step: PlanStep) => React.ReactNode;
  describe: (step: PlanStep) => StepDetail;
  /** A dot was clicked: open the plan at that step. */
  onPick: (id: string) => void;
  /** After opening from a dot, the step to bring into view. */
  focusId?: string;
}>(function PlanTimeline({ steps, vertical, renderMark, renderRow, describe, onPick, focusId }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLSpanElement>(null);
  const fill = useRef<HTMLSpanElement>(null);
  const snapshot = useRef<Snapshot | null>(null);
  const geometry = useRef<Snapshot['line']>(undefined);
  const afterTurn = useRef<() => void>(undefined);
  const [hover, setHover] = useState<{ id: string; anchor: DOMRect } | null>(null);
  const hideTimer = useRef(0);
  // While the dots fly, their boxes are mid-transform: measuring then would lay the line short.
  const flying = useRef(false);
  const done = lastFinished(steps);

  const dots = () => [...(box.current?.querySelectorAll<HTMLElement>('[data-tl-dot]') ?? [])];

  /** Places both lines from the first dot's centre to the last (and the last finished) dot's. */
  const layLine = useCallback(() => {
    const el = box.current, t = track.current, f = fill.current;
    if (!el || !t || !f || flying.current) return;
    const all = dots();
    if (all.length < 2) { t.style.display = f.style.display = 'none'; geometry.current = undefined; return; }
    const origin = el.getBoundingClientRect();
    const first = center(all[0]), last = center(all[all.length - 1]);
    const reach = done >= 0 ? center(all[Math.min(done, all.length - 1)]) : first;
    const angle = vertical ? 90 : 0;
    const length = vertical ? last.y - first.y : last.x - first.x;
    const filled = vertical ? reach.y - first.y : reach.x - first.x;
    for (const [line, len] of [[t, length], [f, filled]] as const) {
      line.style.display = '';
      line.style.left = `${first.x - origin.left}px`;
      line.style.top = `${first.y - origin.top}px`;
      line.style.width = `${Math.max(0, len)}px`;
      line.style.transform = `rotate(${angle}deg)`;
    }
    geometry.current = { start: first, angle, track: length, done: filled };
  }, [vertical, done]);

  useImperativeHandle(ref, () => ({
    capture() {
      layLine();
      const map = new Map<string, Point>();
      for (const dot of dots()) map.set(dot.dataset.tlDot!, center(dot));
      let line = geometry.current;
      if (line && flying.current && box.current && track.current && fill.current) {
        const t = track.current, f = fill.current, origin = box.current.getBoundingClientRect();
        const matrix = new DOMMatrixReadOnly(getComputedStyle(t).transform);
        const filled = new DOMMatrixReadOnly(getComputedStyle(f).transform);
        line = {
          start: { x: origin.left + t.offsetLeft + matrix.e, y: origin.top + t.offsetTop + matrix.f },
          angle: Math.atan2(matrix.b, matrix.a) * 180 / Math.PI,
          track: t.offsetWidth * Math.hypot(matrix.a, matrix.b),
          done: f.offsetWidth * Math.hypot(filled.a, filled.b),
        };
      }
      snapshot.current = { dots: map, line };
      afterTurn.current = undefined;
    },
    afterTurn(callback) { afterTurn.current = callback; },
  }), [layLine]);

  // Keep the line on the dots as the sheet resizes.
  useLayoutEffect(() => {
    layLine();
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // Lay the line on the next frame, outside observer delivery.
    let frame = 0;
    const observer = new ResizeObserver(() => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; layLine(); }); });
    observer.observe(el);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [layLine, steps]);

  // Play the switch: dots move from where they were, the line turns and
  // stretches from its old place, and the rows arrive from the left.
  useLayoutEffect(() => {
    const before = snapshot.current;
    const finish = afterTurn.current;
    snapshot.current = null;
    afterTurn.current = undefined;
    setHover(null);
    if (!before || !box.current || !box.current.animate) { finish?.(); return; }
    const still = reduced();
    const duration = vertical ? TIMELINE_MOTION.turn : TIMELINE_MOTION.turnBack;
    // Nothing in flight should flash the sheet's scrollbars.
    const scroller = box.current.closest<HTMLElement>('.plan-sheet-scroll');
    scroller?.setAttribute('data-turning', '');
    flying.current = true;
    const played: Animation[] = [];
    const timing = { duration, easing: vertical || still ? EASE_OUT : PLAN_FOLD_EASING };
    for (const dot of dots()) {
      const from = before.dots.get(dot.dataset.tlDot!);
      if (!from) continue;
      const to = center(dot);
      if (still) played.push(dot.animate([{ opacity: 0 }, { opacity: 1 }], timing));
      else played.push(dot.animate([{ transform: `translate(${from.x - to.x}px, ${from.y - to.y}px)` }, { transform: 'none' }], timing));
    }
    const now = geometry.current, then = before.line;
    if (now && then) {
      for (const [line, oldLen, newLen] of [[track.current, then.track, now.track], [fill.current, then.done, now.done]] as const) {
        if (!line || newLen <= 0) continue;
        const end = `rotate(${now.angle}deg)`;
        if (still) { played.push(line.animate([{ opacity: 0 }, { opacity: 1 }], timing)); continue; }
        const dx = then.start.x - now.start.x, dy = then.start.y - now.start.y;
        played.push(line.animate([
          { transform: `translate(${dx}px, ${dy}px) rotate(${then.angle}deg) scaleX(${Math.max(0, oldLen) / newLen})` },
          { transform: end },
        ], timing));
      }
    }
    const rows = [...box.current.querySelectorAll<HTMLElement>('[data-tl-text]')];
    rows.forEach((row, i) => played.push(row.animate(
      still ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: `translateX(-${TIMELINE_MOTION.textShift}px)` }, { opacity: 1, transform: 'none' }],
      { duration: TIMELINE_MOTION.text, easing: EASE_OUT, delay: (vertical ? TIMELINE_MOTION.textDelay : 0) + Math.min(i, 10) * TIMELINE_MOTION.textStagger, fill: 'backwards' },
    )));
    let live = true;
    // Cancelled when the plan switches again mid-flight; either way the scrollbars come back.
    const land = () => { flying.current = false; scroller?.removeAttribute('data-turning'); layLine(); finish?.(); };
    void Promise.allSettled(played.map(a => a.finished)).then(() => { if (live) land(); });
    return () => { live = false; for (const animation of played) animation.cancel(); flying.current = false; scroller?.removeAttribute('data-turning'); };
  }, [vertical]);

  // Opened from a dot: bring that step into view.
  useEffect(() => {
    if (!vertical || !focusId) return;
    const row = [...(box.current?.querySelectorAll<HTMLElement>('[data-plan-step-id]') ?? [])].find(el => el.dataset.planStepId === focusId);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [vertical, focusId]);

  useEffect(() => () => window.clearTimeout(hideTimer.current), []);
  const show = (id: string, el: HTMLElement) => { window.clearTimeout(hideTimer.current); setHover({ id, anchor: el.getBoundingClientRect() }); };
  // A short grace keeps the card from flickering as the pointer crosses the gap between dots.
  const hide = () => { window.clearTimeout(hideTimer.current); hideTimer.current = window.setTimeout(() => setHover(null), 80); };
  const hovered = hover && steps.find(s => s.id === hover.id);
  const index = hovered ? steps.indexOf(hovered) : -1;
  const info = hovered && describe(hovered);

  return <div ref={box} className="plan-timeline" data-plan-timeline={vertical ? 'vertical' : 'horizontal'}>
    <span ref={track} className="plan-timeline-line" aria-hidden />
    <span ref={fill} className="plan-timeline-line" data-filled aria-hidden />
    {vertical
      ? <ol className="plan-sheet-steps plan-timeline-rows">{steps.map(renderRow)}</ol>
      : <ol className="plan-timeline-dots" aria-label="Plan steps">
          {steps.map((step, i) => {
            const d = describe(step);
            return <li key={step.id} className="plan-timeline-stop">
              <button type="button" className="plan-timeline-dot" data-tl-dot={step.id} data-plan-dot={step.status}
                aria-label={`Step ${i + 1} of ${steps.length}: ${step.title}. ${d.status}`}
                aria-describedby={hover?.id === step.id ? 'plan-timeline-card' : undefined}
                onPointerEnter={e => show(step.id, e.currentTarget)} onPointerLeave={hide}
                onFocus={e => show(step.id, e.currentTarget)} onBlur={hide}
                onClick={() => onPick(step.id)}>
                {renderMark(step)}
              </button>
            </li>;
          })}
        </ol>}
    {hovered && info && typeof document !== 'undefined' && createPortal(
      <TimelineCard anchor={hover!.anchor} place={`Step ${index + 1} of ${steps.length}`} title={hovered.title} pass={hovered.pass} status={info.status} detail={info.detail} />,
      document.body,
    )}
  </div>;
});

/** The hover card: above the dot, kept on screen, no pointer events of its own. */
function TimelineCard({ anchor, place, title, status, detail, pass }: { anchor: DOMRect; place: string; title: string; pass?: number } & StepDetail) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left + anchor.width / 2 - r.width / 2, window.innerWidth - r.width - 8));
    const above = anchor.top - r.height - 8;
    el.style.left = `${left}px`;
    el.style.top = `${above >= 8 ? above : anchor.bottom + 8}px`;
  }, [anchor, title, detail]);
  return <div ref={ref} id="plan-timeline-card" className="plan-timeline-card" role="tooltip">
    <div className="plan-timeline-card-meta">{place} · {status}{pass && pass > 1 ? ` · Pass ${pass}` : ''}</div>
    <div className="plan-timeline-card-title" dir="auto">{title}</div>
    {detail && <div className="plan-timeline-card-detail" dir="auto">{detail}</div>}
  </div>;
}
