/**
 * The `browser` tool's actions and input checks, shared by the host (which
 * validates before asking for approval) and the desktop bridge (which validates
 * again before touching a window, since it is the authority).
 */

/** Actions both modes support: the original five. */
export const BROWSER_BASIC_ACTIONS = ['navigate', 'inspect', 'click', 'fill', 'close'] as const;
/** Playwright-backed actions, dedicated (in-app) mode only. */
export const BROWSER_DEDICATED_ACTIONS = ['wait', 'type', 'press', 'scroll', 'extract', 'evaluate', 'screenshot', 'tabs', 'tab_new', 'tab_switch', 'tab_close', 'logs', 'snapshot'] as const;
export const BROWSER_ACTIONS = [...BROWSER_BASIC_ACTIONS, ...BROWSER_DEDICATED_ACTIONS] as const;
export type BrowserAction = (typeof BROWSER_ACTIONS)[number];

export const BROWSER_WAIT_STATES = ['visible', 'attached', 'hidden', 'detached'] as const;
export const BROWSER_SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
export const BROWSER_EXTRACT_KINDS = ['text', 'links'] as const;
/** Longest a single wait may block; the bridge request itself times out at 30 s. */
export const BROWSER_MAX_WAIT_MS = 20_000;

export const isBrowserAction = (value: unknown): value is BrowserAction => (BROWSER_ACTIONS as readonly unknown[]).includes(value);
export const isHttpUrl = (value: unknown): value is string => typeof value === 'string' && /^https?:\/\//i.test(value);

const optionalString = (input: Record<string, unknown>, key: string, max: number): string | undefined => {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) throw new Error(`${key} must be a string of at most ${max} characters.`);
  return value;
};

/**
 * Throws a readable error when the input cannot be run. Only shape is checked
 * here; whether a selector matches is the page's business.
 */
export function validateBrowserInput(input: Record<string, unknown>): BrowserAction {
  const action = input.action;
  if (!isBrowserAction(action)) throw new Error('Unsupported browser action.');
  const selector = optionalString(input, 'selector', 500);
  if (action === 'navigate' && !isHttpUrl(input.url)) throw new Error('Only HTTP(S) pages can be opened.');
  if (action === 'tab_new' && input.url !== undefined && !isHttpUrl(input.url)) throw new Error('Only HTTP(S) pages can be opened.');
  if ((action === 'click' || action === 'fill') && !selector) throw new Error('A CSS selector is required.');
  if (action === 'fill' && input.value !== undefined && (typeof input.value !== 'string' || input.value.length > 10_000)) throw new Error('value must be a string of at most 10000 characters.');
  if (action === 'type' && (typeof input.text !== 'string' || !input.text || input.text.length > 10_000)) throw new Error('type needs text of at most 10000 characters.');
  if (action === 'press' && (typeof input.key !== 'string' || !/^[\x21-\x7e]{1,50}$/.test(input.key))) throw new Error('press needs a key such as Enter, Tab, ArrowDown or Control+A.');
  if (action === 'wait') {
    const text = optionalString(input, 'text', 500);
    if (!selector && !text) throw new Error('wait needs a selector or text.');
    if (input.state !== undefined && !(BROWSER_WAIT_STATES as readonly unknown[]).includes(input.state)) throw new Error(`state must be one of ${BROWSER_WAIT_STATES.join(', ')}.`);
  }
  if (input.timeout_ms !== undefined && (typeof input.timeout_ms !== 'number' || !Number.isFinite(input.timeout_ms) || input.timeout_ms < 0 || input.timeout_ms > BROWSER_MAX_WAIT_MS)) throw new Error(`timeout_ms must be between 0 and ${BROWSER_MAX_WAIT_MS}.`);
  if (action === 'scroll') {
    if (input.direction !== undefined && !(BROWSER_SCROLL_DIRECTIONS as readonly unknown[]).includes(input.direction)) throw new Error(`direction must be one of ${BROWSER_SCROLL_DIRECTIONS.join(', ')}.`);
    if (input.amount !== undefined && (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount < 1 || input.amount > 20_000)) throw new Error('amount must be between 1 and 20000 pixels.');
  }
  if (action === 'extract' && input.what !== undefined && !(BROWSER_EXTRACT_KINDS as readonly unknown[]).includes(input.what)) throw new Error(`what must be one of ${BROWSER_EXTRACT_KINDS.join(', ')}.`);
  if (action === 'evaluate' && (typeof input.expression !== 'string' || !input.expression.trim() || input.expression.length > 5_000)) throw new Error('evaluate needs an expression of at most 5000 characters.');
  if ((action === 'tab_switch' || (action === 'tab_close' && input.tab !== undefined)) && (typeof input.tab !== 'number' || !Number.isInteger(input.tab) || input.tab < 0 || input.tab > 50)) throw new Error('tab must be a tab index from the tabs action.');
  if (input.visible !== undefined && typeof input.visible !== 'boolean') throw new Error('visible must be a boolean.');
  if (action === 'snapshot' && selector && /^@e\d+$/.test(selector)) throw new Error('A snapshot scope is a CSS selector, not a ref.');
  if (action === 'scroll' && selector && /^@e\d+$/.test(selector)) throw new Error('scroll takes a CSS selector; click, fill and type on a ref already scroll it into view.');
  return action;
}
