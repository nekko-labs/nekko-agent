import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, expect, it, vi } from 'vitest';

// Synthetic normal-session handles, not persisted user data.
vi.mock('./sessions.js', () => ({ getSession: (id: string) => ({ id, executionMode: 'unified' }) }));
import { DEFAULT_SETTINGS, type ToolCall } from '@nekko-agent/shared';
import { executeTool } from './tools.js';

/**
 * The `browser` tool's dedicated mode and the `capture` tool as the TS host
 * runs them, against a scripted desktop bridge, which the engine daemon's
 * port (crates/nekko-web `browser`) must reproduce: the checks, the approval
 * prompt, the bridge request, the result (images included) and the file a
 * capture writes. Paths under the temporary project read `<ROOT>` with `/`.
 * Writes crates/nekko-web/tests/golden/browser.json; fails if it is stale
 * (rewrite with UPDATE_GOLDEN=1).
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekko-web', 'tests', 'golden', 'browser.json');

interface Case {
  tool: 'browser' | 'capture';
  session: string;
  input: Record<string, unknown>;
  approve?: boolean;
  allow?: boolean;
  bridge?: boolean;
  reply?: { ok: boolean; body: unknown } | { throws: string };
  /** Capture: a file that already exists, relative to the project. */
  existing?: string;
  sandboxMode?: string;
}

