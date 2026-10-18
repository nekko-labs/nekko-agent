import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { describeLogs, formatEvaluated, PAGE_TEXT_LIMIT, runPageAction, watchPage, type PageLogEntry } from './agentBrowserActions.js';

function fakePage() {
  const locator = {
    first: vi.fn(() => locator),
    click: vi.fn(async () => {}), fill: vi.fn(async () => {}), press: vi.fn(async () => {}),
    pressSequentially: vi.fn(async () => {}), waitFor: vi.fn(async () => {}),
    scrollIntoViewIfNeeded: vi.fn(async () => {}), innerText: vi.fn(async () => 'Selected text'),
  };
  const listeners = new Map<string, (arg: any) => void>();
  const page = {
    goto: vi.fn(async () => null),
    title: vi.fn(async () => 'Title'),
    evaluate: vi.fn(async (fn: unknown, _arg?: unknown) => {
      if (typeof fn === 'string') return { answer: 42 };
      const src = String(fn);
      if (src.includes('innerText ??')) return 'Body text';
      if (src.includes('scrollHeight')) return { x: 0, y: 600, height: 4000, viewport: 760 };
      if (src.includes('querySelectorAll')) return [{ text: 'Docs', href: 'https://example.com/docs' }, { text: '', href: 'https://example.com/x' }];
      return undefined;
    }),
    locator: vi.fn(() => locator),
    getByText: vi.fn(() => locator),
    keyboard: { type: vi.fn(async () => {}), press: vi.fn(async () => {}) },
    on: vi.fn((event: string, cb: (arg: any) => void) => { listeners.set(event, cb); }),
  };
  return { page, locator, listeners, asPage: page as unknown as Page };
}

