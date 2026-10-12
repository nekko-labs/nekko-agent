/**
 * Code the harness injects into the page. Each probe measures in the page's own
 * clock: from the input event's timestamp (when the browser received it) to
 * the end of the first frame that shows the effect.
 *
 * "End of the frame" is a requestAnimationFrame callback followed by a
 * MessageChannel tick: the rAF runs in the frame's rendering step, style,
 * layout and paint follow it in the same task, and the posted message runs in
 * the next task, after the frame has been produced.
 */

/** Pure DOM helpers shared by the probes, as page-side source. */
const HELPERS = String.raw`
  const afterFrame = (fn) => requestAnimationFrame(() => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => fn(performance.now());
    ch.port2.postMessage(0);
  });
  // Transcript-only wall windows have a separate shared composer. Locate the
  // titled transcript itself; a composer is not evidence that history painted.
  const visiblePanel = (title) => {
    for (const panel of document.querySelectorAll('.panel')) {
      if (!panel.checkVisibility()) continue;
      const strip = panel.firstElementChild?.querySelector('span.truncate');
      const scroller = panel.querySelector('[data-transcript-scroll]');
      if (strip?.textContent === title && scroller?.checkVisibility()) return panel;
    }
    return null;
  };
  // The newest assistant reply is laid out and inside the transcript's viewport.
  const newestVisible = (panel, marker) => {
    const all = panel.querySelectorAll('.msg-ai');
    const last = all[all.length - 1];
    if (!last || !last.textContent.includes(marker)) return false;
    const r = last.getBoundingClientRect();
    const sc = last.closest('.overflow-y-auto');
    const v = sc ? sc.getBoundingClientRect() : { top: 0, bottom: innerHeight };
    return r.height > 0 && r.bottom > v.top && r.top < v.bottom;
  };
`;

export const INSTALL = String.raw`(() => {
  if (window.__perf) return true;
  ${HELPERS}
  const P = (window.__perf = { keys: [], eventTiming: [] });

  // --- Keypress to paint in the composer (a textarea, or the editable markdown surface) ---
  let keyAt = null;
  const isTerminal = (el) => !!(el && el.classList && el.classList.contains('xterm-helper-textarea'));
  const isComposer = (el) => !!el && ((el.tagName === 'TEXTAREA' && !isTerminal(el)) || el.isContentEditable === true);
  document.addEventListener('keydown', (e) => {
    if (isComposer(e.target) && e.key.length === 1) keyAt = e.timeStamp;
  }, true);
  // Registered from the input event, which is where the value (and React's
  // controlled state) changes, so the frame that follows includes the commit.
  document.addEventListener('input', (e) => {
    if (keyAt == null || !isComposer(e.target)) return;
    const start = keyAt;
    keyAt = null;
    afterFrame((now) => P.keys.push(now - start));
  }, true);
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!P.recordEvents) continue;
        P.eventTiming.push({ name: e.name, duration: e.duration, processing: e.processingEnd - e.processingStart });
      }
    }).observe({ type: 'event', durationThreshold: 16 });
  } catch { /* Event Timing unavailable */ }
  // Long animation frames (50 ms or more) with the scripts that ran in them,
  // so a slow sample can say where its time went (the occasional 100 ms
  // switch). Only the newest few hundred are kept.
  P.loaf = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        P.loaf.push({
          start: e.startTime, duration: e.duration, blocking: e.blockingDuration,
          render: e.renderStart ? e.startTime + e.duration - e.renderStart : 0,
          styleLayout: e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0,
          scripts: (e.scripts ?? []).map((x) => ({ invoker: x.invoker, source: (x.sourceURL || '').split('/').pop() + (x.sourceFunctionName ? ':' + x.sourceFunctionName : ''), duration: Math.round(x.duration), forcedLayout: Math.round(x.forcedStyleAndLayoutDuration || 0) })),
        });
        if (P.loaf.length > 300) P.loaf.splice(0, P.loaf.length - 300);
      }
    }).observe({ type: 'long-animation-frame', buffered: false });
  } catch { /* Long Animation Frames unavailable */ }

  // --- Keypress to paint in a terminal ---
  // Timed to the frame after the echo is drawn: the key goes to the pty, the
  // shell echoes it back as terminal output, the pane hands that to xterm, and
  // xterm draws it on its next animation frame. Two task hops let the pane's
  // own listener (registered after this one) and xterm's write queue run
  // first, so the frame measured is the one that shows the character.
  P.term = [];
  // When the echo reached the page, before any drawing: the pty round trip.
  P.termEcho = [];
  let termKey = null;
  document.addEventListener('keydown', (e) => {
    if (isTerminal(e.target) && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) termKey = { at: e.timeStamp, ch: e.key };
  }, true);
  if (window.nekko && window.nekko.onTerminalEvent) {
    window.nekko.onTerminalEvent((ev) => {
      if (!termKey || ev.type !== 'data' || !ev.data.includes(termKey.ch)) return;
      const start = termKey.at;
      termKey = null;
      P.termEcho.push(performance.now() - start);
      setTimeout(() => setTimeout(() => afterFrame((now) => P.term.push(now - start)), 0), 0);
    });
  }

  /** Resolve once a chat's frame and newest reply are both painted. */
  P.waitForChat = (title, marker, timeoutMs = 20000) => new Promise((resolve) => {
    const deadline = performance.now() + timeoutMs;
    const loop = () => requestAnimationFrame(() => {
      const panel = visiblePanel(title);
      if (panel && newestVisible(panel, marker)) return resolve(true);
      if (performance.now() > deadline) return resolve(false);
      loop();
    });
    loop();
  });

  /**
   * Arm a switch measurement: the next click starts the clock, and the result
   * records when the target chat's frame, then its newest reply, first painted.
   */
  P.armSwitch = (title, marker, timeoutMs = 15000) => {
    P.switchResult = null;
    let start = null;
    let sawFrame = false;
    let sawHistory = false;
    const res = {};
    const finish = () => {
      const end = start + Math.max(res.frame ?? 0, res.history ?? 0);
      res.loaf = P.loaf.filter((e) => e.start + e.duration >= start && e.start <= end);
      P.switchResult = res;
    };
    const loop = () => requestAnimationFrame(() => {
      const panel = visiblePanel(title);
      const frameNow = !sawFrame && !!panel;
      const historyNow = !sawHistory && !!panel && newestVisible(panel, marker);
      if (frameNow) sawFrame = true;
      if (historyNow) sawHistory = true;
      if (frameNow || historyNow) {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => {
          const d = performance.now() - start;
          if (frameNow) res.frame = d;
          if (historyNow) res.history = d;
          if (res.frame != null && res.history != null) finish();
        };
        ch.port2.postMessage(0);
      }
      if (sawFrame && sawHistory) return;
      if (performance.now() - start > timeoutMs) { res.timeout = true; finish(); return; }
      loop();
    });
    document.addEventListener('click', (e) => { start = e.timeStamp; loop(); }, { capture: true, once: true });
  };
  /** The window whose title strip reads "title", visible or not. */
  P.panel = (title) => [...document.querySelectorAll('.panel')]
    .find((p) => p.firstElementChild && p.firstElementChild.querySelector('span.truncate')?.textContent === title) ?? null;
  return true;
})()`;

