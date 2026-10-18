import type { AgentPage as Page } from './agentPage.js';
import { BROWSER_MAX_WAIT_MS } from '@nekko-agent/shared';
import { untimed, type PhaseMark } from './agentBrowserTiming.js';

/** Text returned to the model is capped so one page cannot flood the context. */
export const PAGE_TEXT_LIMIT = 6_000;
const LOG_LIMIT = 200;
const DEFAULT_WAIT_MS = 5_000;
/** Clicks and fills fail fast instead of waiting out the bridge's 30 s. */
const ACTION_TIMEOUT_MS = 10_000;

export interface PageLogEntry { kind: 'console' | 'pageerror' | 'requestfailed' | 'http'; text: string; at: number }

/** Record console output, page errors and failed requests for the logs action. */
export function watchPage(page: Page, log: PageLogEntry[]): void {
  const push = (kind: PageLogEntry['kind'], text: string) => {
    log.push({ kind, text: text.slice(0, 500), at: Date.now() });
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
  };
  page.on('console', (message) => push('console', `[${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => push('pageerror', error.message));
  page.on('requestfailed', (request) => push('requestfailed', `${request.method()} ${request.url()} ${request.failure()?.errorText ?? 'failed'}`));
  page.on('response', (response) => { if (response.status() >= 400) push('http', `${response.status()} ${response.request().method()} ${response.url()}`); });
}

export function describeLogs(log: PageLogEntry[]): string {
  if (!log.length) return 'No console messages, page errors or failed requests since the last logs call.';
  const order: PageLogEntry['kind'][] = ['pageerror', 'requestfailed', 'http', 'console'];
  const titles = { pageerror: 'Page errors', requestfailed: 'Failed requests', http: 'HTTP errors', console: 'Console' };
  return order.map((kind) => {
    const entries = log.filter((e) => e.kind === kind);
    return entries.length ? `${titles[kind]} (${entries.length}):\n${entries.map((e) => `- ${e.text}`).join('\n')}` : '';
  }).filter(Boolean).join('\n\n');
}

export async function pageSummary(page: Page): Promise<string> {
  const [title, text] = await Promise.all([page.title(), page.evaluate(() => document.body?.innerText ?? '')]);
  return `${title}\n${String(text).slice(0, PAGE_TEXT_LIMIT)}`;
}

const waitMs = (input: Record<string, unknown>, fallback: number) => Math.min(typeof input.timeout_ms === 'number' ? input.timeout_ms : fallback, BROWSER_MAX_WAIT_MS);

/** Serialize an evaluate result for the model, never more than the text cap. */
export function formatEvaluated(value: unknown): string {
  if (value === undefined) return 'undefined';
  let text: string;
  try { text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value); }
  catch { text = String(value); }
  return text.length > PAGE_TEXT_LIMIT ? `${text.slice(0, PAGE_TEXT_LIMIT)}\n...(truncated)` : text;
}

/**
 * Run one validated page-level action. Tab handling, visibility, screenshots
 * and logs live with the window bookkeeping in agentBrowser.ts.
 */
export async function runPageAction(page: Page, input: Record<string, unknown>, mark: PhaseMark = untimed): Promise<string> {
  const summary = () => mark('summary', () => pageSummary(page));
  const selector = typeof input.selector === 'string' && input.selector ? input.selector : undefined;
  switch (input.action) {
    case 'navigate':
      await mark('navigate', () => page.goto(String(input.url), { waitUntil: 'load', timeout: 25_000 }));
      return summary();
    case 'inspect':
      return summary();
    case 'click':
      // The first match, as document.querySelector picked before Playwright.
      await mark('click', () => page.locator(selector!).first().click({ timeout: ACTION_TIMEOUT_MS }));
      return summary();
    case 'fill':
      await page.locator(selector!).first().fill(String(input.value ?? ''), { timeout: ACTION_TIMEOUT_MS });
      return 'Field filled.';
    case 'type': {
      const text = String(input.text);
      if (selector) await page.locator(selector).first().pressSequentially(text, { timeout: ACTION_TIMEOUT_MS });
      else await page.keyboard.type(text);
      return `Typed ${text.length} characters${selector ? ` into ${selector}` : ' into the focused element'}.`;
    }
    case 'press': {
      const key = String(input.key);
      if (selector) await page.locator(selector).first().press(key, { timeout: ACTION_TIMEOUT_MS });
      else await page.keyboard.press(key);
      return `Pressed ${key}.`;
    }
    case 'wait': {
      const state = (input.state as 'visible' | 'attached' | 'hidden' | 'detached' | undefined) ?? 'visible';
      const timeout = waitMs(input, DEFAULT_WAIT_MS);
      const started = Date.now();
      const target = selector ? page.locator(selector).first() : page.getByText(String(input.text)).first();
      await target.waitFor({ state, timeout });
      return `${selector ? `Selector ${selector}` : `Text "${String(input.text)}"`} is ${state} (${Date.now() - started} ms).`;
    }
    case 'scroll': {
      if (selector) {
        await page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
      } else {
        const amount = typeof input.amount === 'number' ? input.amount : 600;
        const direction = input.direction ?? 'down';
        const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
        const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
        await page.evaluate(([x, y]) => window.scrollBy(x, y), [dx, dy] as const);
      }
      const pos = await page.evaluate(() => ({ x: Math.round(window.scrollX), y: Math.round(window.scrollY), height: document.documentElement.scrollHeight, viewport: window.innerHeight }));
      return `Scrolled${selector ? ` ${selector} into view` : ''}. Position x=${pos.x}, y=${pos.y} of ${pos.height}px (viewport ${pos.viewport}px).`;
    }
    case 'extract': {
      if (input.what === 'links') {
        const links = await page.evaluate((scope) => {
          const root = scope ? document.querySelector(scope) : document;
          if (!root) throw new Error('Selector not found.');
          return Array.from(root.querySelectorAll('a[href]')).slice(0, 200).map((a) => ({ text: ((a as HTMLElement).innerText || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 120), href: (a as HTMLAnchorElement).href }));
        }, selector ?? null);
        if (!links.length) return 'No links found.';
        return formatEvaluated(links.map((l) => `${l.text || '(no text)'} (${l.href})`).join('\n'));
      }
      if (!selector) return pageSummary(page);
      const text = await page.locator(selector).first().innerText({ timeout: ACTION_TIMEOUT_MS });
      return text.slice(0, PAGE_TEXT_LIMIT);
    }
    case 'evaluate':
      // A string is evaluated as an expression in the page's main world. The
      // page is a sandboxed renderer with no Node or app access.
      return formatEvaluated(await page.evaluate(String(input.expression)));
    default:
      throw new Error('Unsupported page action.');
  }
}