describe('Playwright page actions', () => {
  it('keeps the original actions and their outputs', async () => {
    const { page, locator, asPage } = fakePage();
    expect(await runPageAction(asPage, { action: 'navigate', url: 'https://example.com' })).toBe('Title\nBody text');
    expect(page.goto).toHaveBeenCalledWith('https://example.com', expect.objectContaining({ waitUntil: 'load' }));
    expect(await runPageAction(asPage, { action: 'inspect' })).toBe('Title\nBody text');
    expect(await runPageAction(asPage, { action: 'click', selector: '#go' })).toBe('Title\nBody text');
    expect(page.locator).toHaveBeenCalledWith('#go');
    expect(locator.first).toHaveBeenCalled(); // first match, as querySelector did
    expect(await runPageAction(asPage, { action: 'fill', selector: '#name', value: 'Nekko' })).toBe('Field filled.');
    expect(locator.fill).toHaveBeenCalledWith('Nekko', expect.anything());
  });

  it('types, presses, waits, scrolls, extracts and evaluates', async () => {
    const { page, locator, asPage } = fakePage();
    expect(await runPageAction(asPage, { action: 'type', text: 'hello' })).toContain('Typed 5 characters into the focused element');
    expect(page.keyboard.type).toHaveBeenCalledWith('hello');
    await runPageAction(asPage, { action: 'type', selector: '#q', text: 'abc' });
    expect(locator.pressSequentially).toHaveBeenCalledWith('abc', expect.anything());
    expect(await runPageAction(asPage, { action: 'press', key: 'Enter' })).toBe('Pressed Enter.');
    expect(page.keyboard.press).toHaveBeenCalledWith('Enter');
    await runPageAction(asPage, { action: 'press', selector: '#q', key: 'Control+A' });
    expect(locator.press).toHaveBeenCalledWith('Control+A', expect.anything());
    expect(await runPageAction(asPage, { action: 'wait', text: 'Done', timeout_ms: 99_999 })).toContain('is visible');
    expect(page.getByText).toHaveBeenCalledWith('Done');
    expect(locator.waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 20_000 }); // capped below the bridge timeout
    await runPageAction(asPage, { action: 'wait', selector: '.spinner', state: 'hidden' });
    expect(locator.waitFor).toHaveBeenLastCalledWith({ state: 'hidden', timeout: 5_000 });
    expect(await runPageAction(asPage, { action: 'scroll', direction: 'down', amount: 600 })).toContain('y=600 of 4000px');
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), [0, 600]);
    await runPageAction(asPage, { action: 'scroll', selector: '#bottom' });
    expect(locator.scrollIntoViewIfNeeded).toHaveBeenCalled();
    expect(await runPageAction(asPage, { action: 'extract', selector: '#status' })).toBe('Selected text');
    expect(await runPageAction(asPage, { action: 'extract', what: 'links' })).toBe('Docs (https://example.com/docs)\n(no text) (https://example.com/x)');
    expect(await runPageAction(asPage, { action: 'evaluate', expression: 'answer()' })).toBe('{\n  "answer": 42\n}');
    expect(page.evaluate).toHaveBeenCalledWith('answer()');
  });

  it('snapshots interactive elements with refs, and says when there are none or no native driver', async () => {
    const { page, asPage } = fakePage();
    await expect(runPageAction(asPage, { action: 'snapshot' })).rejects.toThrow('native in-app browser');
    const snapshot = vi.fn(async (scope?: string) => scope === '#empty' ? { tree: '(no interactive elements)', refs: 0 } : { tree: '- textbox "Email" [ref=e1]\n- button "Subscribe" [ref=e2]', refs: 2 });
    Object.assign(page, { snapshot });
    const out = await runPageAction(asPage, { action: 'snapshot' });
    expect(out).toBe('Title\n- textbox "Email" [ref=e1]\n- button "Subscribe" [ref=e2]\nUse a ref such as @e1 as the selector for click, fill, type, press, wait or extract. Refs expire when the page changes.');
    await runPageAction(asPage, { action: 'snapshot', selector: 'form' });
    expect(snapshot).toHaveBeenLastCalledWith('form');
    expect(await runPageAction(asPage, { action: 'snapshot', selector: '#empty' })).toContain('No interactive elements in #empty');
    snapshot.mockResolvedValueOnce({ tree: 'x'.repeat(PAGE_TEXT_LIMIT + 50), refs: 900 });
    const long = await runPageAction(asPage, { action: 'snapshot' });
    expect(long).toContain('...(truncated; pass a selector');
    expect(long.length).toBeLessThan(PAGE_TEXT_LIMIT + 300);
  });

  it('passes refs through as selectors', async () => {
    const { page, asPage } = fakePage();
    await runPageAction(asPage, { action: 'fill', selector: '@e1', value: 'a@b.c' });
    await runPageAction(asPage, { action: 'click', selector: '@e2' });
    expect(page.locator.mock.calls.map((c: unknown[]) => c[0])).toEqual(['@e1', '@e2']);
  });

  it('caps evaluate output and summarizes logs by kind', () => {
    expect(formatEvaluated('x'.repeat(PAGE_TEXT_LIMIT + 10))).toContain('...(truncated)');
    expect(formatEvaluated(undefined)).toBe('undefined');
    const { listeners, asPage } = fakePage();
    const log: PageLogEntry[] = [];
    watchPage(asPage, log);
    listeners.get('console')!({ type: () => 'error', text: () => 'boom' });
    listeners.get('pageerror')!(new Error('uncaught'));
    listeners.get('requestfailed')!({ method: () => 'GET', url: () => 'https://x.test/a.js', failure: () => ({ errorText: 'net::ERR_FAILED' }) });
    listeners.get('response')!({ status: () => 404, url: () => 'https://x.test/missing', request: () => ({ method: () => 'GET' }) });
    listeners.get('response')!({ status: () => 200, url: () => 'https://x.test/ok', request: () => ({ method: () => 'GET' }) });
    const text = describeLogs(log);
    expect(text).toContain('Page errors (1):\n- uncaught');
    expect(text).toContain('Failed requests (1):\n- GET https://x.test/a.js net::ERR_FAILED');
    expect(text).toContain('HTTP errors (1):\n- 404 GET https://x.test/missing');
    expect(text).toContain('Console (1):\n- [error] boom');
    expect(text).not.toContain('/ok');
    expect(describeLogs([])).toContain('No console messages');
  });
});