/**
 * Keep the latency browser's frames flowing, whatever the app is doing.
 *
 * The latency browser runs with the frame-rate limiter off so a frame starts
 * as soon as the main thread is free. Chromium honours that only while frames
 * carry damage: after a frame that changes nothing on screen (a
 * requestAnimationFrame callback that draws nothing, the harness's own
 * settle-then-click, or a stepped decoration whose tick lands on the same
 * step), the display scheduler holds the next frame to the end of a default
 * 60 Hz interval. Input in that window waits up to 16.7 ms for a frame that
 * is not coming any sooner, so the latency figures measured the frame clock's
 * idle wake, not the app: they jumped by a whole frame the moment no looping
 * CSS decoration happened to be animating on the page (the decoration clock
 * of #438 moved warm switches from 13 to 19 ms and terminal keys from 6 to
 * 36 ms on CI without the app doing more work).
 *
 * A 1 px compositor-only animation, outside the app's DOM, puts damage in
 * every frame without adding main-thread work: the compositor keeps drawing
 * back to back and the next main frame starts as soon as it is asked for, as
 * it does on a fast real display. It only removes the hold; any work the app
 * does still delays the frame that shows the change.
 */
export const FRAME_PUMP = String.raw`(() => {
  if (document.getElementById('__perf-frame-pump')) return true;
  const el = document.createElement('div');
  el.id = '__perf-frame-pump';
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none;z-index:2147483647;will-change:transform;background:rgba(0,0,0,0.01);contain:strict';
  document.documentElement.appendChild(el);
  el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(1px)' }], { duration: 1000, iterations: Infinity, direction: 'alternate' });
  return true;
})()`;

/**
 * How long the page waits for a frame it asks for just after a frame that
 * drew nothing: the frame clock's idle wake, the cost FRAME_PUMP removes.
 * Samples in ms; a few tenths when frames are flowing, about 15 when the
 * display holds the next frame to a 60 Hz tick. A page function.
 */
export async function frameWake(n) {
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const out = [];
  for (let i = 0; i < n; i++) {
    await raf();
    await raf();
    await new Promise((r) => setTimeout(r, 2));
    const t = performance.now();
    await raf();
    out.push(performance.now() - t);
  }
  return out;
}

/**
 * Center of the first visible element matching `selector` whose title (or
 * text) is `text` (any, when null), scrolled into view. A page function, for
 * `cdp.call(locate, selector, text)`.
 */
export function locate(selector, text) {
  const el = [...document.querySelectorAll(selector)]
    .find((x) => x.checkVisibility() && (text == null || (x.getAttribute('title') ?? x.textContent ?? '').trim() === text));
  if (!el) return null;
  // Centred, not 'nearest': at the bottom edge a card sits under the floating resource HUD.
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 12)) };
}
