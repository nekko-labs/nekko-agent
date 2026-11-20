import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WheelEvent } from 'react';
import { forwardWheelToContent } from './railWheel.js';

/** A stand-in element: scroll metrics, a parent, and `contains`, since no DOM runs here. */
type Fake = { nodeType: 1; parentElement: Fake | null; scrollTop: number; scrollHeight: number; clientHeight: number; overflow: string; contains: (n: Fake) => boolean };

function box({ scrollHeight = 100, clientHeight = 100, scrollTop = 0, overflow = 'visible' } = {}, parent: Fake | null = null): Fake {
  const el: Fake = {
    nodeType: 1, parentElement: parent, scrollTop, scrollHeight, clientHeight, overflow,
    contains: (n) => { for (let x: Fake | null = n; x; x = x.parentElement) if (x === el) return true; return false; },
  };
  return el;
}

beforeAll(() => { vi.stubGlobal('getComputedStyle', (el: Fake) => ({ overflowY: el.overflow })); });
afterAll(() => { vi.unstubAllGlobals(); });

function page(railMetrics = {}) {
  const layout = box();
  const rail = box(railMetrics, layout);
  const link = box({}, rail);
  const content = box({ scrollHeight: 2000, clientHeight: 500, overflow: 'auto' }, layout);
  return { layout, rail, link, content };
}

const wheel = (target: Fake, currentTarget: Fake, deltaY: number, extra: { deltaMode?: number; ctrlKey?: boolean } = {}) =>
  ({ target, currentTarget, deltaY, deltaMode: 0, ctrlKey: false, defaultPrevented: false, ...extra }) as unknown as WheelEvent<HTMLElement>;
const el = (f: Fake) => f as unknown as HTMLElement;

describe('forwardWheelToContent', () => {
  it('scrolls the content when the wheel turns over the side menu', () => {
    const { layout, link, content } = page();
    forwardWheelToContent(wheel(link, layout, 120), el(content));
    expect(content.scrollTop).toBe(120);
  });

  it('scrolls the content from the gutters beside it', () => {
    const { layout, content } = page();
    forwardWheelToContent(wheel(layout, layout, 40), el(content));
    expect(content.scrollTop).toBe(40);
  });

  it('leaves a wheel inside the content to the browser', () => {
    const { layout, content } = page();
    const inner = box({}, content);
    forwardWheelToContent(wheel(inner, layout, 120), el(content));
    expect(content.scrollTop).toBe(0);
  });

  it('lets a long menu scroll itself first, then hands over at its end', () => {
    const { layout, rail, link, content } = page({ scrollHeight: 900, clientHeight: 300, overflow: 'auto' });
    forwardWheelToContent(wheel(link, layout, 100), el(content));
    expect(content.scrollTop).toBe(0);
    rail.scrollTop = 600;
    forwardWheelToContent(wheel(link, layout, 100), el(content));
    expect(content.scrollTop).toBe(100);
  });

  it('counts a line-mode wheel in lines and ignores pinch zoom', () => {
    const { layout, link, content } = page();
    forwardWheelToContent(wheel(link, layout, 3, { deltaMode: 1 }), el(content));
    expect(content.scrollTop).toBe(48);
    forwardWheelToContent(wheel(link, layout, 100, { ctrlKey: true }), el(content));
    expect(content.scrollTop).toBe(48);
  });
});
