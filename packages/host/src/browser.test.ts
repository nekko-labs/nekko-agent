import { afterEach, describe, expect, it, vi } from 'vitest';

// These unit fixtures use synthetic normal-session handles, not persisted user data.
vi.mock('./sessions.js', () => ({ getSession: (id: string) => ({ id, executionMode: 'unified' }) }));
import { DEFAULT_SETTINGS } from '@nekko-agent/shared';
import { executeTool } from './tools.js';

const call = { id: 'browser-1', name: 'browser', input: { mode: 'dedicated', action: 'navigate', url: 'https://example.com' } };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('in-app browser routing', () => {
  it('never contacts the browser before approval', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const requestApproval = vi.fn(async () => false);
    const result = await executeTool(call, { settings: DEFAULT_SETTINGS, sessionId: 'chat-1', allowBrowserControl: true, mode: 'yolo', requestApproval });
    expect(result.isError).toBe(true);
    expect(requestApproval).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('routes approved dedicated actions to Electron instead of launching a browser', async () => {
    vi.stubEnv('NEKKO_BROWSER_URL', 'http://127.0.0.1:12345/');
    vi.stubEnv('NEKKO_BROWSER_TOKEN', 'test-token');
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ output: 'Example page' }) }));
    vi.stubGlobal('fetch', fetch);
    const result = await executeTool(call, { settings: DEFAULT_SETTINGS, sessionId: 'chat-1', allowBrowserControl: true, requestApproval: async () => true });
    expect(result.output).toBe('Example page');
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:12345/', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      body: JSON.stringify({ ...call.input, sessionId: 'chat-1' }),
    }));
  });

  it('fails clearly without an Electron bridge, with no external fallback', async () => {
    vi.stubEnv('NEKKO_BROWSER_URL', ''); vi.stubEnv('NEKKO_BROWSER_TOKEN', '');
    const result = await executeTool(call, { settings: DEFAULT_SETTINGS, sessionId: 'chat-1', allowBrowserControl: true, requestApproval: async () => true });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Restart the desktop app');
  });

  it('validates new actions before asking, and keeps them to dedicated mode', async () => {
    const requestApproval = vi.fn(async () => true);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const run = (input: Record<string, unknown>) => executeTool({ id: 'b', name: 'browser', input }, { settings: DEFAULT_SETTINGS, sessionId: 'chat-1', allowBrowserControl: true, requestApproval });
    for (const [input, message] of [
      [{ mode: 'dedicated', action: 'teleport' }, 'Unsupported browser action'],
      [{ mode: 'dedicated', action: 'wait' }, 'selector or text'],
      [{ mode: 'dedicated', action: 'wait', text: 'Done', timeout_ms: 60_000 }, 'timeout_ms'],
      [{ mode: 'dedicated', action: 'press', key: 'Enter Enter' }, 'press needs a key'],
      [{ mode: 'dedicated', action: 'type' }, 'type needs text'],
      [{ mode: 'dedicated', action: 'evaluate', expression: '' }, 'evaluate needs an expression'],
      [{ mode: 'dedicated', action: 'tab_new', url: 'javascript:alert(1)' }, 'Only HTTP(S)'],
      [{ mode: 'dedicated', action: 'tab_switch' }, 'tab must be'],
      [{ mode: 'dedicated', action: 'scroll', direction: 'sideways' }, 'direction'],
      [{ mode: 'existing', action: 'screenshot' }, 'needs dedicated mode'],
      [{ mode: 'existing', action: 'snapshot' }, 'needs dedicated mode'],
      [{ mode: 'dedicated', action: 'snapshot', selector: '@e2' }, 'not a ref'],
      [{ mode: 'dedicated', action: 'scroll', selector: '@e12' }, 'scroll takes a CSS selector'],
    ] as const) {
      const result = await run(input);
      expect(result.isError, JSON.stringify(input)).toBe(true);
      expect(result.output).toContain(message);
    }
    expect(requestApproval).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('names what an evaluate runs and discloses screenshot pixels in the approval', async () => {
    vi.stubEnv('NEKKO_BROWSER_URL', 'http://127.0.0.1:12345/');
    vi.stubEnv('NEKKO_BROWSER_TOKEN', 'test-token');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ output: '3' }) })));
    const reasons: string[] = [];
    const requestApproval = vi.fn(async (_call: unknown, reason: string) => { reasons.push(reason); return true; });
    await executeTool({ id: 'e', name: 'browser', input: { mode: 'dedicated', action: 'evaluate', expression: 'document.links.length' } }, { settings: DEFAULT_SETTINGS, sessionId: 'chat-1', allowBrowserControl: true, requestApproval });
    expect(reasons[0]).toContain('document.links.length');
    expect(reasons[0]).toContain('runs as script inside the page');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ output: 'Screenshot of tab 0', image: { data: 'iVBORw0KGgo=', mime: 'image/png' } }) })));
    const shot = await executeTool({ id: 's', name: 'browser', input: { mode: 'dedicated', action: 'screenshot' } }, { settings: DEFAULT_SETTINGS, sessionId: 'chat-1', allowBrowserControl: true, requestApproval });
    expect(reasons[1]).toContain('Page pixels will be sent to the selected chat model');
    expect(shot.isError).toBeFalsy();
    expect(shot.images).toEqual(['data:image/png;base64,iVBORw0KGgo=']);
    expect(shot.output).not.toContain('iVBORw0KGgo');
  });

  it('rejects a screenshot reply without valid PNG data', async () => {
    vi.stubEnv('NEKKO_BROWSER_URL', 'http://127.0.0.1:12345/');
    vi.stubEnv('NEKKO_BROWSER_TOKEN', 'test-token');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ output: 'x', image: { data: 'abc', mime: 'image/jpeg' } }) })));
    const result = await executeTool({ id: 's', name: 'browser', input: { mode: 'dedicated', action: 'screenshot' } }, { settings: DEFAULT_SETTINGS, sessionId: 'chat-1', allowBrowserControl: true, requestApproval: async () => true });
    expect(result.isError).toBe(true);
    expect(result.images).toBeUndefined();
  });

  it('is unavailable outside a local desktop chat', async () => {
    const result = await executeTool({ id: 'w', name: 'browser', input: { mode: 'dedicated', action: 'tabs' } }, { settings: DEFAULT_SETTINGS, sessionId: 'chat-1', allowBrowserControl: false, requestApproval: async () => true });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('only in a local desktop chat');
  });
});