const PNG = Buffer.from('png-bytes').toString('base64');
const WEBM = Buffer.from('webm-bytes').toString('base64');
const CASES: Case[] = [
  { tool: 'browser', session: 'b1', input: { mode: 'dedicated', action: 'navigate', url: 'https://example.com' }, reply: { ok: true, body: { output: 'Example page' } } },
  { tool: 'browser', session: 'b1', input: { mode: 'existing', action: 'inspect' } },
  { tool: 'browser', session: 'b1', input: { mode: 'dedicated', action: 'close' }, reply: { ok: true, body: { output: 'Closed.' } } },
  { tool: 'browser', session: 'b2', input: { mode: 'dedicated', action: 'evaluate', expression: `document.links.length + ${'1'.repeat(400)}` }, reply: { ok: true, body: { output: '3' } } },
  { tool: 'browser', session: 'b3', input: { mode: 'dedicated', action: 'screenshot' }, reply: { ok: true, body: { output: 'Screenshot of tab 0', image: { data: 'iVBORw0KGgo=', mime: 'image/png' } } } },
  { tool: 'browser', session: 'b3', input: { mode: 'dedicated', action: 'screenshot' }, reply: { ok: true, body: { image: { data: 'iVBORw0KGgo=', mime: 'image/png' } } } },
  { tool: 'browser', session: 'b3', input: { mode: 'dedicated', action: 'screenshot' }, reply: { ok: true, body: { image: { data: 'x', mime: 'image/jpeg' } } } },
  { tool: 'browser', session: 'b4', input: { mode: 'dedicated', action: 'type', text: `say "hi"\n${'x'.repeat(200)}` }, reply: { ok: true, body: { output: 'Typed.' } } },
  { tool: 'browser', session: 'b4', input: { mode: 'dedicated', action: 'press', key: 'Control+A' }, reply: { ok: false, body: { error: 'No page.' } } },
  { tool: 'browser', session: 'b4', input: { mode: 'dedicated', action: 'wait', text: 'Done' }, reply: { ok: false, body: {} } },
  { tool: 'browser', session: 'b4', input: { mode: 'dedicated', action: 'wait', selector: '#done', state: 'visible' }, reply: { ok: true, body: {} } },
  { tool: 'browser', session: 'b4', input: { mode: 'dedicated', action: 'tab_switch', tab: 2 }, reply: { ok: true, body: { output: 'Tab 2.' } } },
  { tool: 'browser', session: 'b4', input: { mode: 'dedicated', action: 'tab_close' }, reply: { ok: true, body: { output: 'Closed tab.' } } },
  { tool: 'browser', session: 'b4', input: { mode: 'dedicated', action: 'click', selector: 'a.more', sessionId: 'spoofed', visible: true }, reply: { ok: true, body: { output: 'Clicked.' } } },
  { tool: 'browser', session: 'b5', input: { mode: 'dedicated', action: 'navigate', url: 'https://example.com' }, approve: false },
  { tool: 'browser', session: 'b5', input: { mode: 'dedicated', action: 'navigate', url: 'https://example.com' }, bridge: false },
  { tool: 'browser', session: 'b5', input: { mode: 'dedicated', action: 'navigate', url: 'https://example.com' }, allow: false },
  { tool: 'browser', session: 'b5', input: { mode: 'dedicated', action: 'navigate', url: 'https://example.com' }, reply: { throws: 'fetch failed' } },
  { tool: 'browser', session: 'b6', input: { mode: 'nope', action: 'navigate' } },
  { tool: 'browser', session: 'b6', input: { mode: 'existing', action: 'inspect', visible: false } },
  { tool: 'browser', session: 'b6', input: { mode: 'existing', action: 'inspect', port: '9333x' } },
  { tool: 'browser', session: 'b6', input: { mode: 'existing', action: 'logs' } },
  { tool: 'browser', session: 'b6', input: { mode: 'dedicated', action: 'fill', selector: '#q', value: 5 } },
  { tool: 'browser', session: 'b6', input: { mode: 'dedicated', action: 'scroll', amount: 0 } },
  { tool: 'browser', session: 'b6', input: { mode: 'dedicated', action: 'extract', what: 'html' } },
  { tool: 'browser', session: 'b6', input: { mode: 'dedicated', action: 'navigate', url: 'HTTPS://EXAMPLE.COM', selector: 'x'.repeat(501) } },
  { tool: 'browser', session: 'b6', input: { mode: 'dedicated', action: 'tab_new', url: 'ftp://x' } },
  { tool: 'browser', session: 'b6', input: { mode: 'dedicated', action: 'press', key: 'Enteré' } },
  { tool: 'browser', session: 'b7', input: { mode: 'dedicated', action: 'snapshot' }, reply: { ok: true, body: { output: 'Signup\n- textbox "Email" [ref=e1]\n- button "Subscribe" [ref=e2]' } } },
  { tool: 'browser', session: 'b7', input: { mode: 'dedicated', action: 'snapshot', selector: 'form' }, reply: { ok: true, body: { output: 'Signup\n- textbox "Email" [ref=e1]' } } },
  { tool: 'browser', session: 'b7', input: { mode: 'dedicated', action: 'fill', selector: '@e1', value: 'a@b.c' }, reply: { ok: true, body: { output: 'Field filled.' } } },
  { tool: 'browser', session: 'b7', input: { mode: 'dedicated', action: 'click', selector: '@e2' }, reply: { ok: false, body: { error: 'Unknown ref: e2. Take a new snapshot; refs expire when the page changes.' } } },
  { tool: 'browser', session: 'b7', input: { mode: 'dedicated', action: 'snapshot', selector: '@e1' } },
  { tool: 'browser', session: 'b7', input: { mode: 'dedicated', action: 'scroll', selector: '@e1' } },
  { tool: 'browser', session: 'b7', input: { mode: 'existing', action: 'snapshot' } },
  { tool: 'capture', session: 'c1', input: { action: 'list' }, reply: { ok: true, body: { windows: [{ window_id: 'window:1', title: 'Editor', size: [1200, 800] }], empty: [], none: {} } } },
  { tool: 'capture', session: 'c1', input: { action: 'list', window_id: 'window:1' }, approve: false },
  { tool: 'capture', session: 'c1', input: { action: 'list' }, allow: false },
  { tool: 'capture', session: 'c1', input: { action: 'list' }, bridge: false },
  { tool: 'capture', session: 'c1', input: { action: 'zoom' } },
  { tool: 'capture', session: 'c1', input: { action: 'screenshot', inspect: 'yes' } },
  { tool: 'capture', session: 'c1', input: { action: 'screenshot', path: 'a.png' } },
  { tool: 'capture', session: 'c1', input: { action: 'screenshot', window_id: 'window:1' } },
  { tool: 'capture', session: 'c1', input: { action: 'screenshot', window_id: 'window:1', path: '../outside.png' }, sandboxMode: 'off' },
  { tool: 'capture', session: 'c1', input: { action: 'screenshot', window_id: 'window:1', path: '../outside.png' }, sandboxMode: 'workspace-jail' },
  { tool: 'capture', session: 'c1', input: { action: 'screenshot', window_id: 'window:1', path: 'shot.jpg' } },
  { tool: 'capture', session: 'c1', input: { action: 'screenshot', window_id: 'window:1', path: 'taken.png' }, existing: 'taken.png' },
  { tool: 'capture', session: 'c1', input: { action: 'record', window_id: 'window:1', path: 'clip.webm', seconds: 20 } },
  { tool: 'capture', session: 'c1', input: { action: 'record', window_id: 'window:1', path: 'clip.webm', seconds: '3' }, reply: { ok: true, body: { window_id: 'window:1', mime: 'video/webm', data: WEBM, seconds: 3 } } },
  { tool: 'capture', session: 'c1', input: { action: 'screenshot', window_id: 'window:1', path: '.shots/after.png' }, reply: { ok: true, body: { title: 'Other', window_id: 'window:1', mime: 'image/png', data: PNG, width: 1200, height: 800, path: 'theirs', bytes: 1 } } },
  { tool: 'capture', session: 'c1', input: { action: 'screenshot', window_id: 'window:1', path: 'deep/er/quiet.PNG', inspect: false }, reply: { ok: true, body: { mime: 'image/png', data: `${PNG}\n` } } },
  { tool: 'capture', session: 'c1', input: { action: 'screenshot', window_id: 'window:1', path: 'bad.png' }, reply: { ok: true, body: { mime: 'image/jpeg', data: PNG } } },
  { tool: 'capture', session: 'c1', input: { action: 'screenshot', window_id: 'window:1', path: 'empty.png' }, reply: { ok: true, body: { mime: 'image/png', data: '====' } } },
  { tool: 'capture', session: 'c1', input: { action: 'screenshot', window_id: 'window:1', path: 'fail.png' }, reply: { ok: true, body: { error: 'Window is gone.' } } },
  { tool: 'capture', session: 'c1', input: { action: 'screenshot', window_id: 'window:1', path: 'fail2.png' }, reply: { ok: false, body: {} } },
];

