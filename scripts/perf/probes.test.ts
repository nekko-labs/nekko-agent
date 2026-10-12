import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { FRAME_PUMP, INSTALL } from './lib/probes.mjs';

it('finds transcript-only panels without requiring an embedded composer', async () => {
  const scroller = { checkVisibility: () => true, getBoundingClientRect: () => ({ top: 100, bottom: 200 }) };
  const reply = { textContent: '[newest]', getBoundingClientRect: () => ({ top: 120, bottom: 180, height: 60 }), closest: () => scroller };
  const panel = { checkVisibility: () => true, firstElementChild: { querySelector: () => ({ textContent: 'Chat' }) }, querySelector: () => scroller, querySelectorAll: () => [reply] };
  const document = { querySelectorAll: (selector: string) => selector === '.panel' ? [panel] : [], addEventListener: () => {} };
  const window: any = {};
  new Function('window', 'document', 'requestAnimationFrame', 'PerformanceObserver', 'performance', INSTALL)(window, document, (fn: Function) => fn(), class { observe() {} }, { now: () => 0 });
  expect(await window.__perf.waitForChat('Chat', '[newest]')).toBe(true);
});

it('opens the exact setup control and waits for the sidebar before accepting history', () => {
  const source = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8');
  const open = source.indexOf('await showAllCards();');
  const sidebar = source.indexOf("'the Agents sidebar'");
  const history = source.indexOf('const ok = await cdp.call');
  expect(open).toBeGreaterThan(0);
  expect(open).toBeGreaterThan(sidebar);
  expect(history).toBeGreaterThan(sidebar);
  expect(source).toContain('await clickAt(at);'); // measured switches still use input events
});

it('installs one frame pump, outside the app, animating on the compositor only', () => {
  const made: any[] = [];
  const document = {
    getElementById: (id: string) => made.find((e) => e.id === id) ?? null,
    createElement: () => {
      const el: any = { style: {}, attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v; } };
      el.animate = (frames: Record<string, string>[], opts: { iterations: number }) => { el.frames = frames; el.opts = opts; };
      return el;
    },
    documentElement: { appendChild: (el: any) => made.push(el) },
  };
  const install = new Function('document', `return ${FRAME_PUMP}`);
  expect(install(document)).toBe(true);
  expect(install(document)).toBe(true);
  expect(made).toHaveLength(1);
  const [pump] = made;
  expect(pump.style.cssText).toContain('pointer-events:none');
  expect(pump.style.cssText).toContain('width:1px');
  // Transform only: the compositor runs it, the main thread does no work per frame.
  expect(pump.frames.every((f: Record<string, string>) => Object.keys(f).join() === 'transform')).toBe(true);
  expect(pump.opts.iterations).toBe(Infinity);
});