const root = realpathSync(mkdtempSync(join(tmpdir(), 'nekko-browser-golden-')));
const project = join(root, 'project');
mkdirSync(project);
afterAll(() => rmSync(root, { recursive: true, force: true }));
// Paths also appear JSON-escaped inside a capture's output text.
const escaped = (p: string) => JSON.stringify(p).slice(1, -1);
const norm = (s: string) => s.split(escaped(project)).join('<ROOT>').split(project).join('<ROOT>')
  .split(escaped(root)).join('<OUT>').split(root).join('<OUT>').replace(/\\\\/g, '/').replace(/\\/g, '/');
const deepNorm = (v: unknown): unknown => (typeof v === 'string' ? norm(v)
  : Array.isArray(v) ? v.map(deepNorm)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepNorm(x)])) : v);

it('browser and capture match the daemon golden set', async () => {
  const out = [];
  for (const c of CASES) {
    if (c.existing) writeFileSync(join(project, c.existing), 'old');
    const reasons: string[] = [];
    const requests: unknown[] = [];
    if (c.bridge === false) { vi.stubEnv('NEKKO_BROWSER_URL', ''); vi.stubEnv('NEKKO_BROWSER_TOKEN', ''); }
    else { vi.stubEnv('NEKKO_BROWSER_URL', 'http://127.0.0.1:1/bridge'); vi.stubEnv('NEKKO_BROWSER_TOKEN', 'golden-token'); }
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      requests.push(JSON.parse(init.body));
      const reply = c.reply ?? { ok: true, body: {} };
      if ('throws' in reply) throw new TypeError(reply.throws);
      return { ok: reply.ok, json: async () => reply.body };
    }));
    const call: ToolCall = { id: `call-${out.length}`, name: c.tool, input: c.input };
    const result = await executeTool(call, {
      settings: { ...DEFAULT_SETTINGS, sandboxMode: (c.sandboxMode ?? 'off') as never, workspaces: [{ id: 'w1', name: 'project', path: project, addedAt: 1 }] },
      defaultCwd: project,
      sessionId: c.session,
      allowBrowserControl: c.allow !== false,
      mode: 'yolo',
      requestApproval: async (_call, reason) => { reasons.push(norm(reason)); return c.approve !== false; },
    });
    const path = typeof c.input.path === 'string' ? join(project, c.input.path) : '';
    const written = c.tool === 'capture' && path && !c.existing && existsSync(path) ? readFileSync(path).toString('base64') : null;
    out.push({ case: c, reasons, requests, result: deepNorm(result), written });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(join(golden, '..'), { recursive: true });
    writeFileSync(golden, `${JSON.stringify(out, null, 1)}\n`);
  }
  expect(JSON.parse(readFileSync(golden, 'utf8'))).toEqual(JSON.parse(JSON.stringify(out)));
});
